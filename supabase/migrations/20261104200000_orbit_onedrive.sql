-- Kanıt dosyaları (fotoğraf, ekran görüntüsü, kamera ve ekran kaydı) ebeveynin OneDrive'ına:
-- OneDrive > Uygulamalar > Orbit > <çocuk> > <tarih>. Bağlantı bilgileri sadece sunucuda (service role) okunur.
-- Kanıt yolu "<aile>/<koşu>/od:<OneDrive öğe id>" biçiminde saklanır.

create table if not exists orbit.cloud_storage (
  family_id uuid primary key references orbit.families(id) on delete cascade,
  provider text not null default 'onedrive',
  client_id text,
  client_secret text,
  refresh_token text,
  access_token text,
  access_expires timestamptz,
  account text,
  state text,
  state_expires timestamptz,
  return_to text,
  connected_at timestamptz,
  updated_at timestamptz not null default now()
);
alter table orbit.cloud_storage enable row level security;
-- Politika yok: istemciler doğrudan okuyamaz, sadece aşağıdaki fonksiyonlar ve sunucu.

alter table orbit.families add column if not exists cloud_retention_days int not null default 3 check (cloud_retention_days between 1 and 45);

create or replace function orbit.parent_cloud_status()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare fam uuid := orbit.parent_family(); c orbit.cloud_storage; days int;
begin
  if fam is null then raise exception 'not_allowed'; end if;
  select * into c from orbit.cloud_storage where family_id = fam;
  select cloud_retention_days into days from orbit.families where id = fam;
  return jsonb_build_object('configured', c.client_id is not null, 'connected', c.refresh_token is not null,
    'account', c.account, 'connected_at', c.connected_at, 'client_id', c.client_id, 'retention_days', days);
end; $$;
grant execute on function orbit.parent_cloud_status() to authenticated;

create or replace function orbit.device_whoami()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare dev orbit.devices := orbit.current_device();
begin
  if dev.id is null or dev.kind <> 'child_phone' then raise exception 'not_allowed'; end if;
  return jsonb_build_object('child_id', dev.child_id, 'family_id', dev.family_id,
    'child_name', (select name from orbit.children where id = dev.child_id));
end; $$;
grant execute on function orbit.device_whoami() to authenticated;

/** Gerçek zamanlı video kaydı (kare hızı oynatmayla aynı) */
create or replace function orbit.device_record_realtime(p_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare dev orbit.devices := orbit.current_device();
begin
  if dev.id is null or dev.kind <> 'child_phone' then raise exception 'not_allowed'; end if;
  update orbit.task_recordings set capture_fps = 30, video_fps = 30 where id = p_id and child_id = dev.child_id;
end; $$;
grant execute on function orbit.device_record_realtime(uuid) to authenticated;

-- Temizlik: OneDrive'daki kanıtlar ayardaki gün sayısı (varsayılan 3) dolunca silinir
create or replace function orbit.mark_proofs_for_cleanup()
returns integer language plpgsql security definer set search_path = '' as $$
declare n int;
begin
  update orbit.task_proofs p set removed_at = now()
   where p.removed_at is null
     and (p.delete_after < now()
          or p.created_at < now() - interval '45 days'
          or (p.path like '%/od:%' and p.created_at < now() - make_interval(days => coalesce((select f.cloud_retention_days from orbit.families f where f.id = p.family_id), 3)))
          or exists (select 1 from orbit.task_runs r where r.id = p.run_id and r.status in ('expired', 'claimed')));
  get diagnostics n = row_count;
  return n;
end; $$;

-- Onayda: OneDrive dosyaları hemen silinmez, gün sayısı dolunca silinir
do $do$
declare src text := pg_get_functiondef('orbit.parent_decide_run(uuid,boolean,text,integer,text,date,date)'::regprocedure);
begin
  src := replace(src,
    'select coalesce(array_agg(path), ''{}'') into paths from orbit.task_proofs where run_id = r.id and removed_at is null;',
    'select coalesce(array_agg(path), ''{}'') into paths from orbit.task_proofs where run_id = r.id and removed_at is null and path not like ''%/od:%'';');
  src := replace(src,
    'update orbit.task_proofs set removed_at = now() where run_id = r.id and removed_at is null;',
    'update orbit.task_proofs set removed_at = now() where run_id = r.id and removed_at is null and path not like ''%/od:%'';
      update orbit.task_proofs set delete_after = created_at + make_interval(days => (select cloud_retention_days from orbit.families where id = fam)) where run_id = r.id and removed_at is null and path like ''%/od:%'';');
  execute src;
end $do$;
