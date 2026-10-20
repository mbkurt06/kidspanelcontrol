-- Orbit: iPhone (PWA) bildirimleri, kanıt temizliği ve çevrimdışı uyarısı.
-- Gizli değerler (VAPID anahtarları, kanca sırrı) Supabase Vault'ta durur; koda yazılmaz.

create extension if not exists pg_net with schema extensions;
create extension if not exists pg_cron;

-- Ebeveyn cihazlarının bildirim abonelikleri
create table orbit.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  family_id uuid not null references orbit.families(id) on delete cascade,
  parent_device_id uuid references orbit.parent_devices(id) on delete cascade,
  endpoint text not null unique,
  p256dh text not null,
  auth text not null,
  -- Hangi olaylar için bildirim gelsin (boş = hepsi)
  types text[] not null default '{}',
  disabled_at timestamptz,
  created_at timestamptz not null default now()
);
alter table orbit.push_subscriptions enable row level security;
create policy parent_own on orbit.push_subscriptions for all to authenticated
  using (user_id = auth.uid() and family_id = orbit.parent_family())
  with check (user_id = auth.uid() and family_id = orbit.parent_family());
grant select, insert, update, delete on orbit.push_subscriptions to authenticated;
grant all on orbit.push_subscriptions to service_role;

alter table orbit.task_proofs add column if not exists file_deleted_at timestamptz;
alter table orbit.devices add column if not exists offline_notified_at timestamptz;

-- Sunucu tarafı ayarlar: sadece service_role (Edge Function) okuyabilir.
create or replace function orbit.server_config()
returns jsonb
language sql stable security definer set search_path = ''
as $$
  select jsonb_object_agg(name, decrypted_secret)
  from vault.decrypted_secrets where name in ('orbit_vapid_public', 'orbit_vapid_private', 'orbit_hook_secret');
$$;
revoke all on function orbit.server_config() from public, anon, authenticated;
grant execute on function orbit.server_config() to service_role;

-- Panelin abone olurken kullandığı açık anahtar (gizli değil).
create or replace function orbit.vapid_public_key()
returns text
language sql stable security definer set search_path = ''
as $$ select decrypted_secret from vault.decrypted_secrets where name = 'orbit_vapid_public'; $$;
revoke all on function orbit.vapid_public_key() from public, anon;
grant execute on function orbit.vapid_public_key() to authenticated;

-- Edge Function çağrısı (kanca sırrıyla)
create or replace function orbit.call_function(p_name text, p_body jsonb)
returns void
language plpgsql volatile security definer set search_path = ''
as $$
declare secret text;
begin
  select decrypted_secret into secret from vault.decrypted_secrets where name = 'orbit_hook_secret';
  perform net.http_post(
    url := 'https://pwxbrkbljcknstjbccwu.supabase.co/functions/v1/' || p_name,
    body := p_body,
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-orbit-hook', secret),
    timeout_milliseconds := 10000
  );
end;
$$;
revoke all on function orbit.call_function(text, jsonb) from public, anon, authenticated;

-- Yeni olay → bildirim gönder
create or replace function orbit.on_event_push()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if new.type in ('task_submitted', 'time_request', 'app_installed', 'parent_device_pending',
                  'device_owner_lost', 'offline_long', 'device_paired', 'push_test') then
    perform orbit.call_function('orbit-push', jsonb_build_object('event_id', new.id));
  end if;
  return new;
end;
$$;
create trigger orbit_event_push after insert on orbit.events
  for each row execute function orbit.on_event_push();

-- 1 saattir sesi çıkmayan telefon için bir kez uyarı
create or replace function orbit.check_offline()
returns void
language plpgsql volatile security definer set search_path = ''
as $$
declare d orbit.devices;
begin
  for d in
    select * from orbit.devices
    where kind = 'child_phone' and status = 'active'
      and last_seen_at < now() - interval '60 minutes'
      and (offline_notified_at is null or offline_notified_at < last_seen_at)
  loop
    update orbit.devices set offline_notified_at = now() where id = d.id;
    insert into orbit.events (family_id, child_id, type, payload)
    values (d.family_id, d.child_id, 'offline_long', jsonb_build_object('last_seen_at', d.last_seen_at, 'model', d.model));
  end loop;
end;
$$;
revoke all on function orbit.check_offline() from public, anon, authenticated;

-- Zamanlanmış işler: her 15 dakikada kanıt temizliği ve çevrimdışı kontrolü
select cron.schedule('orbit-cleanup', '*/15 * * * *', $$select orbit.call_function('orbit-cleanup', '{}'::jsonb)$$);
select cron.schedule('orbit-offline', '*/10 * * * *', $$select orbit.check_offline()$$);
