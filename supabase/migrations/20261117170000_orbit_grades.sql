-- Notlar: dersler (sınıf düzeyine göre, iki çocukta ortak, çocuk başına gizlenebilir), not kayıtları (onaylı)
alter table orbit.children add column if not exists grade_level integer;

create table if not exists orbit.subjects (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references orbit.families(id) on delete cascade,
  grade_level integer not null,
  name text not null,
  color text,
  sort integer not null default 0,
  weights jsonb not null default '{}'::jsonb,
  hidden_for uuid[] not null default '{}',
  created_at timestamptz not null default now()
);
create index if not exists subjects_family on orbit.subjects (family_id, grade_level, sort);

create table if not exists orbit.grades (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references orbit.families(id) on delete cascade,
  child_id uuid not null references orbit.children(id) on delete cascade,
  subject_id uuid not null references orbit.subjects(id) on delete cascade,
  grade_level integer not null,
  kind text not null check (kind in ('exam', 'oral', 'test', 'homework')),
  grade text not null,
  value numeric(3,1) not null,
  taken_on date not null,
  note text,
  photos text[] not null default '{}',
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  reject_note text,
  decided_at timestamptz,
  decided_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists grades_child on orbit.grades (child_id, grade_level, subject_id, taken_on);

alter table orbit.subjects enable row level security;
alter table orbit.grades enable row level security;
drop policy if exists parent_all on orbit.subjects;
create policy parent_all on orbit.subjects for all using (family_id = orbit.parent_family()) with check (family_id = orbit.parent_family());
drop policy if exists device_read on orbit.subjects;
create policy device_read on orbit.subjects for select using (family_id = orbit.device_family());
drop policy if exists parent_all on orbit.grades;
create policy parent_all on orbit.grades for all using (family_id = orbit.parent_family()) with check (family_id = orbit.parent_family());
drop policy if exists phone_read on orbit.grades;
create policy phone_read on orbit.grades for select using (child_id = orbit.device_child());
grant select, insert, update, delete on orbit.subjects, orbit.grades to authenticated;

drop trigger if exists rt_notify on orbit.subjects;
create trigger rt_notify after insert or update or delete on orbit.subjects for each row execute function orbit.rt_notify();
drop trigger if exists rt_notify on orbit.grades;
create trigger rt_notify after insert or update or delete on orbit.grades for each row execute function orbit.rt_notify();

-- "2-" → 2,3 · "2+" → 1,7 · "2" → 2,0
create or replace function orbit.grade_value(p text) returns numeric language sql immutable as $$
  select case when p ~ '^[1-6][+-]?$' then substr(p, 1, 1)::numeric + case right(p, 1) when '-' then 0.3 when '+' then -0.3 else 0 end end
$$;

-- Telefon: not kaydet / düzeltip tekrar gönder (onay bekler)
create or replace function orbit.device_grade_save(p_id uuid, p_subject uuid, p_kind text, p_grade text, p_taken_on date, p_note text, p_photos text[])
returns uuid language plpgsql security definer set search_path to '' as $$
declare child uuid := orbit.device_child(); fam uuid := orbit.device_family(); s orbit.subjects; g text := replace(replace(trim(p_grade), '−', '-'), ' ', ''); v numeric; gid uuid; lvl int;
begin
  if child is null then raise exception 'not_allowed'; end if;
  select * into s from orbit.subjects where id = p_subject and family_id = fam;
  if s.id is null or child = any (s.hidden_for) then raise exception 'bad_subject'; end if;
  v := orbit.grade_value(g);
  if v is null then raise exception 'bad_grade'; end if;
  if p_kind not in ('exam', 'oral', 'test', 'homework') then raise exception 'bad_kind'; end if;
  if p_taken_on is null or p_taken_on > (now() at time zone 'Europe/Berlin')::date then raise exception 'bad_date'; end if;
  lvl := s.grade_level;
  if p_id is null then
    insert into orbit.grades (family_id, child_id, subject_id, grade_level, kind, grade, value, taken_on, note, photos)
    values (fam, child, s.id, lvl, p_kind, g, v, p_taken_on, nullif(trim(p_note), ''), coalesce(p_photos, '{}'))
    returning id into gid;
  else
    update orbit.grades set subject_id = s.id, grade_level = lvl, kind = p_kind, grade = g, value = v, taken_on = p_taken_on,
      note = nullif(trim(p_note), ''), photos = photos || coalesce(p_photos, '{}'), status = 'pending', reject_note = null, decided_at = null, decided_by = null, updated_at = now()
     where id = p_id and child_id = child and status in ('pending', 'rejected')
    returning id into gid;
    if gid is null then raise exception 'not_editable'; end if;
  end if;
  insert into orbit.events (family_id, child_id, type, payload)
  values (fam, child, 'grade_submitted', jsonb_build_object('grade_id', gid, 'subject', s.name, 'kind', p_kind, 'grade', g, 'taken_on', p_taken_on));
  return gid;
end $$;
grant execute on function orbit.device_grade_save(uuid, uuid, text, text, date, text, text[]) to authenticated;
