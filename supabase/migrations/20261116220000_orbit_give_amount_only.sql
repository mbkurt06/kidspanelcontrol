-- "Ver" sadece süre (miktar) ekler: kilitliyken saat gibi akan süreye çevrilmez, kilidi de açmaz (açmak için 🔓).
-- Kapalı saatte verilen süre bir sonraki açık saatlere yazılır (telefonu açmaz).
drop trigger if exists grant_locked_clock on orbit.time_grants;

create or replace function orbit.give_time(p_child uuid, p_minutes integer, p_mode text, p_within integer, p_note text, p_source text, p_by uuid, p_task boolean)
returns uuid language plpgsql security definer set search_path to '' as $function$
declare
  os int; oe int;
  nb timestamp := now() at time zone 'Europe/Berlin';
  d date := nb::date;
  t int := orbit.tmins(nb::time);
  s int; e int; gid uuid; gid2 uuid; mode text := coalesce(p_mode, 'usage');
  tv boolean := true;
begin
  if p_minutes is null or p_minutes <= 0 then return null; end if;
  select h.os, h.oe into os, oe from orbit.open_hours(p_child, d) h;
  os := coalesce(os, 480); oe := coalesce(oe, 1260);
  perform set_config('orbit.gt', '1', true);

  if not p_task and (t < os or t >= oe) then
    if t >= oe then
      d := d + 1;
      select h.os, h.oe into os, oe from orbit.open_hours(p_child, d) h;
      os := coalesce(os, 480); oe := coalesce(oe, 1260);
    end if;
    e := case mode when 'clock' then least(os + p_minutes, oe) when 'within' then least(os + coalesce(p_within, 120), oe) else oe end;
    insert into orbit.time_grants (child_id, minutes, valid_on, source, note, created_by, window_start, window_end, use_mode, to_vault)
    values (p_child, p_minutes, d, p_source, p_note, p_by, orbit.mtime(os), orbit.mtime(greatest(e, os + 1)), mode, tv)
    returning id into gid;
    perform set_config('orbit.gt', '', true);
    return gid;
  end if;

  if (p_task and t >= oe) or (mode = 'open' and (t < os or t >= oe)) then
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
      else oe
    end;
  end if;
  if e <= s then e := s + 1; end if;
  e := least(e, 1439);

  insert into orbit.time_grants (child_id, minutes, valid_on, source, note, created_by, window_start, window_end, use_mode, to_vault)
  values (p_child, p_minutes, d, p_source, p_note, p_by, orbit.mtime(s), orbit.mtime(e), mode, tv)
  returning id into gid;
  perform set_config('orbit.gt', '', true);
  return gid;
end; $function$;
