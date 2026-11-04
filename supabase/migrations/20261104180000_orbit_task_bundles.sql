-- Bağlı görevler: bir grubun içinde birlikte açılan görev kümeleri (bağlar)
-- bundles = [{"tasks": [task_id, ...]}, ...] sıralı; zorunlu bağlar seçmelilerden önce (panel sıralar)
-- Bir bağın süresi, içindeki görevlerin hepsi onaylanınca birlikte açılır.
-- bundles_sequential: her bağ, kendinden önceki bağların hepsi bitince açılır (görevler yine yapılabilir, puan bekler).
-- Seçmeli bağlar ve bağsız seçmeliler: bütün zorunlular bitince açılır. Bağsız zorunlu: onaylanınca hemen.

alter table orbit.task_groups add column if not exists bundles jsonb not null default '[]';
alter table orbit.task_groups add column if not exists bundles_sequential boolean not null default true;

create or replace function orbit.bundle_ids(b jsonb) returns uuid[] language sql immutable set search_path = '' as $$
  select coalesce(array_agg(x::uuid), '{}') from jsonb_array_elements_text(coalesce(b->'tasks', '[]')) x
$$;

/** Bağdaki bütün (bugün koşusu olan) görevler onaylandı mı */
create or replace function orbit.bundle_done(p_ids uuid[], p_child uuid, p_day date) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce(bool_and(r.status = 'approved'), true)
    from orbit.task_runs r join orbit.tasks t on t.id = r.task_id
   where r.task_id = any(p_ids) and r.child_id = p_child and r.day = p_day and r.status <> 'claimed' and t.active
$$;

/** Belirli görevlerin bekleyen (onaylı, verilmemiş) süresini ver */
create or replace function orbit.group_release_tasks(g orbit.task_groups, p_child uuid, p_day date, p_ids uuid[], p_note text)
returns int language plpgsql security definer set search_path = '' as $$
declare total int; gid uuid; n int;
begin
  select coalesce(sum(greatest(coalesce(r.granted_minutes, t.reward_minutes, 0), 0)), 0), count(*) into total, n
    from orbit.task_runs r join orbit.tasks t on t.id = r.task_id
   where r.task_id = any(p_ids) and r.child_id = p_child and r.day = p_day and r.status = 'approved' and r.grant_id is null;
  if n = 0 then return 0; end if;
  if total > 0 then
    gid := orbit.insert_group_grant(g, p_child, total, p_note, false);
    update orbit.task_runs set grant_id = gid
     where task_id = any(p_ids) and child_id = p_child and day = p_day and status = 'approved' and grant_id is null and gid is not null;
  end if;
  return n;
end; $$;

/** Bağlara göre bekleyen süreleri aç */
create or replace function orbit.group_release_bundles(g orbit.task_groups, p_child uuid, p_day date, p_mand_left int)
returns void language plpgsql security definer set search_path = '' as $$
declare i int; b jsonb; ids uuid[]; all_ids uuid[] := '{}'; done boolean; opt boolean; ready boolean := true; rr record;
begin
  for i in 0 .. jsonb_array_length(g.bundles) - 1 loop
    b := g.bundles->i;
    ids := orbit.bundle_ids(b);
    all_ids := all_ids || ids;
    done := orbit.bundle_done(ids, p_child, p_day);
    opt := not exists (select 1 from orbit.tasks t where t.id = any(ids) and t.mandatory);
    if done and (not g.bundles_sequential or ready) and (not opt or p_mand_left = 0) then
      perform orbit.group_release_tasks(g, p_child, p_day, ids,
        g.name || ' · ' || (i + 1)::text || '. bağ');
    end if;
    if not done then ready := false; end if;
  end loop;
  -- Bağsız zorunlu: kendi süresi hemen; bağsız seçmeli: zorunlular bitince
  for rr in
    select r.task_id, t.title, t.mandatory
      from orbit.task_runs r join orbit.tasks t on t.id = r.task_id
     where t.group_id = g.id and r.child_id = p_child and r.day = p_day and r.status = 'approved' and r.grant_id is null
       and not (t.id = any(all_ids))
  loop
    if rr.mandatory or p_mand_left = 0 then
      perform orbit.group_release_tasks(g, p_child, p_day, array[rr.task_id], g.name || ' · ' || rr.title);
    end if;
  end loop;
end; $$;

/** Telefon için: görevin bağ bilgisi */
create or replace function orbit.bundle_info(p_group uuid, p_task uuid, p_child uuid, p_day date)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare g orbit.task_groups; i int; b jsonb; ids uuid[]; done boolean; ready boolean := true; cur int := null; res jsonb := null; mins int; held int; opt boolean;
begin
  select * into g from orbit.task_groups where id = p_group;
  if g.id is null or jsonb_array_length(g.bundles) = 0 then return null; end if;
  for i in 0 .. jsonb_array_length(g.bundles) - 1 loop
    b := g.bundles->i;
    ids := orbit.bundle_ids(b);
    done := orbit.bundle_done(ids, p_child, p_day);
    if not done and cur is null then cur := i; end if;
    if p_task = any(ids) then
      select coalesce(sum(greatest(coalesce(t.reward_minutes, 0), 0)), 0) into mins from orbit.tasks t where t.id = any(ids) and t.active;
      select coalesce(sum(greatest(coalesce(r.granted_minutes, t.reward_minutes, 0), 0)), 0) into held
        from orbit.task_runs r join orbit.tasks t on t.id = r.task_id
       where r.task_id = any(ids) and r.child_id = p_child and r.day = p_day and r.status = 'approved' and r.grant_id is null;
      opt := not exists (select 1 from orbit.tasks t where t.id = any(ids) and t.mandatory);
      res := jsonb_build_object('pos', i + 1, 'size', cardinality(ids), 'done', done, 'ready', (not g.bundles_sequential) or ready,
        'minutes', mins, 'held', held, 'optional', opt, 'sequential', g.bundles_sequential);
    end if;
    if not done then ready := false; end if;
  end loop;
  if res is not null then res := res || jsonb_build_object('current', coalesce(cur, -1) + 1 = (res->>'pos')::int); end if;
  return res;
end; $$;

create or replace function orbit.bundle_pos(g_bundles jsonb, p_task uuid) returns int
language sql immutable set search_path = '' as $$
  select min(o)::int from jsonb_array_elements(coalesce(g_bundles, '[]')) with ordinality as e(b, o)
   where p_task::text in (select jsonb_array_elements_text(e.b->'tasks'))
$$;

create or replace function orbit.group_settle(p_group uuid, p_child uuid, p_day date, p_final boolean)
returns text language plpgsql security definer set search_path = '' as $$
declare g orbit.task_groups; s jsonb; gr orbit.task_group_runs; gid uuid; mins int; met boolean; given int;
begin
  select * into g from orbit.task_groups where id = p_group;
  if g.id is null then return null; end if;
  insert into orbit.task_group_runs (group_id, child_id, day) values (p_group, p_child, p_day) on conflict do nothing;
  select * into gr from orbit.task_group_runs where group_id = p_group and child_id = p_child and day = p_day for update;
  if gr.status = 'failed' then return gr.status; end if;
  s := orbit.group_state(p_group, p_child, p_day);
  met := (s->>'total')::int > 0 and (s->>'approved')::int >= (s->>'need')::int and (s->>'mandatory_left')::int = 0;

  if (not p_final or gr.status = 'met') and jsonb_array_length(coalesce(g.bundles, '[]')) > 0 then
    perform orbit.group_release_bundles(g, p_child, p_day, (s->>'mandatory_left')::int);
  elsif not p_final or gr.status = 'met' then
    -- (a) her zorunlu görev onaylanınca kendi süresi hemen; seçmeliler zorunlular bitince
    if g.mandatory_release = 'each' then
      perform orbit.group_release(g, p_child, p_day, true);
      if (s->>'mandatory_left')::int = 0 then perform orbit.group_release(g, p_child, p_day, false); end if;
    -- (b) koşul sağlanınca hepsi birlikte
    elsif met then
      perform orbit.group_release(g, p_child, p_day, false);
    end if;
  end if;

  if gr.status = 'open' and met then
    if g.reward_mode = 'all' then
      select coalesce(sum(greatest(coalesce(r.granted_minutes, 0), 0)), 0) into given
        from orbit.task_runs r join orbit.tasks t on t.id = r.task_id
       where t.group_id = p_group and r.child_id = p_child and r.day = p_day and r.status = 'approved';
      mins := (s->>'all_minutes')::int - given;
      if mins > 0 then gid := orbit.insert_group_grant(g, p_child, mins, g.name || ' · tamamlama ödülü', false); end if;
    end if;
    update orbit.task_group_runs set status = 'met', grant_id = gid, settled_at = now() where group_id = p_group and child_id = p_child and day = p_day;
    insert into orbit.events (family_id, child_id, type, payload)
    values (g.family_id, p_child, 'task_group_met', jsonb_build_object('group_id', g.id, 'name', g.name));
    return 'met';
  end if;

  if p_final and gr.status = 'open' then
    s := orbit.group_state(p_group, p_child, p_day);
    if g.fail_mode = 'vault' then
      gid := orbit.insert_group_grant(g, p_child, (s->>'held_minutes')::int, g.name || ' · koşul sağlanmadı', true);
    elsif g.fail_mode = 'penalty' and coalesce(g.penalty_minutes, 0) > 0 then
      gid := orbit.insert_group_grant(g, p_child, -g.penalty_minutes, 'Grup cezası: ' || g.name, false);
    end if;
    update orbit.task_runs r set grant_id = gid
      from orbit.tasks t where t.id = r.task_id and t.group_id = p_group and r.child_id = p_child and r.day = p_day and r.status = 'approved' and r.grant_id is null and gid is not null;
    update orbit.task_group_runs set status = 'failed', grant_id = gid, settled_at = now() where group_id = p_group and child_id = p_child and day = p_day;
    insert into orbit.events (family_id, child_id, type, payload)
    values (g.family_id, p_child, 'task_group_failed', jsonb_build_object('group_id', g.id, 'name', g.name, 'fail_mode', g.fail_mode, 'held', (s->>'held_minutes')::int));
    return 'failed';
  end if;
  return gr.status;
end; $$;


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
    'record_minutes', t.record_minutes, 'record_min_minutes', t.record_min_minutes, 'screenshot_min', t.screenshot_min, 'screenshot_max', t.screenshot_max, 'screen_record_minutes', t.screen_record_minutes, 'screen_record_min_minutes', t.screen_record_min_minutes, 'allowed_packages', to_jsonb(t.allowed_packages), 'record_camera', t.record_camera, 'record_pause', t.record_pause, 'record_pause_max', t.record_pause_max,
    'recording', (select jsonb_build_object('id', x.id, 'status', x.status, 'recorded_seconds', x.recorded_seconds, 'paused_seconds', x.paused_seconds, 'pause_count', x.pause_count, 'camera', x.camera)
                    from orbit.task_recordings x where x.run_id = r.id and x.attempt = r.attempts and x.status <> 'cancelled' and x.camera <> 'screen' order by x.started_at desc limit 1),
    'screen_recording', (select jsonb_build_object('id', x.id, 'status', x.status, 'recorded_seconds', x.recorded_seconds) from orbit.task_recordings x where x.run_id = r.id and x.attempt = r.attempts and x.status <> 'cancelled' and x.camera = 'screen' order by x.started_at desc limit 1),
    'proofs', (select coalesce(jsonb_agg(jsonb_build_object('stage', p.stage, 'media', p.media)), '[]'::jsonb)
                 from orbit.task_proofs p where p.run_id = r.id and p.removed_at is null and p.stage <> 'record' and (p.stage = 'before' or p.attempt = r.attempts)),
    'group_id', g.id, 'group_name', g.name, 'group_order', t.group_order, 'sequential', coalesce(g.sequential, false),
    'locked', case when g.id is not null then orbit.run_locked(r.id) else false end, 'start_time', g.start_time,
    'group', case when g.id is not null then orbit.group_state(g.id, r.child_id, r.day) end,
    'agenda_item_id', (select a.id from orbit.agenda_items a where a.task_id = t.id and a.child_id = r.child_id limit 1)
  ) || jsonb_build_object('allowed_mode', t.allowed_mode,
       'start_date', t.start_date, 'end_date', t.end_date, 'recurrence', t.recurrence,
       'window_start', coalesce(g.start_time, f.open_start), 'window_end', coalesce(g.due_time, t.due_time, f.open_end),
       'restriction', case when g.id is null or t.mandatory then t.phone_restriction else 'none' end,
       'restriction_mode_id', t.restriction_mode_id, 'restricted_allowed', t.restricted_allowed,
       'orbit_focus_profile_id', t.orbit_focus_profile_id,
       'bundle', case when g.id is not null then orbit.bundle_info(g.id, t.id, r.child_id, r.day) end)
  order by g.sort nulls last, g.id nulls last, orbit.bundle_pos(g.bundles, t.id) nulls last, t.group_order, t.mandatory desc, t.due_time nulls last, t.created_at)
  from orbit.task_runs r
  join orbit.tasks t on t.id = r.task_id
  left join orbit.task_groups g on g.id = t.group_id
  join orbit.families f on f.id = t.family_id
  where r.child_id = child and (r.day = p_day
    or ((t.recurrence = 'once' and t.group_id is null or g.recurrence = 'once') and r.status in ('open', 'started', 'submitted', 'rejected'))
    or (r.day >= p_day - 1 and r.status in ('approved', 'rejected', 'submitted')))), '[]'::jsonb);
end; $$;


