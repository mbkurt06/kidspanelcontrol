-- İzinli uygulama davranışı: keep = o anki durumu koru (kısıtlıyken açık, serbestken dokunma), focus = görev sırasında sadece bunlar
alter table orbit.tasks add column if not exists allowed_mode text not null default 'keep' check (allowed_mode in ('keep', 'focus'));
alter table orbit.task_templates add column if not exists allowed_mode text not null default 'keep';

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
       'start_date', t.start_date, 'end_date', t.end_date, 'recurrence', t.recurrence)
  order by g.sort nulls last, g.id nulls last, t.group_order, t.mandatory desc, t.due_time nulls last, t.created_at)
  from orbit.task_runs r
  join orbit.tasks t on t.id = r.task_id
  left join orbit.task_groups g on g.id = t.group_id
  where r.child_id = child and (r.day = p_day
    or ((t.recurrence = 'once' and t.group_id is null or g.recurrence = 'once') and r.status in ('open', 'started', 'submitted', 'rejected'))
    or (r.day >= p_day - 1 and r.status in ('approved', 'rejected', 'submitted')))), '[]'::jsonb);
end; $$;

