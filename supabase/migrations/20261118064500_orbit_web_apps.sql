-- Web sayfası / YouTube video listesi: telefonda Orbit içinde uygulama gibi açılır.
-- Her kayıt için child_apps'ta 'web:<id>' paketli bir satır olur; grup, durum, özel kural, kiosk oradan yönetilir.
create table if not exists orbit.web_apps (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references orbit.families(id) on delete cascade,
  child_id uuid not null references orbit.children(id) on delete cascade,
  kind text not null default 'site' check (kind in ('site','videos')),
  title text not null,
  url text,
  allowed_domains text[] not null default '{}',
  videos jsonb not null default '[]'::jsonb,   -- [{type:'video'|'playlist', id, title}]
  autoplay boolean not null default true,
  loop boolean not null default false,
  strict boolean not null default true,
  history boolean not null default true,
  downloads boolean not null default false,
  media boolean not null default false,
  fullscreen boolean not null default true,
  safe_search boolean not null default true,
  remember_login boolean not null default true,
  login_mode text not null default 'auto' check (login_mode in ('off','fill','auto')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists web_apps_child on orbit.web_apps(child_id);

create table if not exists orbit.web_visits (
  id bigint generated always as identity primary key,
  family_id uuid not null references orbit.families(id) on delete cascade,
  child_id uuid not null references orbit.children(id) on delete cascade,
  web_app_id uuid not null references orbit.web_apps(id) on delete cascade,
  url text not null,
  title text,
  blocked boolean not null default false,
  at timestamptz not null default now()
);
create index if not exists web_visits_app on orbit.web_visits(web_app_id, at desc);

alter table orbit.web_apps enable row level security;
alter table orbit.web_visits enable row level security;
drop policy if exists parent_all on orbit.web_apps;
create policy parent_all on orbit.web_apps for all to authenticated
  using (family_id = orbit.parent_family()) with check (family_id = orbit.parent_family());
drop policy if exists device_read on orbit.web_apps;
create policy device_read on orbit.web_apps for select to authenticated using (child_id = orbit.device_child());
drop policy if exists parent_read on orbit.web_visits;
create policy parent_read on orbit.web_visits for select to authenticated using (family_id = orbit.parent_family());
drop policy if exists parent_delete on orbit.web_visits;
create policy parent_delete on orbit.web_visits for delete to authenticated using (family_id = orbit.parent_family());
drop policy if exists device_insert on orbit.web_visits;
create policy device_insert on orbit.web_visits for insert to authenticated
  with check (child_id = orbit.device_child() and family_id = orbit.device_family());
grant select, insert, update, delete on orbit.web_apps to authenticated;
grant select, insert, delete on orbit.web_visits to authenticated;

-- child_apps satırını eşle
create or replace function orbit.web_app_sync() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    delete from orbit.child_apps where child_id = old.child_id and package = 'web:' || old.id;
    return old;
  end if;
  insert into orbit.child_apps (child_id, package, label, is_system, installed, app_group, approved, category)
  values (new.child_id, 'web:' || new.id, new.title, false, true, 'timed', true, null)
  on conflict (child_id, package) do update set label = excluded.label, installed = true, updated_at = now();
  return new;
end $$;
drop trigger if exists web_app_sync on orbit.web_apps;
create trigger web_app_sync after insert or update of title or delete on orbit.web_apps
  for each row execute function orbit.web_app_sync();

-- Telefonun uygulama raporu web satırlarını "kaldırıldı" yapmasın
create or replace function orbit.device_report_apps(p_apps jsonb)
 returns void language plpgsql security definer set search_path to ''
as $function$
declare
  dev orbit.devices := orbit.current_device();
  a jsonb;
  is_new boolean;
  pkgs text[];
begin
  if dev.id is null or dev.kind <> 'child_phone' then raise exception 'not_allowed'; end if;
  select coalesce(array_agg(x ->> 'package'), '{}') into pkgs from jsonb_array_elements(p_apps) x;
  update orbit.child_apps set installed = false
   where child_id = dev.child_id and installed and not (package = any (pkgs)) and package not like 'web:%';
  for a in select * from jsonb_array_elements(p_apps) loop
    is_new := not exists (select 1 from orbit.child_apps where child_id = dev.child_id and package = a ->> 'package');
    insert into orbit.child_apps (child_id, package, label, is_system, installed, app_group, approved, category)
    values (dev.child_id, a ->> 'package', coalesce(a ->> 'label', a ->> 'package'),
            coalesce((a ->> 'system')::boolean, false), true,
            coalesce(a ->> 'default_group', 'blocked'),
            coalesce((a ->> 'preapproved')::boolean, false),
            a ->> 'category')
    on conflict (child_id, package) do update
      set label = excluded.label, installed = true, updated_at = now(),
          category = coalesce(excluded.category, orbit.child_apps.category)
      where orbit.child_apps.label is distinct from excluded.label
         or not orbit.child_apps.installed
         or (excluded.category is not null and orbit.child_apps.category is distinct from excluded.category);
    if is_new and not coalesce((a ->> 'preapproved')::boolean, false) and (a ->> 'initial') is null then
      insert into orbit.events (family_id, child_id, type, payload)
      values (dev.family_id, dev.child_id, 'app_installed',
              jsonb_build_object('package', a ->> 'package', 'label', a ->> 'label'));
    end if;
  end loop;
end;
$function$;

-- Değişince telefona haber ver
drop trigger if exists rt_notify on orbit.web_apps;
create trigger rt_notify after insert or update or delete on orbit.web_apps for each row execute function orbit.rt_notify();
