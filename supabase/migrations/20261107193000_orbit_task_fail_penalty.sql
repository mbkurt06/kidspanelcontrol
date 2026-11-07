-- Görevde ödülden bağımsız "yapmazsa süre düşülsün"
alter table orbit.tasks add column if not exists fail_minutes int check (fail_minutes is null or fail_minutes between 1 and 1440),
  add column if not exists fail_target text not null default 'today' check (fail_target in ('today','wallet','vault'));
alter table orbit.task_templates add column if not exists fail_minutes int check (fail_minutes is null or fail_minutes between 1 and 1440),
  add column if not exists fail_target text not null default 'today' check (fail_target in ('today','wallet','vault'));

do $$
declare src text := pg_get_functiondef('orbit.expire_runs(date)'::regprocedure);
begin
  if src not like '%t.fail_minutes%' then
    src := replace(src,
      '    update orbit.task_runs set status = ''expired'' where id = r.id;',
      '    -- Yapılmazsa süre düşülsün (ödülden bağımsız)
    if coalesce(t.fail_minutes, 0) > 0 and not exists (select 1 from orbit.time_grants tg where tg.task_run_id = r.id and tg.source = ''task_penalty'') then
      insert into orbit.time_grants (child_id, minutes, valid_on, expires_on, source, note, created_by, task_run_id, vault)
      values (r.child_id, -t.fail_minutes, case when t.fail_target = ''today'' then p_today end, null, ''task_penalty'',
              ''Görev yapılmadı: '' || t.title, t.created_by, r.id, t.fail_target = ''vault'');
    end if;
    update orbit.task_runs set status = ''expired'' where id = r.id;');
    execute src;
  end if;
  src := pg_get_functiondef('orbit.device_tasks(date)'::regprocedure);
  if src not like '%fail_minutes%' then
    src := replace(src, 'jsonb_build_object(''allowed_mode'', t.allowed_mode,', 'jsonb_build_object(''allowed_mode'', t.allowed_mode, ''fail_minutes'', t.fail_minutes, ''fail_target'', t.fail_target,');
    execute src;
  end if;
end $$;
