-- Bölüm türü her zaman profilin ayarlarından türetilir (hazır profiller de dahil)
create or replace function orbit.mode_kind(m orbit.modes) returns text
language sql immutable set search_path = '' as $$
  select case when m.kiosk_enabled then 'kiosk' when m.others_blocked then 'blocked' when m.counts_toward_daily then 'timed' else 'open' end
$$;

create or replace function orbit.section_mode_sync() returns trigger
language plpgsql security definer set search_path = '' as $$
declare m orbit.modes; fam uuid; b text;
begin
  if new.mode_id is not null and (tg_op = 'INSERT' or new.mode_id is distinct from old.mode_id) then
    select * into m from orbit.modes where id = new.mode_id;
    b := orbit.mode_kind(m);
    new.default_rule := case when b = 'kiosk' then 'blocked' else b end;
    new.kiosk := b = 'kiosk';
  elsif tg_op = 'INSERT' or new.default_rule is distinct from old.default_rule or new.kiosk is distinct from old.kiosk then
    select family_id into fam from orbit.rule_profiles where id = new.profile_id;
    select id into new.mode_id from orbit.modes
     where family_id = fam and builtin = case when new.kiosk then 'kiosk' else new.default_rule end;
  end if;
  return new;
end $$;

create or replace function orbit.mode_sections_sync() returns trigger
language plpgsql security definer set search_path = '' as $$
declare b text := orbit.mode_kind(new);
begin
  update orbit.profile_sections
     set default_rule = case when b = 'kiosk' then 'blocked' else b end, kiosk = b = 'kiosk'
   where mode_id = new.id and (default_rule is distinct from (case when b = 'kiosk' then 'blocked' else b end) or kiosk is distinct from (b = 'kiosk'));
  return new;
end $$;
