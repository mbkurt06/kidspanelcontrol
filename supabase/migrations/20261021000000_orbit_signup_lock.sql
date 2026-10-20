-- Sadece davet listesindeki e-postalar ve Orbit cihaz hesapları (eşleştirme fonksiyonu açar) kayıt olabilir.
create or replace function orbit.guard_signup()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.email like 'device-%@orbit.invalid' then
    return new;
  end if;
  if exists (select 1 from orbit.allowed_parents a where a.email = lower(new.email)) then
    return new;
  end if;
  raise exception 'signup_not_allowed';
end;
$$;

revoke all on function orbit.guard_signup() from public, anon, authenticated;

create trigger orbit_guard_signup
  before insert on auth.users
  for each row execute function orbit.guard_signup();
