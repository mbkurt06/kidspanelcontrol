-- Orbit Aşama 2: görevler, şablonlar, kanıtlar (foto/video), onay/ret ve ödüller.

-- ---------------------------------------------------------------------------
-- Tablolar
-- ---------------------------------------------------------------------------

-- Kaydedilmiş görev şablonları ("Odanı topla", "Ödevini yap", "Tekrarları yap" …)
create table orbit.task_templates (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references orbit.families(id) on delete cascade,
  title text not null,
  description text,
  -- none | photo | video | photo_or_video
  proof text not null default 'photo' check (proof in ('none', 'photo', 'video', 'photo_or_video')),
  before_after boolean not null default false,
  reward_minutes int check (reward_minutes is null or reward_minutes > 0),
  reward_text text,
  -- today | tomorrow | date | wallet (çocuk istediği gün kullanır)
  reward_validity text not null default 'today' check (reward_validity in ('today', 'tomorrow', 'date', 'wallet')),
  reward_expires_days int check (reward_expires_days is null or reward_expires_days > 0),
  mandatory boolean not null default false,
  created_at timestamptz not null default now()
);

-- Verilen görevler (tek seferlik veya tekrarlı)
create table orbit.tasks (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references orbit.families(id) on delete cascade,
  template_id uuid references orbit.task_templates(id) on delete set null,
  title text not null,
  description text,
  child_ids uuid[] not null,
  -- each: her çocuk ayrı yapar · first: ilk yapan alır
  assign_mode text not null default 'each' check (assign_mode in ('each', 'first')),
  -- once: tek seferlik (start_date günü, ya da tamamlanana kadar) · days: seçili günlerde tekrar
  recurrence text not null default 'once' check (recurrence in ('once', 'days')),
  days smallint[] not null default '{1,2,3,4,5,6,7}',
  start_date date not null default current_date,
  end_date date,
  -- Tek seferlik görev bitiş tarihine kadar her gün listede kalır (tamamlanmadıysa).
  due_date date,
  due_time time,
  proof text not null default 'photo' check (proof in ('none', 'photo', 'video', 'photo_or_video')),
  before_after boolean not null default false,
  reward_minutes int check (reward_minutes is null or reward_minutes > 0),
  reward_text text,
  reward_validity text not null default 'today' check (reward_validity in ('today', 'tomorrow', 'date', 'wallet')),
  reward_date date,
  reward_expires_days int check (reward_expires_days is null or reward_expires_days > 0),
  mandatory boolean not null default false,
  active boolean not null default true,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);
create index on orbit.tasks (family_id, active);

-- Bir çocuğun bir gündeki görevi (tekrarlı görevler için her gün yeni bir satır)
create table orbit.task_runs (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references orbit.tasks(id) on delete cascade,
  child_id uuid not null references orbit.children(id) on delete cascade,
  day date not null,
  -- open · started (öncesi kanıtı çekildi) · submitted · approved · rejected · claimed (başkası aldı) · expired
  status text not null default 'open' check (status in ('open', 'started', 'submitted', 'approved', 'rejected', 'claimed', 'expired')),
  submitted_at timestamptz,
  decided_at timestamptz,
  decided_by uuid references auth.users(id),
  reject_note text,
  attempts int not null default 0,
  granted_minutes int,
  grant_id uuid references orbit.time_grants(id) on delete set null,
  reward_text text,
  reward_delivered_at timestamptz,
  created_at timestamptz not null default now(),
  unique (task_id, child_id, day)
);
create index on orbit.task_runs (child_id, day);
create index on orbit.task_runs (status);

-- Kanıt dosyaları (Storage'da). Onay/ret sonrası ve en geç 7 gün sonra silinir.
create table orbit.task_proofs (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references orbit.task_runs(id) on delete cascade,
  child_id uuid not null references orbit.children(id) on delete cascade,
  family_id uuid not null references orbit.families(id) on delete cascade,
  stage text not null default 'single' check (stage in ('before', 'after', 'single')),
  media text not null check (media in ('photo', 'video')),
  path text not null unique,
  attempt int not null default 0,
  -- Dosya Storage'dan silindiğinde işaretlenir (kayıt sadece iz olarak kalır).
  removed_at timestamptz,
  created_at timestamptz not null default now()
);
create index on orbit.task_proofs (run_id);
create index on orbit.task_proofs (created_at);

alter table orbit.time_grants add column if not exists task_run_id uuid references orbit.task_runs(id) on delete set null;

-- ---------------------------------------------------------------------------
-- Görev günlerini üretme
-- ---------------------------------------------------------------------------

-- Bir çocuk için verilen günün görev satırlarını oluşturur (yoksa).
create or replace function orbit.ensure_runs(p_child uuid, p_day date)
returns void
language plpgsql volatile security definer set search_path = ''
as $$
declare t orbit.tasks;
begin
  for t in
    select * from orbit.tasks
    where active and p_child = any(child_ids)
      and start_date <= p_day
      and (end_date is null or end_date >= p_day)
  loop
    if t.recurrence = 'days' then
      if extract(isodow from p_day)::int = any(t.days) then
        insert into orbit.task_runs (task_id, child_id, day) values (t.id, p_child, p_day)
        on conflict do nothing;
      end if;
    else
      -- Tek seferlik: tek satır; tamamlanmadıysa bitiş gününe kadar açık kalır.
      if not exists (select 1 from orbit.task_runs r where r.task_id = t.id and r.child_id = p_child) then
        insert into orbit.task_runs (task_id, child_id, day) values (t.id, p_child, greatest(t.start_date, p_day))
        on conflict do nothing;
      end if;
    end if;
  end loop;
end;
$$;

-- Zamanı geçmiş açık görevleri "süresi doldu" yapar.
create or replace function orbit.expire_runs(p_today date)
returns void
language sql volatile security definer set search_path = ''
as $$
  update orbit.task_runs r set status = 'expired'
  from orbit.tasks t
  where r.task_id = t.id and r.status in ('open', 'started', 'rejected')
    and (
      (t.recurrence = 'days' and r.day < p_today)
      or (t.recurrence = 'once' and coalesce(t.due_date, t.end_date) is not null and coalesce(t.due_date, t.end_date) < p_today)
    );
$$;

-- ---------------------------------------------------------------------------
-- Çocuk telefonu RPC'leri
-- ---------------------------------------------------------------------------

-- Telefonun bugünkü görevleri (görev bilgileriyle birlikte).
create or replace function orbit.device_tasks(p_day date)
returns jsonb
language plpgsql volatile security definer set search_path = ''
as $$
declare child uuid := orbit.device_child();
begin
  if child is null then raise exception 'not_allowed'; end if;
  perform orbit.expire_runs(p_day);
  perform orbit.ensure_runs(child, p_day);
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'run_id', r.id, 'task_id', t.id, 'day', r.day, 'status', r.status, 'reject_note', r.reject_note,
      'title', t.title, 'description', t.description, 'proof', t.proof, 'before_after', t.before_after,
      'reward_minutes', t.reward_minutes, 'reward_text', t.reward_text, 'reward_validity', t.reward_validity,
      'reward_date', t.reward_date, 'mandatory', t.mandatory, 'due_time', t.due_time, 'due_date', coalesce(t.due_date, t.end_date),
      'assign_mode', t.assign_mode, 'attempts', r.attempts,
      'proofs', (select coalesce(jsonb_agg(jsonb_build_object('stage', p.stage, 'media', p.media)), '[]'::jsonb)
                 from orbit.task_proofs p where p.run_id = r.id and p.attempt = r.attempts and p.removed_at is null)
    ) order by t.mandatory desc, t.due_time nulls last, t.created_at)
    from orbit.task_runs r join orbit.tasks t on t.id = r.task_id
    where r.child_id = child
      and (r.day = p_day
           or (t.recurrence = 'once' and r.status in ('open', 'started', 'submitted', 'rejected'))
           or (r.day >= p_day - 1 and r.status in ('approved', 'rejected', 'submitted')))
  ), '[]'::jsonb);
end;
$$;

-- Kanıt dosyası kaydı (dosya Storage'a yüklendikten sonra çağrılır).
create or replace function orbit.device_add_proof(p_run uuid, p_stage text, p_media text, p_path text)
returns void
language plpgsql volatile security definer set search_path = ''
as $$
declare
  dev orbit.devices := orbit.current_device();
  r orbit.task_runs;
begin
  if dev.id is null or dev.kind <> 'child_phone' then raise exception 'not_allowed'; end if;
  select * into r from orbit.task_runs where id = p_run and child_id = dev.child_id;
  if r.id is null then raise exception 'not_allowed'; end if;
  if r.status not in ('open', 'started', 'rejected') then raise exception 'not_open'; end if;
  if p_path not like dev.family_id::text || '/' || p_run::text || '/%' then raise exception 'bad_path'; end if;
  insert into orbit.task_proofs (run_id, child_id, family_id, stage, media, path, attempt)
  values (p_run, dev.child_id, dev.family_id, p_stage, p_media, p_path, r.attempts);
  if p_stage = 'before' and r.status in ('open', 'rejected') then
    update orbit.task_runs set status = 'started' where id = p_run;
  end if;
end;
$$;

-- Görevi "tamamladım" olarak gönderir. Gereken kanıtlar yüklenmiş olmalı.
create or replace function orbit.device_submit_run(p_run uuid)
returns text
language plpgsql volatile security definer set search_path = ''
as $$
declare
  dev orbit.devices := orbit.current_device();
  r orbit.task_runs;
  t orbit.tasks;
  have_before boolean;
  have_after boolean;
begin
  if dev.id is null or dev.kind <> 'child_phone' then raise exception 'not_allowed'; end if;
  select * into r from orbit.task_runs where id = p_run and child_id = dev.child_id;
  if r.id is null then raise exception 'not_allowed'; end if;
  if r.status not in ('open', 'started', 'rejected') then raise exception 'not_open'; end if;
  select * into t from orbit.tasks where id = r.task_id;
  if t.proof <> 'none' then
    select exists (select 1 from orbit.task_proofs where run_id = r.id and attempt = r.attempts and removed_at is null and stage = 'before') into have_before;
    select exists (select 1 from orbit.task_proofs where run_id = r.id and attempt = r.attempts and removed_at is null and stage in ('after', 'single')) into have_after;
    if not have_after or (t.before_after and not have_before) then raise exception 'proof_missing'; end if;
  end if;
  update orbit.task_runs set status = 'submitted', submitted_at = now() where id = r.id;
  insert into orbit.events (family_id, child_id, type, payload)
  values (dev.family_id, dev.child_id, 'task_submitted', jsonb_build_object('run_id', r.id, 'title', t.title));
  return 'submitted';
end;
$$;

-- ---------------------------------------------------------------------------
-- Ebeveyn RPC'leri
-- ---------------------------------------------------------------------------

create or replace function orbit.parent_ensure_runs(p_day date)
returns void
language plpgsql volatile security definer set search_path = ''
as $$
declare fam uuid := orbit.parent_family(); c uuid;
begin
  if fam is null then raise exception 'not_allowed'; end if;
  perform orbit.expire_runs(p_day);
  for c in select id from orbit.children where family_id = fam loop
    perform orbit.ensure_runs(c, p_day);
  end loop;
end;
$$;

-- Onay veya ret. Onayda ödül süresi cüzdana eklenir; ebeveyn süreyi ve geçerliliği o an değiştirebilir.
-- Dönen değer: silinmesi gereken kanıt dosyalarının yolları (panel Storage'dan siler).
create or replace function orbit.parent_decide_run(
  p_run uuid, p_approve boolean, p_note text,
  p_minutes int default null, p_validity text default null, p_date date default null, p_expires date default null
)
returns text[]
language plpgsql volatile security definer set search_path = ''
as $$
declare
  fam uuid := orbit.parent_family();
  r orbit.task_runs;
  t orbit.tasks;
  mins int;
  validity text;
  v_on date;
  exp date;
  today date := (now() at time zone 'Europe/Berlin')::date;
  gid uuid;
  paths text[];
begin
  if fam is null then raise exception 'not_allowed'; end if;
  select r2.* into r from orbit.task_runs r2 join orbit.tasks t2 on t2.id = r2.task_id
  where r2.id = p_run and t2.family_id = fam;
  if r.id is null then raise exception 'not_allowed'; end if;
  select * into t from orbit.tasks where id = r.task_id;

  select coalesce(array_agg(path), '{}') into paths from orbit.task_proofs where run_id = r.id and removed_at is null;

  if p_approve then
    mins := coalesce(p_minutes, t.reward_minutes);
    validity := coalesce(p_validity, t.reward_validity);
    if mins is not null and mins > 0 then
      v_on := case validity when 'today' then today when 'tomorrow' then today + 1 when 'date' then coalesce(p_date, t.reward_date, today) else null end;
      exp := case when validity = 'wallet' then coalesce(p_expires, case when t.reward_expires_days is not null then today + t.reward_expires_days end) end;
      insert into orbit.time_grants (child_id, minutes, valid_on, expires_on, source, note, created_by, task_run_id)
      values (r.child_id, mins, v_on, exp, 'task', t.title, auth.uid(), r.id)
      returning id into gid;
    end if;
    update orbit.task_runs
       set status = 'approved', decided_at = now(), decided_by = auth.uid(), reject_note = null,
           granted_minutes = mins, grant_id = gid, reward_text = t.reward_text
     where id = r.id;
    -- "İlk yapan alır" görevinde diğer çocukların aynı günkü görevi kapanır.
    if t.assign_mode = 'first' then
      update orbit.task_runs set status = 'claimed'
       where task_id = t.id and id <> r.id and day = r.day and status in ('open', 'started', 'rejected', 'submitted');
    end if;
  else
    update orbit.task_runs
       set status = 'rejected', decided_at = now(), decided_by = auth.uid(), reject_note = nullif(trim(coalesce(p_note, '')), ''),
           attempts = attempts + 1
     where id = r.id;
  end if;
  update orbit.task_proofs set removed_at = now() where run_id = r.id and removed_at is null;
  return paths;
end;
$$;

-- ---------------------------------------------------------------------------
-- Storage: kanıt dosyaları (özel bucket)
-- Yol: <family_id>/<run_id>/<dosya>
-- ---------------------------------------------------------------------------

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('orbit-proofs', 'orbit-proofs', false, 52428800, array['image/jpeg', 'image/png', 'image/webp', 'video/mp4'])
on conflict (id) do nothing;

create policy orbit_proofs_phone_insert on storage.objects for insert to authenticated
  with check (
    bucket_id = 'orbit-proofs'
    and (storage.foldername(name))[1] = orbit.device_family()::text
    and exists (
      select 1 from orbit.task_runs r
      where r.id::text = (storage.foldername(name))[2] and r.child_id = orbit.device_child()
        and r.status in ('open', 'started', 'rejected')
    )
  );

create policy orbit_proofs_parent_read on storage.objects for select to authenticated
  using (bucket_id = 'orbit-proofs' and (storage.foldername(name))[1] = orbit.parent_family()::text);

create policy orbit_proofs_parent_delete on storage.objects for delete to authenticated
  using (bucket_id = 'orbit-proofs' and (storage.foldername(name))[1] = orbit.parent_family()::text);

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------

alter table orbit.task_templates enable row level security;
alter table orbit.tasks enable row level security;
alter table orbit.task_runs enable row level security;
alter table orbit.task_proofs enable row level security;

create policy parent_all on orbit.task_templates for all to authenticated
  using (family_id = orbit.parent_family()) with check (family_id = orbit.parent_family());
create policy parent_all on orbit.tasks for all to authenticated
  using (family_id = orbit.parent_family()) with check (family_id = orbit.parent_family());
create policy parent_all on orbit.task_runs for all to authenticated
  using (child_id in (select id from orbit.children where family_id = orbit.parent_family()))
  with check (child_id in (select id from orbit.children where family_id = orbit.parent_family()));
create policy parent_read on orbit.task_proofs for select to authenticated
  using (family_id = orbit.parent_family());

-- Telefon ve Noor tableti görev durumlarını okuyabilir (Noor sayfası için).
create policy device_read on orbit.tasks for select to authenticated
  using (family_id = orbit.device_family());
create policy device_read on orbit.task_runs for select to authenticated
  using (child_id in (select id from orbit.children where family_id = orbit.device_family())
         and (orbit.device_child() is null or child_id = orbit.device_child()));

grant select, insert, update, delete on orbit.task_templates, orbit.tasks, orbit.task_runs, orbit.task_proofs to authenticated;
grant all on orbit.task_templates, orbit.tasks, orbit.task_runs, orbit.task_proofs to service_role;
revoke all on function orbit.ensure_runs(uuid, date) from public, anon, authenticated;
revoke all on function orbit.expire_runs(date) from public, anon, authenticated;
revoke all on function orbit.device_tasks(date), orbit.device_add_proof(uuid, text, text, text), orbit.device_submit_run(uuid),
  orbit.parent_ensure_runs(date), orbit.parent_decide_run(uuid, boolean, text, int, text, date, date) from public, anon;
grant execute on function orbit.device_tasks(date), orbit.device_add_proof(uuid, text, text, text), orbit.device_submit_run(uuid),
  orbit.parent_ensure_runs(date), orbit.parent_decide_run(uuid, boolean, text, int, text, date, date) to authenticated;

alter publication supabase_realtime add table orbit.tasks, orbit.task_runs;
