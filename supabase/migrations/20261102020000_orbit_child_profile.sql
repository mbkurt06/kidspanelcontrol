alter table orbit.children add column if not exists profile_nickname text check (profile_nickname is null or length(trim(profile_nickname)) between 1 and 60);
alter table orbit.children add column if not exists profile_avatar text check (profile_avatar is null or length(profile_avatar) between 1 and 8);

create or replace function orbit.guard_phone_child_profile()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.id = orbit.device_child() and
     (to_jsonb(new) - array['profile_nickname', 'profile_avatar']::text[]) is distinct from
     (to_jsonb(old) - array['profile_nickname', 'profile_avatar']::text[]) then
    raise exception 'not_allowed';
  end if;
  return new;
end;
$$;

drop trigger if exists guard_phone_child_profile on orbit.children;
create trigger guard_phone_child_profile before update on orbit.children
  for each row execute function orbit.guard_phone_child_profile();

create policy phone_profile_update on orbit.children for update to authenticated
  using (id = orbit.device_child())
  with check (id = orbit.device_child() and family_id = orbit.device_family());
