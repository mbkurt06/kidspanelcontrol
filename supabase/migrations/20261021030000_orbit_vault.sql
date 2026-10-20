-- Orbit Aşama 3: şifre kasası (uçtan uca şifreli).
--
-- Her çocuğun kasasının rastgele bir anahtarı (AES-256-GCM) vardır. Sunucu bu anahtarı hiç görmez:
-- - Anahtar her "sahip" cihaz (onaylı ebeveyn cihazı, çocuğun telefonu) için o cihazın RSA-OAEP açık
--   anahtarıyla şifrelenip vault_keys'te saklanır. Özel anahtar sadece o cihazdadır.
-- - Ayrıca ebeveynlerin yazılı tuttuğu kurtarma koduyla (PBKDF2) şifrelenmiş bir kopyası vault_recovery'dedir.
-- - Kayıtlar (uygulama, kullanıcı adı, şifre, kurtarma bilgisi, not) bu anahtarla şifrelenmiş tek bir blob olarak durur.
-- Anahtara sahip bir cihaz, anahtarı olmayan yeni bir sahip görünce onun için de şifreleyip ekler.

create table orbit.vault_holders (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references orbit.families(id) on delete cascade,
  kind text not null check (kind in ('parent', 'phone')),
  parent_device_id uuid unique references orbit.parent_devices(id) on delete cascade,
  device_id uuid unique references orbit.devices(id) on delete cascade,
  -- Telefon sahibi sadece kendi çocuğunun kasasına erişir
  child_id uuid references orbit.children(id) on delete cascade,
  -- RSA-OAEP (SHA-256) açık anahtarı, SPKI DER base64
  public_key text not null,
  label text,
  created_at timestamptz not null default now(),
  check ((kind = 'parent') = (parent_device_id is not null)),
  check ((kind = 'phone') = (device_id is not null and child_id is not null))
);

create table orbit.vault_keys (
  child_id uuid not null references orbit.children(id) on delete cascade,
  holder_id uuid not null references orbit.vault_holders(id) on delete cascade,
  -- Kasa anahtarı, sahibin açık anahtarıyla RSA-OAEP ile şifrelenmiş (base64)
  wrapped_key text not null,
  created_at timestamptz not null default now(),
  primary key (child_id, holder_id)
);

create table orbit.vault_recovery (
  child_id uuid primary key references orbit.children(id) on delete cascade,
  -- Kurtarma kodundan PBKDF2-SHA256 ile türetilen anahtarla AES-GCM şifreli kasa anahtarı
  salt text not null,
  iterations int not null,
  iv text not null,
  wrapped_key text not null,
  created_at timestamptz not null default now()
);

create table orbit.vault_entries (
  id uuid primary key default gen_random_uuid(),
  child_id uuid not null references orbit.children(id) on delete cascade,
  iv text not null,
  ciphertext text not null,
  -- Kim ekledi/değiştirdi (sadece bilgi): parent | phone
  updated_by text not null default 'phone' check (updated_by in ('parent', 'phone')),
  removed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index on orbit.vault_entries (child_id);

alter table orbit.vault_holders enable row level security;
alter table orbit.vault_keys enable row level security;
alter table orbit.vault_recovery enable row level security;
alter table orbit.vault_entries enable row level security;

-- Ebeveyn (onaylı cihazdan): ailenin tüm sahiplerini görür; sadece kendi cihazı için sahip kaydı ekler.
create policy parent_read on orbit.vault_holders for select to authenticated
  using (family_id = orbit.parent_family());
create policy parent_insert on orbit.vault_holders for insert to authenticated
  with check (family_id = orbit.parent_family() and kind = 'parent' and parent_device_id = orbit.current_parent_device());

-- Telefon: kendi çocuğunun ailesindeki ebeveyn sahiplerini ve kendisini görür; sadece kendisi için ekler.
create policy phone_read on orbit.vault_holders for select to authenticated
  using (family_id = orbit.device_family() and (kind = 'parent' or device_id = (orbit.current_device()).id));
create policy phone_insert on orbit.vault_holders for insert to authenticated
  with check (family_id = orbit.device_family() and kind = 'phone'
              and device_id = (orbit.current_device()).id and child_id = orbit.device_child());

-- Anahtar kopyaları: ebeveyn ailenin tüm çocukları için; telefon sadece kendi çocuğu için.
create policy parent_all on orbit.vault_keys for all to authenticated
  using (child_id in (select id from orbit.children where family_id = orbit.parent_family()))
  with check (child_id in (select id from orbit.children where family_id = orbit.parent_family())
              and holder_id in (select id from orbit.vault_holders where family_id = orbit.parent_family()));
create policy phone_read on orbit.vault_keys for select to authenticated
  using (child_id = orbit.device_child());
create policy phone_insert on orbit.vault_keys for insert to authenticated
  with check (child_id = orbit.device_child()
              and holder_id in (select id from orbit.vault_holders where family_id = orbit.device_family()
                                and (kind = 'parent' or child_id = orbit.device_child())));

create policy parent_all on orbit.vault_recovery for all to authenticated
  using (child_id in (select id from orbit.children where family_id = orbit.parent_family()))
  with check (child_id in (select id from orbit.children where family_id = orbit.parent_family()));

create policy parent_all on orbit.vault_entries for all to authenticated
  using (child_id in (select id from orbit.children where family_id = orbit.parent_family()))
  with check (child_id in (select id from orbit.children where family_id = orbit.parent_family()));
create policy phone_all on orbit.vault_entries for all to authenticated
  using (child_id = orbit.device_child())
  with check (child_id = orbit.device_child());

grant select, insert, update, delete on orbit.vault_holders, orbit.vault_keys, orbit.vault_recovery, orbit.vault_entries to authenticated;
grant all on orbit.vault_holders, orbit.vault_keys, orbit.vault_recovery, orbit.vault_entries to service_role;

-- Ebeveyn cihazı, tarayıcı verisi silinip anahtarı kaybolduysa kendi sahip kaydının açık anahtarını yenileyebilir.
create policy parent_update_own on orbit.vault_holders for update to authenticated
  using (family_id = orbit.parent_family() and parent_device_id = orbit.current_parent_device())
  with check (family_id = orbit.parent_family() and parent_device_id = orbit.current_parent_device() and kind = 'parent');
