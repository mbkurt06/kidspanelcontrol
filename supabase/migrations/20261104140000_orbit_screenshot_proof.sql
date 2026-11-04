-- Kanıt: ekran görüntüsü (en az / en fazla)
alter table orbit.tasks add column if not exists screenshot_min int check (screenshot_min is null or screenshot_min between 1 and 10);
alter table orbit.tasks add column if not exists screenshot_max int check (screenshot_max is null or screenshot_max between 1 and 10);
alter table orbit.task_templates add column if not exists screenshot_min int;
alter table orbit.task_templates add column if not exists screenshot_max int;
alter table orbit.task_proofs drop constraint if exists task_proofs_stage_check;
alter table orbit.task_proofs add constraint task_proofs_stage_check check (stage in ('before', 'after', 'single', 'record', 'screenshot'));

create or replace function orbit.device_add_proof(p_run uuid, p_stage text, p_media text, p_path text)
returns void language plpgsql security definer set search_path = '' as $$
declare
  dev orbit.devices := orbit.current_device();
  r orbit.task_runs; t orbit.tasks; n int; max_count int;
begin
  if dev.id is null or dev.kind <> 'child_phone' then raise exception 'not_allowed'; end if;
  select * into r from orbit.task_runs where id = p_run and child_id = dev.child_id;
  if r.id is null then raise exception 'not_allowed'; end if;
  if r.status not in ('open', 'started', 'rejected') then raise exception 'not_open'; end if;
  select * into t from orbit.tasks where id = r.task_id;
  if p_path not like dev.family_id::text || '/' || p_run::text || '/%' then raise exception 'bad_path'; end if;
  if p_stage not in ('before', 'after', 'single', 'screenshot') then raise exception 'bad_stage'; end if;
  if p_stage = 'before' and coalesce(t.proof_before_min, 0) = 0 then raise exception 'proof_stage_not_allowed'; end if;
  if p_stage = 'screenshot' and t.screenshot_min is null then raise exception 'proof_stage_not_allowed'; end if;
  select count(*) into n
    from orbit.task_proofs
   where run_id = r.id and removed_at is null
     and (p_stage = 'before' and stage = 'before'
          or p_stage in ('after', 'single') and attempt = r.attempts and stage in ('after', 'single')
          or p_stage = 'screenshot' and attempt = r.attempts and stage = 'screenshot');
  max_count := case when p_stage = 'before' then coalesce(t.proof_before_max, 4)
                    when p_stage = 'screenshot' then coalesce(t.screenshot_max, t.screenshot_min, 4)
                    else coalesce(t.proof_after_max, 4) end;
  if n >= max_count then raise exception 'proof_limit'; end if;
  insert into orbit.task_proofs (run_id, child_id, family_id, stage, media, path, attempt)
  values (p_run, dev.child_id, dev.family_id, p_stage, p_media, p_path, r.attempts);
  if p_stage = 'before' and r.status in ('open', 'rejected') then
    update orbit.task_runs set status = 'started' where id = p_run;
  end if;
end; $$;

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
  if t.record_min_minutes is not null and coalesce((select max(recorded_seconds) from orbit.task_recordings where run_id = r.id and attempt = r.attempts and status = 'done'), 0) < t.record_min_minutes * 60 then
    raise exception 'recording_short';
  end if;
  if t.screenshot_min is not null and (select count(*) from orbit.task_proofs where run_id = r.id and attempt = r.attempts and removed_at is null and stage = 'screenshot') < t.screenshot_min then
    raise exception 'screenshot_missing';
  end if;
  update orbit.task_runs set status = 'submitted', submitted_at = now() where id = r.id;
  insert into orbit.events (family_id, child_id, type, payload)
  values (dev.family_id, dev.child_id, 'task_submitted', jsonb_build_object('run_id', r.id, 'title', t.title));
  return 'submitted';
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
    'record_minutes', t.record_minutes, 'record_min_minutes', t.record_min_minutes, 'screenshot_min', t.screenshot_min, 'screenshot_max', t.screenshot_max, 'record_camera', t.record_camera, 'record_pause', t.record_pause, 'record_pause_max', t.record_pause_max,
    'recording', (select jsonb_build_object('id', x.id, 'status', x.status, 'recorded_seconds', x.recorded_seconds, 'paused_seconds', x.paused_seconds, 'pause_count', x.pause_count, 'camera', x.camera)
                    from orbit.task_recordings x where x.run_id = r.id and x.attempt = r.attempts and x.status <> 'cancelled' order by x.started_at desc limit 1),
    'proofs', (select coalesce(jsonb_agg(jsonb_build_object('stage', p.stage, 'media', p.media)), '[]'::jsonb)
                 from orbit.task_proofs p where p.run_id = r.id and p.removed_at is null and p.stage <> 'record' and (p.stage = 'before' or p.attempt = r.attempts)),
    'group_id', g.id, 'group_name', g.name, 'group_order', t.group_order, 'sequential', coalesce(g.sequential, false),
    'locked', case when g.id is not null then orbit.run_locked(r.id) else false end, 'start_time', g.start_time,
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

