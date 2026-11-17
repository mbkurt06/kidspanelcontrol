-- Bekleyen görev süresi: ebeveyn elle kullandırır, cüzdana / kasaya koyar ya da kaldırır
create or replace function orbit.parent_release_held(p_run uuid, p_target text) returns uuid
language plpgsql security definer set search_path to '' as $$
declare r orbit.task_runs; t orbit.tasks; g orbit.task_groups; gid uuid; mins int; nm text;
begin
  select * into r from orbit.task_runs where id = p_run for update;
  select * into t from orbit.tasks where id = r.task_id;
  if t.id is null or t.family_id <> orbit.parent_family() then raise exception 'not_allowed'; end if;
  if r.status <> 'approved' or r.grant_id is not null then return null; end if;
  if p_target = 'drop' then
    update orbit.task_runs set granted_minutes = 0 where id = r.id;
    return null;
  end if;
  select * into g from orbit.task_groups where id = t.group_id;
  mins := greatest(coalesce(r.granted_minutes, t.reward_minutes, 0), 0);
  if mins = 0 then return null; end if;
  nm := coalesce(g.name || ' · ', '') || t.title;
  perform set_config('orbit.grant_bypass', '1', true);
  if p_target = 'use' then
    gid := orbit.give_time(r.child_id, mins, 'usage', null, nm, 'task', auth.uid(), true);
  elsif p_target in ('wallet', 'vault') then
    insert into orbit.time_grants (child_id, minutes, valid_on, source, note, created_by, vault)
    values (r.child_id, mins, null, 'task', nm || case when p_target = 'vault' then ' · kasaya' else ' · cüzdana' end, auth.uid(), p_target = 'vault')
    returning id into gid;
  else
    raise exception 'bad_target';
  end if;
  update orbit.time_grants set task_run_id = r.id where id = gid;
  update orbit.task_runs set grant_id = gid where id = r.id;
  perform set_config('orbit.grant_bypass', '', true);
  return gid;
end $$;
grant execute on function orbit.parent_release_held(uuid, text) to authenticated;
