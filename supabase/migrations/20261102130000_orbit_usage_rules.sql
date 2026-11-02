create table if not exists orbit.app_usage_rules (
  id uuid primary key default gen_random_uuid(), family_id uuid not null references orbit.families(id) on delete cascade,
  name text not null, mode text not null default 'timed' check (mode in ('open','timed','blocked')),
  max_minutes int check (max_minutes is null or max_minutes >= 0), counts_toward_daily boolean not null default true,
  start_time time, end_time time, created_at timestamptz not null default now(),
  check ((start_time is null) = (end_time is null))
);
create index if not exists app_usage_rules_family on orbit.app_usage_rules(family_id);
alter table orbit.child_apps add column if not exists usage_rule_id uuid references orbit.app_usage_rules(id) on delete set null;
alter table orbit.families add column if not exists task_before_photo_min int not null default 1;
alter table orbit.families add column if not exists task_before_photo_max int not null default 4;
alter table orbit.families add column if not exists task_after_photo_min int not null default 1;
alter table orbit.families add column if not exists task_after_photo_max int not null default 4;
alter table orbit.tasks add column if not exists before_photo_min int not null default 1;
alter table orbit.tasks add column if not exists before_photo_max int not null default 4;
alter table orbit.tasks add column if not exists after_photo_min int not null default 1;
alter table orbit.tasks add column if not exists after_photo_max int not null default 4;
alter table orbit.task_templates add column if not exists before_photo_min int not null default 1;
alter table orbit.task_templates add column if not exists before_photo_max int not null default 4;
alter table orbit.task_templates add column if not exists after_photo_min int not null default 1;
alter table orbit.task_templates add column if not exists after_photo_max int not null default 4;
do $$ begin if not exists (select 1 from pg_constraint where conname = 'families_task_photo_defaults_check') then alter table orbit.families add constraint families_task_photo_defaults_check check (task_before_photo_min between 1 and 4 and task_before_photo_max between task_before_photo_min and 4 and task_after_photo_min between 1 and 4 and task_after_photo_max between task_after_photo_min and 4); end if; end $$;
alter table orbit.app_usage_rules enable row level security;
create policy parent_all on orbit.app_usage_rules for all to authenticated using (family_id = orbit.parent_family()) with check (family_id = orbit.parent_family());
create policy device_read on orbit.app_usage_rules for select to authenticated using (family_id = orbit.device_family());
grant select, insert, update, delete on orbit.app_usage_rules to authenticated;
alter publication supabase_realtime add table orbit.app_usage_rules;

create or replace function orbit.device_tasks(p_day date) returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare child uuid := orbit.device_child();
begin
  if child is null then raise exception 'not_allowed'; end if; perform orbit.expire_runs(p_day); perform orbit.ensure_runs(child, p_day);
  return coalesce((select jsonb_agg(jsonb_build_object(
    'run_id',r.id,'task_id',t.id,'day',r.day,'status',r.status,'reject_note',r.reject_note,'title',t.title,'description',t.description,'proof',t.proof,'before_after',t.before_after,
    'before_photo_min',t.before_photo_min,'before_photo_max',t.before_photo_max,'after_photo_min',t.after_photo_min,'after_photo_max',t.after_photo_max,
    'reward_minutes',t.reward_minutes,'reward_text',t.reward_text,'reward_validity',t.reward_validity,'reward_date',t.reward_date,'mandatory',t.mandatory,'due_time',t.due_time,'due_date',coalesce(t.due_date,t.end_date),'assign_mode',t.assign_mode,'attempts',r.attempts,'created_at',r.created_at,
    'record_minutes',t.record_minutes,'record_camera',t.record_camera,'record_pause',t.record_pause,'record_pause_max',t.record_pause_max,
    'recording',(select jsonb_build_object('id',x.id,'status',x.status,'recorded_seconds',x.recorded_seconds,'paused_seconds',x.paused_seconds,'pause_count',x.pause_count,'camera',x.camera) from orbit.task_recordings x where x.run_id=r.id and x.attempt=r.attempts and x.status <> 'cancelled' order by x.started_at desc limit 1),
    'proofs',(select coalesce(jsonb_agg(jsonb_build_object('stage',p.stage,'media',p.media)),'[]'::jsonb) from orbit.task_proofs p where p.run_id=r.id and p.removed_at is null and p.stage <> 'record' and (p.stage='before' or p.attempt=r.attempts))
  ) order by t.mandatory desc,t.due_time nulls last,t.created_at) from orbit.task_runs r join orbit.tasks t on t.id=r.task_id where r.child_id=child and (r.day=p_day or (t.recurrence='once' and r.status in ('open','started','submitted','rejected')) or (r.day>=p_day-1 and r.status in ('approved','rejected','submitted')))),'[]'::jsonb);
end; $$;

create or replace function orbit.guard_task_proof_count() returns trigger language plpgsql security definer set search_path = '' as $$
declare r orbit.task_runs; t orbit.tasks; n int; max_n int;
begin
  select r0 into r from orbit.task_runs r0 where r0.id=new.run_id;
  select t0 into t from orbit.tasks t0 where t0.id=r.task_id;
  if new.stage='before' then select count(*) into n from orbit.task_proofs where run_id=new.run_id and attempt=r.attempts and stage='before' and removed_at is null; max_n:=t.before_photo_max;
  elsif new.stage in ('after','single') then select count(*) into n from orbit.task_proofs where run_id=new.run_id and attempt=r.attempts and stage in ('after','single') and removed_at is null; max_n:=t.after_photo_max; else return new; end if;
  if n>=max_n then raise exception 'proof_limit'; end if; return new;
end; $$;
drop trigger if exists task_proof_count_guard on orbit.task_proofs;
create trigger task_proof_count_guard before insert on orbit.task_proofs for each row execute function orbit.guard_task_proof_count();
