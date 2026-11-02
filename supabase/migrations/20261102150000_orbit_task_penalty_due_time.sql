create or replace function orbit.expire_runs(p_today date) returns void language plpgsql volatile security definer set search_path = '' as $$
declare r orbit.task_runs; t orbit.tasks; mins int; validity text; v_on date; exp date;
begin
  for r in select r2 from orbit.task_runs r2 join orbit.tasks t2 on t2.id=r2.task_id where r2.status in ('open','started','rejected') and (
    (t2.recurrence='days' and r2.day<p_today)
    or (t2.recurrence='once' and coalesce(t2.due_date,t2.end_date) is not null and coalesce(t2.due_date,t2.end_date)<p_today)
    or (t2.due_time is not null and coalesce(t2.due_date,t2.end_date,r2.day)=p_today and t2.due_time <= (now() at time zone 'Europe/Berlin')::time)
  ) loop
    select * into t from orbit.tasks where id=r.task_id;
    if coalesce(t.reward_minutes,0)<0 and not exists(select 1 from orbit.time_grants g where g.task_run_id=r.id and g.source='task_penalty') then
      mins:=t.reward_minutes; validity:=coalesce(t.reward_validity,'today'); v_on:=case validity when 'today' then p_today when 'tomorrow' then p_today+1 when 'date' then coalesce(t.reward_date,p_today) else null end; exp:=case when validity='wallet' and t.reward_expires_days is not null then p_today+t.reward_expires_days end;
      insert into orbit.time_grants(child_id,minutes,valid_on,expires_on,source,note,created_by,task_run_id,vault) values(r.child_id,mins,v_on,exp,'task_penalty','Görev cezası: '||t.title,t.created_by,r.id,validity='vault');
    end if;
    update orbit.task_runs set status='expired' where id=r.id;
  end loop;
end; $$;
