-- Görev onaylanana kadar uygulanacak bağımsız telefon ve Orbit kısıtları.
alter table orbit.tasks
  add column if not exists phone_restriction text not null default 'none'
    check (phone_restriction in ('none', 'limit', 'kiosk'));

alter table orbit.tasks
  add column if not exists orbit_focus_profile_id uuid references orbit.focus_profiles(id) on delete set null;

-- Telefon görev paketine kısıt ayarlarını ekle; eski görevler none ile aynı davranışı korur.
create or replace function orbit.device_tasks(p_day date)
returns jsonb
language plpgsql volatile security definer set search_path = ''
as $$
declare child uuid := orbit.device_child();
begin
  if child is null then raise exception 'not_allowed'; end if;
  perform orbit.expire_runs(p_day);
  perform orbit.ensure_runs(child, p_day);
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'run_id', r.id, 'task_id', t.id, 'day', r.day, 'status', r.status, 'reject_note', r.reject_note,
      'title', t.title, 'description', t.description, 'proof', t.proof, 'before_after', t.before_after,
      'reward_minutes', t.reward_minutes, 'reward_text', t.reward_text, 'reward_validity', t.reward_validity,
      'reward_date', t.reward_date, 'mandatory', t.mandatory, 'due_time', t.due_time, 'due_date', coalesce(t.due_date, t.end_date),
      'assign_mode', t.assign_mode, 'attempts', r.attempts, 'created_at', r.created_at,
      'phone_restriction', t.phone_restriction, 'orbit_focus_profile_id', t.orbit_focus_profile_id,
      'record_minutes', t.record_minutes, 'record_camera', t.record_camera, 'record_pause', t.record_pause,
      'record_pause_max', t.record_pause_max,
      'recording', (select jsonb_build_object('id', x.id, 'status', x.status, 'recorded_seconds', x.recorded_seconds,
                                              'paused_seconds', x.paused_seconds, 'pause_count', x.pause_count, 'camera', x.camera)
                    from orbit.task_recordings x where x.run_id = r.id and x.attempt = r.attempts and x.status <> 'cancelled'
                    order by x.started_at desc limit 1),
      'proofs', (select coalesce(jsonb_agg(jsonb_build_object('stage', p.stage, 'media', p.media)), '[]'::jsonb)
                 from orbit.task_proofs p where p.run_id = r.id and p.removed_at is null and p.stage <> 'record'
                   and (p.stage = 'before' or p.attempt = r.attempts))
    ) order by t.mandatory desc, t.due_time nulls last, t.created_at)
    from orbit.task_runs r join orbit.tasks t on t.id = r.task_id
    where r.child_id = child
      and (r.day = p_day
           or (t.recurrence = 'once' and r.status in ('open', 'started', 'submitted', 'rejected'))
           or (r.day >= p_day - 1 and r.status in ('approved', 'rejected', 'submitted')))
  ), '[]'::jsonb);
end;
$$;
