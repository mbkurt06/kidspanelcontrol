alter table orbit.devices add column if not exists update_status text;
alter table orbit.devices add column if not exists update_target integer;
alter table orbit.devices add column if not exists update_checked_at timestamptz;
alter table orbit.devices add column if not exists update_error text;

alter table orbit.children drop constraint if exists children_profile_avatar_check;
alter table orbit.children add constraint children_profile_avatar_check check (
  profile_avatar is null
  or (profile_avatar like 'data:image/%;base64,%' and length(profile_avatar) <= 600000)
  or (profile_avatar not like 'data:image/%' and length(profile_avatar) between 1 and 8)
);
