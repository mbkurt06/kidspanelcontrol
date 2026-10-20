-- Orbit: ebeveyn denetim sistemi — çekirdek şema (Aşama 1)
-- Noor Supabase projesinde, Noor tablolarından ayrı "orbit" şemasında durur.

create schema if not exists orbit;

create extension if not exists pgcrypto with schema extensions;

-- ---------------------------------------------------------------------------
-- Aile, ebeveynler, ebeveyn cihazları
-- ---------------------------------------------------------------------------

create table orbit.families (
  id uuid primary key default gen_random_uuid(),
  name text not null default 'Aile',
  timezone text not null default 'Europe/Berlin',
  created_at timestamptz not null default now()
);

-- Ebeveyn olarak kayıt olabilecek e-postalar (davet listesi).
create table orbit.allowed_parents (
  email text primary key check (email = lower(email)),
  family_id uuid references orbit.families(id) on delete cascade,
  display_name text,
  created_at timestamptz not null default now()
);

create table orbit.parents (
  user_id uuid primary key references auth.users(id) on delete cascade,
  family_id uuid not null references orbit.families(id) on delete cascade,
  email text not null,
  display_name text not null default 'Ebeveyn',
  created_at timestamptz not null default now()
);

-- Ebeveyn cihazları: her tarayıcı/PWA kurulumu bir cihazdır. Onaylanmamış cihaz veri göremez.
-- İstemci, rastgele bir sırrı yerelde saklar ve her istekte
-- "x-orbit-device: <id>.<sır>" başlığıyla gönderir; burada sadece sırrın SHA-256 özeti tutulur.
create table orbit.parent_devices (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references orbit.parents(user_id) on delete cascade,
  family_id uuid not null references orbit.families(id) on delete cascade,
  label text not null default 'Cihaz',
  secret_hash text not null,
  status text not null default 'pending' check (status in ('pending', 'approved', 'revoked')),
  approved_by uuid references auth.users(id),
  approved_at timestamptz,
  last_seen_at timestamptz,
  created_at timestamptz not null default now()
);
create index on orbit.parent_devices (family_id, status);

-- ---------------------------------------------------------------------------
-- Çocuklar ve cihazları
-- ---------------------------------------------------------------------------

create table orbit.children (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references orbit.families(id) on delete cascade,
  name text not null,
  color text not null default '#4F7CFF',
  sort_order int not null default 0,
  created_at timestamptz not null default now()
);

-- Telefon veya Noor tableti. Her cihaz kendi Supabase Auth kullanıcısıyla bağlanır.
create table orbit.devices (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references orbit.families(id) on delete cascade,
  child_id uuid references orbit.children(id) on delete cascade,
  kind text not null check (kind in ('child_phone', 'viewer')),
  auth_user_id uuid unique references auth.users(id) on delete set null,
  label text not null default 'Cihaz',
  model text,
  os_version text,
  app_version text,
  is_device_owner boolean,
  status text not null default 'active' check (status in ('active', 'revoked')),
  last_seen_at timestamptz,
  created_at timestamptz not null default now(),
  check ((kind = 'child_phone') = (child_id is not null))
);

-- Eşleştirme kodları (ebeveyn panelinde üretilir, 15 dk geçerli, tek kullanımlık).
create table orbit.pairing_codes (
  code text primary key,
  family_id uuid not null references orbit.families(id) on delete cascade,
  child_id uuid references orbit.children(id) on delete cascade,
  kind text not null check (kind in ('child_phone', 'viewer')),
  created_by uuid not null references auth.users(id),
  expires_at timestamptz not null default now() + interval '15 minutes',
  used_at timestamptz,
  device_id uuid references orbit.devices(id) on delete set null,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Uygulamalar ve gruplar
-- ---------------------------------------------------------------------------

-- Grup: always_open (her zaman açık), unlimited (süreden düşmez, saat aralığında),
-- timed (günlük süreden düşer), blocked (kapalı).
-- Yeni yüklenen uygulama ebeveyn onaylayana kadar approved=false ve blocked kalır.
create table orbit.child_apps (
  child_id uuid not null references orbit.children(id) on delete cascade,
  package text not null,
  label text not null,
  app_group text not null default 'blocked' check (app_group in ('always_open', 'unlimited', 'timed', 'blocked')),
  approved boolean not null default false,
  daily_limit_minutes int check (daily_limit_minutes is null or daily_limit_minutes >= 0),
  is_system boolean not null default false,
  installed boolean not null default true,
  first_seen_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (child_id, package)
);

-- Ebeveynin kaydettiği uygulama listeleri (örneğin "Oyunlarım": 3 oyun).
create table orbit.app_lists (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references orbit.families(id) on delete cascade,
  name text not null,
  packages text[] not null default '{}',
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Kural profilleri ve durumlar (modlar)
-- ---------------------------------------------------------------------------

create table orbit.rule_profiles (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references orbit.families(id) on delete cascade,
  name text not null,
  daily_minutes int not null default 90 check (daily_minutes >= 0),
  max_total_minutes int check (max_total_minutes is null or max_total_minutes >= 0),
  -- Süreli uygulamalar için izinli saatler (boşsa gün boyu).
  timed_windows jsonb not null default '[]',
  -- Sınırsız uygulamaların açık olduğu saatler (boşsa gün boyu).
  unlimited_windows jsonb not null default '[]',
  warn_minutes int[] not null default '{10,2}',
  created_at timestamptz not null default now()
);

-- Ebeveynin oluşturduğu durum. Örnek: Oyun zamanı — 3 oyun, 30 dk, 16:00–18:00, günlük süreyi etkilemez.
create table orbit.modes (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references orbit.families(id) on delete cascade,
  name text not null,
  icon text not null default 'circle',
  color text not null default '#7C5CFF',
  -- Bu durumda açık olanlar: seçilen paketler + seçilen gruplar.
  allowed_packages text[] not null default '{}',
  allowed_groups text[] not null default '{always_open}',
  -- null = aralık boyunca sınırsız; değer = bu durumun kendi süresi (dakika).
  budget_minutes int check (budget_minutes is null or budget_minutes >= 0),
  counts_toward_daily boolean not null default false,
  -- true: durum boyunca diğer uygulamalar kapalı; false: diğerleri normal kurallarla açık.
  others_blocked boolean not null default true,
  extra_time_allowed boolean not null default false,
  warn_minutes int[] not null default '{5}',
  priority int not null default 50,
  created_at timestamptz not null default now()
);

-- Bir profilde hangi durum hangi gün ve saatte geçerli.
create table orbit.mode_slots (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references orbit.rule_profiles(id) on delete cascade,
  mode_id uuid not null references orbit.modes(id) on delete cascade,
  -- ISO günleri: 1 = Pazartesi … 7 = Pazar
  days smallint[] not null default '{1,2,3,4,5,6,7}',
  start_time time not null,
  end_time time not null,
  created_at timestamptz not null default now(),
  check (start_time <> end_time)
);

-- Haftanın günlerine göre çocuğa profil atama.
create table orbit.profile_assignments (
  child_id uuid not null references orbit.children(id) on delete cascade,
  weekday smallint not null check (weekday between 1 and 7),
  profile_id uuid not null references orbit.rule_profiles(id) on delete cascade,
  primary key (child_id, weekday)
);

-- Tek güne istisna (örneğin bayram günü 3 saat).
create table orbit.day_overrides (
  id uuid primary key default gen_random_uuid(),
  child_id uuid not null references orbit.children(id) on delete cascade,
  day date not null,
  profile_id uuid references orbit.rule_profiles(id) on delete set null,
  daily_minutes int check (daily_minutes is null or daily_minutes >= 0),
  note text,
  created_at timestamptz not null default now(),
  unique (child_id, day)
);

-- ---------------------------------------------------------------------------
-- Ebeveyn komutları, ekstra süre, cihaz durumu, kullanım
-- ---------------------------------------------------------------------------

-- Anlık müdahaleler: şimdi kilitle, kilidi aç, durumu başlat/bitir, süre ekle/düş.
create table orbit.commands (
  id uuid primary key default gen_random_uuid(),
  child_id uuid not null references orbit.children(id) on delete cascade,
  type text not null check (type in ('lock', 'unlock', 'start_mode', 'end_mode', 'adjust_minutes', 'resync')),
  payload jsonb not null default '{}',
  -- Kilit/kilit açma/durum için bitiş zamanı (null = ebeveyn kaldırana kadar / gün sonuna kadar).
  until_at timestamptz,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  acked_at timestamptz,
  cancelled_at timestamptz
);
create index on orbit.commands (child_id, created_at desc);

-- Süre cüzdanı (ekstra süreler). Aşama 1'de ebeveyn elle süre verir; Aşama 2'de görevlerden gelir.
create table orbit.time_grants (
  id uuid primary key default gen_random_uuid(),
  child_id uuid not null references orbit.children(id) on delete cascade,
  minutes int not null,
  -- valid_on: belirli gün; null ise çocuk istediği gün kullanır (expires_on'a kadar).
  valid_on date,
  expires_on date,
  activated_on date,
  source text not null default 'manual' check (source in ('manual', 'task')),
  note text,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);
create index on orbit.time_grants (child_id, valid_on);

-- Telefonun anlık durumu (telefon günceller, panel ve Noor okur).
create table orbit.device_status (
  child_id uuid primary key references orbit.children(id) on delete cascade,
  device_id uuid references orbit.devices(id) on delete set null,
  day date,
  used_minutes int not null default 0,
  allowance_minutes int not null default 0,
  remaining_minutes int not null default 0,
  current_mode_id uuid references orbit.modes(id) on delete set null,
  current_mode_name text,
  locked boolean not null default false,
  lock_reason text,
  foreground_package text,
  battery int,
  updated_at timestamptz not null default now()
);

-- Günlük kullanım özeti (uygulama başına dakika).
create table orbit.usage_daily (
  child_id uuid not null references orbit.children(id) on delete cascade,
  day date not null,
  package text not null,
  minutes int not null default 0,
  counted_minutes int not null default 0,
  updated_at timestamptz not null default now(),
  primary key (child_id, day, package)
);

-- Ebeveyne bildirilecek olaylar (yeni uygulama, çevrimdışı, yeniden başlatma, süre isteği).
create table orbit.events (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references orbit.families(id) on delete cascade,
  child_id uuid references orbit.children(id) on delete cascade,
  type text not null,
  payload jsonb not null default '{}',
  created_at timestamptz not null default now(),
  read_at timestamptz
);
create index on orbit.events (family_id, created_at desc);

-- ---------------------------------------------------------------------------
-- Yardımcı fonksiyonlar (RLS için)
-- ---------------------------------------------------------------------------

-- İstekle gelen ebeveyn cihaz başlığını doğrular. Onaylı cihaz değilse null döner.
create or replace function orbit.current_parent_device()
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  hdr text;
  dev_id uuid;
  secret text;
  found uuid;
begin
  begin
    hdr := current_setting('request.headers', true)::json ->> 'x-orbit-device';
  exception when others then
    return null;
  end;
  if hdr is null or position('.' in hdr) = 0 then
    return null;
  end if;
  begin
    dev_id := split_part(hdr, '.', 1)::uuid;
  exception when others then
    return null;
  end;
  secret := substr(hdr, length(split_part(hdr, '.', 1)) + 2);
  select d.id into found
  from orbit.parent_devices d
  where d.id = dev_id
    and d.user_id = auth.uid()
    and d.status = 'approved'
    and d.secret_hash = encode(extensions.digest(secret, 'sha256'), 'hex');
  return found;
end;
$$;

-- Onaylı bir cihazdan bağlanan ebeveynin ailesi; değilse null.
create or replace function orbit.parent_family()
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select p.family_id
  from orbit.parents p
  where p.user_id = auth.uid()
    and orbit.current_parent_device() is not null;
$$;

-- Bağlanan cihaz (çocuk telefonu veya Noor tableti) kaydı.
create or replace function orbit.current_device()
returns orbit.devices
language sql
stable
security definer
set search_path = ''
as $$
  select d.* from orbit.devices d
  where d.auth_user_id = auth.uid() and d.status = 'active';
$$;

create or replace function orbit.device_family()
returns uuid
language sql stable security definer set search_path = ''
as $$ select (orbit.current_device()).family_id; $$;

create or replace function orbit.device_child()
returns uuid
language sql stable security definer set search_path = ''
as $$ select (orbit.current_device()).child_id; $$;

-- ---------------------------------------------------------------------------
-- Ebeveyn kaydı ve cihaz onayı (RPC)
-- ---------------------------------------------------------------------------

-- Giriş yapan ebeveyn bu tarayıcıyı cihaz olarak kaydeder.
-- Davet listesinde değilse hata verir. Ailede hiç onaylı cihaz yoksa (ilk kurulum) otomatik onaylanır.
create or replace function orbit.register_parent_device(p_device_id uuid, p_secret text, p_label text)
returns text
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  uid uuid := auth.uid();
  mail text;
  fam uuid;
  invite orbit.allowed_parents;
  st text;
begin
  if uid is null then
    raise exception 'not_authenticated';
  end if;
  if length(coalesce(p_secret, '')) < 32 then
    raise exception 'weak_secret';
  end if;
  select lower(u.email) into mail from auth.users u where u.id = uid;

  select p.family_id into fam from orbit.parents p where p.user_id = uid;
  if fam is null then
    select * into invite from orbit.allowed_parents a where a.email = mail;
    if invite.email is null then
      raise exception 'not_invited';
    end if;
    fam := invite.family_id;
    if fam is null then
      insert into orbit.families (name) values ('Aile') returning id into fam;
      update orbit.allowed_parents set family_id = fam where email = mail;
    end if;
    insert into orbit.parents (user_id, family_id, email, display_name)
    values (uid, fam, mail, coalesce(invite.display_name, split_part(mail, '@', 1)));
  end if;

  if exists (select 1 from orbit.parent_devices d where d.id = p_device_id) then
    select d.status into st from orbit.parent_devices d where d.id = p_device_id and d.user_id = uid;
    if st is null then
      raise exception 'device_conflict';
    end if;
    return st;
  end if;

  if not exists (select 1 from orbit.parent_devices d where d.family_id = fam and d.status = 'approved') then
    st := 'approved';
  else
    st := 'pending';
  end if;

  insert into orbit.parent_devices (id, user_id, family_id, label, secret_hash, status, approved_at)
  values (p_device_id, uid, fam, left(coalesce(nullif(p_label, ''), 'Cihaz'), 60),
          encode(extensions.digest(p_secret, 'sha256'), 'hex'), st,
          case when st = 'approved' then now() end);

  if st = 'pending' then
    insert into orbit.events (family_id, type, payload)
    values (fam, 'parent_device_pending', jsonb_build_object('device_id', p_device_id, 'label', p_label, 'email', mail));
  end if;
  return st;
end;
$$;

-- Bu cihazın durumu (onay bekleyen cihaz da kendi durumunu görebilsin).
create or replace function orbit.my_device_status(p_device_id uuid)
returns text
language sql stable security definer set search_path = ''
as $$
  select d.status from orbit.parent_devices d where d.id = p_device_id and d.user_id = auth.uid();
$$;

create or replace function orbit.set_parent_device_status(p_device_id uuid, p_status text)
returns void
language plpgsql volatile security definer set search_path = ''
as $$
declare fam uuid := orbit.parent_family();
begin
  if fam is null then raise exception 'not_allowed'; end if;
  if p_status not in ('approved', 'revoked') then raise exception 'bad_status'; end if;
  update orbit.parent_devices
     set status = p_status,
         approved_by = case when p_status = 'approved' then auth.uid() else approved_by end,
         approved_at = case when p_status = 'approved' then now() else approved_at end
   where id = p_device_id and family_id = fam;
end;
$$;

-- Onaylı cihazın son görülme zamanı.
create or replace function orbit.touch_parent_device()
returns void
language sql volatile security definer set search_path = ''
as $$
  update orbit.parent_devices set last_seen_at = now() where id = orbit.current_parent_device();
$$;

-- Ebeveyn başka bir ebeveyni (eşini) davet eder.
create or replace function orbit.invite_parent(p_email text, p_name text)
returns void
language plpgsql volatile security definer set search_path = ''
as $$
declare fam uuid := orbit.parent_family();
begin
  if fam is null then raise exception 'not_allowed'; end if;
  insert into orbit.allowed_parents (email, family_id, display_name)
  values (lower(trim(p_email)), fam, p_name)
  on conflict (email) do update set display_name = excluded.display_name
  where orbit.allowed_parents.family_id = fam;
end;
$$;

-- Eşleştirme kodu üretir (çocuk telefonu veya Noor tableti için).
create or replace function orbit.create_pairing_code(p_kind text, p_child_id uuid)
returns text
language plpgsql volatile security definer set search_path = ''
as $$
declare
  fam uuid := orbit.parent_family();
  c text;
begin
  if fam is null then raise exception 'not_allowed'; end if;
  if p_kind = 'child_phone' and not exists (select 1 from orbit.children where id = p_child_id and family_id = fam) then
    raise exception 'bad_child';
  end if;
  c := lpad((floor(random() * 100000000))::bigint::text, 8, '0');
  insert into orbit.pairing_codes (code, family_id, child_id, kind, created_by)
  values (c, fam, case when p_kind = 'child_phone' then p_child_id end, p_kind, auth.uid());
  return c;
end;
$$;

-- Telefon yeni bir uygulama bildirir (yüklendiğinde). Onaysız ve kapalı başlar, ebeveyne olay düşer.
create or replace function orbit.device_report_apps(p_apps jsonb)
returns void
language plpgsql volatile security definer set search_path = ''
as $$
declare
  dev orbit.devices := orbit.current_device();
  a jsonb;
  is_new boolean;
begin
  if dev.id is null or dev.kind <> 'child_phone' then raise exception 'not_allowed'; end if;
  update orbit.child_apps set installed = false where child_id = dev.child_id;
  for a in select * from jsonb_array_elements(p_apps) loop
    is_new := not exists (select 1 from orbit.child_apps where child_id = dev.child_id and package = a ->> 'package');
    insert into orbit.child_apps (child_id, package, label, is_system, installed, app_group, approved)
    values (dev.child_id, a ->> 'package', coalesce(a ->> 'label', a ->> 'package'),
            coalesce((a ->> 'system')::boolean, false), true,
            coalesce(a ->> 'default_group', 'blocked'),
            coalesce((a ->> 'preapproved')::boolean, false))
    on conflict (child_id, package) do update
      set label = excluded.label, installed = true, updated_at = now();
    if is_new and not coalesce((a ->> 'preapproved')::boolean, false) and (a ->> 'initial') is null then
      insert into orbit.events (family_id, child_id, type, payload)
      values (dev.family_id, dev.child_id, 'app_installed',
              jsonb_build_object('package', a ->> 'package', 'label', a ->> 'label'));
    end if;
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------

alter table orbit.families enable row level security;
alter table orbit.allowed_parents enable row level security;
alter table orbit.parents enable row level security;
alter table orbit.parent_devices enable row level security;
alter table orbit.children enable row level security;
alter table orbit.devices enable row level security;
alter table orbit.pairing_codes enable row level security;
alter table orbit.child_apps enable row level security;
alter table orbit.app_lists enable row level security;
alter table orbit.rule_profiles enable row level security;
alter table orbit.modes enable row level security;
alter table orbit.mode_slots enable row level security;
alter table orbit.profile_assignments enable row level security;
alter table orbit.day_overrides enable row level security;
alter table orbit.commands enable row level security;
alter table orbit.time_grants enable row level security;
alter table orbit.device_status enable row level security;
alter table orbit.usage_daily enable row level security;
alter table orbit.events enable row level security;

-- Ebeveyn (onaylı cihazdan): kendi ailesinin her şeyi.
create policy parent_all on orbit.families for all to authenticated
  using (id = orbit.parent_family()) with check (id = orbit.parent_family());
create policy parent_read on orbit.allowed_parents for select to authenticated
  using (family_id = orbit.parent_family());
create policy parent_delete on orbit.allowed_parents for delete to authenticated
  using (family_id = orbit.parent_family());
create policy parent_read on orbit.parents for select to authenticated
  using (family_id = orbit.parent_family());
create policy parent_update_self on orbit.parents for update to authenticated
  using (user_id = auth.uid() and family_id = orbit.parent_family())
  with check (user_id = auth.uid());
create policy parent_read on orbit.parent_devices for select to authenticated
  using (family_id = orbit.parent_family());
create policy parent_rename on orbit.parent_devices for update to authenticated
  using (family_id = orbit.parent_family()) with check (family_id = orbit.parent_family());

do $$
declare t text;
begin
  foreach t in array array['children', 'devices', 'app_lists', 'rule_profiles', 'modes', 'events']
  loop
    execute format(
      'create policy parent_all on orbit.%I for all to authenticated using (family_id = orbit.parent_family()) with check (family_id = orbit.parent_family())', t);
  end loop;
  foreach t in array array['child_apps', 'profile_assignments', 'day_overrides', 'commands', 'time_grants', 'device_status', 'usage_daily']
  loop
    execute format(
      'create policy parent_all on orbit.%I for all to authenticated using (child_id in (select id from orbit.children where family_id = orbit.parent_family())) with check (child_id in (select id from orbit.children where family_id = orbit.parent_family()))', t);
  end loop;
end $$;

create policy parent_all on orbit.mode_slots for all to authenticated
  using (profile_id in (select id from orbit.rule_profiles where family_id = orbit.parent_family()))
  with check (profile_id in (select id from orbit.rule_profiles where family_id = orbit.parent_family()));
create policy parent_read on orbit.pairing_codes for select to authenticated
  using (family_id = orbit.parent_family());

-- Cihazlar (çocuk telefonu ve Noor tableti): ailenin kurallarını okur.
create policy device_read on orbit.families for select to authenticated using (id = orbit.device_family());
create policy device_read on orbit.children for select to authenticated using (family_id = orbit.device_family());
create policy device_read on orbit.app_lists for select to authenticated using (family_id = orbit.device_family());
create policy device_read on orbit.rule_profiles for select to authenticated using (family_id = orbit.device_family());
create policy device_read on orbit.modes for select to authenticated using (family_id = orbit.device_family());
create policy device_read on orbit.mode_slots for select to authenticated
  using (profile_id in (select id from orbit.rule_profiles where family_id = orbit.device_family()));
create policy device_self on orbit.devices for select to authenticated using (auth_user_id = auth.uid());
create policy device_update_self on orbit.devices for update to authenticated
  using (auth_user_id = auth.uid() and status = 'active') with check (auth_user_id = auth.uid() and status = 'active');

-- Noor tableti (viewer): iki çocuğun durumunu okur.
create policy viewer_read on orbit.device_status for select to authenticated
  using (child_id in (select id from orbit.children where family_id = orbit.device_family()));
create policy viewer_read on orbit.time_grants for select to authenticated
  using (child_id in (select id from orbit.children where family_id = orbit.device_family()));

-- Çocuk telefonu: sadece kendi çocuğunun kayıtları.
create policy phone_read on orbit.child_apps for select to authenticated using (child_id = orbit.device_child());
create policy phone_read on orbit.profile_assignments for select to authenticated using (child_id = orbit.device_child());
create policy phone_read on orbit.day_overrides for select to authenticated using (child_id = orbit.device_child());
create policy phone_read on orbit.commands for select to authenticated using (child_id = orbit.device_child());
create policy phone_ack on orbit.commands for update to authenticated
  using (child_id = orbit.device_child()) with check (child_id = orbit.device_child());
create policy phone_update on orbit.time_grants for update to authenticated
  using (child_id = orbit.device_child()) with check (child_id = orbit.device_child());
create policy phone_write on orbit.device_status for insert to authenticated with check (child_id = orbit.device_child());
create policy phone_update on orbit.device_status for update to authenticated
  using (child_id = orbit.device_child()) with check (child_id = orbit.device_child());
create policy phone_write on orbit.usage_daily for insert to authenticated with check (child_id = orbit.device_child());
create policy phone_update on orbit.usage_daily for update to authenticated
  using (child_id = orbit.device_child()) with check (child_id = orbit.device_child());
create policy phone_read on orbit.usage_daily for select to authenticated using (child_id = orbit.device_child());
create policy phone_insert on orbit.events for insert to authenticated
  with check (family_id = orbit.device_family() and child_id is not distinct from orbit.device_child());

-- Çocuk telefonu: commands'ta sadece acked_at, time_grants'te sadece activated_on değiştirilebilir.
create or replace function orbit.guard_phone_commands()
returns trigger language plpgsql security definer set search_path = ''
as $$
begin
  if orbit.device_child() is not null then
    if (new.type, new.payload, new.until_at, new.child_id, new.created_by, new.created_at, new.cancelled_at)
       is distinct from (old.type, old.payload, old.until_at, old.child_id, old.created_by, old.created_at, old.cancelled_at) then
      raise exception 'not_allowed';
    end if;
  end if;
  return new;
end;
$$;
create trigger guard_phone before update on orbit.commands
  for each row execute function orbit.guard_phone_commands();

create or replace function orbit.guard_phone_grants()
returns trigger language plpgsql security definer set search_path = ''
as $$
begin
  if orbit.device_child() is not null then
    if (new.minutes, new.valid_on, new.expires_on, new.child_id, new.source, new.note, new.created_by)
       is distinct from (old.minutes, old.valid_on, old.expires_on, old.child_id, old.source, old.note, old.created_by)
       or old.activated_on is not null then
      raise exception 'not_allowed';
    end if;
  end if;
  return new;
end;
$$;
create trigger guard_phone before update on orbit.time_grants
  for each row execute function orbit.guard_phone_grants();

create or replace function orbit.guard_phone_devices()
returns trigger language plpgsql security definer set search_path = ''
as $$
begin
  if orbit.parent_family() is null then
    if (new.family_id, new.child_id, new.kind, new.auth_user_id, new.status, new.label)
       is distinct from (old.family_id, old.child_id, old.kind, old.auth_user_id, old.status, old.label) then
      raise exception 'not_allowed';
    end if;
  end if;
  return new;
end;
$$;
create trigger guard_device before update on orbit.devices
  for each row execute function orbit.guard_phone_devices();

-- ---------------------------------------------------------------------------
-- Yetkiler (Data API) ve Realtime
-- ---------------------------------------------------------------------------

grant usage on schema orbit to authenticated, service_role;
grant select, insert, update, delete on all tables in schema orbit to authenticated;
grant all on all tables in schema orbit to service_role;
revoke all on all functions in schema orbit from public, anon;
grant execute on all functions in schema orbit to authenticated, service_role;
alter default privileges for role postgres in schema orbit grant select, insert, update, delete on tables to authenticated;
alter default privileges for role postgres in schema orbit grant all on tables to service_role;
alter default privileges for role postgres in schema orbit revoke execute on functions from public;

alter publication supabase_realtime add table
  orbit.commands, orbit.child_apps, orbit.rule_profiles, orbit.modes, orbit.mode_slots,
  orbit.profile_assignments, orbit.day_overrides, orbit.time_grants, orbit.device_status, orbit.events;

-- İlk ebeveyn davetini ayrı bir seed betiği ekler (e-posta adresi kodda tutulmaz).
