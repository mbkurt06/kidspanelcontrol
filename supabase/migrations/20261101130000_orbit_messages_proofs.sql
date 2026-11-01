-- Mesajlaşma (çocuk ↔ ebeveyn) ve görev kanıtlarının denemeler boyunca saklanması.

-- --- Mesajlar ---
create table orbit.messages (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references orbit.families(id) on delete cascade,
  child_id uuid not null references orbit.children(id) on delete cascade,
  from_parent boolean not null,
  sender_user uuid references auth.users(id) on delete set null,
  sender_name text,
  body text not null check (length(trim(body)) between 1 and 1000),
  created_at timestamptz not null default now(),
  read_at timestamptz
);
create index on orbit.messages (child_id, created_at desc);

alter table orbit.messages enable row level security;
create policy parent_all on orbit.messages for all to authenticated
  using (family_id = orbit.parent_family()) with check (family_id = orbit.parent_family());
-- Telefon: kendi sohbetini okur, sadece kendi adına yazar, ebeveyn mesajlarını "okundu" yapar
create policy phone_read on orbit.messages for select to authenticated using (child_id = orbit.device_child());
create policy phone_insert on orbit.messages for insert to authenticated
  with check (child_id = orbit.device_child() and family_id = orbit.device_family() and not from_parent);
create policy phone_update on orbit.messages for update to authenticated
  using (child_id = orbit.device_child() and from_parent) with check (child_id = orbit.device_child());

create or replace function orbit.guard_messages()
returns trigger language plpgsql security definer set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    -- Kimin yazdığını istemci değil sunucu belirler
    new.from_parent := orbit.parent_family() is not null;
    if new.from_parent then
      new.sender_user := auth.uid();
      select coalesce(display_name, 'Ebeveyn') into new.sender_name from orbit.parents where user_id = auth.uid();
    else
      new.sender_user := null;
      new.sender_name := null;
    end if;
    new.created_at := now();
    new.read_at := null;
    return new;
  end if;
  -- Güncellemede sadece okundu bilgisi değişebilir
  if (new.body, new.from_parent, new.child_id, new.family_id, new.created_at, new.sender_user)
     is distinct from (old.body, old.from_parent, old.child_id, old.family_id, old.created_at, old.sender_user) then
    raise exception 'not_allowed';
  end if;
  return new;
end;
$$;
create trigger guard_messages before insert or update on orbit.messages
  for each row execute function orbit.guard_messages();

-- Çocuk yazınca ebeveynlere bildirim (olay → web push)
create or replace function orbit.on_child_message()
returns trigger language plpgsql security definer set search_path = ''
as $$
begin
  if not new.from_parent then
    insert into orbit.events (family_id, child_id, type, payload, read_at)
    values (new.family_id, new.child_id, 'message', jsonb_build_object('message_id', new.id, 'body', left(new.body, 140)), now());
  end if;
  return new;
end;
$$;
create trigger on_child_message after insert on orbit.messages
  for each row execute function orbit.on_child_message();

grant select, insert, update, delete on orbit.messages to authenticated;
alter publication supabase_realtime add table orbit.messages;

create or replace function orbit.on_event_push()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if new.type in ('task_submitted', 'time_request', 'app_request', 'app_installed', 'parent_device_pending',
                  'device_owner_lost', 'offline_long', 'device_paired', 'push_test', 'message') then
    perform orbit.call_function('orbit-push', jsonb_build_object('event_id', new.id));
  end if;
  return new;
end;
$$;

-- 90 günden eski mesajlar silinir
select cron.schedule('orbit-messages-cleanup', '17 3 * * *', $$delete from orbit.messages where created_at < now() - interval '90 days'$$);

-- --- Görev kanıtları: reddedilince silinmez ---
-- Onaydan sonra kaç gün saklansın (0 = hemen silinsin)
alter table orbit.families add column if not exists proof_retention_days int not null default 0
  check (proof_retention_days in (0, 7, 30));
alter table orbit.task_proofs add column if not exists delete_after timestamptz;

-- Her reddin notu (denemeler yan yana gösterilsin)
create table orbit.task_run_notes (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references orbit.task_runs(id) on delete cascade,
  attempt int not null,
  note text,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);
create index on orbit.task_run_notes (run_id);
alter table orbit.task_run_notes enable row level security;
create policy parent_read on orbit.task_run_notes for select to authenticated
  using (run_id in (select r.id from orbit.task_runs r join orbit.children c on c.id = r.child_id where c.family_id = orbit.parent_family()));
grant select on orbit.task_run_notes to authenticated;

-- Onay/ret. Ret: kanıtlar ve not saklanır, çocuk sadece yeni "sonrası" çeker.
-- Onay: kanıtlar ailenin saklama ayarına göre hemen ya da N gün sonra silinir.
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
  paths text[] := '{}';
  keep int;
begin
  if fam is null then raise exception 'not_allowed'; end if;
  select r2.* into r from orbit.task_runs r2 join orbit.tasks t2 on t2.id = r2.task_id
  where r2.id = p_run and t2.family_id = fam;
  if r.id is null then raise exception 'not_allowed'; end if;
  select * into t from orbit.tasks where id = r.task_id;

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
    if t.assign_mode = 'first' then
      update orbit.task_runs set status = 'claimed'
       where task_id = t.id and id <> r.id and day = r.day and status in ('open', 'started', 'rejected', 'submitted');
    end if;
    select proof_retention_days into keep from orbit.families where id = fam;
    if coalesce(keep, 0) = 0 then
      select coalesce(array_agg(path), '{}') into paths from orbit.task_proofs where run_id = r.id and removed_at is null;
      update orbit.task_proofs set removed_at = now() where run_id = r.id and removed_at is null;
    else
      update orbit.task_proofs set delete_after = now() + make_interval(days => keep) where run_id = r.id and removed_at is null;
    end if;
  else
    insert into orbit.task_run_notes (run_id, attempt, note, created_by)
    values (r.id, r.attempts, nullif(trim(coalesce(p_note, '')), ''), auth.uid());
    update orbit.task_runs
       set status = 'rejected', decided_at = now(), decided_by = auth.uid(), reject_note = nullif(trim(coalesce(p_note, '')), ''),
           attempts = attempts + 1
     where id = r.id;
  end if;
  return paths;
end;
$$;

-- "Öncesi" fotoğrafı bir kez yeter: tekrar denemede sadece "sonrası" istenir
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
    select exists (select 1 from orbit.task_proofs where run_id = r.id and removed_at is null and stage = 'before') into have_before;
    select exists (select 1 from orbit.task_proofs where run_id = r.id and attempt = r.attempts and removed_at is null and stage in ('after', 'single')) into have_after;
    if not have_after or (t.before_after and not have_before) then raise exception 'proof_missing'; end if;
  end if;
  update orbit.task_runs set status = 'submitted', submitted_at = now() where id = r.id;
  insert into orbit.events (family_id, child_id, type, payload)
  values (dev.family_id, dev.child_id, 'task_submitted', jsonb_build_object('run_id', r.id, 'title', t.title));
  return 'submitted';
end;
$$;

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
      'assign_mode', t.assign_mode, 'attempts', r.attempts, 'created_at', r.created_at,
      -- "öncesi" her denemeden sayılır; "sonrası" sadece şimdiki denemeden
      'proofs', (select coalesce(jsonb_agg(jsonb_build_object('stage', p.stage, 'media', p.media)), '[]'::jsonb)
                 from orbit.task_proofs p where p.run_id = r.id and p.removed_at is null
                   and (p.stage = 'before' or p.attempt = r.attempts))
    ) order by t.mandatory desc, t.due_time nulls last, t.created_at)
    from orbit.task_runs r join orbit.tasks t on t.id = r.task_id
    where r.child_id = child
      and (r.day = p_day
           or (t.recurrence = 'once' and r.status in ('open', 'started', 'submitted', 'rejected'))
           or (r.day >= p_day - 1 and r.status in ('approved', 'rejected', 'submitted')))
  ), '[]'::jsonb);
end;
$$;

-- Temizlik: silinecek kanıtları işaretle (onaylı+süresi dolmuş, kapanmış görevler, 45 günden eski)
create or replace function orbit.mark_proofs_for_cleanup()
returns int language plpgsql volatile security definer set search_path = ''
as $$
declare n int;
begin
  update orbit.task_proofs p set removed_at = now()
   where p.removed_at is null
     and (p.delete_after < now()
          or p.created_at < now() - interval '45 days'
          or exists (select 1 from orbit.task_runs r where r.id = p.run_id and r.status in ('expired', 'claimed')));
  get diagnostics n = row_count;
  return n;
end;
$$;
revoke all on function orbit.mark_proofs_for_cleanup() from public, anon, authenticated;
grant execute on function orbit.mark_proofs_for_cleanup() to service_role;
