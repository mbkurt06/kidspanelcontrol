-- Sayaç (çalışma süresi), odak profilleri, etkinlikler, alarm ve hatırlatıcılar.

-- --- Odak profilleri: sayaç çalışırken telefonda ne açık kalsın (sadece daha fazla kısıtlar) ---
create table orbit.focus_profiles (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references orbit.families(id) on delete cascade,
  name text not null,
  icon text,
  allowed_groups uuid[] not null default '{}',
  allowed_packages text[] not null default '{}',
  messages_allowed boolean not null default true,
  calls_allowed boolean not null default true,
  sort_order int not null default 0,
  created_at timestamptz not null default now()
);
create index on orbit.focus_profiles (family_id);

-- --- Etkinlikler (Matematik, Kitap…) ---
create table orbit.activities (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references orbit.families(id) on delete cascade,
  name text not null,
  icon text,
  default_focus_id uuid references orbit.focus_profiles(id) on delete set null,
  -- Ödül: her reward_every dk odaklı çalışmaya reward_minutes dk ekstra süre
  reward_every int check (reward_every is null or reward_every > 0),
  reward_minutes int check (reward_minutes is null or reward_minutes > 0),
  reward_to text not null default 'today' check (reward_to in ('today', 'vault')),
  sort_order int not null default 0,
  created_at timestamptz not null default now()
);
create index on orbit.activities (family_id);

-- --- Sayaçlar ---
create table orbit.timer_sessions (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references orbit.families(id) on delete cascade,
  child_id uuid not null references orbit.children(id) on delete cascade,
  activity_id uuid references orbit.activities(id) on delete set null,
  title text not null,
  icon text,
  kind text not null check (kind in ('countdown', 'stopwatch')),
  planned_seconds int check (planned_seconds is null or planned_seconds > 0),
  focus_id uuid references orbit.focus_profiles(id) on delete set null,
  started_by text not null check (started_by in ('child', 'parent')),
  -- Ebeveynin başlattığında çocuğun yetkileri (çocuğun kendi sayacında hepsi serbest)
  allow_stop text not null default 'yes' check (allow_stop in ('no', 'yes', 'notify')),
  pause_mode text not null default 'child' check (pause_mode in ('none', 'limit', 'child')),
  pause_max_minutes int,
  focus_change text not null default 'free' check (focus_change in ('no', 'stricter', 'free')),
  status text not null default 'running' check (status in ('running', 'paused', 'done', 'stopped', 'cancelled')),
  started_at timestamptz not null default now(),
  paused_at timestamptz,
  paused_seconds int not null default 0,
  ended_at timestamptz,
  ended_by text check (ended_by in ('child', 'parent', 'auto')),
  focused_seconds int not null default 0,
  away_seconds int not null default 0,
  grant_id uuid references orbit.time_grants(id) on delete set null,
  updated_at timestamptz not null default now()
);
create index on orbit.timer_sessions (child_id, started_at desc);
create index on orbit.timer_sessions (status);

-- Ebeveynin başlattığı sayaçlar için çocuk başına varsayılanlar
alter table orbit.children add column if not exists timer_defaults jsonb not null
  default '{"allow_stop":"notify","pause_mode":"limit","pause_max_minutes":5,"focus_change":"stricter"}';

-- --- Alarm ve hatırlatıcılar ---
create table orbit.alarms (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references orbit.families(id) on delete cascade,
  child_id uuid not null references orbit.children(id) on delete cascade,
  by_parent boolean not null default false,
  title text not null,
  kind text not null default 'alarm' check (kind in ('alarm', 'reminder')),
  at_time time not null,
  -- boş = tek seferlik (on_date), dolu = haftanın günleri (1 = Pzt)
  days smallint[] not null default '{}',
  on_date date,
  active boolean not null default true,
  child_can_edit boolean not null default true,
  child_can_delete boolean not null default true,
  snooze_max int not null default 3 check (snooze_max between 0 and 10),
  snooze_minutes int not null default 5 check (snooze_minutes between 1 and 30),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index on orbit.alarms (child_id);

create table orbit.alarm_log (
  id uuid primary key default gen_random_uuid(),
  alarm_id uuid references orbit.alarms(id) on delete set null,
  child_id uuid not null references orbit.children(id) on delete cascade,
  title text,
  fired_at timestamptz not null default now(),
  dismissed_at timestamptz,
  snoozes int not null default 0
);
create index on orbit.alarm_log (child_id, fired_at desc);

-- --- Yetkiler ---
alter table orbit.focus_profiles enable row level security;
alter table orbit.activities enable row level security;
alter table orbit.timer_sessions enable row level security;
alter table orbit.alarms enable row level security;
alter table orbit.alarm_log enable row level security;

create policy parent_all on orbit.focus_profiles for all to authenticated
  using (family_id = orbit.parent_family()) with check (family_id = orbit.parent_family());
create policy parent_all on orbit.activities for all to authenticated
  using (family_id = orbit.parent_family()) with check (family_id = orbit.parent_family());
create policy parent_all on orbit.timer_sessions for all to authenticated
  using (family_id = orbit.parent_family()) with check (family_id = orbit.parent_family());
create policy parent_all on orbit.alarms for all to authenticated
  using (family_id = orbit.parent_family()) with check (family_id = orbit.parent_family());
create policy parent_all on orbit.alarm_log for all to authenticated
  using (child_id in (select id from orbit.children where family_id = orbit.parent_family()))
  with check (child_id in (select id from orbit.children where family_id = orbit.parent_family()));

create policy device_read on orbit.focus_profiles for select to authenticated using (family_id = orbit.device_family());
create policy device_read on orbit.activities for select to authenticated using (family_id = orbit.device_family());

create policy phone_all on orbit.timer_sessions for all to authenticated
  using (child_id = orbit.device_child()) with check (child_id = orbit.device_child() and family_id = orbit.device_family());
create policy phone_all on orbit.alarms for all to authenticated
  using (child_id = orbit.device_child()) with check (child_id = orbit.device_child() and family_id = orbit.device_family());
create policy phone_all on orbit.alarm_log for all to authenticated
  using (child_id = orbit.device_child()) with check (child_id = orbit.device_child());

-- Telefon: ebeveynin kurduğu sayaç ve alarmlarda izin verilenin dışına çıkamaz
create or replace function orbit.guard_phone_timers()
returns trigger language plpgsql security definer set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    if orbit.device_child() is not null then raise exception 'not_allowed'; end if;
    return old;
  end if;
  if orbit.device_child() is null then
    new.updated_at := now();
    return new;
  end if;
  if tg_op = 'INSERT' then
    new.started_by := 'child';
    new.allow_stop := 'yes'; new.pause_mode := 'child'; new.focus_change := 'free';
    new.updated_at := now();
    return new;
  end if;
  -- Değiştirilemez alanlar
  if (new.started_by, new.allow_stop, new.pause_mode, new.pause_max_minutes, new.focus_change, new.child_id, new.family_id, new.kind, new.planned_seconds, new.started_at)
     is distinct from (old.started_by, old.allow_stop, old.pause_mode, old.pause_max_minutes, old.focus_change, old.child_id, old.family_id, old.kind, old.planned_seconds, old.started_at) then
    raise exception 'not_allowed';
  end if;
  if old.started_by = 'parent' then
    if new.status in ('stopped', 'cancelled') and old.status in ('running', 'paused') and old.allow_stop = 'no' then
      raise exception 'not_allowed';
    end if;
    if new.status = 'paused' and old.status = 'running' and old.pause_mode = 'none' then
      raise exception 'not_allowed';
    end if;
    if new.focus_id is distinct from old.focus_id and old.focus_change = 'no' then
      raise exception 'not_allowed';
    end if;
  end if;
  new.updated_at := now();
  return new;
end;
$$;
create trigger guard_phone_timers before insert or update or delete on orbit.timer_sessions
  for each row execute function orbit.guard_phone_timers();

create or replace function orbit.guard_phone_alarms()
returns trigger language plpgsql security definer set search_path = ''
as $$
begin
  if orbit.device_child() is null then
    if tg_op = 'INSERT' then new.by_parent := true; end if;
    if tg_op <> 'DELETE' then new.updated_at := now(); return new; end if;
    return old;
  end if;
  if tg_op = 'INSERT' then
    new.by_parent := false; new.child_can_edit := true; new.child_can_delete := true;
    new.updated_at := now();
    return new;
  end if;
  if tg_op = 'DELETE' then
    if old.by_parent and not old.child_can_delete then raise exception 'not_allowed'; end if;
    return old;
  end if;
  if old.by_parent and not old.child_can_edit then raise exception 'not_allowed'; end if;
  if (new.by_parent, new.child_can_edit, new.child_can_delete, new.snooze_max, new.child_id, new.family_id)
     is distinct from (old.by_parent, old.child_can_edit, old.child_can_delete, old.snooze_max, old.child_id, old.family_id) then
    raise exception 'not_allowed';
  end if;
  new.updated_at := now();
  return new;
end;
$$;
create trigger guard_phone_alarms before insert or update or delete on orbit.alarms
  for each row execute function orbit.guard_phone_alarms();

-- Sayaç olayları: başladı / bitti / erken bitti / iptal → Olaylar; ebeveyn sayacı erken bitirilirse bildirim
-- Bitince etkinliğin ödülü (odaklı süreye göre) ekstra süre olarak verilir.
create or replace function orbit.on_timer_change()
returns trigger language plpgsql security definer set search_path = ''
as $$
declare
  a orbit.activities;
  mins int;
  gid uuid;
  ev text;
  alert boolean := false;
  early boolean;
begin
  if tg_op = 'INSERT' then
    insert into orbit.events (family_id, child_id, type, payload, read_at)
    values (new.family_id, new.child_id, 'timer', jsonb_build_object('session_id', new.id, 'title', new.title, 'status', 'started', 'by', new.started_by), now());
    return new;
  end if;
  if new.status = old.status or new.status not in ('done', 'stopped', 'cancelled') then return new; end if;
  early := new.kind = 'countdown' and new.status in ('stopped', 'cancelled');
  if old.started_by = 'parent' and early and coalesce(new.ended_by, 'child') = 'child' and old.allow_stop = 'notify' then
    alert := true;
  end if;
  -- Ödül
  if new.status in ('done', 'stopped') and new.activity_id is not null and new.grant_id is null then
    select * into a from orbit.activities where id = new.activity_id;
    if a.reward_every is not null and a.reward_minutes is not null then
      mins := (new.focused_seconds / 60 / a.reward_every) * a.reward_minutes;
      if mins > 0 then
        insert into orbit.time_grants (child_id, minutes, valid_on, vault, source, note)
        values (new.child_id, mins,
                case when a.reward_to = 'vault' then null else (now() at time zone 'Europe/Berlin')::date end,
                a.reward_to = 'vault', 'manual', new.title || ' çalışması')
        returning id into gid;
        update orbit.timer_sessions set grant_id = gid where id = new.id;
      end if;
    end if;
  end if;
  insert into orbit.events (family_id, child_id, type, payload, read_at)
  values (new.family_id, new.child_id, case when alert then 'timer_alert' else 'timer' end,
          jsonb_build_object('session_id', new.id, 'title', new.title, 'status', new.status, 'by', old.started_by,
                             'ended_by', new.ended_by, 'focused', new.focused_seconds, 'away', new.away_seconds, 'reward', mins),
          case when alert then null else now() end);
  return new;
end;
$$;
create trigger on_timer_change after insert or update on orbit.timer_sessions
  for each row execute function orbit.on_timer_change();

create or replace function orbit.on_event_push()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if new.type in ('task_submitted', 'time_request', 'app_request', 'app_installed', 'parent_device_pending',
                  'device_owner_lost', 'offline_long', 'device_paired', 'push_test', 'message', 'timer_alert') then
    perform orbit.call_function('orbit-push', jsonb_build_object('event_id', new.id));
  end if;
  return new;
end;
$$;

grant select, insert, update, delete on orbit.focus_profiles, orbit.activities, orbit.timer_sessions, orbit.alarms, orbit.alarm_log to authenticated;
alter publication supabase_realtime add table orbit.focus_profiles, orbit.activities, orbit.timer_sessions, orbit.alarms;

-- Başlangıç: örnek odak profilleri ve etkinlikler (her aile için bir kez)
insert into orbit.focus_profiles (family_id, name, icon, allowed_groups, messages_allowed, calls_allowed, sort_order)
select f.id, 'Ders', '📚', coalesce((select array_agg(g.id) from orbit.app_groups g where g.family_id = f.id and g.name = 'Okul'), '{}'), true, true, 0
  from orbit.families f where not exists (select 1 from orbit.focus_profiles x where x.family_id = f.id);
insert into orbit.focus_profiles (family_id, name, icon, messages_allowed, calls_allowed, sort_order)
select f.id, p.name, p.icon, p.msg, p.calls, p.ord
  from orbit.families f
 cross join (values ('Kitap', '📖', true, true, 1), ('Komple kapalı', '🔕', false, false, 2)) p(name, icon, msg, calls, ord)
 where (select count(*) from orbit.focus_profiles x where x.family_id = f.id) = 1;

insert into orbit.activities (family_id, name, icon, default_focus_id, sort_order)
select f.id, a.name, a.icon,
       (select id from orbit.focus_profiles x where x.family_id = f.id and x.name = a.focus), a.ord
  from orbit.families f
 cross join (values ('Matematik', '📐', 'Ders', 0), ('Ödev', '✏️', 'Ders', 1), ('Kitap okuma', '📖', 'Kitap', 2), ('Müzik', '🎹', null, 3)) a(name, icon, focus, ord)
 where not exists (select 1 from orbit.activities x where x.family_id = f.id);
