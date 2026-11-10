-- Canlı bağlantı: 25 ayrı tablo aboneliği (postgres_changes) yerine tek yayın kanalı.
-- Bir tablo değişince ilgili çocuğun "orbit-<child>" kanalına küçük bir "changed" mesajı gider (veri yok, sadece tablo adı;
-- komutlarda telefonu bul için kayıt da gönderilir). Aynı işlemde aynı çocuğa bir kez gönderilir.
create or replace function orbit.rt_notify() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  r jsonb := to_jsonb(coalesce(new, old));
  cid uuid := nullif(r ->> 'child_id', '')::uuid;
  fid uuid := nullif(r ->> 'family_id', '')::uuid;
  ids uuid[];
  c uuid;
  k text;
  body jsonb;
begin
  if tg_table_name = 'children' then cid := (r ->> 'id')::uuid; end if;
  if cid is not null then
    ids := array[cid];
  elsif fid is not null then
    select array_agg(id) into ids from orbit.children where family_id = fid;
  else
    select array_agg(id) into ids from orbit.children;
  end if;
  body := jsonb_build_object('table', tg_table_name);
  if tg_table_name = 'commands' and tg_op = 'INSERT' then body := body || jsonb_build_object('record', r); end if;
  foreach c in array coalesce(ids, '{}') loop
    k := 'orbit.rt_' || replace(c::text, '-', '') || '_' || tg_table_name;
    if tg_table_name <> 'commands' and coalesce(current_setting(k, true), '') = '1' then continue; end if;
    perform set_config(k, '1', true);
    begin
      perform realtime.send(body, 'changed', 'orbit-' || c::text, false);
    exception when others then null;
    end;
  end loop;
  return null;
end $$;

do $$
declare t text;
begin
  foreach t in array array['commands','child_apps','time_grants','profile_assignments','day_overrides','task_runs','messages',
    'timer_sessions','alarms','agenda_items','task_group_runs','rule_profiles','modes','mode_slots','profile_sections','section_rules',
    'app_groups','app_group_members','profile_group_limits','tasks','vault_holders','focus_profiles','activities','time_rules','children']
  loop
    if to_regclass('orbit.' || t) is not null then
      execute format('drop trigger if exists rt_notify on orbit.%I', t);
      execute format('create trigger rt_notify after insert or update or delete on orbit.%I for each row execute function orbit.rt_notify()', t);
    end if;
  end loop;
end $$;

-- Telefon canlı bağlantıda mı (panelde gösterilir)
alter table orbit.device_status add column if not exists live boolean;

-- Zamanlanmış işlerin eski çalışma kayıtları birikmesin
select cron.schedule('orbit-cron-history', '41 4 * * *', $$delete from cron.job_run_details where end_time < now() - interval '3 days'$$);
delete from cron.job_run_details where end_time < now() - interval '3 days';

-- Uygulama listesi: değişmeyen satırlar yeniden yazılmasın (her bildirimde iki kez güncelleniyordu)
create or replace function orbit.device_report_apps(p_apps jsonb)
returns void language plpgsql security definer set search_path = '' as $$
declare
  dev orbit.devices := orbit.current_device();
  a jsonb;
  is_new boolean;
  pkgs text[];
begin
  if dev.id is null or dev.kind <> 'child_phone' then raise exception 'not_allowed'; end if;
  select coalesce(array_agg(x ->> 'package'), '{}') into pkgs from jsonb_array_elements(p_apps) x;
  update orbit.child_apps set installed = false
   where child_id = dev.child_id and installed and not (package = any (pkgs));
  for a in select * from jsonb_array_elements(p_apps) loop
    is_new := not exists (select 1 from orbit.child_apps where child_id = dev.child_id and package = a ->> 'package');
    insert into orbit.child_apps (child_id, package, label, is_system, installed, app_group, approved, category)
    values (dev.child_id, a ->> 'package', coalesce(a ->> 'label', a ->> 'package'),
            coalesce((a ->> 'system')::boolean, false), true,
            coalesce(a ->> 'default_group', 'blocked'),
            coalesce((a ->> 'preapproved')::boolean, false),
            a ->> 'category')
    on conflict (child_id, package) do update
      set label = excluded.label, installed = true, updated_at = now(),
          category = coalesce(excluded.category, orbit.child_apps.category)
      where orbit.child_apps.label is distinct from excluded.label
         or not orbit.child_apps.installed
         or (excluded.category is not null and orbit.child_apps.category is distinct from excluded.category);
    if is_new and not coalesce((a ->> 'preapproved')::boolean, false) and (a ->> 'initial') is null then
      insert into orbit.events (family_id, child_id, type, payload)
      values (dev.family_id, dev.child_id, 'app_installed',
              jsonb_build_object('package', a ->> 'package', 'label', a ->> 'label'));
    end if;
  end loop;
end;
$$;

alter table orbit.device_status add column if not exists power_exempt boolean;
