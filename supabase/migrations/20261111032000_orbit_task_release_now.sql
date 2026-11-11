-- Bekleyen görev süresini ebeveyn hemen açar ya da kasaya atar; kamera varsayılanı "çocuk seçsin".
alter table orbit.families add column if not exists task_record_camera text not null default 'choose';
alter table orbit.tasks alter column record_camera set default 'choose';

create or replace function orbit.parent_release_run(p_run uuid, p_vault boolean) returns uuid
language plpgsql security definer set search_path = '' as $$
declare r orbit.task_runs; t orbit.tasks; g orbit.task_groups; gid uuid; mins int;
begin
  select * into r from orbit.task_runs where id = p_run for update;
  select * into t from orbit.tasks where id = r.task_id;
  if t.id is null or t.family_id <> orbit.parent_family() then raise exception 'not_allowed'; end if;
  if r.status <> 'approved' or r.grant_id is not null then return null; end if;
  select * into g from orbit.task_groups where id = t.group_id;
  mins := greatest(coalesce(r.granted_minutes, t.reward_minutes, 0), 0);
  if mins = 0 then return null; end if;
  if p_vault then
    insert into orbit.time_grants (child_id, minutes, valid_on, source, note, created_by, vault, task_run_id)
    values (r.child_id, mins, null, 'task', coalesce(g.name || ' · ', '') || t.title || ' · kasaya', auth.uid(), true, r.id)
    returning id into gid;
  else
    gid := orbit.insert_task_grant(t, r.child_id, mins, coalesce(g.name || ' · ', '') || t.title, false);
    update orbit.time_grants set task_run_id = r.id where id = gid;
  end if;
  update orbit.task_runs set grant_id = gid where id = r.id;
  return gid;
end $$;
grant execute on function orbit.parent_release_run(uuid, boolean) to authenticated;
