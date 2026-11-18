-- Kişiler: çocukların Orbit ana ekranında görünen anne/baba numarası ve önemli bilgiler (arama yok, sadece bilgi)
create table if not exists orbit.contacts (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references orbit.families(id) on delete cascade,
  name text not null,
  emoji text not null default '👤',
  value text not null default '',
  child_ids uuid[] not null default '{}',
  sort int not null default 0,
  created_at timestamptz not null default now()
);
alter table orbit.contacts enable row level security;
drop policy if exists parent_all on orbit.contacts;
create policy parent_all on orbit.contacts for all to authenticated
  using (family_id = orbit.parent_family()) with check (family_id = orbit.parent_family());
drop policy if exists device_read on orbit.contacts;
create policy device_read on orbit.contacts for select to authenticated
  using (family_id = orbit.device_family() and orbit.device_child() = any(child_ids));
grant select, insert, update, delete on orbit.contacts to authenticated;
drop trigger if exists rt_notify on orbit.contacts;
create trigger rt_notify after insert or update or delete on orbit.contacts for each row execute function orbit.rt_notify();
