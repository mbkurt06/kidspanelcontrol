-- Çocuğun kendi planı (yapılacaklar + hatırlatma). Kurallarla bağlantısı yok; ebeveyn sadece görür.
create table if not exists orbit.plan_categories (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references orbit.families(id) on delete cascade,
  child_id uuid not null references orbit.children(id) on delete cascade,
  name text not null,
  emoji text not null default '📌',
  created_at timestamptz not null default now()
);
create table if not exists orbit.plan_items (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references orbit.families(id) on delete cascade,
  child_id uuid not null references orbit.children(id) on delete cascade,
  day date not null,
  title text not null,
  category text,
  emoji text,
  at time,
  remind boolean not null default false,
  remind_before int not null default 0,
  repeat text not null default 'none' check (repeat in ('none','daily','weekdays','days')),
  repeat_days int[] not null default '{}',
  ends_on date,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists plan_items_child on orbit.plan_items(child_id, day);
create table if not exists orbit.plan_checks (
  item_id uuid not null references orbit.plan_items(id) on delete cascade,
  day date not null,
  family_id uuid not null references orbit.families(id) on delete cascade,
  child_id uuid not null references orbit.children(id) on delete cascade,
  done boolean not null default true,
  skipped boolean not null default false,
  at timestamptz not null default now(),
  primary key (item_id, day)
);
alter table orbit.plan_categories enable row level security;
alter table orbit.plan_items enable row level security;
alter table orbit.plan_checks enable row level security;
do $$ declare t text; begin
  foreach t in array array['plan_categories','plan_items','plan_checks'] loop
    execute format('drop policy if exists parent_read on orbit.%I', t);
    execute format('create policy parent_read on orbit.%I for select using (family_id = orbit.parent_family())', t);
    execute format('drop policy if exists device_all on orbit.%I', t);
    execute format('create policy device_all on orbit.%I for all using (child_id = orbit.device_child()) with check (child_id = orbit.device_child() and family_id = orbit.device_family())', t);
  end loop;
end $$;
grant select, insert, update, delete on orbit.plan_categories, orbit.plan_items, orbit.plan_checks to authenticated;
