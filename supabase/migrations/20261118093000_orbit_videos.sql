-- Videolarım: panelden OneDrive'a yüklenen videolar; telefon bir kez indirir, Orbit'in oynatıcısında oynatır.
-- Her liste her çocukta bir child_apps satırı ('video:<id>'): durum/kiosk/özel kural oradan.
create table if not exists orbit.video_lists (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references orbit.families(id) on delete cascade,
  child_id uuid references orbit.children(id) on delete set null,
  name text not null,
  emoji text not null default '🎬',
  sort int not null default 0,
  created_at timestamptz not null default now()
);
create table if not exists orbit.videos (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references orbit.families(id) on delete cascade,
  list_id uuid not null references orbit.video_lists(id) on delete cascade,
  title text not null,
  file_name text,
  size_bytes bigint,
  duration_sec int,
  width int,
  height int,
  mime text,
  item_id text,
  thumb text,
  sort int not null default 0,
  status text not null default 'uploading' check (status in ('uploading','ready')),
  created_at timestamptz not null default now()
);
create index if not exists videos_list on orbit.videos(list_id, sort);
create table if not exists orbit.child_video_settings (
  child_id uuid primary key references orbit.children(id) on delete cascade,
  family_id uuid not null references orbit.families(id) on delete cascade,
  can_delete boolean not null default true,
  can_redownload boolean not null default false,
  auto_delete_days int,
  max_gb numeric not null default 4,
  wifi_only boolean not null default true,
  updated_at timestamptz not null default now()
);
create table if not exists orbit.video_progress (
  child_id uuid not null references orbit.children(id) on delete cascade,
  video_id uuid not null references orbit.videos(id) on delete cascade,
  family_id uuid not null references orbit.families(id) on delete cascade,
  position_sec int not null default 0,
  duration_sec int,
  watched boolean not null default false,
  removed boolean not null default false,
  downloaded boolean not null default false,
  updated_at timestamptz not null default now(),
  primary key (child_id, video_id)
);

alter table orbit.video_lists enable row level security;
alter table orbit.videos enable row level security;
alter table orbit.child_video_settings enable row level security;
alter table orbit.video_progress enable row level security;
do $$ declare t text; begin
  foreach t in array array['video_lists','videos','child_video_settings','video_progress'] loop
    execute format('drop policy if exists parent_all on orbit.%I', t);
    execute format('create policy parent_all on orbit.%I for all to authenticated using (family_id = orbit.parent_family()) with check (family_id = orbit.parent_family())', t);
  end loop;
end $$;
drop policy if exists device_read on orbit.video_lists;
create policy device_read on orbit.video_lists for select to authenticated using (family_id = orbit.device_family());
drop policy if exists device_read on orbit.videos;
create policy device_read on orbit.videos for select to authenticated using (family_id = orbit.device_family());
drop policy if exists device_read on orbit.child_video_settings;
create policy device_read on orbit.child_video_settings for select to authenticated using (child_id = orbit.device_child());
drop policy if exists device_all on orbit.video_progress;
create policy device_all on orbit.video_progress for all to authenticated
  using (child_id = orbit.device_child()) with check (child_id = orbit.device_child() and family_id = orbit.device_family());
grant select, insert, update, delete on orbit.video_lists, orbit.videos, orbit.child_video_settings, orbit.video_progress to authenticated;

-- Liste ↔ child_apps ('video:<id>'): oluşturulduğu çocukta "Kurallara göre", diğerlerinde "Hep kapalı"
create or replace function orbit.video_list_sync() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    delete from orbit.child_apps where package = 'video:' || old.id
      and child_id in (select id from orbit.children where family_id = old.family_id);
    return old;
  end if;
  insert into orbit.child_apps (child_id, package, label, is_system, installed, app_group, approved, category)
  select c.id, 'video:' || new.id, new.name, false, true,
         case when c.id = new.child_id then 'timed' else 'blocked' end, true, null
    from orbit.children c where c.family_id = new.family_id
  on conflict (child_id, package) do update set label = excluded.label, installed = true, updated_at = now();
  return new;
end $$;
drop trigger if exists video_list_sync on orbit.video_lists;
create trigger video_list_sync after insert or update of name or delete on orbit.video_lists
  for each row execute function orbit.video_list_sync();

-- Yeni çocuk: ailenin web sayfaları ve video listeleri "Hep kapalı"
create or replace function orbit.web_apps_for_child() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into orbit.child_apps (child_id, package, label, is_system, installed, app_group, approved, category)
  select new.id, 'web:' || w.id, w.title, false, true, 'blocked', true, null
    from orbit.web_apps w where w.family_id = new.family_id
  on conflict (child_id, package) do nothing;
  insert into orbit.child_apps (child_id, package, label, is_system, installed, app_group, approved, category)
  select new.id, 'video:' || l.id, l.name, false, true, 'blocked', true, null
    from orbit.video_lists l where l.family_id = new.family_id
  on conflict (child_id, package) do nothing;
  return new;
end $$;

-- Telefonun uygulama raporu sanal satırları ("web:", "video:") kaldırılmış saymasın
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
   where child_id = dev.child_id and installed and not (package = any (pkgs))
     and package not like 'web:%' and package not like 'video:%';
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

-- Değişince telefonlara haber ver
do $$ declare t text; begin
  foreach t in array array['video_lists','videos','child_video_settings'] loop
    execute format('drop trigger if exists rt_notify on orbit.%I', t);
    execute format('create trigger rt_notify after insert or update or delete on orbit.%I for each row execute function orbit.rt_notify()', t);
  end loop;
end $$;
