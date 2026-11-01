create table orbit.agenda_items (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references orbit.families(id) on delete cascade,
  child_id uuid not null references orbit.children(id) on delete cascade,
  kind text not null default 'homework' check (kind in ('homework', 'exam', 'payment', 'event')),
  title text not null check (length(trim(title)) between 1 and 160),
  note text,
  entered_at timestamptz not null default now(),
  due_date date not null,
  due_time time,
  amount numeric(10,2) check (amount is null or amount >= 0),
  currency text not null default 'EUR' check (currency ~ '^[A-Z]{3}$'),
  status text not null default 'open' check (status in ('open', 'done')),
  completed_at timestamptz,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index agenda_items_child_due_idx on orbit.agenda_items(child_id, due_date, status);
create index agenda_items_family_due_idx on orbit.agenda_items(family_id, due_date, status);

alter table orbit.agenda_items enable row level security;

create policy parent_all on orbit.agenda_items for all to authenticated
  using (family_id = orbit.parent_family())
  with check (family_id = orbit.parent_family());

create policy phone_read on orbit.agenda_items for select to authenticated
  using (child_id = orbit.device_child());

create policy phone_insert on orbit.agenda_items for insert to authenticated
  with check (child_id = orbit.device_child() and family_id = orbit.device_family());

create policy phone_update on orbit.agenda_items for update to authenticated
  using (child_id = orbit.device_child())
  with check (child_id = orbit.device_child() and family_id = orbit.device_family());

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
    new.created_at is distinct from old.created_at
  ) then
    raise exception 'not_allowed';
  end if;
  return new;
end;
$$;

create trigger guard_phone_agenda before update on orbit.agenda_items
  for each row execute function orbit.guard_phone_agenda();

grant select, insert, update, delete on orbit.agenda_items to authenticated;
grant all on orbit.agenda_items to service_role;
alter publication supabase_realtime add table orbit.agenda_items;
