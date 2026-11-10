-- Gün profili bölümleri ile kullanım profilleri birleşir:
-- Serbest / Süreli / Kilitli / Tam kilit "hazır" kullanım profili olur; her bölüm bir kullanım profili seçer.

alter table orbit.modes add column if not exists builtin text check (builtin is null or builtin in ('open', 'timed', 'blocked', 'kiosk'));
alter table orbit.modes add column if not exists kiosk_message text;
create unique index if not exists modes_builtin_unique on orbit.modes (family_id, builtin) where builtin is not null;

-- Hazır profiller (her aile için bir kez)
insert into orbit.modes (family_id, name, icon, color, allowed_packages, allowed_groups, budget_minutes, counts_toward_daily, others_blocked, extra_time_allowed, warn_minutes, priority, kiosk_enabled, kiosk_screens, builtin)
select f.id, v.name, v.icon, v.color, '{}', v.groups::text[], null, v.counts, v.others, v.extra, '{10,2}', v.prio, v.kiosk,
       case when v.kiosk then '{tasks,agenda,alarms,timer}'::text[] else '{}'::text[] end, v.b
  from orbit.families f
 cross join (values
   ('open',    'Serbest',   '🟢', '#22C55E', '{}',            false, false, true,  10, false),
   ('timed',   'Süreli',    '⏱',  '#4F7CFF', '{}',            true,  false, true,  20, false),
   ('blocked', 'Kilitli',   '🌙', '#F59E0B', '{always_open}', false, true,  false, 30, false),
   ('kiosk',   'Tam kilit', '🔒', '#EF4444', '{}',            false, true,  false, 40, true)
 ) as v(b, name, icon, color, groups, counts, others, extra, prio, kiosk)
 where not exists (select 1 from orbit.modes m where m.family_id = f.id and m.builtin = v.b);

alter table orbit.profile_sections add column if not exists mode_id uuid references orbit.modes(id) on delete set null;

-- Mevcut bölümler hazır profillere eşlenir
update orbit.profile_sections s
   set mode_id = m.id
  from orbit.rule_profiles p, orbit.modes m
 where p.id = s.profile_id and m.family_id = p.family_id and s.mode_id is null
   and m.builtin = case when s.kiosk then 'kiosk' else s.default_rule end;

-- Bölümün türü kullanım profilinden türetilir (eski telefon sürümleri default_rule / kiosk okur)
create or replace function orbit.section_mode_sync() returns trigger
language plpgsql security definer set search_path = '' as $$
declare m orbit.modes; fam uuid; b text;
begin
  if new.mode_id is not null and (tg_op = 'INSERT' or new.mode_id is distinct from old.mode_id) then
    select * into m from orbit.modes where id = new.mode_id;
    b := coalesce(m.builtin, case when m.kiosk_enabled then 'kiosk' when m.others_blocked then 'blocked' when m.counts_toward_daily then 'timed' else 'open' end);
    new.default_rule := case when b = 'kiosk' then 'blocked' else b end;
    new.kiosk := b = 'kiosk';
  elsif tg_op = 'INSERT' or new.default_rule is distinct from old.default_rule or new.kiosk is distinct from old.kiosk then
    select family_id into fam from orbit.rule_profiles where id = new.profile_id;
    select id into new.mode_id from orbit.modes
     where family_id = fam and builtin = case when new.kiosk then 'kiosk' else new.default_rule end;
  end if;
  return new;
end $$;
drop trigger if exists section_mode_sync on orbit.profile_sections;
create trigger section_mode_sync before insert or update on orbit.profile_sections
  for each row execute function orbit.section_mode_sync();

-- Profilin ayarı değişince ona bağlı bölümlerin türü de güncellensin
create or replace function orbit.mode_sections_sync() returns trigger
language plpgsql security definer set search_path = '' as $$
declare b text;
begin
  b := coalesce(new.builtin, case when new.kiosk_enabled then 'kiosk' when new.others_blocked then 'blocked' when new.counts_toward_daily then 'timed' else 'open' end);
  update orbit.profile_sections
     set default_rule = case when b = 'kiosk' then 'blocked' else b end, kiosk = b = 'kiosk'
   where mode_id = new.id and (default_rule is distinct from (case when b = 'kiosk' then 'blocked' else b end) or kiosk is distinct from (b = 'kiosk'));
  return new;
end $$;
drop trigger if exists mode_sections_sync on orbit.modes;
create trigger mode_sections_sync after update on orbit.modes
  for each row execute function orbit.mode_sections_sync();

-- Hazır profiller silinemez
create or replace function orbit.mode_builtin_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if old.builtin is not null then raise exception 'builtin_mode'; end if;
  return old;
end $$;
drop trigger if exists mode_builtin_guard on orbit.modes;
create trigger mode_builtin_guard before delete on orbit.modes
  for each row execute function orbit.mode_builtin_guard();

-- Yeni aileler için de hazır profiller
create or replace function orbit.family_builtin_modes() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into orbit.modes (family_id, name, icon, color, allowed_packages, allowed_groups, counts_toward_daily, others_blocked, extra_time_allowed, warn_minutes, priority, kiosk_enabled, kiosk_screens, builtin)
  values
    (new.id, 'Serbest', '🟢', '#22C55E', '{}', '{}', false, false, true, '{10,2}', 10, false, '{}', 'open'),
    (new.id, 'Süreli', '⏱', '#4F7CFF', '{}', '{}', true, false, true, '{10,2}', 20, false, '{}', 'timed'),
    (new.id, 'Kilitli', '🌙', '#F59E0B', '{}', '{always_open}', false, true, false, '{10,2}', 30, false, '{}', 'blocked'),
    (new.id, 'Tam kilit', '🔒', '#EF4444', '{}', '{}', false, true, false, '{10,2}', 40, true, '{tasks,agenda,alarms,timer}', 'kiosk')
  on conflict do nothing;
  return new;
end $$;
drop trigger if exists family_builtin_modes on orbit.families;
create trigger family_builtin_modes after insert on orbit.families
  for each row execute function orbit.family_builtin_modes();
