-- Kelime kartı görevinde kanıt da istenebilir (ör. ekran kaydı): kanıt istenen görev kart hedefi dolunca
-- kendiliğinden onaylanmaz; çocuk kanıtla gönderir, ebeveyn onaylar.
do $$
declare src text := pg_get_functiondef('orbit.device_vocab_session'::regproc);
  o text := $q$    select r.id, t.vocab_cards from orbit.task_runs r join orbit.tasks t on t.id = r.task_id
     where r.child_id = dev.child_id and t.vocab_cards is not null and r.status in ('open', 'started', 'rejected')$q$;
  n text := $q$    select r.id, t.vocab_cards from orbit.task_runs r join orbit.tasks t on t.id = r.task_id
     where r.child_id = dev.child_id and t.vocab_cards is not null and r.status in ('open', 'started', 'rejected')
       and coalesce(t.proof, 'none') = 'none' and t.record_minutes is null and t.screenshot_min is null and t.screen_record_minutes is null$q$;
begin
  if position(o in src) = 0 then raise exception 'device_vocab_session beklenen metni içermiyor'; end if;
  execute replace(src, o, n);
end $$;
