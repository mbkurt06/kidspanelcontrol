-- Telefon güncellemeleri gizli GitHub deposunun sürümlerinden (Releases) iner: ebeveyn panelden salt okunur
-- bir GitHub anahtarı girer, telefonlar bu anahtarı alır. Anahtar yoksa yedek: Supabase'deki herkese açık kurulum dosyası.
create table if not exists orbit.family_secrets (
  family_id uuid primary key references orbit.families(id) on delete cascade,
  update_token text,
  updated_at timestamptz not null default now()
);
alter table orbit.family_secrets enable row level security;
drop policy if exists parent_all on orbit.family_secrets;
create policy parent_all on orbit.family_secrets for all to authenticated
  using (family_id = orbit.parent_family()) with check (family_id = orbit.parent_family());
grant select, insert, update on orbit.family_secrets to authenticated;

create or replace function orbit.device_update_token() returns text
language plpgsql stable security definer set search_path = '' as $$
declare dev orbit.devices := orbit.current_device();
begin
  if dev.id is null or dev.kind <> 'child_phone' then raise exception 'not_allowed'; end if;
  return (select update_token from orbit.family_secrets where family_id = dev.family_id);
end $$;
grant execute on function orbit.device_update_token() to authenticated;

-- Yedek kurulum dosyası (QR ile kurulum ve anahtarı henüz olmayan telefonlar)
insert into storage.buckets (id, name, public) values ('orbit-install', 'orbit-install', true)
on conflict (id) do update set public = true;
