-- Açık saatler artık Ayarlar'daki ayrı ayardan değil, çocuğun günlük programından gelir:
-- o günün programında "Kilitli" olmayan (Açık / Sınırlı) bölümlerin ilk başlangıcı – son bitişi.
-- Programı olmayan çocukta eski aile ayarı (yoksa 08:00–21:00) kullanılır.
create or replace function orbit.open_hours(p_child uuid, p_day date, out os int, out oe int)
language sql stable security definer set search_path = '' as $$
  with secs as (
    select orbit.tmins(s.start_time) st,
           case when s.end_time <= s.start_time then 1439 else orbit.tmins(s.end_time) end en
      from orbit.profile_assignments a
      join orbit.profile_sections s on s.profile_id = a.profile_id
     where a.child_id = p_child and a.weekday = extract(isodow from p_day)::int and s.default_rule <> 'blocked'
  ), fam as (
    select orbit.tmins(f.open_start) fs, orbit.tmins(f.open_end) fe from orbit.families f join orbit.children c on c.family_id = f.id where c.id = p_child
  )
  select coalesce((select min(st) from secs), (select fs from fam), 480),
         least(coalesce((select max(en) from secs), (select fe from fam), 1260), 1439)
$$;

create or replace function orbit.open_end_at(p_child uuid, p_day date) returns time
language sql stable security definer set search_path = '' as $$ select orbit.mtime((orbit.open_hours(p_child, p_day)).oe) $$;
create or replace function orbit.open_start_at(p_child uuid, p_day date) returns time
language sql stable security definer set search_path = '' as $$ select orbit.mtime((orbit.open_hours(p_child, p_day)).os) $$;

do $do$
declare src text;
begin
  -- give_time: açık saatler programdan; "kullanılana kadar" süre ertesi günün açılışına kadar
  src := pg_get_functiondef('orbit.give_time(uuid,integer,text,integer,text,text,uuid,boolean)'::regprocedure);
  src := replace(src, 'select orbit.tmins(f.open_start), orbit.tmins(f.open_end) into os, oe
    from orbit.families f join orbit.children c on c.family_id = f.id where c.id = p_child;',
    'select h.os, h.oe into os, oe from orbit.open_hours(p_child, d) h;');
  src := replace(src, 'else case when t < os then os else 1440 + os end',
    'else case when t < os then os else 1440 + (select h2.os from orbit.open_hours(p_child, d + 1) h2) end');
  if position('orbit.open_hours' in src) = 0 then raise exception 'give_time yaması uymadı'; end if;
  execute src;

  src := pg_get_functiondef('orbit.expire_runs(date)'::regprocedure);
  src := replace(src, 'coalesce(t2.due_time, f.open_end)', 'coalesce(t2.due_time, orbit.open_end_at(r2.child_id, p_today))');
  src := replace(src, 'coalesce(g2.due_time, f.open_end)', 'coalesce(g2.due_time, orbit.open_end_at(r2.child_id, p_today))');
  src := replace(src, 'coalesce(gg.due_time, ff.open_end)', 'coalesce(gg.due_time, orbit.open_end_at(rr.child_id, p_today))');
  if position('open_end)' in src) > 0 then raise exception 'expire_runs yaması uymadı'; end if;
  execute src;

  src := pg_get_functiondef('orbit.device_tasks(date)'::regprocedure);
  src := replace(src, 'coalesce(g.start_time, f.open_start)', 'coalesce(g.start_time, orbit.open_start_at(child, p_day))');
  src := replace(src, 'coalesce(g.due_time, t.due_time, f.open_end)', 'coalesce(g.due_time, t.due_time, orbit.open_end_at(child, p_day))');
  if position('f.open_' in src) > 0 then raise exception 'device_tasks yaması uymadı'; end if;
  execute src;
end $do$;
