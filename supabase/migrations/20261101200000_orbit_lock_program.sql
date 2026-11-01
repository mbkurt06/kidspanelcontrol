-- Kilit programı: Kilitle (tam kilit) / Sınırla (sadece her zaman açık uygulamalar) / Serbest,
-- tarih aralığı; aile ebeveyn PIN'i; ana sayfa kilit tuşu ayarı.

alter table orbit.time_rules drop constraint if exists time_rules_kind_check;
alter table orbit.time_rules add constraint time_rules_kind_check check (kind in ('kiosk', 'limit', 'free', 'music_off', 'music_on'));
alter table orbit.time_rules add column if not exists start_date date;
alter table orbit.time_rules add column if not exists end_date date;

-- Aile: tek ebeveyn PIN'i (sha256("orbit:<aile id>:<pin>")), PIN ile açık kalma süresi, ana sayfa kilit tuşu
alter table orbit.families add column if not exists parent_pin_hash text;
alter table orbit.families add column if not exists pin_unlock_minutes int not null default 15 check (pin_unlock_minutes between 1 and 240);
alter table orbit.families add column if not exists lock_button text not null default 'kiosk' check (lock_button in ('kiosk', 'limit', 'ask'));
-- null = ebeveyn kaldırana kadar
alter table orbit.families add column if not exists lock_button_minutes int check (lock_button_minutes is null or lock_button_minutes > 0);

-- "Kapalı" bölümü kilit programına taşınır: her gün 19:00–10:00 Sınırla
insert into orbit.time_rules (family_id, name, kind, start_time, end_time, days)
select distinct p.family_id, 'Akşam ve gece', 'limit', s.start_time, s.end_time, '{1,2,3,4,5,6,7}'::smallint[]
  from orbit.profile_sections s join orbit.rule_profiles p on p.id = s.profile_id
 where s.name = 'Kapalı' and s.start_time = '19:00' and s.end_time = '10:00'
   and not exists (select 1 from orbit.time_rules r where r.family_id = p.family_id and r.kind = 'limit' and r.start_time = s.start_time and r.end_time = s.end_time);
-- Eski "Kapalı" bölümü panelden silinebilir (kural artık kilit programında).

-- PIN olayları ve kilit olayı için bildirim
create or replace function orbit.on_event_push()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if new.type in ('task_submitted', 'time_request', 'app_request', 'app_installed', 'parent_device_pending',
                  'device_owner_lost', 'offline_long', 'device_paired', 'push_test', 'message', 'timer_alert', 'recording_alert',
                  'pin_unlock', 'pin_fail') then
    perform orbit.call_function('orbit-push', jsonb_build_object('event_id', new.id));
  end if;
  return new;
end;
$$;
