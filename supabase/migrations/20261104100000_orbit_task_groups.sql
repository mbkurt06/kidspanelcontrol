-- Görev grupları: sıra, tamamlama koşulu, ödül kuralı, zaman/tekrar; görev varsayılanları; ajandadan görev.

create table if not exists orbit.task_groups (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references orbit.families(id) on delete cascade,
  name text not null check (length(trim(name)) between 1 and 80),
  child_ids uuid[] not null default '{}',
  active boolean not null default true,
  -- once | days | biweekly | monthly
  recurrence text not null default 'days' check (recurrence in ('once','days','biweekly','monthly')),
  days smallint[] not null default '{1,2,3,4,5,6,7}',
  start_date date not null default (now() at time zone 'Europe/Berlin')::date,
  end_date date,
  start_time time,
  due_time time,
  sequential boolean not null default false,
  -- null = hepsi
  min_count int check (min_count is null or min_count >= 1),
  -- done = yaptığı görevlerin süresi, all = grubun toplamı
  reward_mode text not null default 'done' check (reward_mode in ('done','all')),
  -- today (hemen) | wallet | vault
  reward_validity text not null default 'today' check (reward_validity in ('today','wallet','vault')),
  -- koşul sağlanmazsa: vault = kazanılan kasaya, burn = yanar, penalty = yanar + ceza
  fail_mode text not null default 'vault' check (fail_mode in ('vault','burn','penalty')),
  penalty_minutes int check (penalty_minutes is null or penalty_minutes > 0),
  defaults jsonb,
  sort int not null default 0,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);
create index if not exists task_groups_family_idx on orbit.task_groups(family_id);

alter table orbit.tasks add column if not exists group_id uuid references orbit.task_groups(id) on delete set null;
alter table orbit.tasks add column if not exists group_order int not null default 0;
alter table orbit.families add column if not exists task_defaults jsonb;
alter table orbit.agenda_items add column if not exists task_id uuid references orbit.tasks(id) on delete set null;
create index if not exists tasks_group_idx on orbit.tasks(group_id, group_order);

-- Bir grubun bir çocuk için bir günkü sonucu
create table if not exists orbit.task_group_runs (
  group_id uuid not null references orbit.task_groups(id) on delete cascade,
  child_id uuid not null references orbit.children(id) on delete cascade,
  day date not null,
  status text not null default 'open' check (status in ('open','met','failed')),
  grant_id uuid,
  settled_at timestamptz,
  primary key (group_id, child_id, day)
);

alter table orbit.task_groups enable row level security;
alter table orbit.task_group_runs enable row level security;
create policy parent_all on orbit.task_groups for all to authenticated
  using (family_id = orbit.parent_family()) with check (family_id = orbit.parent_family());
create policy device_read on orbit.task_groups for select to authenticated
  using (orbit.device_child() = any(child_ids));
create policy parent_all on orbit.task_group_runs for all to authenticated
  using (exists (select 1 from orbit.task_groups g where g.id = group_id and g.family_id = orbit.parent_family()))
  with check (exists (select 1 from orbit.task_groups g where g.id = group_id and g.family_id = orbit.parent_family()));
create policy device_read on orbit.task_group_runs for select to authenticated
  using (child_id = orbit.device_child());

grant select, insert, update, delete on orbit.task_groups, orbit.task_group_runs to authenticated;
grant all on orbit.task_groups, orbit.task_group_runs to service_role;
alter publication supabase_realtime add table orbit.task_groups;
alter publication supabase_realtime add table orbit.task_group_runs;

-- Çocuk, göreve dönüşmüş ajanda girdisini değiştiremez / işaretleyemez
create or replace function orbit.guard_phone_agenda()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.child_id = orbit.device_child() and (
    new.id is distinct from old.id or
    new.family_id is distinct from old.family_id or
    new.child_id is distinct from old.child_id or
    new.entered_at is distinct from old.entered_at or
    new.created_by is distinct from old.created_by or
    new.created_at is distinct from old.created_at or
    new.task_id is distinct from old.task_id or
    (old.task_id is not null and (new.status is distinct from old.status or new.title is distinct from old.title or new.due_date is distinct from old.due_date))
  ) then
    raise exception 'not_allowed';
  end if;
  return new;
end;
$$;
