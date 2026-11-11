-- Görev grubu: ayarlar görev başına (grup ayarları tablosu).
--  Zorunlu (tasks.mandatory) · Bitene kadar telefon (tasks.phone_restriction / restriction_mode_id)
--  Süre ne zaman kazanılır (earn_links + earn_mode + earn_min; boş = görev onaylanınca)
--  Süre nereye gider (tasks.reward_validity today|wallet|vault + use_mode)
--  Göreve başlama (start_after) · Yapılma saati (start_time–due_time, varsayılan 08:00–20:00)
-- Koşul gün içinde sağlanmazsa bekleyen süre kasaya; ceza (fail_minutes) görevin kendisinde.

alter table orbit.tasks add column if not exists earn_links uuid[] not null default '{}';
alter table orbit.tasks add column if not exists earn_mode text not null default 'all';
alter table orbit.tasks add column if not exists earn_min integer not null default 1;
alter table orbit.tasks add column if not exists start_after uuid[] not null default '{}';
alter table orbit.tasks add column if not exists start_time time;
do $$ begin
  alter table orbit.tasks add constraint tasks_earn_mode check (earn_mode in ('all', 'any', 'min'));
exception when duplicate_object then null; end $$;
alter table orbit.task_groups add column if not exists per_task boolean not null default false;

-- Mevcut grupların ayarlarını görevlere taşı (davranış korunur)
do $$
declare g orbit.task_groups; t orbit.tasks; mand uuid[]; b jsonb; prev uuid; links uuid[];
begin
  for g in select * from orbit.task_groups where not per_task loop
    select coalesce(array_agg(id), '{}') into mand from orbit.tasks where group_id = g.id and active and mandatory;
    prev := null;
    for t in select * from orbit.tasks where group_id = g.id order by group_order, created_at, id loop
      links := '{}';
      for b in select * from jsonb_array_elements(coalesce(g.bundles, '[]')) loop
        if t.id = any (orbit.bundle_ids(b)) then links := orbit.bundle_ids(b); end if;
      end loop;
      if cardinality(links) = 0 then
        if not t.mandatory and cardinality(mand) > 0 then links := mand || t.id;
        elsif t.mandatory and g.mandatory_release = 'all' and cardinality(mand) > 1 then links := mand;
        end if;
      end if;
      update orbit.tasks set
        earn_links = links, earn_mode = 'all', earn_min = 1,
        start_after = case when g.sequential and prev is not null then array[prev] else '{}' end,
        start_time = coalesce(g.start_time, start_time),
        due_time = coalesce(g.due_time, due_time),
        reward_validity = case when g.reward_validity in ('today', 'wallet', 'vault') then g.reward_validity else 'today' end,
        use_mode = coalesce(g.use_mode, 'usage'),
        use_within_minutes = g.use_within_minutes,
        phone_restriction = case
          when g.restriction <> 'none' and (g.restriction_until = 'all' or t.mandatory) then g.restriction
          when not t.mandatory then 'none'
          else phone_restriction end,
        restriction_mode_id = case when g.restriction <> 'none' and (g.restriction_until = 'all' or t.mandatory) then g.restriction_mode_id else restriction_mode_id end,
        restricted_allowed = case when g.restriction <> 'none' and coalesce(jsonb_array_length(restricted_allowed), 0) = 0 then g.restricted_allowed else restricted_allowed end
      where id = t.id;
      prev := t.id;
    end loop;
    update orbit.task_groups set per_task = true, bundles = '[]', sequential = false, reward_mode = 'done', fail_mode = 'vault',
      min_count = null, restriction = 'none', restriction_until = 'mandatory'
     where id = g.id;
  end loop;
end $$;
alter table orbit.task_groups alter column per_task set default true;

-- Görevin son saati (görev başına; grup ayarı yedek)
create or replace function orbit.task_due(t orbit.tasks, g orbit.task_groups) returns time
language sql stable set search_path = '' as $$
  select case when g.per_task then coalesce(t.due_time, g.due_time) else coalesce(g.due_time, t.due_time) end
$$;
-- Grubun son saati: görevlerin en geç son saati
create or replace function orbit.group_due(g orbit.task_groups) returns time
language sql stable security definer set search_path = '' as $$
  select case when g.per_task then (select max(coalesce(t.due_time, g.due_time)) from orbit.tasks t where t.group_id = g.id and t.active) else g.due_time end
$$;

-- Kazanma koşulu sağlandı mı (bağlı görevler hepsi / herhangi biri / en az N onaylandı)
create or replace function orbit.task_earn_met(t orbit.tasks, p_child uuid, p_day date) returns boolean
language plpgsql stable security definer set search_path = '' as $$
declare cnt int; n int;
begin
  select count(*), count(*) filter (where r.status = 'approved') into cnt, n
    from orbit.tasks x join orbit.task_runs r on r.task_id = x.id and r.child_id = p_child and r.day = p_day
   where x.id = any (t.earn_links) and x.active and r.status <> 'claimed';
  if coalesce(cardinality(t.earn_links), 0) = 0 or cnt = 0 then return true; end if;
  return case t.earn_mode when 'any' then n >= 1 when 'min' then n >= least(greatest(t.earn_min, 1), cnt) else n = cnt end;
end $$;

-- Görev ödülünü görevin kendi ayarıyla ver (Hemen → süre; Cüzdana; Kasaya)
create or replace function orbit.insert_task_grant(t orbit.tasks, p_child uuid, p_minutes int, p_note text, p_vault boolean) returns uuid
language plpgsql security definer set search_path = '' as $$
declare gid uuid; v text := case when p_vault then 'vault' else coalesce(t.reward_validity, 'today') end;
begin
  if p_minutes is null or p_minutes <= 0 then return null; end if;
  if v = 'today' then
    return orbit.give_time(p_child, p_minutes, coalesce(t.use_mode, 'usage'), t.use_within_minutes, p_note, 'task', t.created_by, true);
  end if;
  insert into orbit.time_grants (child_id, minutes, valid_on, source, note, created_by, vault)
  values (p_child, p_minutes, null, 'task', p_note, t.created_by, v = 'vault')
  returning id into gid;
  return gid;
end $$;

-- Onaylanmış ve koşulu sağlanmış görevlerin süresini aç
create or replace function orbit.task_release(g orbit.task_groups, p_child uuid, p_day date) returns int
language plpgsql security definer set search_path = '' as $$
declare rr record; gid uuid; n int := 0; tt orbit.tasks;
begin
  for rr in
    select r.id, r.task_id, greatest(coalesce(r.granted_minutes, t.reward_minutes, 0), 0) mins
      from orbit.task_runs r join orbit.tasks t on t.id = r.task_id
     where t.group_id = g.id and r.child_id = p_child and r.day = p_day and r.status = 'approved' and r.grant_id is null
     order by r.decided_at nulls last
  loop
    select * into tt from orbit.tasks where id = rr.task_id;
    if not orbit.task_earn_met(tt, p_child, p_day) then continue; end if;
    gid := orbit.insert_task_grant(tt, p_child, rr.mins, g.name || ' · ' || tt.title, false);
    if gid is not null then
      update orbit.time_grants set task_run_id = rr.id where id = gid;
      update orbit.task_runs set grant_id = gid where id = rr.id;
    end if;
    n := n + 1;
  end loop;
  return n;
end $$;

-- Grup kapanışı: görev başına gruplarda bekleyen süre gün sonunda kasaya
create or replace function orbit.group_settle(p_group uuid, p_child uuid, p_day date, p_final boolean)
returns text language plpgsql security definer set search_path = '' as $$
declare g orbit.task_groups; s jsonb; gr orbit.task_group_runs; gid uuid; mins int; met boolean; given int; rr record;
begin
  select * into g from orbit.task_groups where id = p_group;
  if g.id is null then return null; end if;
  insert into orbit.task_group_runs (group_id, child_id, day) values (p_group, p_child, p_day) on conflict do nothing;
  select * into gr from orbit.task_group_runs where group_id = p_group and child_id = p_child and day = p_day for update;
  if gr.status = 'failed' then return gr.status; end if;

  if g.per_task then
    perform orbit.task_release(g, p_child, p_day);
    s := orbit.group_state(p_group, p_child, p_day);
    met := (s->>'total')::int > 0 and (s->>'approved')::int >= (s->>'need')::int and (s->>'mandatory_left')::int = 0;
    if gr.status = 'open' and met and (s->>'held_minutes')::int = 0 then
      update orbit.task_group_runs set status = 'met', settled_at = now() where group_id = p_group and child_id = p_child and day = p_day;
      insert into orbit.events (family_id, child_id, type, payload)
      values (g.family_id, p_child, 'task_group_met', jsonb_build_object('group_id', g.id, 'name', g.name));
      return 'met';
    end if;
    if p_final and gr.status <> 'met' then
      -- Koşulu sağlanmayan bekleyen süreler kasaya
      for rr in
        select r.id, t.title, greatest(coalesce(r.granted_minutes, t.reward_minutes, 0), 0) mins
          from orbit.task_runs r join orbit.tasks t on t.id = r.task_id
         where t.group_id = p_group and r.child_id = p_child and r.day = p_day and r.status = 'approved' and r.grant_id is null
      loop
        if rr.mins > 0 then
          insert into orbit.time_grants (child_id, minutes, valid_on, source, note, created_by, vault, task_run_id)
          values (p_child, rr.mins, null, 'task', g.name || ' · ' || rr.title || ' · koşul sağlanmadı', g.created_by, true, rr.id)
          returning id into gid;
          update orbit.task_runs set grant_id = gid where id = rr.id;
        end if;
      end loop;
      update orbit.task_group_runs set status = case when met then 'met' else 'failed' end, settled_at = now()
       where group_id = p_group and child_id = p_child and day = p_day;
      if not met then
        insert into orbit.events (family_id, child_id, type, payload)
        values (g.family_id, p_child, 'task_group_failed', jsonb_build_object('group_id', g.id, 'name', g.name, 'fail_mode', 'vault', 'held', (s->>'held_minutes')::int));
      end if;
      return case when met then 'met' else 'failed' end;
    end if;
    return gr.status;
  end if;

  -- Eski (grup ayarlı) davranış
  s := orbit.group_state(p_group, p_child, p_day);
  met := (s->>'total')::int > 0 and (s->>'approved')::int >= (s->>'need')::int and (s->>'mandatory_left')::int = 0;
  if (not p_final or gr.status = 'met') and jsonb_array_length(coalesce(g.bundles, '[]')) > 0 then
    perform orbit.group_release_bundles(g, p_child, p_day, (s->>'mandatory_left')::int);
  elsif not p_final or gr.status = 'met' then
    if g.mandatory_release = 'each' then
      perform orbit.group_release(g, p_child, p_day, true);
      if (s->>'mandatory_left')::int = 0 then perform orbit.group_release(g, p_child, p_day, false); end if;
    elsif met then
      perform orbit.group_release(g, p_child, p_day, false);
    end if;
  end if;
  if gr.status = 'open' and met then
    if g.reward_mode = 'all' then
      select coalesce(sum(greatest(coalesce(r.granted_minutes, 0), 0)), 0) into given
        from orbit.task_runs r join orbit.tasks t on t.id = r.task_id
       where t.group_id = p_group and r.child_id = p_child and r.day = p_day and r.status = 'approved';
      mins := (s->>'all_minutes')::int - given;
      if mins > 0 then gid := orbit.insert_group_grant(g, p_child, mins, g.name || ' · tamamlama ödülü', false); end if;
    end if;
    update orbit.task_group_runs set status = 'met', grant_id = gid, settled_at = now() where group_id = p_group and child_id = p_child and day = p_day;
    insert into orbit.events (family_id, child_id, type, payload)
    values (g.family_id, p_child, 'task_group_met', jsonb_build_object('group_id', g.id, 'name', g.name));
    return 'met';
  end if;
  if p_final and gr.status = 'open' then
    s := orbit.group_state(p_group, p_child, p_day);
    if g.fail_mode = 'vault' then
      gid := orbit.insert_group_grant(g, p_child, (s->>'held_minutes')::int, g.name || ' · koşul sağlanmadı', true);
    elsif g.fail_mode = 'penalty' and coalesce(g.penalty_minutes, 0) > 0 then
      gid := orbit.insert_group_grant(g, p_child, -g.penalty_minutes, 'Grup cezası: ' || g.name, false);
    end if;
    update orbit.task_runs r set grant_id = gid
      from orbit.tasks t where t.id = r.task_id and t.group_id = p_group and r.child_id = p_child and r.day = p_day and r.status = 'approved' and r.grant_id is null and gid is not null;
    update orbit.task_group_runs set status = 'failed', grant_id = gid, settled_at = now() where group_id = p_group and child_id = p_child and day = p_day;
    insert into orbit.events (family_id, child_id, type, payload)
    values (g.family_id, p_child, 'task_group_failed', jsonb_build_object('group_id', g.id, 'name', g.name, 'fail_mode', g.fail_mode, 'held', (s->>'held_minutes')::int));
    return 'failed';
  end if;
  return gr.status;
end $$;

-- Göreve başlama: "şu görevler bitince" ve görevin başlama saati
create or replace function orbit.run_locked(p_run uuid) returns boolean
language plpgsql stable security definer set search_path = '' as $$
declare r orbit.task_runs; t orbit.tasks; g orbit.task_groups; nb timestamp := now() at time zone 'Europe/Berlin';
begin
  select * into r from orbit.task_runs where id = p_run;
  select * into t from orbit.tasks where id = r.task_id;
  if t.group_id is null then return false; end if;
  select * into g from orbit.task_groups where id = t.group_id;
  if g.per_task then
    if exists (select 1 from orbit.tasks x join orbit.task_runs r2 on r2.task_id = x.id and r2.child_id = r.child_id and r2.day = r.day
                where x.id = any (t.start_after) and x.active and r2.status not in ('approved', 'claimed')) then return true; end if;
    return t.start_time is not null and r.day = nb::date and nb::time < t.start_time;
  end if;
  return exists (
    select 1 from orbit.tasks t2 join orbit.task_runs r2 on r2.task_id = t2.id and r2.child_id = r.child_id and r2.day = r.day
     where g.sequential and t2.group_id = t.group_id and t2.active
       and (t2.group_order, t2.created_at, t2.id) < (t.group_order, t.created_at, t.id)
       and r2.status not in ('approved', 'claimed')
  ) or (g.start_time is not null and r.day = nb::date and nb::time < g.start_time);
end $$;
