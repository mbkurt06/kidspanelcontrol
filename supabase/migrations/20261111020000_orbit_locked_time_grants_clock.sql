-- Kilit / Tam kilit / kapalı saatte verilen her süre "saat gibi akar":
-- verildiği andan itibaren verilen dakika kadar telefon açık; bitince telefon eski durumuna (Tam kilit, kilitli, kapalı) döner.
-- Kalan olmaz (kasaya gitmez). Açık saatte verilen süre değişmedi: açık saat sonuna kadar, kalanı kasaya.

/** Çocuk şu an kilit durumunda mı: 'kiosk' (Tam kilit), 'locked' (Kilitli bölüm), 'closed' (açık saat dışı) ya da null (açık). */
create or replace function orbit.child_locked_state(p_child uuid) returns text
language plpgsql stable security definer set search_path = '' as $$
declare
  nb timestamp := now() at time zone 'Europe/Berlin';
  d date := nb::date;
  t int := orbit.tmins(nb::time);
  dow int := extract(isodow from d)::int;
  ydow int := extract(isodow from d - 1)::int;
  fam uuid; lc record; sec record; has_prof boolean; os int; oe int;
begin
  select family_id into fam from orbit.children where id = p_child;
  if fam is null then return null; end if;

  -- Elle Tam kilit
  select type, until_at into lc from orbit.commands
   where child_id = p_child and cancelled_at is null and type in ('kiosk_start', 'kiosk_end')
   order by created_at desc limit 1;
  if lc.type = 'kiosk_start' and (lc.until_at is null or lc.until_at > now()) then return 'kiosk'; end if;

  -- Kilit programı (Tam kilit saatleri)
  if exists (
    select 1 from orbit.time_rules r
     where r.family_id = fam and r.active and r.kind = 'kiosk'
       and (coalesce(cardinality(r.child_ids), 0) = 0 or p_child = any (r.child_ids))
       and (r.start_date is null or r.start_date <= d) and (r.end_date is null or r.end_date >= d)
       and case when r.end_time > r.start_time
                then dow = any (r.days::int[]) and t >= orbit.tmins(r.start_time) and t < orbit.tmins(r.end_time)
                else (dow = any (r.days::int[]) and t >= orbit.tmins(r.start_time)) or (ydow = any (r.days::int[]) and t < orbit.tmins(r.end_time))
           end
  ) then return 'kiosk'; end if;

  -- Bugünkü programın o anki bölümü
  select exists (select 1 from orbit.profile_assignments a where a.child_id = p_child and a.weekday = dow) into has_prof;
  if has_prof then
    select s.default_rule, s.kiosk, s.mode_id into sec
      from orbit.profile_assignments a join orbit.profile_sections s on s.profile_id = a.profile_id
     where a.child_id = p_child and a.weekday = dow
       and case when s.end_time > s.start_time then t >= orbit.tmins(s.start_time) and t < orbit.tmins(s.end_time)
                else t >= orbit.tmins(s.start_time) or t < orbit.tmins(s.end_time) end
     order by s.sort_order limit 1;
    if not found then return 'closed'; end if;
    if sec.kiosk then return 'kiosk'; end if;
    if sec.mode_id is not null and exists (select 1 from orbit.modes m where m.id = sec.mode_id and m.kiosk_enabled) then return 'kiosk'; end if;
    if sec.default_rule = 'blocked' then return 'locked'; end if;
  end if;

  select h.os, h.oe into os, oe from orbit.open_hours(p_child, d) h;
  if t < coalesce(os, 480) or t >= coalesce(oe, 1260) then return 'closed'; end if;
  return null;
end $$;
revoke execute on function orbit.child_locked_state(uuid) from public, anon, authenticated;

/** Panel: çocuk şu an kilit saatinde mi (verilen süre saat gibi akacak mı) */
create or replace function orbit.child_lock_state(p_child uuid) returns text
language plpgsql stable security definer set search_path = '' as $$
begin
  if not exists (select 1 from orbit.children c where c.id = p_child and (c.family_id = orbit.parent_family() or c.id = orbit.device_child())) then
    raise exception 'not_allowed';
  end if;
  return orbit.child_locked_state(p_child);
end $$;
grant execute on function orbit.child_lock_state(uuid) to authenticated;

-- Süre ver: kilit saatindeyse (görev ödülü hariç) her zaman saat gibi akar, kalan kasaya gitmez
create or replace function orbit.give_time(p_child uuid, p_minutes int, p_mode text, p_within int, p_note text, p_source text, p_by uuid, p_task boolean)
returns uuid language plpgsql volatile security definer set search_path = '' as $$
declare
  os int; oe int;
  nb timestamp := now() at time zone 'Europe/Berlin';
  d date := nb::date;
  t int := orbit.tmins(nb::time);
  s int; e int; gid uuid; gid2 uuid; mode text := coalesce(p_mode, 'usage');
  locked boolean := false; tv boolean := true;
begin
  if p_minutes is null or p_minutes <= 0 then return null; end if;
  select h.os, h.oe into os, oe from orbit.open_hours(p_child, d) h;
  os := coalesce(os, 480); oe := coalesce(oe, 1260);

  if not p_task and orbit.child_locked_state(p_child) is not null then
    locked := true; mode := 'clock'; tv := false;
  end if;
  perform set_config('orbit.gt', '1', true);

  if not locked and ((p_task and t >= oe) or (mode = 'open' and (t < os or t >= oe))) then
    insert into orbit.time_grants (child_id, minutes, valid_on, source, note, created_by, vault)
    values (p_child, p_minutes, null, p_source, coalesce(p_note, 'Ekstra süre') || ' · kullanılamadı (kapalı saat)', p_by, true)
    returning id into gid;
    perform set_config('orbit.gt', '', true);
    return gid;
  end if;

  s := case when p_task then greatest(t, os) else t end;
  if p_task then
    e := case mode when 'clock' then least(s + p_minutes, oe) when 'within' then least(s + coalesce(p_within, 120), oe) else oe end;
  else
    e := case mode
      when 'clock' then s + p_minutes
      when 'within' then s + coalesce(p_within, 120)
      when 'open' then oe
      else case when t < os then os when t < oe then oe else 1440 + (select h2.os from orbit.open_hours(p_child, d + 1) h2) end
    end;
  end if;
  if e <= s then e := s + 1; end if;

  if e <= 1439 then
    insert into orbit.time_grants (child_id, minutes, valid_on, source, note, created_by, window_start, window_end, use_mode, to_vault)
    values (p_child, p_minutes, d, p_source, p_note, p_by, orbit.mtime(s), orbit.mtime(e), mode, tv)
    returning id into gid;
    perform set_config('orbit.gt', '', true);
    return gid;
  end if;

  insert into orbit.time_grants (child_id, minutes, valid_on, source, note, created_by, window_start, window_end, use_mode, to_vault)
  values (p_child, case when mode = 'clock' then least(p_minutes, e - 1440) else p_minutes end, d + 1, p_source, p_note, p_by,
          '00:00', orbit.mtime(greatest(e - 1440, 1)), mode, tv)
  returning id into gid2;
  insert into orbit.time_grants (child_id, minutes, valid_on, source, note, created_by, window_start, window_end, use_mode, to_vault, carry_to)
  values (p_child, case when mode = 'clock' then least(p_minutes, 1439 - s) else p_minutes end, d, p_source, p_note, p_by,
          orbit.mtime(s), '23:59', mode, tv, case when mode = 'clock' then null else gid2 end)
  returning id into gid;
  perform set_config('orbit.gt', '', true);
  return gid;
end; $$;

-- Panelden / telefondan doğrudan eklenen "şu andan itibaren" süreler de kilit saatinde saat gibi akar
create or replace function orbit.grant_locked_clock() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  nb timestamp := now() at time zone 'Europe/Berlin';
  d date := nb::date;
  t int := orbit.tmins(nb::time);
  e int;
begin
  if current_setting('orbit.gt', true) = '1' then return new; end if;
  if new.vault or new.window_start is null or new.valid_on is distinct from d or new.minutes <= 0 then return new; end if;
  if coalesce(new.source, 'manual') not in ('manual', 'leftover') then return new; end if;
  if abs(orbit.tmins(new.window_start) - t) > 2 then return new; end if;   -- ileri saatli süreler değil, sadece "şimdi"
  if orbit.child_locked_state(new.child_id) is null then return new; end if;

  new.use_mode := 'clock';
  new.to_vault := false;
  new.carry_to := null;
  new.window_start := orbit.mtime(t);
  e := t + new.minutes;
  if e <= 1439 then
    new.window_end := orbit.mtime(e);
  else
    -- Gece yarısını geçiyor: bugün 23:59'a kadar, kalan dakikalar yarın 00:00'dan itibaren
    new.window_end := '23:59';
    perform set_config('orbit.gt', '1', true);
    insert into orbit.time_grants (child_id, minutes, valid_on, source, note, created_by, window_start, window_end, use_mode, to_vault)
    values (new.child_id, e - 1439, d + 1, new.source, new.note, new.created_by, '00:00', orbit.mtime(greatest(e - 1439, 1)), 'clock', false);
    perform set_config('orbit.gt', '', true);
    new.minutes := 1439 - t;
  end if;
  return new;
end $$;
drop trigger if exists grant_locked_clock on orbit.time_grants;
create trigger grant_locked_clock before insert on orbit.time_grants for each row execute function orbit.grant_locked_clock();
