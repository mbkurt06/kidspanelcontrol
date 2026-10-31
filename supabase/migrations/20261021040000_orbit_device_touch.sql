-- Noor tableti (sadece okuyan cihaz) son görülme zamanını bildirir.
create or replace function orbit.device_touch(p_app_version text default null)
returns void
language sql volatile security definer set search_path = ''
as $$
  update orbit.devices set last_seen_at = now(), app_version = coalesce(p_app_version, app_version)
  where auth_user_id = auth.uid() and status = 'active';
$$;
revoke all on function orbit.device_touch(text) from public, anon;
grant execute on function orbit.device_touch(text) to authenticated;
