-- Tam kilit (kiosk), ebeveyn PIN'i, müzik çalar ayarları ve ek zaman kuralları.

-- Elle tam kilit: kiosk_start (until_at = bitiş, null = süresiz) / kiosk_end
alter table orbit.commands drop constraint if exists commands_type_check;
alter table orbit.commands add constraint commands_type_check
  check (type in ('lock', 'unlock', 'start_mode', 'end_mode', 'adjust_minutes', 'resync', 'kiosk_start', 'kiosk_end'));

-- Çocuk ayarları
alter table orbit.children add column if not exists kiosk_settings jsonb not null
  default '{"message": null, "screens": ["tasks", "messages", "music", "timer", "alarms"], "calls": "emergency"}'::jsonb;
alter table orbit.children add column if not exists parent_pin_hash text;
alter table orbit.children add column if not exists parent_pin_enabled boolean not null default false;
alter table orbit.children add column if not exists music_mode text not null default 'rules'
  check (music_mode in ('always', 'rules', 'never'));
-- null = çocuk klasörü kendisi seçer
alter table orbit.children add column if not exists music_folder text;
-- Telefonun bildirdiği müzik klasörleri
alter table orbit.children add column if not exists music_folders text[] not null default '{}';

-- Bölüm: tam kilit ve müzik
alter table orbit.profile_sections add column if not exists kiosk boolean not null default false;
alter table orbit.profile_sections add column if not exists music boolean not null default true;

-- Ek zaman kuralları (bölümlerden bağımsız): tam kilit, müzik kapalı, müzik açık
create table if not exists orbit.time_rules (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references orbit.families(id) on delete cascade,
  name text not null default 'Kural',
  kind text not null check (kind in ('kiosk', 'music_off', 'music_on')),
  -- boş = bütün çocuklar
  child_ids uuid[] not null default '{}',
  days smallint[] not null default '{1,2,3,4,5,6,7}',
  start_time time not null,
  end_time time not null,
  message text,
  -- tam kilitte açık Orbit ekranları; null = çocuğun varsayılanı
  screens text[],
  active boolean not null default true,
  created_at timestamptz not null default now(),
  check (start_time <> end_time)
);
alter table orbit.time_rules enable row level security;
create policy parent_all on orbit.time_rules for all to authenticated
  using (family_id = orbit.parent_family()) with check (family_id = orbit.parent_family());
create policy phone_read on orbit.time_rules for select to authenticated using (family_id = orbit.device_family());
grant select, insert, update, delete on orbit.time_rules to authenticated;
alter publication supabase_realtime add table orbit.time_rules;

-- Telefon: müzik klasörlerini bildirir
create or replace function orbit.device_report_music(p_folders text[])
returns void
language plpgsql volatile security definer set search_path = ''
as $$
declare c uuid := orbit.device_child();
begin
  if c is null then raise exception 'not_allowed'; end if;
  update orbit.children set music_folders = coalesce(p_folders, '{}') where id = c and music_folders is distinct from coalesce(p_folders, '{}');
end;
$$;

-- Telefon: ebeveyn PIN'i ile açıldı / yanlış girildi
create or replace function orbit.device_event(p_type text, p_payload jsonb default '{}'::jsonb)
returns void
language plpgsql volatile security definer set search_path = ''
as $$
declare dev orbit.devices := orbit.current_device();
begin
  if dev.id is null or dev.kind <> 'child_phone' then raise exception 'not_allowed'; end if;
  if p_type not in ('pin_unlock', 'pin_fail', 'kiosk') then raise exception 'bad_type'; end if;
  insert into orbit.events (family_id, child_id, type, payload) values (dev.family_id, dev.child_id, p_type, coalesce(p_payload, '{}'::jsonb));
end;
$$;

grant execute on function orbit.device_report_music(text[]), orbit.device_event(text, jsonb) to authenticated;

alter publication supabase_realtime add table orbit.children;
