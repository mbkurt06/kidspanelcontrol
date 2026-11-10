-- Telefon ayarları: panelden istenen (desired) ve telefonun bildirdiği güncel durum (reported).
-- Tek seferlik işler (uygulama kaldır, veriyi temizle, yeniden başlat, kilitle) komut olarak gider:
--   commands(type='resync', payload={"phone": {"action": "...", "package": "..."}})
create table if not exists orbit.device_settings (
  child_id uuid primary key references orbit.children(id) on delete cascade,
  family_id uuid not null references orbit.families(id) on delete cascade,
  desired jsonb not null default '{}'::jsonb,
  reported jsonb,
  reported_at timestamptz,
  updated_at timestamptz not null default now()
);
alter table orbit.device_settings enable row level security;
drop policy if exists parent_all on orbit.device_settings;
create policy parent_all on orbit.device_settings for all to authenticated
  using (family_id = orbit.parent_family()) with check (family_id = orbit.parent_family());
drop policy if exists phone_read on orbit.device_settings;
create policy phone_read on orbit.device_settings for select to authenticated
  using (child_id = orbit.device_child());
grant select, insert, update on orbit.device_settings to authenticated;

-- Panel değiştirince telefona haber gitsin (tek yayın kanalı)
drop trigger if exists rt_notify on orbit.device_settings;
create trigger rt_notify after insert or update of desired on orbit.device_settings
  for each row execute function orbit.rt_notify();

/** Telefon: güncel ayar durumunu bildirir (sadece değişince çağrılır). */
create or replace function orbit.device_report_settings(p_reported jsonb)
returns void language plpgsql security definer set search_path = '' as $$
declare dev orbit.devices := orbit.current_device();
begin
  if dev.id is null or dev.kind <> 'child_phone' then raise exception 'not_allowed'; end if;
  insert into orbit.device_settings (child_id, family_id, reported, reported_at)
  values (dev.child_id, dev.family_id, p_reported, now())
  on conflict (child_id) do update set reported = excluded.reported, reported_at = now();
end $$;
grant execute on function orbit.device_report_settings(jsonb) to authenticated;
