-- Zorunlu görev kısıtlaması, görev saat aralığı (açık saatler), grup ödül serbest bırakma ve süre kullanma modları
--
-- Açık saatler: aile ayarı (varsayılan 08:00–21:00, her gün). Görevler ve görevden kazanılan süre bu aralıkta geçerli.
-- Süre modları: clock (saat gibi aksın), usage (kullandıkça düşer), within (belirli süre içinde), open (açık saatlerde; sadece elle verilen)
-- Görevden kazanılan süre açık saatlerin sonunu geçmez. Elle verilen süre (open hariç) her saatte geçerli.
-- Kullanılmayan süre (to_vault) bitişte telefon tarafından kasaya aktarılır.

alter table orbit.families add column if not exists open_start time not null default '08:00';
alter table orbit.families add column if not exists open_end time not null default '21:00';

alter table orbit.tasks drop constraint if exists tasks_phone_restriction_check;
alter table orbit.tasks add constraint tasks_phone_restriction_check check (phone_restriction in ('none', 'limit', 'kiosk', 'mode'));
alter table orbit.tasks add column if not exists restriction_mode_id uuid references orbit.modes(id) on delete set null;
alter table orbit.tasks add column if not exists restricted_allowed jsonb not null default '[]';
alter table orbit.tasks add column if not exists use_mode text not null default 'usage' check (use_mode in ('clock', 'usage', 'within'));
alter table orbit.tasks add column if not exists use_within_minutes int;
alter table orbit.tasks alter column allowed_mode set default 'focus';
update orbit.tasks set allowed_mode = 'focus' where allowed_mode <> 'focus';

alter table orbit.task_templates add column if not exists phone_restriction text not null default 'none';
alter table orbit.task_templates add column if not exists restriction_mode_id uuid;
alter table orbit.task_templates add column if not exists restricted_allowed jsonb not null default '[]';
alter table orbit.task_templates add column if not exists use_mode text not null default 'usage';
alter table orbit.task_templates add column if not exists use_within_minutes int;

alter table orbit.task_groups add column if not exists mandatory_release text not null default 'each' check (mandatory_release in ('each', 'all'));
alter table orbit.task_groups add column if not exists use_mode text not null default 'usage' check (use_mode in ('clock', 'usage', 'within'));
alter table orbit.task_groups add column if not exists use_within_minutes int;

alter table orbit.time_grants add column if not exists use_mode text;
alter table orbit.time_grants add column if not exists to_vault boolean not null default false;
alter table orbit.time_grants add column if not exists carry_to uuid references orbit.time_grants(id) on delete set null;
alter table orbit.time_grants add column if not exists settled_at timestamptz;
alter table orbit.time_grants drop constraint if exists time_grants_source_check;
alter table orbit.time_grants add constraint time_grants_source_check check (source in ('manual', 'task', 'task_penalty', 'daily_surplus', 'leftover'));

create or replace function orbit.mtime(m int) returns time language sql immutable set search_path = '' as $$
  select make_time(least(greatest(m, 0), 1439) / 60, least(greatest(m, 0), 1439) % 60, 0)
$$;
create or replace function orbit.tmins(t time) returns int language sql immutable set search_path = '' as $$
  select extract(hour from t)::int * 60 + extract(minute from t)::int
$$;

/**
 * Süre ver: moda göre saat aralıklı süre (gerekirse gece yarısında ikiye bölünür).
 * p_task = true: görevden kazanılan süre, açık saatlerin dışına taşmaz (kapalıysa doğrudan kasaya).
 * Dönüş: ilk süre kaydının id'si.
 */
create or replace function orbit.give_time(p_child uuid, p_minutes int, p_mode text, p_within int, p_note text, p_source text, p_by uuid, p_task boolean)
returns uuid language plpgsql volatile security definer set search_path = '' as $$
declare
  os int; oe int;
  nb timestamp := now() at time zone 'Europe/Berlin';
  d date := nb::date;
  t int := orbit.tmins(nb::time);
  s int; e int; gid uuid; gid2 uuid; mode text := coalesce(p_mode, 'usage');
begin
  if p_minutes is null or p_minutes <= 0 then return null; end if;
  select orbit.tmins(f.open_start), orbit.tmins(f.open_end) into os, oe
    from orbit.families f join orbit.children c on c.family_id = f.id where c.id = p_child;
  os := coalesce(os, 480); oe := coalesce(oe, 1260);

  -- Kullanılamayacak süre: doğrudan kasaya
  if (p_task and t >= oe) or (mode = 'open' and (t < os or t >= oe)) then
    insert into orbit.time_grants (child_id, minutes, valid_on, source, note, created_by, vault)
    values (p_child, p_minutes, null, p_source, coalesce(p_note, 'Ekstra süre') || ' · kullanılamadı (kapalı saat)', p_by, true)
    returning id into gid;
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
      else case when t < os then os else 1440 + os end   -- usage: kapalı saatler bitene kadar
    end;
  end if;
  if e <= s then e := s + 1; end if;

  if e <= 1439 then
    insert into orbit.time_grants (child_id, minutes, valid_on, source, note, created_by, window_start, window_end, use_mode, to_vault)
    values (p_child, p_minutes, d, p_source, p_note, p_by, orbit.mtime(s), orbit.mtime(e), mode, true)
    returning id into gid;
    return gid;
  end if;

  -- Gece yarısını geçiyor: yarın için devam kaydı (kalan süre telefon tarafından aktarılır)
  insert into orbit.time_grants (child_id, minutes, valid_on, source, note, created_by, window_start, window_end, use_mode, to_vault)
  values (p_child, case when mode = 'clock' then least(p_minutes, e - 1440) else p_minutes end, d + 1, p_source, p_note, p_by,
          '00:00', orbit.mtime(greatest(e - 1440, 1)), mode, true)
  returning id into gid2;
  insert into orbit.time_grants (child_id, minutes, valid_on, source, note, created_by, window_start, window_end, use_mode, to_vault, carry_to)
  values (p_child, case when mode = 'clock' then least(p_minutes, 1439 - s) else p_minutes end, d, p_source, p_note, p_by,
          orbit.mtime(s), '23:59', mode, true, case when mode = 'clock' then null else gid2 end)
  returning id into gid;
  return gid;
end; $$;

/** Ebeveyn: hemen süre ver (4 mod). */
create or replace function orbit.parent_give_time(p_child uuid, p_minutes int, p_mode text, p_within int default null, p_note text default null)
returns uuid language plpgsql volatile security definer set search_path = '' as $$
declare fam uuid := orbit.parent_family();
begin
  if fam is null or not exists (select 1 from orbit.children where id = p_child and family_id = fam) then raise exception 'not_allowed'; end if;
  if p_mode not in ('clock', 'usage', 'within', 'open') then raise exception 'bad_mode'; end if;
  return orbit.give_time(p_child, p_minutes, p_mode, p_within, p_note, 'manual', auth.uid(), false);
end; $$;
grant execute on function orbit.parent_give_time(uuid, int, text, int, text) to authenticated;

/** Telefon: saat aralıklı sürenin kullanılmayan kısmı (bitişte). Devamı varsa ona, yoksa kasaya. */
create or replace function orbit.device_grant_leftover(p_grant uuid, p_minutes int)
returns void language plpgsql volatile security definer set search_path = '' as $$
declare dev orbit.devices := orbit.current_device(); g orbit.time_grants;
begin
  if dev.id is null or dev.kind <> 'child_phone' then raise exception 'not_allowed'; end if;
  select * into g from orbit.time_grants where id = p_grant and child_id = dev.child_id for update;
  if g.id is null or g.settled_at is not null or not g.to_vault then return; end if;
  update orbit.time_grants set settled_at = now() where id = g.id;
  if g.carry_to is not null then
    if coalesce(p_minutes, 0) <= 0 then
      update orbit.time_grants set minutes = 0, settled_at = now() where id = g.carry_to;
    else
      update orbit.time_grants set minutes = least(p_minutes, g.minutes) where id = g.carry_to;
    end if;
  elsif coalesce(p_minutes, 0) > 0 then
    insert into orbit.time_grants (child_id, minutes, valid_on, source, note, created_by, vault)
    values (g.child_id, least(p_minutes, g.minutes), null, 'leftover', 'Kullanılmayan süre · ' || coalesce(g.note, 'Ekstra süre'), g.created_by, true);
  end if;
end; $$;
grant execute on function orbit.device_grant_leftover(uuid, int) to authenticated, anon;

-- Grup durumu: bekleyen = onaylanmış ama henüz verilmemiş
create or replace function orbit.group_state(p_group uuid, p_child uuid, p_day date)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare g orbit.task_groups; total int; approved int; mand_left int; held int; need int; st text; mand int;
begin
  select * into g from orbit.task_groups where id = p_group;
  if g.id is null then return null; end if;
  select count(*), count(*) filter (where r.status = 'approved'),
         count(*) filter (where t.mandatory and r.status <> 'approved'),
         count(*) filter (where t.mandatory),
         coalesce(sum(case when r.status = 'approved' and r.grant_id is null then greatest(coalesce(r.granted_minutes, t.reward_minutes, 0), 0) else 0 end), 0)
    into total, approved, mand_left, mand, held
    from orbit.task_runs r join orbit.tasks t on t.id = r.task_id
   where t.group_id = p_group and r.child_id = p_child and r.day = p_day and r.status <> 'claimed';
  need := case when g.min_count is null then total else least(g.min_count, total) end;
  select status into st from orbit.task_group_runs where group_id = p_group and child_id = p_child and day = p_day;
  return jsonb_build_object('total', total, 'approved', approved, 'need', need, 'mandatory_left', mand_left, 'mandatory', mand,
    'held_minutes', held, 'status', coalesce(st, 'open'), 'release', g.mandatory_release,
    'all_minutes', (select coalesce(sum(greatest(coalesce(t.reward_minutes, 0), 0)), 0) from orbit.tasks t where t.group_id = p_group and t.active));
end; $$;

/** Grubun ödülünü ver: grubun geçerliliğine (hemen / cüzdan / kasa) ve kullanma moduna göre. */
create or replace function orbit.insert_group_grant(g orbit.task_groups, p_child uuid, p_minutes integer, p_note text, p_vault boolean)
returns uuid language plpgsql security definer set search_path = '' as $$
declare gid uuid; v text := case when p_vault then 'vault' else g.reward_validity end;
begin
  if p_minutes is null or p_minutes = 0 then return null; end if;
  if p_minutes > 0 and v = 'today' then
    return orbit.give_time(p_child, p_minutes, g.use_mode, g.use_within_minutes, p_note, 'task', g.created_by, true);
  end if;
  insert into orbit.time_grants (child_id, minutes, valid_on, source, note, created_by, vault)
  values (p_child, p_minutes, case when v = 'today' then (now() at time zone 'Europe/Berlin')::date else null end,
          case when p_minutes < 0 then 'task_penalty' else 'task' end, p_note, g.created_by, v = 'vault')
  returning id into gid;
  return gid;
end; $$;

/** Bekleyen grup ödüllerini ver (seçili koşu kümeleri). */
create or replace function orbit.group_release(g orbit.task_groups, p_child uuid, p_day date, p_mandatory_only boolean)
returns int language plpgsql security definer set search_path = '' as $$
declare rr record; gid uuid; n int := 0;
begin
  for rr in
    select r.id, t.title, greatest(coalesce(r.granted_minutes, t.reward_minutes, 0), 0) mins
      from orbit.task_runs r join orbit.tasks t on t.id = r.task_id
     where t.group_id = g.id and r.child_id = p_child and r.day = p_day and r.status = 'approved' and r.grant_id is null
       and (not p_mandatory_only or t.mandatory)
     order by r.decided_at
  loop
    if rr.mins > 0 then
      gid := orbit.insert_group_grant(g, p_child, rr.mins, g.name || ' · ' || rr.title, false);
      update orbit.time_grants set task_run_id = rr.id where id = gid;
    else gid := null;
    end if;
    if gid is not null then update orbit.task_runs set grant_id = gid where id = rr.id; end if;
    n := n + 1;
  end loop;
  return n;
end; $$;

create or replace function orbit.group_settle(p_group uuid, p_child uuid, p_day date, p_final boolean)
returns text language plpgsql security definer set search_path = '' as $$
declare g orbit.task_groups; s jsonb; gr orbit.task_group_runs; gid uuid; mins int; met boolean; given int;
begin
  select * into g from orbit.task_groups where id = p_group;
  if g.id is null then return null; end if;
  insert into orbit.task_group_runs (group_id, child_id, day) values (p_group, p_child, p_day) on conflict do nothing;
  select * into gr from orbit.task_group_runs where group_id = p_group and child_id = p_child and day = p_day for update;
  if gr.status = 'failed' then return gr.status; end if;
  s := orbit.group_state(p_group, p_child, p_day);
  met := (s->>'total')::int > 0 and (s->>'approved')::int >= (s->>'need')::int and (s->>'mandatory_left')::int = 0;

  if not p_final or gr.status = 'met' then
    -- (a) her zorunlu görev onaylanınca kendi süresi hemen; seçmeliler zorunlular bitince
    if g.mandatory_release = 'each' then
      perform orbit.group_release(g, p_child, p_day, true);
      if (s->>'mandatory_left')::int = 0 then perform orbit.group_release(g, p_child, p_day, false); end if;
    -- (b) koşul sağlanınca hepsi birlikte
    elsif met then
      perform orbit.group_release(g, p_child, p_day, false);
    end if;
  end if;

  if gr.status = 'open' and met then
    if g.reward_mode = 'all' then
      select coalesce(sum(greatest(coalesce(r.granted_minutes, 0), 0)), 0) into given
        from orbit.task_runs r join orbit.tasks t on t.id = r.task_id
       where t.group_id = p_group and r.child_id = p_child and r.day = p_day and r.status = 'approved';
      mins := (s->>'all_minutes')::int - given;
      if mins > 0 then gid := orbit.insert_group_grant(g, p_child, mins, g.name || ' · tamamlama ödülü', false); end if;
    end if;
    update orbit.task_group_runs set status = 'met', grant_id = gid, settled_at = now() where group_id = p_group and child_id = p_child and day = p_day;
    insert into orbit.events (family_id, child_id, type, payload)
    values (g.family_id, p_child, 'task_group_met', jsonb_build_object('group_id', g.id, 'name', g.name));
    return 'met';
  end if;

  if p_final and gr.status = 'open' then
    s := orbit.group_state(p_group, p_child, p_day);
    if g.fail_mode = 'vault' then
      gid := orbit.insert_group_grant(g, p_child, (s->>'held_minutes')::int, g.name || ' · koşul sağlanmadı', true);
    elsif g.fail_mode = 'penalty' and coalesce(g.penalty_minutes, 0) > 0 then
      gid := orbit.insert_group_grant(g, p_child, -g.penalty_minutes, 'Grup cezası: ' || g.name, false);
    end if;
    update orbit.task_runs r set grant_id = gid
      from orbit.tasks t where t.id = r.task_id and t.group_id = p_group and r.child_id = p_child and r.day = p_day and r.status = 'approved' and r.grant_id is null and gid is not null;
    update orbit.task_group_runs set status = 'failed', grant_id = gid, settled_at = now() where group_id = p_group and child_id = p_child and day = p_day;
    insert into orbit.events (family_id, child_id, type, payload)
    values (g.family_id, p_child, 'task_group_failed', jsonb_build_object('group_id', g.id, 'name', g.name, 'fail_mode', g.fail_mode, 'held', (s->>'held_minutes')::int));
    return 'failed';
  end if;
  return gr.status;
end; $$;

create or replace function orbit.parent_decide_run(p_run uuid, p_approve boolean, p_note text, p_minutes integer default null, p_validity text default null, p_date date default null, p_expires date default null)
returns text[] language plpgsql security definer set search_path = '' as $$
declare
  fam uuid := orbit.parent_family();
  r orbit.task_runs; t orbit.tasks; g orbit.task_groups;
  mins int; validity text; v_on date; exp date;
  today date := (now() at time zone 'Europe/Berlin')::date;
  gid uuid; paths text[] := '{}'; keep int;
begin
  if fam is null then raise exception 'not_allowed'; end if;
  select r2.* into r from orbit.task_runs r2 join orbit.tasks t2 on t2.id = r2.task_id where r2.id = p_run and t2.family_id = fam;
  if r.id is null then raise exception 'not_allowed'; end if;
  select * into t from orbit.tasks where id = r.task_id;
  if t.group_id is not null then select * into g from orbit.task_groups where id = t.group_id; end if;

  if p_approve then
    mins := coalesce(p_minutes, t.reward_minutes);
    validity := coalesce(p_validity, t.reward_validity);
    -- Gruptaki görev: süre grubun kuralına göre (group_settle) verilir
    if g.id is null and mins is not null and mins > 0 then
      if validity = 'today' then
        gid := orbit.give_time(r.child_id, mins, t.use_mode, t.use_within_minutes, t.title, 'task', auth.uid(), true);
        update orbit.time_grants set task_run_id = r.id where id = gid;
      else
        v_on := case validity when 'tomorrow' then today + 1 when 'date' then coalesce(p_date, t.reward_date, today) else null end;
        exp := case when validity = 'wallet' then coalesce(p_expires, case when t.reward_expires_days is not null then today + t.reward_expires_days end) end;
        insert into orbit.time_grants (child_id, minutes, valid_on, expires_on, source, note, created_by, task_run_id, vault)
        values (r.child_id, mins, v_on, exp, 'task', t.title, auth.uid(), r.id, validity = 'vault')
        returning id into gid;
      end if;
    end if;
    update orbit.task_runs
       set status = 'approved', decided_at = now(), decided_by = auth.uid(), reject_note = null,
           granted_minutes = mins, grant_id = gid, reward_text = t.reward_text
     where id = r.id;
    if t.assign_mode = 'first' then
      update orbit.task_runs set status = 'claimed'
       where task_id = t.id and id <> r.id and day = r.day and status in ('open', 'started', 'rejected', 'submitted');
    end if;
    update orbit.agenda_items set status = 'done', completed_at = now(), updated_at = now()
     where task_id = t.id and child_id = r.child_id and status <> 'done';
    if g.id is not null then perform orbit.group_settle(g.id, r.child_id, r.day, false); end if;
    select proof_retention_days into keep from orbit.families where id = fam;
    if coalesce(keep, 0) = 0 then
      select coalesce(array_agg(path), '{}') into paths from orbit.task_proofs where run_id = r.id and removed_at is null;
      update orbit.task_proofs set removed_at = now() where run_id = r.id and removed_at is null;
    else
      update orbit.task_proofs set delete_after = now() + make_interval(days => keep) where run_id = r.id and removed_at is null;
    end if;
  else
    insert into orbit.task_run_notes (run_id, attempt, note, created_by)
    values (r.id, r.attempts, nullif(trim(coalesce(p_note, '')), ''), auth.uid());
    update orbit.task_runs
       set status = 'rejected', decided_at = now(), decided_by = auth.uid(), reject_note = nullif(trim(coalesce(p_note, '')), ''),
           attempts = attempts + 1
     where id = r.id;
  end if;
  return paths;
end; $$;

create or replace function orbit.device_tasks(p_day date)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare child uuid := orbit.device_child();
begin
  if child is null then raise exception 'not_allowed'; end if;
  perform orbit.expire_runs(p_day);
  perform orbit.ensure_runs(child, p_day);
  return coalesce((select jsonb_agg(jsonb_build_object(
    'run_id', r.id, 'task_id', t.id, 'day', r.day, 'status', r.status, 'reject_note', r.reject_note, 'title', t.title, 'description', t.description,
    'proof', t.proof, 'before_after', t.before_after,
    'before_photo_min', t.before_photo_min, 'before_photo_max', t.before_photo_max, 'after_photo_min', t.after_photo_min, 'after_photo_max', t.after_photo_max,
    'proof_before_min', t.proof_before_min, 'proof_before_max', t.proof_before_max, 'proof_after_min', t.proof_after_min, 'proof_after_max', t.proof_after_max,
    'reward_minutes', t.reward_minutes, 'reward_text', t.reward_text, 'reward_validity', coalesce(g.reward_validity, t.reward_validity), 'reward_date', t.reward_date,
    'mandatory', t.mandatory, 'due_time', coalesce(g.due_time, t.due_time),
    'due_date', case when g.id is null then coalesce(t.due_date, t.end_date) when g.recurrence = 'once' then g.end_date else r.day end,
    'assign_mode', t.assign_mode, 'attempts', r.attempts, 'created_at', r.created_at,
    'record_minutes', t.record_minutes, 'record_min_minutes', t.record_min_minutes, 'screenshot_min', t.screenshot_min, 'screenshot_max', t.screenshot_max, 'screen_record_minutes', t.screen_record_minutes, 'screen_record_min_minutes', t.screen_record_min_minutes, 'allowed_packages', to_jsonb(t.allowed_packages), 'record_camera', t.record_camera, 'record_pause', t.record_pause, 'record_pause_max', t.record_pause_max,
    'recording', (select jsonb_build_object('id', x.id, 'status', x.status, 'recorded_seconds', x.recorded_seconds, 'paused_seconds', x.paused_seconds, 'pause_count', x.pause_count, 'camera', x.camera)
                    from orbit.task_recordings x where x.run_id = r.id and x.attempt = r.attempts and x.status <> 'cancelled' and x.camera <> 'screen' order by x.started_at desc limit 1),
    'screen_recording', (select jsonb_build_object('id', x.id, 'status', x.status, 'recorded_seconds', x.recorded_seconds) from orbit.task_recordings x where x.run_id = r.id and x.attempt = r.attempts and x.status <> 'cancelled' and x.camera = 'screen' order by x.started_at desc limit 1),
    'proofs', (select coalesce(jsonb_agg(jsonb_build_object('stage', p.stage, 'media', p.media)), '[]'::jsonb)
                 from orbit.task_proofs p where p.run_id = r.id and p.removed_at is null and p.stage <> 'record' and (p.stage = 'before' or p.attempt = r.attempts)),
    'group_id', g.id, 'group_name', g.name, 'group_order', t.group_order, 'sequential', coalesce(g.sequential, false),
    'locked', case when g.id is not null then orbit.run_locked(r.id) else false end, 'start_time', g.start_time,
    'group', case when g.id is not null then orbit.group_state(g.id, r.child_id, r.day) end,
    'agenda_item_id', (select a.id from orbit.agenda_items a where a.task_id = t.id and a.child_id = r.child_id limit 1)
  ) || jsonb_build_object('allowed_mode', t.allowed_mode,
       'start_date', t.start_date, 'end_date', t.end_date, 'recurrence', t.recurrence,
       'window_start', coalesce(g.start_time, f.open_start), 'window_end', coalesce(g.due_time, t.due_time, f.open_end),
       'restriction', case when g.id is null or t.mandatory then t.phone_restriction else 'none' end,
       'restriction_mode_id', t.restriction_mode_id, 'restricted_allowed', t.restricted_allowed,
       'orbit_focus_profile_id', t.orbit_focus_profile_id)
  order by g.sort nulls last, g.id nulls last, t.group_order, t.mandatory desc, t.due_time nulls last, t.created_at)
  from orbit.task_runs r
  join orbit.tasks t on t.id = r.task_id
  left join orbit.task_groups g on g.id = t.group_id
  join orbit.families f on f.id = t.family_id
  where r.child_id = child and (r.day = p_day
    or ((t.recurrence = 'once' and t.group_id is null or g.recurrence = 'once') and r.status in ('open', 'started', 'submitted', 'rejected'))
    or (r.day >= p_day - 1 and r.status in ('approved', 'rejected', 'submitted')))), '[]'::jsonb);
end; $$;


create or replace function orbit.expire_runs(p_today date)
returns void language plpgsql security definer set search_path = '' as $$
declare r orbit.task_runs; t orbit.tasks; mins int; validity text; v_on date; exp date; x record;
  nowt time := (now() at time zone 'Europe/Berlin')::time;
begin
  for r in
    select r2 from orbit.task_runs r2
      join orbit.tasks t2 on t2.id = r2.task_id
      join orbit.families f on f.id = t2.family_id
      left join orbit.task_groups g2 on g2.id = t2.group_id
     where r2.status in ('open', 'started', 'rejected') and (
       (g2.id is null and (
          (t2.recurrence = 'days' and r2.day < p_today)
          or (t2.recurrence = 'once' and coalesce(t2.due_date, t2.end_date) is not null and coalesce(t2.due_date, t2.end_date) < p_today)
          or (((t2.recurrence = 'days' and r2.day = p_today) or (t2.recurrence = 'once' and coalesce(t2.due_date, t2.end_date) = p_today)) and coalesce(t2.due_time, f.open_end) <= nowt)))
       or (g2.id is not null and (
          (g2.recurrence <> 'once' and r2.day < p_today)
          or (g2.recurrence = 'once' and g2.end_date is not null and g2.end_date < p_today)
          or ((case when g2.recurrence = 'once' then coalesce(g2.end_date, g2.start_date) else r2.day end) = p_today and coalesce(g2.due_time, f.open_end) <= nowt)))
     )
  loop
    select * into t from orbit.tasks where id = r.task_id;
    if coalesce(t.reward_minutes, 0) < 0 and not exists (select 1 from orbit.time_grants tg where tg.task_run_id = r.id and tg.source = 'task_penalty') then
      mins := t.reward_minutes; validity := coalesce(t.reward_validity, 'today');
      v_on := case validity when 'today' then p_today when 'tomorrow' then p_today + 1 when 'date' then coalesce(t.reward_date, p_today) else null end;
      exp := case when validity = 'wallet' and t.reward_expires_days is not null then p_today + t.reward_expires_days end;
      insert into orbit.time_grants (child_id, minutes, valid_on, expires_on, source, note, created_by, task_run_id, vault)
      values (r.child_id, mins, v_on, exp, 'task_penalty', 'Görev cezası: ' || t.title, t.created_by, r.id, validity = 'vault');
    end if;
    update orbit.task_runs set status = 'expired' where id = r.id;
  end loop;

  for x in
    select distinct tt.group_id, rr.child_id, rr.day
      from orbit.task_runs rr
      join orbit.tasks tt on tt.id = rr.task_id
      join orbit.task_groups gg on gg.id = tt.group_id
      join orbit.families ff on ff.id = gg.family_id
     where not exists (select 1 from orbit.task_group_runs gr where gr.group_id = tt.group_id and gr.child_id = rr.child_id and gr.day = rr.day and gr.status <> 'open')
       and (
         (gg.recurrence <> 'once' and rr.day < p_today)
         or (gg.recurrence = 'once' and gg.end_date is not null and gg.end_date < p_today)
         or ((case when gg.recurrence = 'once' then coalesce(gg.end_date, gg.start_date) else rr.day end) = p_today and coalesce(gg.due_time, ff.open_end) <= nowt))
       and rr.day >= p_today - 14
  loop
    if not exists (select 1 from orbit.task_runs r3 join orbit.tasks t3 on t3.id = r3.task_id
                    where t3.group_id = x.group_id and r3.child_id = x.child_id and r3.day = x.day and r3.status = 'submitted') then
      perform orbit.group_settle(x.group_id, x.child_id, x.day, true);
    end if;
  end loop;
end; $$;
