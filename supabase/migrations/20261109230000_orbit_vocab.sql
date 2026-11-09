-- Kelime kartları (Fransızca – Almanca): desteler, kartlar, çocuk başına ilerleme (aralıklı tekrar), çalışmalar, görev hedefi

create table if not exists orbit.vocab_decks (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references orbit.families(id) on delete cascade,
  name text not null check (length(trim(name)) between 1 and 80),
  created_by_child uuid references orbit.children(id) on delete set null,
  created_at timestamptz not null default now(),
  deleted_at timestamptz
);

create table if not exists orbit.vocab_cards (
  id uuid primary key default gen_random_uuid(),
  deck_id uuid not null references orbit.vocab_decks(id) on delete cascade,
  family_id uuid not null references orbit.families(id) on delete cascade,
  fr text not null check (length(trim(fr)) between 1 and 200),
  de text not null check (length(trim(de)) between 1 and 200),
  example text check (example is null or length(example) <= 400),
  created_by_child uuid references orbit.children(id) on delete set null,
  created_at timestamptz not null default now(),
  deleted_at timestamptz
);
create index if not exists vocab_cards_deck on orbit.vocab_cards(deck_id) where deleted_at is null;

-- box: 0 yeni, 1–3 öğreniliyor, 4–5 öğrenildi
create table if not exists orbit.vocab_progress (
  child_id uuid not null references orbit.children(id) on delete cascade,
  card_id uuid not null references orbit.vocab_cards(id) on delete cascade,
  family_id uuid not null references orbit.families(id) on delete cascade,
  box smallint not null default 0 check (box between 0 and 5),
  due_on date,
  right_count int not null default 0,
  wrong_count int not null default 0,
  last_at timestamptz,
  primary key (child_id, card_id)
);

-- Çocuğun çalışma alanındaki desteler
create table if not exists orbit.vocab_study (
  child_id uuid not null references orbit.children(id) on delete cascade,
  deck_id uuid not null references orbit.vocab_decks(id) on delete cascade,
  family_id uuid not null references orbit.families(id) on delete cascade,
  added_at timestamptz not null default now(),
  primary key (child_id, deck_id)
);

create table if not exists orbit.vocab_sessions (
  id uuid primary key default gen_random_uuid(),
  child_id uuid not null references orbit.children(id) on delete cascade,
  family_id uuid not null references orbit.families(id) on delete cascade,
  day date not null,
  started_at timestamptz not null,
  ended_at timestamptz not null default now(),
  seconds int not null default 0,
  cards int not null default 0,
  known int not null default 0,
  unknown int not null default 0
);
create index if not exists vocab_sessions_child_day on orbit.vocab_sessions(child_id, day);

alter table orbit.children add column if not exists vocab_settings jsonb not null
  default '{"direction":"fr_de","daily_goal":20,"allow_closed":true}'::jsonb;
alter table orbit.tasks add column if not exists vocab_cards int check (vocab_cards is null or vocab_cards between 1 and 500);
alter table orbit.task_templates add column if not exists vocab_cards int check (vocab_cards is null or vocab_cards between 1 and 500);

alter table orbit.vocab_decks enable row level security;
alter table orbit.vocab_cards enable row level security;
alter table orbit.vocab_progress enable row level security;
alter table orbit.vocab_study enable row level security;
alter table orbit.vocab_sessions enable row level security;
do $$
declare t text;
begin
  foreach t in array array['vocab_decks','vocab_cards','vocab_progress','vocab_study','vocab_sessions'] loop
    execute format('drop policy if exists parent_all on orbit.%I', t);
    execute format('create policy parent_all on orbit.%I for all to authenticated using (family_id = orbit.parent_family()) with check (family_id = orbit.parent_family())', t);
  end loop;
end $$;
grant select, insert, update, delete on orbit.vocab_decks, orbit.vocab_cards, orbit.vocab_progress, orbit.vocab_study, orbit.vocab_sessions to authenticated;

-- Gün (aile saat dilimi)
create or replace function orbit.vocab_today(p_child uuid) returns date
language sql stable security definer set search_path = '' as $$
  select (now() at time zone coalesce(f.timezone, 'Europe/Berlin'))::date
    from orbit.children c join orbit.families f on f.id = c.family_id where c.id = p_child
$$;

-- Bugün çalışılan kart sayısı
create or replace function orbit.vocab_done_today(p_child uuid) returns int
language sql stable security definer set search_path = '' as $$
  select coalesce(sum(cards), 0)::int from orbit.vocab_sessions where child_id = p_child and day = orbit.vocab_today(p_child)
$$;

-- Telefona: ayarlar, ailenin bütün desteleri (kim ekledi, çalışma alanımda mı), kartlar + benim ilerlemem
create or replace function orbit.device_vocab() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare dev orbit.devices := orbit.current_device(); ch orbit.children;
begin
  if dev.id is null or dev.kind <> 'child_phone' then raise exception 'not_allowed'; end if;
  select * into ch from orbit.children where id = dev.child_id;
  return jsonb_build_object(
    'settings', ch.vocab_settings,
    'today', orbit.vocab_today(ch.id),
    'done_today', orbit.vocab_done_today(ch.id),
    'decks', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', d.id, 'name', d.name, 'mine', d.created_by_child = ch.id,
        'by', coalesce((select c2.name from orbit.children c2 where c2.id = d.created_by_child), 'Ebeveyn'),
        'study', exists (select 1 from orbit.vocab_study s where s.child_id = ch.id and s.deck_id = d.id),
        'cards', coalesce((
          select jsonb_agg(jsonb_build_object(
            'id', k.id, 'fr', k.fr, 'de', k.de, 'ex', k.example, 'mine', k.created_by_child = ch.id,
            'box', coalesce(p.box, 0), 'due', p.due_on, 'right', coalesce(p.right_count, 0), 'wrong', coalesce(p.wrong_count, 0)
          ) order by k.created_at)
          from orbit.vocab_cards k
          left join orbit.vocab_progress p on p.card_id = k.id and p.child_id = ch.id
          where k.deck_id = d.id and k.deleted_at is null), '[]'::jsonb)
      ) order by d.created_at desc)
      from orbit.vocab_decks d where d.family_id = ch.family_id and d.deleted_at is null), '[]'::jsonb)
  );
end $$;

create or replace function orbit.device_vocab_deck(p_name text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare dev orbit.devices := orbit.current_device(); id uuid;
begin
  if dev.id is null or dev.kind <> 'child_phone' then raise exception 'not_allowed'; end if;
  insert into orbit.vocab_decks (family_id, name, created_by_child) values (dev.family_id, trim(p_name), dev.child_id) returning vocab_decks.id into id;
  insert into orbit.vocab_study (child_id, deck_id, family_id) values (dev.child_id, id, dev.family_id) on conflict do nothing;
  return id;
end $$;

-- p_cards: [{fr, de, ex}]
create or replace function orbit.device_vocab_add(p_deck uuid, p_cards jsonb) returns int
language plpgsql security definer set search_path = '' as $$
declare dev orbit.devices := orbit.current_device(); n int;
begin
  if dev.id is null or dev.kind <> 'child_phone' then raise exception 'not_allowed'; end if;
  if not exists (select 1 from orbit.vocab_decks where id = p_deck and family_id = dev.family_id and deleted_at is null) then raise exception 'not_allowed'; end if;
  insert into orbit.vocab_cards (deck_id, family_id, fr, de, example, created_by_child)
  select p_deck, dev.family_id, trim(x->>'fr'), trim(x->>'de'), nullif(trim(coalesce(x->>'ex', '')), ''), dev.child_id
    from jsonb_array_elements(p_cards) x
   where length(trim(coalesce(x->>'fr', ''))) > 0 and length(trim(coalesce(x->>'de', ''))) > 0;
  get diagnostics n = row_count;
  return n;
end $$;

-- Sadece kendi eklediği kartı düzenler/siler
create or replace function orbit.device_vocab_card(p_card uuid, p_fr text, p_de text, p_ex text, p_delete boolean) returns void
language plpgsql security definer set search_path = '' as $$
declare dev orbit.devices := orbit.current_device();
begin
  if dev.id is null or dev.kind <> 'child_phone' then raise exception 'not_allowed'; end if;
  if not exists (select 1 from orbit.vocab_cards where id = p_card and created_by_child = dev.child_id) then raise exception 'not_allowed'; end if;
  if p_delete then
    update orbit.vocab_cards set deleted_at = now() where id = p_card;
  else
    update orbit.vocab_cards set fr = trim(p_fr), de = trim(p_de), example = nullif(trim(coalesce(p_ex, '')), '') where id = p_card;
  end if;
end $$;

create or replace function orbit.device_vocab_study(p_deck uuid, p_on boolean) returns void
language plpgsql security definer set search_path = '' as $$
declare dev orbit.devices := orbit.current_device();
begin
  if dev.id is null or dev.kind <> 'child_phone' then raise exception 'not_allowed'; end if;
  if not exists (select 1 from orbit.vocab_decks where id = p_deck and family_id = dev.family_id) then raise exception 'not_allowed'; end if;
  if p_on then
    insert into orbit.vocab_study (child_id, deck_id, family_id) values (dev.child_id, p_deck, dev.family_id) on conflict do nothing;
  else
    delete from orbit.vocab_study where child_id = dev.child_id and deck_id = p_deck;
  end if;
end $$;

-- Çocuk yönü ve günlük hedefi değiştirebilir; kapalı saat izni ebeveynde
create or replace function orbit.device_vocab_settings(p_direction text, p_goal int) returns void
language plpgsql security definer set search_path = '' as $$
declare dev orbit.devices := orbit.current_device();
begin
  if dev.id is null or dev.kind <> 'child_phone' then raise exception 'not_allowed'; end if;
  if p_direction not in ('fr_de', 'de_fr', 'mixed') then raise exception 'bad_direction'; end if;
  update orbit.children
     set vocab_settings = vocab_settings || jsonb_build_object('direction', p_direction, 'daily_goal', greatest(5, least(coalesce(p_goal, 20), 200)))
   where id = dev.child_id;
end $$;

-- Görevi kendiliğinden onayla (kelime hedefi tamamlanınca). parent_decide_run'ın onay kısmı, ebeveynsiz.
create or replace function orbit.auto_approve_run(p_run uuid, p_note text) returns void
language plpgsql security definer set search_path = '' as $$
declare r orbit.task_runs; t orbit.tasks; g orbit.task_groups; mins int; validity text; v_on date; exp date; gid uuid;
  today date := (now() at time zone 'Europe/Berlin')::date;
begin
  select * into r from orbit.task_runs where id = p_run for update;
  if r.id is null or r.status not in ('open', 'started', 'rejected', 'submitted') then return; end if;
  select * into t from orbit.tasks where id = r.task_id;
  if t.group_id is not null then select * into g from orbit.task_groups where id = t.group_id; end if;
  mins := t.reward_minutes; validity := t.reward_validity;
  perform set_config('orbit.grant_bypass', '1', true);
  if g.id is null and mins is not null and mins > 0 then
    if validity = 'today' then
      gid := orbit.give_time(r.child_id, mins, t.use_mode, t.use_within_minutes, t.title, 'task', t.created_by, true);
      update orbit.time_grants set task_run_id = r.id where id = gid;
    else
      v_on := case validity when 'tomorrow' then today + 1 when 'date' then coalesce(t.reward_date, today) else null end;
      exp := case when validity = 'wallet' and t.reward_expires_days is not null then today + t.reward_expires_days end;
      insert into orbit.time_grants (child_id, minutes, valid_on, expires_on, source, note, created_by, task_run_id, vault)
      values (r.child_id, mins, v_on, exp, 'task', t.title, t.created_by, r.id, validity = 'vault')
      returning id into gid;
    end if;
  end if;
  perform set_config('orbit.grant_bypass', '', true);
  update orbit.task_runs
     set status = 'approved', submitted_at = coalesce(submitted_at, now()), decided_at = now(), decided_by = null,
         reject_note = null, granted_minutes = mins, grant_id = gid, reward_text = t.reward_text
   where id = r.id;
  if t.assign_mode = 'first' then
    update orbit.task_runs set status = 'claimed'
     where task_id = t.id and id <> r.id and day = r.day and status in ('open', 'started', 'rejected', 'submitted');
  end if;
  update orbit.agenda_items set status = 'done', completed_at = now(), updated_at = now()
   where task_id = t.id and child_id = r.child_id and status <> 'done';
  if g.id is not null then perform orbit.group_settle(g.id, r.child_id, r.day, false); end if;
  insert into orbit.events (family_id, child_id, type, payload)
  values (t.family_id, r.child_id, 'task_submitted', jsonb_build_object('run_id', r.id, 'title', t.title, 'auto', true, 'note', p_note));
end $$;
revoke all on function orbit.auto_approve_run(uuid, text) from public, anon, authenticated;

-- Çalışma bitti: p_results [{card, known(ilk cevap), n(kaç kez soruldu)}]; aralıklı tekrar kutuları güncellenir, kelime görevleri kontrol edilir
create or replace function orbit.device_vocab_session(p_started timestamptz, p_seconds int, p_results jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare dev orbit.devices := orbit.current_device(); d date; x jsonb; k boolean; b int; cards int := 0; known int := 0; unknown int := 0;
  done int; run record;
begin
  if dev.id is null or dev.kind <> 'child_phone' then raise exception 'not_allowed'; end if;
  d := orbit.vocab_today(dev.child_id);
  for x in select * from jsonb_array_elements(coalesce(p_results, '[]'::jsonb)) loop
    if not exists (select 1 from orbit.vocab_cards where id = (x->>'card')::uuid and family_id = dev.family_id) then continue; end if;
    k := coalesce((x->>'known')::boolean, false);
    cards := cards + 1;
    if k then known := known + 1; else unknown := unknown + 1; end if;
    b := null;
    select box into b from orbit.vocab_progress where child_id = dev.child_id and card_id = (x->>'card')::uuid;
    b := case when k then least(coalesce(b, 0) + 1, 5) else 1 end;
    insert into orbit.vocab_progress (child_id, card_id, family_id, box, due_on, right_count, wrong_count, last_at)
    values (dev.child_id, (x->>'card')::uuid, dev.family_id, b,
            d + (array[1, 3, 7, 14, 30])[b], case when k then 1 else 0 end, case when k then 0 else 1 end, now())
    on conflict (child_id, card_id) do update
      set box = excluded.box, due_on = excluded.due_on, last_at = now(),
          right_count = vocab_progress.right_count + excluded.right_count,
          wrong_count = vocab_progress.wrong_count + excluded.wrong_count;
  end loop;
  if cards > 0 then
    insert into orbit.vocab_sessions (child_id, family_id, day, started_at, seconds, cards, known, unknown)
    values (dev.child_id, dev.family_id, d, coalesce(p_started, now()), greatest(coalesce(p_seconds, 0), 0), cards, known, unknown);
  end if;
  done := orbit.vocab_done_today(dev.child_id);
  -- Kelime hedefli görevler: bugün yeterince kart çalışıldıysa kendiliğinden tamamlanır
  for run in
    select r.id, t.vocab_cards from orbit.task_runs r join orbit.tasks t on t.id = r.task_id
     where r.child_id = dev.child_id and t.vocab_cards is not null and r.status in ('open', 'started', 'rejected')
       and (r.day = d or t.recurrence = 'once') and not orbit.run_locked(r.id)
  loop
    if done >= run.vocab_cards then perform orbit.auto_approve_run(run.id, done || ' kart çalışıldı'); end if;
  end loop;
  return jsonb_build_object('cards', cards, 'known', known, 'unknown', unknown, 'done_today', done);
end $$;

do $$
declare src text := pg_get_functiondef('orbit.device_tasks(date)'::regprocedure);
begin
  if src not like '%vocab_cards%' then
    src := replace(src, 'jsonb_build_object(''allowed_mode'', t.allowed_mode,',
      'jsonb_build_object(''allowed_mode'', t.allowed_mode, ''vocab_cards'', t.vocab_cards, ''vocab_done'', case when t.vocab_cards is not null then orbit.vocab_done_today(child) end,');
    execute src;
  end if;
end $$;
