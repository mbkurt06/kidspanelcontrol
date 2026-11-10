-- "Süre bitene kadar" (usage) süre açık saatlerde verildiyse açık saatlerin sonuna kadar geçerli; kalanı kasaya gider.
-- Önceden ertesi sabaha kadar uzuyordu: sabah verilen süre gece kilidini de aşıyordu.
do $$
declare src text := pg_get_functiondef('orbit.give_time'::regproc);
  o text := $q$else case when t < os then os else 1440 + (select h2.os from orbit.open_hours(p_child, d + 1) h2) end$q$;
  n text := $q$else case when t < os then os when t < oe then oe else 1440 + (select h2.os from orbit.open_hours(p_child, d + 1) h2) end$q$;
begin
  if position(o in src) = 0 then raise exception 'give_time beklenen metni içermiyor'; end if;
  execute replace(src, o, n);
end $$;
