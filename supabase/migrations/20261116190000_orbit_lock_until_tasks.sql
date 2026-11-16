-- Elle kilit "görev(ler) bitene kadar": kilit komutunun payload.until_runs içindeki görevlerin hepsi onaylanınca kilit kendiliğinden kalkar.
create or replace function orbit.lock_until_tasks_release() returns trigger
language plpgsql security definer set search_path = '' as $$
declare c record; ended boolean; pending int;
begin
  if new.status <> 'approved' or old.status = 'approved' then return new; end if;
  for c in
    select * from orbit.commands
    where child_id = new.child_id and type in ('kiosk_start', 'lock') and cancelled_at is null
      and payload ? 'until_runs' and payload->'until_runs' @> to_jsonb(new.id::text)
      and (until_at is null or until_at > now())
  loop
    -- Bu kilit zaten bittiyse (sonradan kaldırıldıysa) dokunma
    select exists (
      select 1 from orbit.commands e
      where e.child_id = c.child_id and e.created_at > c.created_at and e.cancelled_at is null
        and e.type = case when c.type = 'kiosk_start' then 'kiosk_end' else 'unlock' end
    ) into ended;
    if ended then continue; end if;
    select count(*) into pending
    from jsonb_array_elements_text(c.payload->'until_runs') x(id)
    join orbit.task_runs r on r.id = x.id::uuid
    where r.status <> 'approved';
    if pending = 0 then
      insert into orbit.commands (child_id, type, payload, created_by)
      values (c.child_id, case when c.type = 'kiosk_start' then 'kiosk_end' else 'unlock' end, jsonb_build_object('reason', 'tasks_done'), c.created_by);
    end if;
  end loop;
  return new;
end $$;

drop trigger if exists lock_until_tasks on orbit.task_runs;
create trigger lock_until_tasks after update of status on orbit.task_runs
for each row execute function orbit.lock_until_tasks_release();
