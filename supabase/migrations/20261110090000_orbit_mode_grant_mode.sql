-- Kullanım profili: "Bu profildeyken süre verirsem" (kapalıyken verilen süre profile taşınır)
-- null = varsayılan (çocuğun Kurallar'daki ayarı); none = verilemez, kasaya gider
alter table orbit.modes add column if not exists grant_mode text check (grant_mode is null or grant_mode in ('none', 'clock', 'usage', 'within', 'open'));
alter table orbit.modes add column if not exists grant_within_minutes int;

update orbit.modes set grant_mode = 'usage' where builtin = 'blocked' and grant_mode is null;
update orbit.modes set grant_mode = 'clock' where builtin = 'kiosk' and grant_mode is null;
update orbit.modes set grant_mode = 'none' where builtin is null and grant_mode is null and name ilike '%uyku%';

create or replace function orbit.family_builtin_modes_grant() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.builtin = 'blocked' and new.grant_mode is null then new.grant_mode := 'usage'; end if;
  if new.builtin = 'kiosk' and new.grant_mode is null then new.grant_mode := 'clock'; end if;
  return new;
end $$;
drop trigger if exists modes_builtin_grant on orbit.modes;
create trigger modes_builtin_grant before insert on orbit.modes
  for each row execute function orbit.family_builtin_modes_grant();
