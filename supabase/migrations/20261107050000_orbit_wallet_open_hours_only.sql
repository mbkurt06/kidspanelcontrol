-- Cüzdan yalnızca açık saatlerde kullanılır (device_use_wallet başına eklenen kontrol)
do $$
declare src text := pg_get_functiondef('orbit.device_use_wallet(integer)'::regprocedure);
begin
  if src like '%wallet_closed%' then return; end if;
  src := replace(src,
    'select wallet_daily_max into lim from orbit.children where id=c;',
    'select wallet_daily_max into lim from orbit.children where id=c;
  declare os int; oe int; t int := extract(hour from (now() at time zone coalesce(tz,''Europe/Berlin'')))::int*60 + extract(minute from (now() at time zone coalesce(tz,''Europe/Berlin'')))::int;
  begin
    select h.os, h.oe into os, oe from orbit.open_hours(c, d) h;
    if t < coalesce(os,480) or t >= coalesce(oe,1260) then
      raise exception ''wallet_closed:%-%'', lpad((coalesce(os,480)/60)::text,2,''0'')||'':''||lpad((coalesce(os,480)%60)::text,2,''0''), lpad((coalesce(oe,1260)/60)::text,2,''0'')||'':''||lpad((coalesce(oe,1260)%60)::text,2,''0'');
    end if;
  end;');
  execute src;
end $$;
