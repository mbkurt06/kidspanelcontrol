-- Web sayfaları / video listeleri ailenin ortak listesi: her çocukta bir child_apps satırı.
-- Eklendiği çocukta "Kurallara göre", diğerlerinde "Hep kapalı" başlar (kapalıysa telefonda görünmez).
-- web_apps.child_id = eklendiği çocuk (bilgi).
drop policy if exists device_read on orbit.web_apps;
create policy device_read on orbit.web_apps for select to authenticated using (family_id = orbit.device_family());

create or replace function orbit.web_app_sync() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    delete from orbit.child_apps where package = 'web:' || old.id
      and child_id in (select id from orbit.children where family_id = old.family_id);
    return old;
  end if;
  insert into orbit.child_apps (child_id, package, label, is_system, installed, app_group, approved, category)
  select c.id, 'web:' || new.id, new.title, false, true,
         case when c.id = new.child_id then 'timed' else 'blocked' end, true, null
    from orbit.children c where c.family_id = new.family_id
  on conflict (child_id, package) do update set label = excluded.label, installed = true, updated_at = now();
  return new;
end $$;

-- Yeni çocuk eklenince ailenin web sayfaları ona "Hep kapalı" gelir
create or replace function orbit.web_apps_for_child() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into orbit.child_apps (child_id, package, label, is_system, installed, app_group, approved, category)
  select new.id, 'web:' || w.id, w.title, false, true, 'blocked', true, null
    from orbit.web_apps w where w.family_id = new.family_id
  on conflict (child_id, package) do nothing;
  return new;
end $$;
drop trigger if exists web_apps_for_child on orbit.children;
create trigger web_apps_for_child after insert on orbit.children for each row execute function orbit.web_apps_for_child();

-- Var olanları diğer çocuklara da ekle (Hep kapalı)
insert into orbit.child_apps (child_id, package, label, is_system, installed, app_group, approved, category)
select c.id, 'web:' || w.id, w.title, false, true, 'blocked', true, null
  from orbit.web_apps w join orbit.children c on c.family_id = w.family_id
on conflict (child_id, package) do nothing;
