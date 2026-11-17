-- Görev başına TELEFON KİLİDİ (K0 dokunmaz · K1 süresi bitene kadar · K2 gün boyu · K3 saate kadar)
-- ve grup dışı görevin süresinin başka görevlere (gruptakiler dahil) bağlanması: koşul sağlanana kadar bekler, gün sonunda kasaya.
alter table orbit.tasks add column if not exists unlock_mode text not null default 'k1' check (unlock_mode in ('k0', 'k1', 'k2', 'k3'));
alter table orbit.tasks add column if not exists unlock_until time;
alter table orbit.time_grants add column if not exists unlock text check (unlock in ('k0', 'k1', 'k2', 'k3'));
alter table orbit.time_grants add column if not exists unlock_until time;

-- Görev ödülü süresi, görevin kilit ayarını taşır (telefon kilidi buna göre kalkar)
create or replace function orbit.grant_unlock_from_task() returns trigger
language plpgsql security definer set search_path to '' as $$
begin
  if new.task_run_id is not null and (tg_op = 'INSERT' or old.task_run_id is distinct from new.task_run_id) then
    select t.unlock_mode, t.unlock_until into new.unlock, new.unlock_until
      from orbit.task_runs r join orbit.tasks t on t.id = r.task_id where r.id = new.task_run_id;
  end if;
  return new;
end $$;
drop trigger if exists grant_unlock_from_task on orbit.time_grants;
create trigger grant_unlock_from_task before insert or update of task_run_id on orbit.time_grants
for each row execute function orbit.grant_unlock_from_task();

-- Grup dışı, bağlı görevlerin bekleyen süresi: koşul sağlanınca verilir; p_final = gün bitti → kasaya
create or replace function orbit.release_linked(p_child uuid, p_day date, p_final boolean default false) returns integer
language plpgsql security definer set search_path to '' as $$
declare rr record; t orbit.tasks; gid uuid; n int := 0; mins int;
begin
  for rr in
    select r.id, r.task_id, r.granted_minutes from orbit.task_runs r join orbit.tasks x on x.id = r.task_id
     where r.child_id = p_child and r.day = p_day and r.status = 'approved' and r.grant_id is null
       and x.group_id is null and coalesce(cardinality(x.earn_links), 0) > 0
     order by r.decided_at nulls last
  loop
    select * into t from orbit.tasks where id = rr.task_id;
    mins := greatest(coalesce(rr.granted_minutes, t.reward_minutes, 0), 0);
    if mins <= 0 then continue; end if;
    perform set_config('orbit.grant_bypass', '1', true);
    if orbit.task_earn_met(t, p_child, p_day) then
      gid := orbit.insert_task_grant(t, p_child, mins, t.title, false);
    elsif p_final then
      gid := orbit.insert_task_grant(t, p_child, mins, t.title || ' · koşul sağlanmadı', true);
    else
      continue;
    end if;
    if gid is not null then
      update orbit.time_grants set task_run_id = rr.id where id = gid;
      update orbit.task_runs set grant_id = gid where id = rr.id;
      n := n + 1;
    end if;
  end loop;
  perform set_config('orbit.grant_bypass', '', true);
  return n;
end $$;

-- Bir görev onaylanınca: ona bağlı bekleyen grup dışı süreler kontrol edilir
create or replace function orbit.release_linked_trg() returns trigger
language plpgsql security definer set search_path to '' as $$
begin
  if new.status = 'approved' and old.status is distinct from 'approved' then
    perform orbit.release_linked(new.child_id, new.day, false);
  end if;
  return null;
end $$;
drop trigger if exists release_linked on orbit.task_runs;
create trigger release_linked after update of status on orbit.task_runs
for each row execute function orbit.release_linked_trg();

-- Gün geçince bekleyenler kasaya
create or replace function orbit.settle_linked(p_today date) returns void
language plpgsql security definer set search_path to '' as $$
declare x record;
begin
  for x in
    select distinct r.child_id, r.day from orbit.task_runs r join orbit.tasks t on t.id = r.task_id
     where r.status = 'approved' and r.grant_id is null and t.group_id is null and coalesce(cardinality(t.earn_links), 0) > 0
       and r.day < p_today and r.day >= p_today - 14
  loop
    perform orbit.release_linked(x.child_id, x.day, true);
  end loop;
end $$;

-- Onaylanınca: bağlı grup dışı görevin süresi hemen verilmez (bekler)
do $$
declare d text;
begin
  d := pg_get_functiondef('orbit.parent_decide_run(uuid,boolean,text,integer,text,date,date)'::regprocedure);
  execute replace(d, 'if g.id is null and mins is not null and mins > 0 then', 'if g.id is null and mins is not null and mins > 0 and coalesce(cardinality(t.earn_links), 0) = 0 then');
  d := pg_get_functiondef('orbit.auto_approve_run(uuid,text)'::regprocedure);
  execute replace(d, 'if g.id is null and mins is not null and mins > 0 then', 'if g.id is null and mins is not null and mins > 0 and coalesce(cardinality(t.earn_links), 0) = 0 then');
  -- Telefon: grup dışı bekleyen süre ve bağlantı bilgisi, kilit ayarı
  d := pg_get_functiondef('orbit.device_tasks(date)'::regprocedure);
  d := replace(d, '''held'', g.id is not null and r.status = ''approved''', '''held'', (g.id is not null or coalesce(cardinality(t.earn_links), 0) > 0) and r.status = ''approved''');
  d := replace(d, '''earn'', case when g.per_task and cardinality(t.earn_links) > 0 then', '''unlock_mode'', t.unlock_mode, ''unlock_until'', t.unlock_until, ''earn'', case when (coalesce(g.per_task, false) or g.id is null) and cardinality(t.earn_links) > 0 then');
  execute d;
end $$;

select cron.unschedule('orbit-expire-runs');
select cron.schedule('orbit-expire-runs', '*/5 * * * *', $$select orbit.expire_runs((now() at time zone 'Europe/Berlin')::date); select orbit.settle_linked((now() at time zone 'Europe/Berlin')::date)$$);
