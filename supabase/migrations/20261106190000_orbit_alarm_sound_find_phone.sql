-- Alarm sesi (telefonun alarm sesleri / müzik), ses seviyesi, yavaş yükselme.
alter table orbit.alarms add column if not exists sound_uri text;
alter table orbit.alarms add column if not exists sound_title text;
alter table orbit.alarms add column if not exists volume int check (volume between 0 and 100);
alter table orbit.alarms add column if not exists ramp boolean not null default false;

-- Telefonun bildirdiği seçilebilir sesler (panelde alarm sesi seçmek için): [{uri,title,kind}]
alter table orbit.devices add column if not exists sounds jsonb;

create or replace function orbit.device_report_sounds(p_sounds jsonb)
returns void language plpgsql security definer set search_path = '' as $$
declare dev orbit.devices := orbit.current_device();
begin
  if dev.id is null or dev.kind <> 'child_phone' then raise exception 'not_allowed'; end if;
  update orbit.devices set sounds = p_sounds where id = dev.id;
end; $$;
grant execute on function orbit.device_report_sounds(jsonb) to authenticated;
-- Telefonu bul: komut "resync" + payload.find (eski sürümler yok sayar), durum "find_phone" olayıyla döner.
