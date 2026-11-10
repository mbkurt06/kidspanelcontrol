-- Telefon ayarları (panel → telefon): istenen ayarlar ve telefonun bildirdiği güncel durum.
-- desired: { "<anahtar>": değer, ..., "rev": { "<anahtar>": ms } }  — rev değişince telefon değeri bir kez uygular
-- (ses, Wi-Fi gibi; çocuk sonra değiştirebilir), kilitler ve izinler ise sürekli uygulanır.
create table if not exists orbit.phone_settings (
  child_id uuid primary key references orbit.children(id) on delete cascade,
  desired jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);
create table if not exists orbit.phone_state (
  child_id uuid primary key references orbit.children(id) on delete cascade,
  state jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);
alter table orbit.phone_settings enable row level security;
alter table orbit.phone_state enable row level security;

drop policy if exists parent_all on orbit.phone_settings;
create policy parent_all on orbit.phone_settings for all to authenticated
  using (child_id in (select id from orbit.children where family_id = orbit.parent_family()))
  with check (child_id in (select id from orbit.children where family_id = orbit.parent_family()));
drop policy if exists phone_read on orbit.phone_settings;
create policy phone_read on orbit.phone_settings for select to authenticated using (child_id = orbit.device_child());

drop policy if exists parent_read on orbit.phone_state;
create policy parent_read on orbit.phone_state for select to authenticated
  using (child_id in (select id from orbit.children where family_id = orbit.parent_family()));
drop policy if exists phone_write on orbit.phone_state;
create policy phone_write on orbit.phone_state for insert to authenticated with check (child_id = orbit.device_child());
drop policy if exists phone_update on orbit.phone_state;
create policy phone_update on orbit.phone_state for update to authenticated
  using (child_id = orbit.device_child()) with check (child_id = orbit.device_child());

grant select, insert, update, delete on orbit.phone_settings, orbit.phone_state to authenticated;

-- Panelde değişince telefona haber
drop trigger if exists rt_notify on orbit.phone_settings;
create trigger rt_notify after insert or update or delete on orbit.phone_settings
  for each row execute function orbit.rt_notify();
