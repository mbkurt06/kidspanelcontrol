-- Kameralı görev: görev süresince zaman atlamalı kayıt (2 kare/sn, 40 kare/sn oynatma → 1x = 20 kat hız).

-- Görev / şablon ayarları
alter table orbit.tasks add column if not exists record_minutes int check (record_minutes is null or record_minutes between 1 and 240);
alter table orbit.tasks add column if not exists record_camera text not null default 'back' check (record_camera in ('back', 'front', 'choose'));
alter table orbit.tasks add column if not exists record_pause text not null default 'child' check (record_pause in ('none', 'limit', 'child'));
alter table orbit.tasks add column if not exists record_pause_max int check (record_pause_max is null or record_pause_max > 0);
alter table orbit.task_templates add column if not exists record_minutes int check (record_minutes is null or record_minutes between 1 and 240);
alter table orbit.task_templates add column if not exists record_camera text not null default 'back' check (record_camera in ('back', 'front', 'choose'));
alter table orbit.task_templates add column if not exists record_pause text not null default 'child' check (record_pause in ('none', 'limit', 'child'));
alter table orbit.task_templates add column if not exists record_pause_max int check (record_pause_max is null or record_pause_max > 0);

create table if not exists orbit.task_recordings (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references orbit.task_runs(id) on delete cascade,
  child_id uuid not null references orbit.children(id) on delete cascade,
  family_id uuid not null references orbit.families(id) on delete cascade,
  attempt int not null default 0,
  status text not null default 'recording' check (status in ('recording', 'paused', 'done', 'cancelled')),
  camera text not null default 'back',
  planned_seconds int,
  recorded_seconds int not null default 0,
  paused_seconds int not null default 0,
  pause_count int not null default 0,
  capture_fps real not null default 2,
  video_fps int not null default 40,
  -- [{at, type: start|pause|resume|gap|leave|done|cancel, ...}]
  events jsonb not null default '[]'::jsonb,
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  updated_at timestamptz not null default now()
);
create index if not exists task_recordings_run on orbit.task_recordings (run_id);
alter table orbit.task_recordings enable row level security;
create policy parent_all on orbit.task_recordings for all to authenticated
  using (family_id = orbit.parent_family()) with check (family_id = orbit.parent_family());
create policy phone_read on orbit.task_recordings for select to authenticated using (child_id = orbit.device_child());
grant select, insert, update, delete on orbit.task_recordings to authenticated;

-- Kayıt parçaları kanıt olarak saklanır (silme kuralları aynen geçerli)
alter table orbit.task_proofs drop constraint if exists task_proofs_media_check;
alter table orbit.task_proofs add constraint task_proofs_media_check check (media in ('photo', 'video', 'timelapse'));
alter table orbit.task_proofs drop constraint if exists task_proofs_stage_check;
alter table orbit.task_proofs add constraint task_proofs_stage_check check (stage in ('before', 'after', 'single', 'record'));
alter table orbit.task_proofs add column if not exists recording_id uuid references orbit.task_recordings(id) on delete set null;
alter table orbit.task_proofs add column if not exists seq int;
alter table orbit.task_proofs add column if not exists frames int;
alter table orbit.task_proofs add column if not exists started_at timestamptz;
alter table orbit.task_proofs add column if not exists ended_at timestamptz;

-- Kayda başla (ya da yarım kalan kaydı sürdür)
create or replace function orbit.device_record_start(p_run uuid, p_camera text)
returns jsonb
language plpgsql volatile security definer set search_path = ''
as $$
declare
  dev orbit.devices := orbit.current_device();
  r orbit.task_runs;
  t orbit.tasks;
  rec orbit.task_recordings;
begin
  if dev.id is null or dev.kind <> 'child_phone' then raise exception 'not_allowed'; end if;
  select * into r from orbit.task_runs where id = p_run and child_id = dev.child_id;
  if r.id is null then raise exception 'not_allowed'; end if;
  if r.status not in ('open', 'started', 'rejected') then raise exception 'not_open'; end if;
  select * into t from orbit.tasks where id = r.task_id;
  if t.record_minutes is null then raise exception 'no_recording'; end if;
  select * into rec from orbit.task_recordings
   where run_id = r.id and attempt = r.attempts and status in ('recording', 'paused')
   order by started_at desc limit 1;
  if rec.id is null then
    insert into orbit.task_recordings (run_id, child_id, family_id, attempt, camera, planned_seconds, events)
    values (r.id, dev.child_id, dev.family_id, r.attempts, coalesce(p_camera, t.record_camera), t.record_minutes * 60,
            jsonb_build_array(jsonb_build_object('at', now(), 'type', 'start')))
    returning * into rec;
    insert into orbit.events (family_id, child_id, type, payload)
    values (dev.family_id, dev.child_id, 'recording', jsonb_build_object('action', 'start', 'title', t.title, 'run_id', r.id, 'minutes', t.record_minutes));
  end if;
  if r.status in ('open', 'rejected') then
    update orbit.task_runs set status = 'started' where id = r.id;
  end if;
  return to_jsonb(rec);
end;
$$;

-- Kayıt durumu: süreler, durum ve olay (mola, ara verme, kesinti, bitti)
create or replace function orbit.device_record_update(p_id uuid, p_status text, p_recorded int, p_paused int, p_pause_count int, p_event jsonb default null)
returns void
language plpgsql volatile security definer set search_path = ''
as $$
declare
  dev orbit.devices := orbit.current_device();
  rec orbit.task_recordings;
  title text;
  ev text;
begin
  if dev.id is null or dev.kind <> 'child_phone' then raise exception 'not_allowed'; end if;
  select * into rec from orbit.task_recordings where id = p_id and child_id = dev.child_id;
  if rec.id is null then raise exception 'not_allowed'; end if;
  if rec.status in ('done', 'cancelled') then return; end if;
  if p_status not in ('recording', 'paused', 'done', 'cancelled') then raise exception 'bad_status'; end if;
  update orbit.task_recordings
     set status = p_status,
         recorded_seconds = greatest(coalesce(p_recorded, recorded_seconds), 0),
         paused_seconds = greatest(coalesce(p_paused, paused_seconds), 0),
         pause_count = greatest(coalesce(p_pause_count, pause_count), 0),
         events = case when p_event is null then events else events || jsonb_build_array(p_event || jsonb_build_object('at', now())) end,
         ended_at = case when p_status in ('done', 'cancelled') then now() else ended_at end,
         updated_at = now()
   where id = rec.id;
  ev := p_event ->> 'type';
  if ev is not null then
    select t.title into title from orbit.task_runs r join orbit.tasks t on t.id = r.task_id where r.id = rec.run_id;
    insert into orbit.events (family_id, child_id, type, payload)
    values (dev.family_id, dev.child_id,
            case when ev in ('gap', 'leave') or (ev = 'done' and coalesce(p_recorded, 0) < coalesce(rec.planned_seconds, 0) - 30) or ev = 'cancel'
                 then 'recording_alert' else 'recording' end,
            jsonb_build_object('action', ev, 'title', title, 'run_id', rec.run_id, 'recorded', p_recorded,
                               'planned', rec.planned_seconds, 'paused', p_paused, 'note', p_event ->> 'note'));
  end if;
end;
$$;

-- Yüklenen kayıt parçası
create or replace function orbit.device_record_segment(p_id uuid, p_seq int, p_path text, p_frames int, p_start timestamptz, p_end timestamptz)
returns void
language plpgsql volatile security definer set search_path = ''
as $$
declare
  dev orbit.devices := orbit.current_device();
  rec orbit.task_recordings;
begin
  if dev.id is null or dev.kind <> 'child_phone' then raise exception 'not_allowed'; end if;
  select * into rec from orbit.task_recordings where id = p_id and child_id = dev.child_id;
  if rec.id is null then raise exception 'not_allowed'; end if;
  if p_path not like dev.family_id::text || '/' || rec.run_id::text || '/%' then raise exception 'bad_path'; end if;
  if exists (select 1 from orbit.task_proofs where recording_id = rec.id and seq = p_seq) then return; end if;
  insert into orbit.task_proofs (run_id, child_id, family_id, stage, media, path, attempt, recording_id, seq, frames, started_at, ended_at)
  values (rec.run_id, dev.child_id, dev.family_id, 'record', 'timelapse', p_path, rec.attempt, rec.id, p_seq, p_frames, p_start, p_end);
end;
$$;

grant execute on function orbit.device_record_start(uuid, text), orbit.device_record_update(uuid, text, int, int, int, jsonb),
  orbit.device_record_segment(uuid, int, text, int, timestamptz, timestamptz) to authenticated;

-- Gönderim: kayıtlı görevde tamamlanmış kayıt gerekir
create or replace function orbit.device_submit_run(p_run uuid)
returns text
language plpgsql volatile security definer set search_path = ''
as $$
declare
  dev orbit.devices := orbit.current_device();
  r orbit.task_runs;
  t orbit.tasks;
  have_before boolean;
  have_after boolean;
begin
  if dev.id is null or dev.kind <> 'child_phone' then raise exception 'not_allowed'; end if;
  select * into r from orbit.task_runs where id = p_run and child_id = dev.child_id;
  if r.id is null then raise exception 'not_allowed'; end if;
  if r.status not in ('open', 'started', 'rejected') then raise exception 'not_open'; end if;
  select * into t from orbit.tasks where id = r.task_id;
  if t.proof <> 'none' then
    select exists (select 1 from orbit.task_proofs where run_id = r.id and removed_at is null and stage = 'before') into have_before;
    select exists (select 1 from orbit.task_proofs where run_id = r.id and attempt = r.attempts and removed_at is null and stage in ('after', 'single')) into have_after;
    if not have_after or (t.before_after and not have_before) then raise exception 'proof_missing'; end if;
  end if;
  if t.record_minutes is not null and not exists (
    select 1 from orbit.task_recordings where run_id = r.id and attempt = r.attempts and status = 'done') then
    raise exception 'recording_missing';
  end if;
  update orbit.task_runs set status = 'submitted', submitted_at = now() where id = r.id;
  insert into orbit.events (family_id, child_id, type, payload)
  values (dev.family_id, dev.child_id, 'task_submitted', jsonb_build_object('run_id', r.id, 'title', t.title));
  return 'submitted';
end;
$$;

-- Telefona görev listesi: kayıt ayarları ve şimdiki denemenin kaydı
create or replace function orbit.device_tasks(p_day date)
returns jsonb
language plpgsql volatile security definer set search_path = ''
as $$
declare child uuid := orbit.device_child();
begin
  if child is null then raise exception 'not_allowed'; end if;
  perform orbit.expire_runs(p_day);
  perform orbit.ensure_runs(child, p_day);
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'run_id', r.id, 'task_id', t.id, 'day', r.day, 'status', r.status, 'reject_note', r.reject_note,
      'title', t.title, 'description', t.description, 'proof', t.proof, 'before_after', t.before_after,
      'reward_minutes', t.reward_minutes, 'reward_text', t.reward_text, 'reward_validity', t.reward_validity,
      'reward_date', t.reward_date, 'mandatory', t.mandatory, 'due_time', t.due_time, 'due_date', coalesce(t.due_date, t.end_date),
      'assign_mode', t.assign_mode, 'attempts', r.attempts, 'created_at', r.created_at,
      'record_minutes', t.record_minutes, 'record_camera', t.record_camera, 'record_pause', t.record_pause,
      'record_pause_max', t.record_pause_max,
      'recording', (select jsonb_build_object('id', x.id, 'status', x.status, 'recorded_seconds', x.recorded_seconds,
                                              'paused_seconds', x.paused_seconds, 'pause_count', x.pause_count, 'camera', x.camera)
                    from orbit.task_recordings x where x.run_id = r.id and x.attempt = r.attempts and x.status <> 'cancelled'
                    order by x.started_at desc limit 1),
      -- "öncesi" her denemeden sayılır; "sonrası" sadece şimdiki denemeden
      'proofs', (select coalesce(jsonb_agg(jsonb_build_object('stage', p.stage, 'media', p.media)), '[]'::jsonb)
                 from orbit.task_proofs p where p.run_id = r.id and p.removed_at is null and p.stage <> 'record'
                   and (p.stage = 'before' or p.attempt = r.attempts))
    ) order by t.mandatory desc, t.due_time nulls last, t.created_at)
    from orbit.task_runs r join orbit.tasks t on t.id = r.task_id
    where r.child_id = child
      and (r.day = p_day
           or (t.recurrence = 'once' and r.status in ('open', 'started', 'submitted', 'rejected'))
           or (r.day >= p_day - 1 and r.status in ('approved', 'rejected', 'submitted')))
  ), '[]'::jsonb);
end;
$$;

-- Bildirim: kayıt kesintisi / erken bitirme
create or replace function orbit.on_event_push()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if new.type in ('task_submitted', 'time_request', 'app_request', 'app_installed', 'parent_device_pending',
                  'device_owner_lost', 'offline_long', 'device_paired', 'push_test', 'message', 'timer_alert', 'recording_alert') then
    perform orbit.call_function('orbit-push', jsonb_build_object('event_id', new.id));
  end if;
  return new;
end;
$$;
