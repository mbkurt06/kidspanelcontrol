-- Uygulamaya özel süre: "WhatsApp'a 10 dk" (kullandıkça düşer, gün bitince silinir; genel süreden ayrı)
create table if not exists orbit.app_grants (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references orbit.families(id) on delete cascade,
  child_id uuid not null references orbit.children(id) on delete cascade,
  day date not null,
  package text not null,
  minutes int not null,
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now()
);
create index if not exists app_grants_child_day on orbit.app_grants (child_id, day);
alter table orbit.app_grants enable row level security;
drop policy if exists parent_all on orbit.app_grants;
create policy parent_all on orbit.app_grants for all to authenticated
  using (family_id = orbit.parent_family()) with check (family_id = orbit.parent_family());
drop policy if exists device_read on orbit.app_grants;
create policy device_read on orbit.app_grants for select to authenticated using (child_id = orbit.device_child());
grant select, insert, update, delete on orbit.app_grants to authenticated;
drop trigger if exists rt_notify on orbit.app_grants;
create trigger rt_notify after insert or update or delete on orbit.app_grants for each row execute function orbit.rt_notify();

-- Bugünlük genel süre kısıtı: genel süre sadece seçilen uygulamalarda, isteğe bağlı uygulama başına üst sınır
create table if not exists orbit.day_app_limits (
  child_id uuid not null references orbit.children(id) on delete cascade,
  day date not null,
  family_id uuid not null references orbit.families(id) on delete cascade,
  only_apps boolean not null default true,
  apps text[] not null default '{}',
  caps jsonb not null default '{}',
  updated_at timestamptz not null default now(),
  primary key (child_id, day)
);
alter table orbit.day_app_limits enable row level security;
drop policy if exists parent_all on orbit.day_app_limits;
create policy parent_all on orbit.day_app_limits for all to authenticated
  using (family_id = orbit.parent_family()) with check (family_id = orbit.parent_family());
drop policy if exists device_read on orbit.day_app_limits;
create policy device_read on orbit.day_app_limits for select to authenticated using (child_id = orbit.device_child());
grant select, insert, update, delete on orbit.day_app_limits to authenticated;
drop trigger if exists rt_notify on orbit.day_app_limits;
create trigger rt_notify after insert or update or delete on orbit.day_app_limits for each row execute function orbit.rt_notify();
