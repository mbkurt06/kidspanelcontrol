-- Saat aralığında kullanılan süre (use_mode = 'range'): ebeveynin seçtiği aralık aynen kalır, kilitliyken saat gibi akışa çevrilmez.
create or replace function orbit.grant_locked_clock() returns trigger
language plpgsql security definer set search_path = '' as $function$
declare
  nb timestamp := now() at time zone 'Europe/Berlin';
  d date := nb::date;
  t int := orbit.tmins(nb::time);
  e int;
begin
  if current_setting('orbit.gt', true) = '1' then return new; end if;
  if new.use_mode = 'range' then return new; end if;
  if new.vault or new.window_start is null or new.valid_on is distinct from d or new.minutes <= 0 then return new; end if;
  if coalesce(new.source, 'manual') not in ('manual', 'leftover') then return new; end if;
  if abs(orbit.tmins(new.window_start) - t) > 2 then return new; end if;
  if orbit.child_locked_state(new.child_id) is null then return new; end if;

  new.use_mode := 'clock';
  new.to_vault := false;
  new.carry_to := null;
  new.window_start := orbit.mtime(t);
  e := t + new.minutes;
  if e <= 1439 then
    new.window_end := orbit.mtime(e);
  else
    new.window_end := '23:59';
    perform set_config('orbit.gt', '1', true);
    insert into orbit.time_grants (child_id, minutes, valid_on, source, note, created_by, window_start, window_end, use_mode, to_vault)
    values (new.child_id, e - 1439, d + 1, new.source, new.note, new.created_by, '00:00', orbit.mtime(greatest(e - 1439, 1)), 'clock', false);
    perform set_config('orbit.gt', '', true);
    new.minutes := 1439 - t;
  end if;
  return new;
end $function$;
