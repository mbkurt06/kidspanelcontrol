-- Orbit: gün bölümleri, uygulama grupları ve bölüm kuralları.
--
-- Gün tipi (rule_profiles) istediği kadar bölüme ayrılır (profile_sections). Her bölümde her grup ya da
-- tek uygulama için kural: açık / süreli / kapalı (section_rules). Gruplar ailede ortaktır (app_groups,
-- app_group_members); günlük grup sınırları gün tipine göredir (profile_group_limits).
-- Bir gün tipinde bölüm varsa telefon yeni kural motorunu kullanır; yoksa eski (pencere + grup) kuralları.

-- --- Uygulama grupları ---
create table orbit.app_groups (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references orbit.families(id) on delete cascade,
  name text not null,
  color text not null default '#7C5CFF',
  sort_order int not null default 0,
  created_at timestamptz not null default now()
);
create index on orbit.app_groups (family_id);

create table orbit.app_group_members (
  family_id uuid not null references orbit.families(id) on delete cascade,
  package text not null,
  group_id uuid not null references orbit.app_groups(id) on delete cascade,
  primary key (family_id, package)
);
create index on orbit.app_group_members (group_id);

-- Telefonun bildirdiği Android kategorisi (oyun, sosyal, video…) — grup önerisi için.
alter table orbit.child_apps add column if not exists category text;

-- --- Bölümler ---
create table orbit.profile_sections (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references orbit.rule_profiles(id) on delete cascade,
  name text not null,
  start_time time not null,
  end_time time not null,
  -- Bölüm süresi (dk). null = bu bölümde süreli uygulamalara bölüm süresi uygulanmaz (sadece grup/uygulama/gün sınırları).
  budget_minutes int check (budget_minutes is null or budget_minutes >= 0),
  -- Kullanılmayan süre sonraki bölüme devretsin mi
  carry_over boolean not null default false,
  -- Gruba girmemiş (ve kendi kuralı olmayan) onaylı uygulamalar bu bölümde ne olsun
  default_rule text not null default 'blocked' check (default_rule in ('open', 'timed', 'blocked')),
  color text not null default '#4F7CFF',
  sort_order int not null default 0,
  created_at timestamptz not null default now(),
  check (start_time <> end_time)
);
create index on orbit.profile_sections (profile_id);

create table orbit.section_rules (
  id uuid primary key default gen_random_uuid(),
  section_id uuid not null references orbit.profile_sections(id) on delete cascade,
  group_id uuid references orbit.app_groups(id) on delete cascade,
  package text,
  rule text not null check (rule in ('open', 'timed', 'blocked')),
  -- Bu bölümde bu grup/uygulama için en fazla (dk). Sadece 'timed' için anlamlı.
  limit_minutes int check (limit_minutes is null or limit_minutes >= 0),
  check ((group_id is null) <> (package is null))
);
create unique index section_rules_group on orbit.section_rules (section_id, group_id) where group_id is not null;
create unique index section_rules_pkg on orbit.section_rules (section_id, package) where package is not null;

create table orbit.profile_group_limits (
  profile_id uuid not null references orbit.rule_profiles(id) on delete cascade,
  group_id uuid not null references orbit.app_groups(id) on delete cascade,
  daily_minutes int not null check (daily_minutes >= 0),
  primary key (profile_id, group_id)
);

-- --- Ekstra süre hedefi ---
-- valid_on + section_id: o günün o bölümüne; valid_on + null: gün boyu havuz; valid_on null: cüzdan.
alter table orbit.time_grants add column if not exists section_id uuid references orbit.profile_sections(id) on delete set null;
alter table orbit.task_templates add column if not exists reward_section_id uuid references orbit.profile_sections(id) on delete set null;
alter table orbit.tasks add column if not exists reward_section_id uuid references orbit.profile_sections(id) on delete set null;
-- Panelde +dk verirken önce seçili gelen yer
alter table orbit.children add column if not exists extra_default text not null default 'current'
  check (extra_default in ('current', 'pool', 'wallet'));

-- Görev ödülü verilince, görevin ödül bölümü süreye yazılır (cüzdan değilse).
create or replace function orbit.grant_task_section()
returns trigger language plpgsql security definer set search_path = ''
as $$
begin
  if new.task_run_id is not null and new.section_id is null and new.valid_on is not null then
    select t.reward_section_id into new.section_id
      from orbit.task_runs r join orbit.tasks t on t.id = r.task_id
     where r.id = new.task_run_id;
  end if;
  return new;
end;
$$;
create trigger grant_task_section before insert on orbit.time_grants
  for each row execute function orbit.grant_task_section();

-- --- Yetkiler ---
alter table orbit.app_groups enable row level security;
alter table orbit.app_group_members enable row level security;
alter table orbit.profile_sections enable row level security;
alter table orbit.section_rules enable row level security;
alter table orbit.profile_group_limits enable row level security;

create policy parent_all on orbit.app_groups for all to authenticated
  using (family_id = orbit.parent_family()) with check (family_id = orbit.parent_family());
create policy parent_all on orbit.app_group_members for all to authenticated
  using (family_id = orbit.parent_family()) with check (family_id = orbit.parent_family());
create policy parent_all on orbit.profile_sections for all to authenticated
  using (profile_id in (select id from orbit.rule_profiles where family_id = orbit.parent_family()))
  with check (profile_id in (select id from orbit.rule_profiles where family_id = orbit.parent_family()));
create policy parent_all on orbit.section_rules for all to authenticated
  using (section_id in (select s.id from orbit.profile_sections s join orbit.rule_profiles p on p.id = s.profile_id where p.family_id = orbit.parent_family()))
  with check (section_id in (select s.id from orbit.profile_sections s join orbit.rule_profiles p on p.id = s.profile_id where p.family_id = orbit.parent_family()));
create policy parent_all on orbit.profile_group_limits for all to authenticated
  using (profile_id in (select id from orbit.rule_profiles where family_id = orbit.parent_family()))
  with check (profile_id in (select id from orbit.rule_profiles where family_id = orbit.parent_family()));

-- Telefon ve Noor tableti (cihaz hesapları) okur.
create policy device_read on orbit.app_groups for select to authenticated using (family_id = orbit.device_family());
create policy device_read on orbit.app_group_members for select to authenticated using (family_id = orbit.device_family());
create policy device_read on orbit.profile_sections for select to authenticated
  using (profile_id in (select id from orbit.rule_profiles where family_id = orbit.device_family()));
create policy device_read on orbit.section_rules for select to authenticated
  using (section_id in (select s.id from orbit.profile_sections s join orbit.rule_profiles p on p.id = s.profile_id where p.family_id = orbit.device_family()));
create policy device_read on orbit.profile_group_limits for select to authenticated
  using (profile_id in (select id from orbit.rule_profiles where family_id = orbit.device_family()));

grant select, insert, update, delete on orbit.app_groups, orbit.app_group_members, orbit.profile_sections,
  orbit.section_rules, orbit.profile_group_limits to authenticated;

alter publication supabase_realtime add table orbit.app_groups, orbit.app_group_members, orbit.profile_sections,
  orbit.section_rules, orbit.profile_group_limits;

-- --- Mevcut ayarları bölümlere çevir ---
-- Her gün tipi: [süreli pencere başı → sonu] "Gündüz" (günlük süre = bölüm süresi), kalan kısım "Uyku" (kapalı).
-- Eski durum programları (Uyku zamanı vb.) olduğu gibi kalır; panelden kaldırılabilir.
create or replace function orbit.convert_profile_to_sections(p_profile uuid)
returns void language plpgsql security definer set search_path = ''
as $$
declare
  p orbit.rule_profiles;
  w_start time;
  w_end time;
begin
  select * into p from orbit.rule_profiles where id = p_profile;
  if p.id is null or exists (select 1 from orbit.profile_sections where profile_id = p.id) then return; end if;
  w_start := coalesce((p.timed_windows -> 0 ->> 'start')::time, '07:00');
  w_end := coalesce((p.timed_windows -> 0 ->> 'end')::time, '21:00');
  insert into orbit.profile_sections (profile_id, name, start_time, end_time, budget_minutes, carry_over, default_rule, color, sort_order)
  values (p.id, 'Gündüz', w_start, w_end, p.daily_minutes, false, 'timed', '#4F7CFF', 0),
         (p.id, 'Uyku', w_end, w_start, null, false, 'blocked', '#6B5CE7', 1);
end;
$$;
revoke all on function orbit.convert_profile_to_sections(uuid) from public, anon;

select orbit.convert_profile_to_sections(id) from orbit.rule_profiles;

-- Varsayılan gruplar (her aile için bir kez)
insert into orbit.app_groups (family_id, name, color, sort_order)
select f.id, g.name, g.color, g.ord
  from orbit.families f
 cross join (values ('Oyunlar', '#FF7A59', 0), ('Sosyal', '#E85D9B', 1), ('Video', '#F2B134', 2),
                    ('Okul', '#2BB673', 3), ('İletişim', '#4F7CFF', 4), ('Araçlar', '#9AA0C3', 5)) g(name, color, ord)
 where not exists (select 1 from orbit.app_groups x where x.family_id = f.id);

-- Telefon uygulama kategorisini de bildirir (grup önerisi için).
create or replace function orbit.device_report_apps(p_apps jsonb)
returns void
language plpgsql volatile security definer set search_path = ''
as $$
declare
  dev orbit.devices := orbit.current_device();
  a jsonb;
  is_new boolean;
begin
  if dev.id is null or dev.kind <> 'child_phone' then raise exception 'not_allowed'; end if;
  update orbit.child_apps set installed = false where child_id = dev.child_id;
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
          category = coalesce(excluded.category, orbit.child_apps.category);
    if is_new and not coalesce((a ->> 'preapproved')::boolean, false) and (a ->> 'initial') is null then
      insert into orbit.events (family_id, child_id, type, payload)
      values (dev.family_id, dev.child_id, 'app_installed',
              jsonb_build_object('package', a ->> 'package', 'label', a ->> 'label'));
    end if;
  end loop;
end;
$$;
