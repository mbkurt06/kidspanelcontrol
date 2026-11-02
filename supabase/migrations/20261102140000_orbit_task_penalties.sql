alter table orbit.task_templates drop constraint if exists task_templates_reward_minutes_check;
alter table orbit.tasks drop constraint if exists tasks_reward_minutes_check;
alter table orbit.task_templates add constraint task_templates_reward_minutes_check check (reward_minutes is null or reward_minutes between -1440 and 1440);
alter table orbit.tasks add constraint tasks_reward_minutes_check check (reward_minutes is null or reward_minutes between -1440 and 1440);
alter table orbit.time_grants drop constraint if exists time_grants_source_check;
alter table orbit.time_grants add constraint time_grants_source_check check (source in ('manual','task','task_penalty'));
create unique index if not exists task_penalty_once on orbit.time_grants(task_run_id,source) where task_run_id is not null and source='task_penalty';
create or replace function orbit.expire_runs(p_today date) returns void language plpgsql volatile security definer set search_path = '' as $$
declare r orbit.task_runs; t orbit.tasks; mins int; validity text; v_on date; exp date;
begin
  for r in select r2 from orbit.task_runs r2 join orbit.tasks t2 on t2.id=r2.task_id where r2.status in ('open','started','rejected') and ((t2.recurrence='days' and r2.day<p_today) or (t2.recurrence='once' and coalesce(t2.due_date,t2.end_date) is not null and coalesce(t2.due_date,t2.end_date)<p_today) or (t2.due_time is not null and r2.day=p_today and t2.due_time <= (now() at time zone 'Europe/Berlin')::time)) loop
    select * into t from orbit.tasks where id=r.task_id;
    if coalesce(t.reward_minutes,0)<0 and not exists(select 1 from orbit.time_grants g where g.task_run_id=r.id and g.source='task_penalty') then
      mins:=t.reward_minutes; validity:=coalesce(t.reward_validity,'today'); v_on:=case validity when 'today' then p_today when 'tomorrow' then p_today+1 when 'date' then coalesce(t.reward_date,p_today) else null end; exp:=case when validity='wallet' and t.reward_expires_days is not null then p_today+t.reward_expires_days end;
      insert into orbit.time_grants(child_id,minutes,valid_on,expires_on,source,note,created_by,task_run_id,vault) values(r.child_id,mins,v_on,exp,'task_penalty','Görev cezası: '||t.title,t.created_by,r.id,validity='vault');
    end if; update orbit.task_runs set status='expired' where id=r.id;
  end loop;
end; $$;
create or replace function orbit.device_use_wallet(p_minutes int) returns int language plpgsql security definer set search_path = '' as $$
declare c uuid:=orbit.device_child(); tz text; d date; lim int; used int; need int; g orbit.time_grants; debt orbit.time_grants; pay int;
begin
  if c is null then raise exception 'not_device'; end if; if p_minutes is null or p_minutes<1 then raise exception 'bad_minutes'; end if;
  select f.timezone into tz from orbit.children ch join orbit.families f on f.id=ch.family_id where ch.id=c; d:=(now() at time zone coalesce(tz,'Europe/Berlin'))::date; select wallet_daily_max into lim from orbit.children where id=c; select coalesce(sum(minutes),0) into used from orbit.time_grants where child_id=c and activated_on=d and minutes>0;
  if lim is not null and used+p_minutes>lim then raise exception 'wallet_limit:%',greatest(lim-used,0); end if;
  perform set_config('orbit.grant_bypass','1',true); need:=p_minutes;
  for g in select * from orbit.time_grants where child_id=c and not vault and minutes>0 and valid_on is null and activated_on is null and (expires_on is null or expires_on>=d) order by expires_on nulls last,created_at for update loop
    exit when need<=0;
    for debt in select * from orbit.time_grants where child_id=c and not vault and minutes<0 and valid_on is null and activated_on is null order by created_at for update loop
      exit when g.minutes<=0; pay:=least(g.minutes,-debt.minutes); if pay>0 then update orbit.time_grants set minutes=minutes-pay where id=g.id; update orbit.time_grants set minutes=minutes+pay,activated_on=case when minutes+pay=0 then d else activated_on end where id=debt.id; g.minutes:=g.minutes-pay; end if;
    end loop; exit when need<=0;
    if g.minutes<=need then update orbit.time_grants set activated_on=d where id=g.id; need:=need-g.minutes; else update orbit.time_grants set minutes=g.minutes-need where id=g.id; insert into orbit.time_grants(child_id,minutes,activated_on,expires_on,source,note,created_by) values(c,need,d,g.expires_on,g.source,g.note,g.created_by); need:=0; end if;
  end loop;
  perform set_config('orbit.grant_bypass','',true); if need>0 and need=p_minutes then raise exception 'wallet_empty'; end if; return p_minutes-greatest(need,0);
end; $$;
