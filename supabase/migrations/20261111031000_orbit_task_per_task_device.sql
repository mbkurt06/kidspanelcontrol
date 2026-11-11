-- Görev başına ayarlar: telefon görev listesi ve süre dolumları görevin kendi saatini/ayarını kullanır.

create or replace function orbit.expire_runs(p_today date) returns void
language plpgsql security definer set search_path = '' as $$
declare r orbit.task_runs; t orbit.tasks; mins int; validity text; v_on date; exp date; x record;
  nowt time := (now() at time zone 'Europe/Berlin')::time;
begin
  for r in
    select r2.* from orbit.task_runs r2
      join orbit.tasks t2 on t2.id = r2.task_id
      join orbit.families f on f.id = t2.family_id
      left join orbit.task_groups g2 on g2.id = t2.group_id
     where r2.status in ('open', 'started', 'rejected') and (
       (g2.id is null and (
          (t2.recurrence = 'days' and r2.day < p_today)
          or (t2.recurrence = 'once' and coalesce(t2.due_date, t2.end_date) is not null and coalesce(t2.due_date, t2.end_date) < p_today)
          or (((t2.recurrence = 'days' and r2.day = p_today) or (t2.recurrence = 'once' and coalesce(t2.due_date, t2.end_date) = p_today)) and coalesce(t2.due_time, orbit.open_end_at(r2.child_id, p_today)) <= nowt)))
       or (g2.id is not null and (
          (g2.recurrence <> 'once' and r2.day < p_today)
          or (g2.recurrence = 'once' and g2.end_date is not null and g2.end_date < p_today)
          or ((case when g2.recurrence = 'once' then coalesce(g2.end_date, g2.start_date) else r2.day end) = p_today and coalesce(orbit.task_due(t2, g2), orbit.open_end_at(r2.child_id, p_today)) <= nowt)))
     )
  loop
    select * into t from orbit.tasks where id = r.task_id;
    if coalesce(t.reward_minutes, 0) < 0 and not exists (select 1 from orbit.time_grants tg where tg.task_run_id = r.id and tg.source = 'task_penalty') then
      mins := t.reward_minutes; validity := coalesce(t.reward_validity, 'today');
      v_on := case validity when 'today' then p_today when 'tomorrow' then p_today + 1 when 'date' then coalesce(t.reward_date, p_today) else null end;
      exp := case when validity = 'wallet' and t.reward_expires_days is not null then p_today + t.reward_expires_days end;
      insert into orbit.time_grants (child_id, minutes, valid_on, expires_on, source, note, created_by, task_run_id, vault)
      values (r.child_id, mins, v_on, exp, 'task_penalty', 'Görev cezası: ' || t.title, t.created_by, r.id, validity = 'vault');
    end if;
    -- Yapılmazsa süre düşülsün (ödülden bağımsız)
    if coalesce(t.fail_minutes, 0) > 0 and not exists (select 1 from orbit.time_grants tg where tg.task_run_id = r.id and tg.source = 'task_penalty') then
      insert into orbit.time_grants (child_id, minutes, valid_on, expires_on, source, note, created_by, task_run_id, vault)
      values (r.child_id, -t.fail_minutes, case when t.fail_target = 'today' then p_today end, null, 'task_penalty',
              'Görev yapılmadı: ' || t.title, t.created_by, r.id, t.fail_target = 'vault');
    end if;
    update orbit.task_runs set status = 'expired' where id = r.id;
  end loop;

  for x in
    select distinct tt.group_id, rr.child_id, rr.day
      from orbit.task_runs rr
      join orbit.tasks tt on tt.id = rr.task_id
      join orbit.task_groups gg on gg.id = tt.group_id
      join orbit.families ff on ff.id = gg.family_id
     where not exists (select 1 from orbit.task_group_runs gr where gr.group_id = tt.group_id and gr.child_id = rr.child_id and gr.day = rr.day and gr.status <> 'open')
       and (
         (gg.recurrence <> 'once' and rr.day < p_today)
         or (gg.recurrence = 'once' and gg.end_date is not null and gg.end_date < p_today)
         or ((case when gg.recurrence = 'once' then coalesce(gg.end_date, gg.start_date) else rr.day end) = p_today and coalesce(orbit.group_due(gg), orbit.open_end_at(rr.child_id, p_today)) <= nowt))
       and rr.day >= p_today - 14
  loop
    if not exists (select 1 from orbit.task_runs r3 join orbit.tasks t3 on t3.id = r3.task_id
                    where t3.group_id = x.group_id and r3.child_id = x.child_id and r3.day = x.day and r3.status = 'submitted') then
      perform orbit.group_settle(x.group_id, x.child_id, x.day, true);
    end if;
  end loop;
end $$;

create or replace function orbit.device_tasks(p_day date) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare child uuid := orbit.device_child();
begin
  if child is null then raise exception 'not_allowed'; end if;
  perform orbit.expire_runs(p_day);
  perform orbit.ensure_runs(child, p_day);
  return coalesce((select jsonb_agg(jsonb_build_object(
    'run_id', r.id, 'task_id', t.id, 'day', r.day, 'status', r.status, 'reject_note', r.reject_note, 'title', t.title, 'description', t.description,
    'proof', t.proof, 'before_after', t.before_after,
    'before_photo_min', t.before_photo_min, 'before_photo_max', t.before_photo_max, 'after_photo_min', t.after_photo_min, 'after_photo_max', t.after_photo_max,
    'proof_before_min', t.proof_before_min, 'proof_before_max', t.proof_before_max, 'proof_after_min', t.proof_after_min, 'proof_after_max', t.proof_after_max,
    'reward_minutes', t.reward_minutes, 'reward_text', t.reward_text,
    'reward_validity', case when g.per_task then t.reward_validity else coalesce(g.reward_validity, t.reward_validity) end, 'reward_date', t.reward_date,
    'mandatory', t.mandatory, 'due_time', case when g.id is null then t.due_time else orbit.task_due(t, g) end,
    'due_date', case when g.id is null then coalesce(t.due_date, t.end_date) when g.recurrence = 'once' then g.end_date else r.day end,
    'assign_mode', t.assign_mode, 'attempts', r.attempts, 'created_at', r.created_at,
    'record_minutes', t.record_minutes, 'record_min_minutes', t.record_min_minutes, 'screenshot_min', t.screenshot_min, 'screenshot_max', t.screenshot_max, 'screen_record_minutes', t.screen_record_minutes, 'screen_record_min_minutes', t.screen_record_min_minutes, 'allowed_packages', to_jsonb(t.allowed_packages), 'record_camera', t.record_camera, 'record_pause', t.record_pause, 'record_pause_max', t.record_pause_max,
    'recording', (select jsonb_build_object('id', x.id, 'status', x.status, 'recorded_seconds', x.recorded_seconds, 'paused_seconds', x.paused_seconds, 'pause_count', x.pause_count, 'camera', x.camera)
                    from orbit.task_recordings x where x.run_id = r.id and x.attempt = r.attempts and x.status <> 'cancelled' and x.camera <> 'screen' order by x.started_at desc limit 1),
    'screen_recording', (select jsonb_build_object('id', x.id, 'status', x.status, 'recorded_seconds', x.recorded_seconds) from orbit.task_recordings x where x.run_id = r.id and x.attempt = r.attempts and x.status <> 'cancelled' and x.camera = 'screen' order by x.started_at desc limit 1),
    'proofs', (select coalesce(jsonb_agg(jsonb_build_object('stage', p.stage, 'media', p.media)), '[]'::jsonb)
                 from orbit.task_proofs p where p.run_id = r.id and p.removed_at is null and p.stage <> 'record' and (p.stage = 'before' or p.attempt = r.attempts)),
    'group_id', g.id, 'group_name', g.name, 'group_order', t.group_order, 'sequential', coalesce(g.sequential, false),
    'locked', case when g.id is not null then orbit.run_locked(r.id) else false end,
    'start_time', case when g.per_task then coalesce(t.start_time, g.start_time) else g.start_time end,
    'group', case when g.id is not null then orbit.group_state(g.id, r.child_id, r.day) end,
    'agenda_item_id', (select a.id from orbit.agenda_items a where a.task_id = t.id and a.child_id = r.child_id limit 1)
  ) || jsonb_build_object('allowed_mode', t.allowed_mode, 'vocab_cards', t.vocab_cards, 'vocab_done', case when t.vocab_cards is not null then orbit.vocab_done_today(child) end, 'fail_minutes', t.fail_minutes, 'fail_target', t.fail_target,
       'start_date', t.start_date, 'end_date', t.end_date, 'recurrence', t.recurrence,
       'window_start', case when g.per_task then coalesce(t.start_time, g.start_time, orbit.open_start_at(child, p_day)) else coalesce(g.start_time, orbit.open_start_at(child, p_day)) end,
       'window_end', coalesce(case when g.id is not null then orbit.task_due(t, g) end, t.due_time, orbit.open_end_at(child, p_day)),
       'restriction', case when g.per_task then t.phone_restriction when gr.applies then g.restriction when g.id is null or t.mandatory then t.phone_restriction else 'none' end,
       'restriction_mode_id', case when g.per_task then t.restriction_mode_id when gr.applies then g.restriction_mode_id else t.restriction_mode_id end,
       'restricted_allowed', case when g.per_task then t.restricted_allowed when gr.applies and coalesce(jsonb_array_length(t.restricted_allowed), 0) = 0 then g.restricted_allowed else t.restricted_allowed end,
       'orbit_focus_profile_id', t.orbit_focus_profile_id,
       'bundle', case when g.id is not null then orbit.bundle_info(g.id, t.id, r.child_id, r.day) end)
  || jsonb_build_object(
       'per_task', coalesce(g.per_task, false), 'use_mode', t.use_mode, 'granted_minutes', r.granted_minutes,
       'held', g.id is not null and r.status = 'approved' and r.grant_id is null and greatest(coalesce(r.granted_minutes, t.reward_minutes, 0), 0) > 0,
       'earn', case when g.per_task and cardinality(t.earn_links) > 0 then jsonb_build_object(
          'titles', (select coalesce(jsonb_agg(x.title order by x.group_order, x.created_at), '[]'::jsonb) from orbit.tasks x where x.id = any (t.earn_links) and x.active),
          'mode', t.earn_mode, 'min', t.earn_min, 'met', orbit.task_earn_met(t, r.child_id, r.day)) end,
       'start_after', case when g.per_task and cardinality(t.start_after) > 0 then
          (select coalesce(jsonb_agg(x.title order by x.group_order, x.created_at), '[]'::jsonb) from orbit.tasks x where x.id = any (t.start_after) and x.active) end)
  order by g.sort nulls last, g.id nulls last, orbit.bundle_pos(g.bundles, t.id) nulls last, t.group_order, t.mandatory desc, t.due_time nulls last, t.created_at)
  from orbit.task_runs r
  join orbit.tasks t on t.id = r.task_id
  left join orbit.task_groups g on g.id = t.group_id
  left join lateral (select g.id is not null and g.restriction <> 'none' and (
      (g.restriction_until = 'mandatory' and t.mandatory)
      or g.restriction_until = 'all'
      or (g.restriction_until = 'condition' and not orbit.group_met(g.id, r.child_id, r.day))) as applies) gr on true
  join orbit.families f on f.id = t.family_id
  where r.child_id = child and (r.day = p_day
    or ((t.recurrence = 'once' and t.group_id is null or g.recurrence = 'once') and r.status in ('open', 'started', 'submitted', 'rejected'))
    or (r.day >= p_day - 1 and r.status in ('approved', 'rejected', 'submitted')))), '[]'::jsonb);
end $$;
