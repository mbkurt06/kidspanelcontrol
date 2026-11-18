-- Web sayfası girişleri: her çocuk için kasadaki hangi kayıt kullanılacak; panelden "telefonda dene"
alter table orbit.web_apps add column if not exists login_url text;

create table if not exists orbit.web_app_logins (
  web_app_id uuid not null references orbit.web_apps(id) on delete cascade,
  child_id uuid not null references orbit.children(id) on delete cascade,
  family_id uuid not null references orbit.families(id) on delete cascade,
  mode text not null default 'auto' check (mode in ('auto','entry','off')),
  entry_id uuid,
  updated_at timestamptz not null default now(),
  primary key (web_app_id, child_id)
);
alter table orbit.web_app_logins enable row level security;
drop policy if exists parent_all on orbit.web_app_logins;
create policy parent_all on orbit.web_app_logins for all to authenticated
  using (family_id = orbit.parent_family()) with check (family_id = orbit.parent_family());
drop policy if exists device_read on orbit.web_app_logins;
create policy device_read on orbit.web_app_logins for select to authenticated using (child_id = orbit.device_child());
grant select, insert, update, delete on orbit.web_app_logins to authenticated;
drop trigger if exists rt_notify on orbit.web_app_logins;
create trigger rt_notify after insert or update or delete on orbit.web_app_logins for each row execute function orbit.rt_notify();

create table if not exists orbit.web_login_tests (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references orbit.families(id) on delete cascade,
  child_id uuid not null references orbit.children(id) on delete cascade,
  web_app_id uuid not null references orbit.web_apps(id) on delete cascade,
  status text not null default 'pending' check (status in ('pending','running','ok','fail','error')),
  final_url text,
  message text,
  created_at timestamptz not null default now(),
  done_at timestamptz
);
create index if not exists web_login_tests_child on orbit.web_login_tests (child_id, created_at desc);
alter table orbit.web_login_tests enable row level security;
drop policy if exists parent_all on orbit.web_login_tests;
create policy parent_all on orbit.web_login_tests for all to authenticated
  using (family_id = orbit.parent_family()) with check (family_id = orbit.parent_family());
drop policy if exists device_read on orbit.web_login_tests;
create policy device_read on orbit.web_login_tests for select to authenticated using (child_id = orbit.device_child());
drop policy if exists device_update on orbit.web_login_tests;
create policy device_update on orbit.web_login_tests for update to authenticated
  using (child_id = orbit.device_child()) with check (child_id = orbit.device_child());
grant select, insert, update, delete on orbit.web_login_tests to authenticated;
drop trigger if exists rt_notify on orbit.web_login_tests;
create trigger rt_notify after insert on orbit.web_login_tests for each row execute function orbit.rt_notify();
