-- Hemen kullanılsın süre, cüzdan günlük sınırı, cüzdandan kısmi kullanım.

-- +15 / +30 varsayılanı: "now" = hemen (açıksa o anki bölüme, kapalıysa şu andan itibaren pencere)
alter table orbit.children drop constraint if exists children_extra_default_check;
alter table orbit.children add constraint children_extra_default_check check (extra_default in ('now', 'current', 'pool', 'wallet'));
alter table orbit.children alter column extra_default set default 'now';
update orbit.children set extra_default = 'now' where extra_default = 'current';

-- Çocuk cüzdanından günde en fazla kaç dakika kullanabilir (null = sınır yok)
alter table orbit.children add column if not exists wallet_daily_max int check (wallet_daily_max is null or wallet_daily_max >= 0);

-- Telefon süre kayıtlarını doğrudan değiştiremez; cüzdan kullanımı sadece device_use_wallet ile
create or replace function orbit.guard_phone_grants()
returns trigger language plpgsql security definer set search_path = ''
as $$
begin
  if orbit.device_child() is not null and coalesce(current_setting('orbit.grant_bypass', true), '') <> '1' then
    raise exception 'not_allowed';
  end if;
  return new;
end;
$$;

-- Cüzdandan bugün kullan: istenen dakikayı (gerekirse bölerek) bugüne aktarır, günlük sınırı uygular.
create or replace function orbit.device_use_wallet(p_minutes int)
returns int
language plpgsql security definer set search_path = ''
as $$
declare
  c uuid := orbit.device_child();
  tz text;
  d date;
  lim int;
  used int;
  need int;
  g orbit.time_grants;
begin
  if c is null then raise exception 'not_device'; end if;
  if p_minutes is null or p_minutes < 1 then raise exception 'bad_minutes'; end if;
  select f.timezone into tz from orbit.children ch join orbit.families f on f.id = ch.family_id where ch.id = c;
  d := (now() at time zone coalesce(tz, 'Europe/Berlin'))::date;
  select wallet_daily_max into lim from orbit.children where id = c;
  select coalesce(sum(minutes), 0) into used from orbit.time_grants where child_id = c and activated_on = d;
  if lim is not null and used + p_minutes > lim then
    raise exception 'wallet_limit:%', greatest(lim - used, 0);
  end if;
  perform set_config('orbit.grant_bypass', '1', true);
  need := p_minutes;
  for g in
    select * from orbit.time_grants
    where child_id = c and not vault and valid_on is null and activated_on is null
      and (expires_on is null or expires_on >= d)
    order by expires_on nulls last, created_at
    for update
  loop
    exit when need <= 0;
    if g.minutes <= need then
      update orbit.time_grants set activated_on = d where id = g.id;
      need := need - g.minutes;
    else
      update orbit.time_grants set minutes = g.minutes - need where id = g.id;
      insert into orbit.time_grants (child_id, minutes, activated_on, expires_on, source, note, created_by)
      values (c, need, d, g.expires_on, g.source, g.note, g.created_by);
      need := 0;
    end if;
  end loop;
  perform set_config('orbit.grant_bypass', '', true);
  if need > 0 then
    if need = p_minutes then raise exception 'wallet_empty'; end if;
  end if;
  return p_minutes - greatest(need, 0);
end;
$$;
grant execute on function orbit.device_use_wallet(int) to anon, authenticated;
