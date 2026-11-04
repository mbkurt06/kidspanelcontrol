-- Görev grubu mantığı: takvim, sıra kilidi, koşul, ödülün tutulup açılması, koşul sağlanmazsa kasaya.

create or replace function orbit.group_on(g orbit.task_groups, p_day date)
returns boolean language sql stable set search_path = '' as $$
  select g.active and g.start_date <= p_day and (g.end_date is null or g.end_date >= p_day) and case g.recurrence
    when 'once' then p_day >= g.start_date
    when 'days' then extract(isodow from p_day)::int = any(g.days)
    when 'biweekly' then extract(isodow from p_day)::int = any(g.days) and ((p_day - g.start_date) / 7) % 2 = 0
    when 'monthly' then extract(day from p_day) = extract(day from g.start_date)
    else false end
$$;

-- Bir grubun bir çocuk için bir günkü durumu
create or replace function orbit.group_state(p_group uuid, p_child uuid, p_day date)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare g orbit.task_groups; total int; approved int; mand_left int; held int; need int; st text;
begin
  select * into g from orbit.task_groups where id = p_group;
  if g.id is null then return null; end if;
  select count(*), count(*) filter (where r.status = 'approved'),
         count(*) filter (where t.mandatory and r.status <> 'approved'),
         coalesce(sum(case when r.status = 'approved' then greatest(coalesce(r.granted_minutes, t.reward_minutes, 0), 0) else 0 end), 0)
    into total, approved, mand_left, held
    from orbit.task_runs r join orbit.tasks t on t.id = r.task_id
   where t.group_id = p_group and r.child_id = p_child and r.day = p_day and r.status <> 'claimed';
  need := case when g.min_count is null then total else least(g.min_count, total) end;
  select status into st from orbit.task_group_runs where group_id = p_group and child_id = p_child and day = p_day;
  return jsonb_build_object('total', total, 'approved', approved, 'need', need, 'mandatory_left', mand_left,
    'held_minutes', held, 'status', coalesce(st, 'open'),
    'all_minutes', (select coalesce(sum(greatest(coalesce(t.reward_minutes, 0), 0)), 0) from orbit.tasks t where t.group_id = p_group and t.active));
end; $$;

-- Sıralı grupta önceki görev onaylanmadıysa kilitli
create or replace function orbit.run_locked(p_run uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1
      from orbit.task_runs r
      join orbit.tasks t on t.id = r.task_id
      join orbit.task_groups g on g.id = t.group_id and g.sequential
      join orbit.tasks t2 on t2.group_id = t.group_id and t2.active
      join orbit.task_runs r2 on r2.task_id = t2.id and r2.child_id = r.child_id and r2.day = r.day
     where r.id = p_run
       and (t2.group_order, t2.created_at, t2.id) < (t.group_order, t.created_at, t.id)
       and r2.status not in ('approved', 'claimed')
  )
$$;

create or replace function orbit.insert_group_grant(g orbit.task_groups, p_child uuid, p_minutes int, p_note text, p_vault boolean)
returns uuid language plpgsql security definer set search_path = '' as $$
declare gid uuid; today date := (now() at time zone 'Europe/Berlin')::date; v text := case when p_vault then 'vault' else g.reward_validity end;
begin
  if p_minutes is null or p_minutes = 0 then return null; end if;
  insert into orbit.time_grants (child_id, minutes, valid_on, source, note, created_by, vault)
  values (p_child, p_minutes, case when v = 'today' then today else null end,
          case when p_minutes < 0 then 'task_penalty' else 'task' end, p_note, g.created_by, v = 'vault')
  returning id into gid;
  return gid;
end; $$;

-- Koşulu değerlendir; sağlandıysa tutulan süreyi aç, p_final ise ve sağlanmadıysa kural uygula
create or replace function orbit.group_settle(p_group uuid, p_child uuid, p_day date, p_final boolean)
returns text language plpgsql security definer set search_path = '' as $$
declare g orbit.task_groups; s jsonb; gr orbit.task_group_runs; gid uuid; mins int;
begin
  select * into g from orbit.task_groups where id = p_group;
  if g.id is null then return null; end if;
  insert into orbit.task_group_runs (group_id, child_id, day) values (p_group, p_child, p_day) on conflict do nothing;
  select * into gr from orbit.task_group_runs where group_id = p_group and child_id = p_child and day = p_day for update;
  if gr.status <> 'open' then return gr.status; end if;
  s := orbit.group_state(p_group, p_child, p_day);
  if (s->>'total')::int > 0 and (s->>'approved')::int >= (s->>'need')::int and (s->>'mandatory_left')::int = 0 then
    mins := case when g.reward_mode = 'all' then (s->>'all_minutes')::int else (s->>'held_minutes')::int end;
    gid := orbit.insert_group_grant(g, p_child, mins, g.name, false);
    update orbit.task_runs r set grant_id = gid
      from orbit.tasks t where t.id = r.task_id and t.group_id = p_group and r.child_id = p_child and r.day = p_day and r.status = 'approved' and r.grant_id is null;
    update orbit.task_group_runs set status = 'met', grant_id = gid, settled_at = now() where group_id = p_group and child_id = p_child and day = p_day;
    insert into orbit.events (family_id, child_id, type, payload)
    values (g.family_id, p_child, 'task_group_met', jsonb_build_object('group_id', g.id, 'name', g.name, 'minutes', mins));
    return 'met';
  end if;
  if p_final then
    if g.fail_mode = 'vault' then
      gid := orbit.insert_group_grant(g, p_child, (s->>'held_minutes')::int, g.name || ' · koşul sağlanmadı', true);
    elsif g.fail_mode = 'penalty' and coalesce(g.penalty_minutes, 0) > 0 then
      gid := orbit.insert_group_grant(g, p_child, -g.penalty_minutes, 'Grup cezası: ' || g.name, false);
    end if;
    update orbit.task_group_runs set status = 'failed', grant_id = gid, settled_at = now() where group_id = p_group and child_id = p_child and day = p_day;
    insert into orbit.events (family_id, child_id, type, payload)
    values (g.family_id, p_child, 'task_group_failed', jsonb_build_object('group_id', g.id, 'name', g.name, 'fail_mode', g.fail_mode, 'held', (s->>'held_minutes')::int));
    return 'failed';
  end if;
  return 'open';
end; $$;

-- Görev çalıştırmalarını oluştur (gruptaki görevler grubun takvimine uyar)
create or replace function orbit.ensure_runs(p_child uuid, p_day date)
returns void language plpgsql security definer set search_path = '' as $$
declare t orbit.tasks; g orbit.task_groups;
begin
  for t in
    select * from orbit.tasks
    where active and group_id is null and p_child = any(child_ids)
      and start_date <= p_day and (end_date is null or end_date >= p_day)
  loop
    if t.recurrence = 'days' then
      if extract(isodow from p_day)::int = any(t.days) then
        insert into orbit.task_runs (task_id, child_id, day) values (t.id, p_child, p_day) on conflict do nothing;
      end if;
    else
      if not exists (select 1 from orbit.task_runs r where r.task_id = t.id and r.child_id = p_child) then
        insert into orbit.task_runs (task_id, child_id, day) values (t.id, p_child, greatest(t.start_date, p_day)) on conflict do nothing;
      end if;
    end if;
  end loop;
  for g in select * from orbit.task_groups where active and p_child = any(child_ids) loop
    if not orbit.group_on(g, p_day) then continue; end if;
    for t in select * from orbit.tasks where group_id = g.id and active loop
      if g.recurrence = 'once' then
        if not exists (select 1 from orbit.task_runs r where r.task_id = t.id and r.child_id = p_child and r.day = g.start_date) then
          insert into orbit.task_runs (task_id, child_id, day) values (t.id, p_child, g.start_date) on conflict do nothing;
        end if;
      else
        insert into orbit.task_runs (task_id, child_id, day) values (t.id, p_child, p_day) on conflict do nothing;
      end if;
    end loop;
  end loop;
end; $$;

-- Süresi geçenleri kapat; grup dönemi bitenleri sonuçlandır
create or replace function orbit.expire_runs(p_today date)
returns void language plpgsql security definer set search_path = '' as $$
declare r orbit.task_runs; t orbit.tasks; mins int; validity text; v_on date; exp date; x record;
  nowt time := (now() at time zone 'Europe/Berlin')::time;
begin
  for r in
    select r2 from orbit.task_runs r2
      join orbit.tasks t2 on t2.id = r2.task_id
      left join orbit.task_groups g2 on g2.id = t2.group_id
     where r2.status in ('open', 'started', 'rejected') and (
       (g2.id is null and (
          (t2.recurrence = 'days' and r2.day < p_today)
          or (t2.recurrence = 'once' and coalesce(t2.due_date, t2.end_date) is not null and coalesce(t2.due_date, t2.end_date) < p_today)
          or (t2.due_time is not null and coalesce(t2.due_date, t2.end_date, r2.day) = p_today and t2.due_time <= nowt)))
       or (g2.id is not null and (
          (g2.recurrence <> 'once' and r2.day < p_today)
          or (g2.recurrence = 'once' and g2.end_date is not null and g2.end_date < p_today)
          or (g2.due_time is not null and (case when g2.recurrence = 'once' then coalesce(g2.end_date, g2.start_date) else r2.day end) = p_today and g2.due_time <= nowt)))
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
    update orbit.task_runs set status = 'expired' where id = r.id;
  end loop;

  -- Dönemi biten grupları sonuçlandır (onay bekleyen görev varsa bekle)
  for x in
    select distinct tt.group_id, rr.child_id, rr.day
      from orbit.task_runs rr
      join orbit.tasks tt on tt.id = rr.task_id
      join orbit.task_groups gg on gg.id = tt.group_id
     where not exists (select 1 from orbit.task_group_runs gr where gr.group_id = tt.group_id and gr.child_id = rr.child_id and gr.day = rr.day and gr.status <> 'open')
       and (
         (gg.recurrence <> 'once' and rr.day < p_today)
         or (gg.recurrence = 'once' and gg.end_date is not null and gg.end_date < p_today)
         or (gg.due_time is not null and (case when gg.recurrence = 'once' then coalesce(gg.end_date, gg.start_date) else rr.day end) = p_today and gg.due_time <= nowt))
       and rr.day >= p_today - 14
  loop
    if not exists (select 1 from orbit.task_runs r3 join orbit.tasks t3 on t3.id = r3.task_id
                    where t3.group_id = x.group_id and r3.child_id = x.child_id and r3.day = x.day and r3.status = 'submitted') then
      perform orbit.group_settle(x.group_id, x.child_id, x.day, true);
    end if;
  end loop;
end; $$;

-- Çocuk teslim ederken sıra kilidi
create or replace function orbit.device_submit_run(p_run uuid)
returns text language plpgsql security definer set search_path = '' as $$
declare
  dev orbit.devices := orbit.current_device();
  r orbit.task_runs; t orbit.tasks;
  before_count int; after_count int; before_min int; after_min int;
begin
  if dev.id is null or dev.kind <> 'child_phone' then raise exception 'not_allowed'; end if;
  select * into r from orbit.task_runs where id = p_run and child_id = dev.child_id;
  if r.id is null then raise exception 'not_allowed'; end if;
  if r.status not in ('open', 'started', 'rejected') then raise exception 'not_open'; end if;
  if orbit.run_locked(r.id) then raise exception 'locked'; end if;
  select * into t from orbit.tasks where id = r.task_id;
  if t.proof <> 'none' then
    select count(*) into before_count from orbit.task_proofs where run_id = r.id and removed_at is null and stage = 'before';
    select count(*) into after_count from orbit.task_proofs where run_id = r.id and attempt = r.attempts and removed_at is null and stage in ('after', 'single');
    before_min := greatest(coalesce(t.proof_before_min, 0), case when t.before_after then 1 else 0 end);
    after_min := greatest(coalesce(t.proof_after_min, 1), 1);
    if after_count < after_min or before_count < before_min then raise exception 'proof_missing'; end if;
  end if;
  if t.record_minutes is not null and not exists (
    select 1 from orbit.task_recordings where run_id = r.id and attempt = r.attempts and status = 'done') then
    raise exception 'recording_missing';
  end if;
  update orbit.task_runs set status = 'submitted', submitted_at = now() where id = r.id;
  insert into orbit.events (family_id, child_id, type, payload)
  values (dev.family_id, dev.child_id, 'task_submitted', jsonb_build_object('run_id', r.id, 'title', t.title));
  return 'submitted';
end; $$;

-- Ebeveyn onayı: gruptaysa süre koşul sağlanana kadar tutulur; ajandadaki girdi yapıldı olur
create or replace function orbit.parent_decide_run(p_run uuid, p_approve boolean, p_note text, p_minutes integer default null, p_validity text default null, p_date date default null, p_expires date default null)
returns text[] language plpgsql security definer set search_path = '' as $$
declare
  fam uuid := orbit.parent_family();
  r orbit.task_runs; t orbit.tasks; g orbit.task_groups;
  mins int; validity text; v_on date; exp date;
  today date := (now() at time zone 'Europe/Berlin')::date;
  gid uuid; paths text[] := '{}'; keep int; gst text;
begin
  if fam is null then raise exception 'not_allowed'; end if;
  select r2.* into r from orbit.task_runs r2 join orbit.tasks t2 on t2.id = r2.task_id where r2.id = p_run and t2.family_id = fam;
  if r.id is null then raise exception 'not_allowed'; end if;
  select * into t from orbit.tasks where id = r.task_id;
  if t.group_id is not null then select * into g from orbit.task_groups where id = t.group_id; end if;

  if p_approve then
    mins := coalesce(p_minutes, t.reward_minutes);
    validity := coalesce(p_validity, t.reward_validity);
    if g.id is not null then
      select status into gst from orbit.task_group_runs where group_id = g.id and child_id = r.child_id and day = r.day;
      -- koşul sağlandıysa ve kural "yaptığı görevler" ise bu görevin süresi hemen eklenir
      if gst = 'met' and g.reward_mode = 'done' and coalesce(mins, 0) > 0 then
        gid := orbit.insert_group_grant(g, r.child_id, mins, t.title, false);
      end if;
    elsif mins is not null and mins > 0 then
      v_on := case validity when 'today' then today when 'tomorrow' then today + 1 when 'date' then coalesce(p_date, t.reward_date, today) else null end;
      exp := case when validity = 'wallet' then coalesce(p_expires, case when t.reward_expires_days is not null then today + t.reward_expires_days end) end;
      insert into orbit.time_grants (child_id, minutes, valid_on, expires_on, source, note, created_by, task_run_id)
      values (r.child_id, mins, v_on, exp, 'task', t.title, auth.uid(), r.id)
      returning id into gid;
    end if;
    update orbit.task_runs
       set status = 'approved', decided_at = now(), decided_by = auth.uid(), reject_note = null,
           granted_minutes = mins, grant_id = gid, reward_text = t.reward_text
     where id = r.id;
    if t.assign_mode = 'first' then
      update orbit.task_runs set status = 'claimed'
       where task_id = t.id and id <> r.id and day = r.day and status in ('open', 'started', 'rejected', 'submitted');
    end if;
    update orbit.agenda_items set status = 'done', completed_at = now(), updated_at = now()
     where task_id = t.id and child_id = r.child_id and status <> 'done';
    if g.id is not null then perform orbit.group_settle(g.id, r.child_id, r.day, false); end if;
    select proof_retention_days into keep from orbit.families where id = fam;
    if coalesce(keep, 0) = 0 then
      select coalesce(array_agg(path), '{}') into paths from orbit.task_proofs where run_id = r.id and removed_at is null;
      update orbit.task_proofs set removed_at = now() where run_id = r.id and removed_at is null;
    else
      update orbit.task_proofs set delete_after = now() + make_interval(days => keep) where run_id = r.id and removed_at is null;
    end if;
  else
    insert into orbit.task_run_notes (run_id, attempt, note, created_by)
    values (r.id, r.attempts, nullif(trim(coalesce(p_note, '')), ''), auth.uid());
    update orbit.task_runs
       set status = 'rejected', decided_at = now(), decided_by = auth.uid(), reject_note = nullif(trim(coalesce(p_note, '')), ''),
           attempts = attempts + 1
     where id = r.id;
  end if;
  return paths;
end; $$;

-- Telefonun görev listesi: grup bilgisi, kilit, ajanda bağlantısı
create or replace function orbit.device_tasks(p_day date)
returns jsonb language plpgsql security definer set search_path = '' as $$
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
    'reward_minutes', t.reward_minutes, 'reward_text', t.reward_text, 'reward_validity', coalesce(g.reward_validity, t.reward_validity), 'reward_date', t.reward_date,
    'mandatory', t.mandatory, 'due_time', coalesce(g.due_time, t.due_time),
    'due_date', case when g.id is null then coalesce(t.due_date, t.end_date) when g.recurrence = 'once' then g.end_date else r.day end,
    'assign_mode', t.assign_mode, 'attempts', r.attempts, 'created_at', r.created_at,
    'record_minutes', t.record_minutes, 'record_camera', t.record_camera, 'record_pause', t.record_pause, 'record_pause_max', t.record_pause_max,
    'recording', (select jsonb_build_object('id', x.id, 'status', x.status, 'recorded_seconds', x.recorded_seconds, 'paused_seconds', x.paused_seconds, 'pause_count', x.pause_count, 'camera', x.camera)
                    from orbit.task_recordings x where x.run_id = r.id and x.attempt = r.attempts and x.status <> 'cancelled' order by x.started_at desc limit 1),
    'proofs', (select coalesce(jsonb_agg(jsonb_build_object('stage', p.stage, 'media', p.media)), '[]'::jsonb)
                 from orbit.task_proofs p where p.run_id = r.id and p.removed_at is null and p.stage <> 'record' and (p.stage = 'before' or p.attempt = r.attempts)),
    'group_id', g.id, 'group_name', g.name, 'group_order', t.group_order, 'sequential', coalesce(g.sequential, false),
    'locked', case when g.sequential then orbit.run_locked(r.id) else false end,
    'group', case when g.id is not null then orbit.group_state(g.id, r.child_id, r.day) end,
    'agenda_item_id', (select a.id from orbit.agenda_items a where a.task_id = t.id and a.child_id = r.child_id limit 1)
  ) order by g.sort nulls last, g.id nulls last, t.group_order, t.mandatory desc, t.due_time nulls last, t.created_at)
  from orbit.task_runs r
  join orbit.tasks t on t.id = r.task_id
  left join orbit.task_groups g on g.id = t.group_id
  where r.child_id = child and (r.day = p_day
    or ((t.recurrence = 'once' and t.group_id is null or g.recurrence = 'once') and r.status in ('open', 'started', 'submitted', 'rejected'))
    or (r.day >= p_day - 1 and r.status in ('approved', 'rejected', 'submitted')))), '[]'::jsonb);
end; $$;

revoke execute on function orbit.group_state(uuid, uuid, date), orbit.run_locked(uuid) from public, anon, authenticated;
revoke execute on function orbit.group_settle(uuid, uuid, date, boolean) from public, anon, authenticated;
revoke execute on function orbit.insert_group_grant(orbit.task_groups, uuid, int, text, boolean) from public, anon, authenticated;
