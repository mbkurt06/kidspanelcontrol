-- Kanıt yükleme hatası: "invalid input syntax for type uuid" — satır, satır değişkenine "select r0" ile değil "select r0.*" ile alınmalı.
create or replace function orbit.guard_task_proof_count() returns trigger language plpgsql security definer set search_path = '' as $$
declare r orbit.task_runs; t orbit.tasks; n int; max_n int;
begin
  select r0.* into r from orbit.task_runs r0 where r0.id=new.run_id;
  select t0.* into t from orbit.tasks t0 where t0.id=r.task_id;
  if new.stage='before' then select count(*) into n from orbit.task_proofs where run_id=new.run_id and attempt=r.attempts and stage='before' and removed_at is null; max_n:=t.before_photo_max;
  elsif new.stage in ('after','single') then select count(*) into n from orbit.task_proofs where run_id=new.run_id and attempt=r.attempts and stage in ('after','single') and removed_at is null; max_n:=t.after_photo_max; else return new; end if;
  if n>=max_n then raise exception 'proof_limit'; end if; return new;
end; $$;
