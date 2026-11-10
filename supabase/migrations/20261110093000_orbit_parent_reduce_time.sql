-- Ana ekrandaki çarkla süre düşme: önce bugün verilen (kullanılmamış) ekstra süreler sunucuda azaltılır / silinir.
-- Telefonun çevrimiçi olmasına gerek kalmaz. Ekstra süreden fazlası istenirse kalan kısım döner (telefona komut olarak gider).
create or replace function orbit.parent_reduce_time(p_child uuid, p_minutes int) returns int
language plpgsql volatile security definer set search_path = '' as $$
declare
  fam uuid := orbit.parent_family();
  left_ int := p_minutes;
  today date := (now() at time zone 'Europe/Berlin')::date;
  nowhm time := (now() at time zone 'Europe/Berlin')::time;
  g record; used int; keep int; usedj jsonb;
begin
  if fam is null or not exists (select 1 from orbit.children where id = p_child and family_id = fam) then raise exception 'not_allowed'; end if;
  if p_minutes is null or p_minutes <= 0 then return 0; end if;
  select coalesce(s.grant_used, '{}'::jsonb) into usedj from orbit.device_status s where s.child_id = p_child;
  usedj := coalesce(usedj, '{}'::jsonb);
  perform set_config('orbit.grant_bypass', '1', true);
  for g in
    select t.* from orbit.time_grants t
     where t.child_id = p_child and t.settled_at is null and not t.vault and t.minutes > 0
       and (t.valid_on = today or t.activated_on = today)
       and not exists (select 1 from orbit.time_grants p where p.carry_to = t.id)
     order by t.created_at desc
  loop
    exit when left_ <= 0;
    used := coalesce((usedj ->> g.id::text)::int, 0);
    keep := greatest(g.minutes - left_, used, 0);
    if keep = g.minutes then continue; end if;
    left_ := left_ - (g.minutes - keep);
    if keep = 0 then
      if g.carry_to is not null then delete from orbit.time_grants where id = g.carry_to and settled_at is null; end if;
      delete from orbit.time_grants where id = g.id;
    else
      update orbit.time_grants set minutes = keep,
             window_end = case when g.use_mode = 'clock' and g.window_end is not null then greatest(nowhm, g.window_start)::time(0) else window_end end
       where id = g.id;
      if g.carry_to is not null then
        if g.use_mode = 'clock' then delete from orbit.time_grants where id = g.carry_to and settled_at is null;
        else update orbit.time_grants set minutes = keep where id = g.carry_to and settled_at is null; end if;
      end if;
    end if;
  end loop;
  return greatest(left_, 0);
end $$;
grant execute on function orbit.parent_reduce_time(uuid, int) to authenticated;
