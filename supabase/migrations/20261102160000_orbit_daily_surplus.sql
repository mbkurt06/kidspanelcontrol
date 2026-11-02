-- Gün sonunda kullanılmayan günlük hakkı süre kasasına aktar.
alter table orbit.time_grants drop constraint if exists time_grants_source_check;
alter table orbit.time_grants add constraint time_grants_source_check
  check (source in ('manual','task','task_penalty','daily_surplus'));

create unique index if not exists daily_surplus_once
  on orbit.time_grants(child_id, source, note)
  where source = 'daily_surplus';

create or replace function orbit.device_store_daily_surplus(p_day date, p_minutes int)
returns void language plpgsql volatile security definer set search_path = ''
as $$
declare c uuid := orbit.device_child();
begin
  if c is null then raise exception 'not_device'; end if;
  if p_day is null or p_minutes is null or p_minutes <= 0 then return; end if;
  perform set_config('orbit.grant_bypass','1',true);
  insert into orbit.time_grants(child_id, minutes, valid_on, expires_on, source, note, created_by, vault)
  values (c, p_minutes, null, null, 'daily_surplus', 'Günlük artan süre · ' || p_day::text, null, true)
  on conflict (child_id, source, note) where source = 'daily_surplus' do nothing;
  perform set_config('orbit.grant_bypass','',true);
end;
$$;

revoke all on function orbit.device_store_daily_surplus(date, int) from public, anon;
grant execute on function orbit.device_store_daily_surplus(date, int) to authenticated;
