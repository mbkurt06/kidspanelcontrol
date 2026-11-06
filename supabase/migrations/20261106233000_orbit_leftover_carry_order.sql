-- Devreden parça, ilk parça kapanmadan kasaya aktarılmasın (kullanılmış süre iki kez sayılıyordu).
create or replace function orbit.device_grant_leftover(p_grant uuid, p_minutes integer)
returns void language plpgsql security definer set search_path = '' as $$
declare dev orbit.devices := orbit.current_device(); g orbit.time_grants;
begin
  if dev.id is null or dev.kind <> 'child_phone' then raise exception 'not_allowed'; end if;
  select * into g from orbit.time_grants where id = p_grant and child_id = dev.child_id for update;
  if g.id is null or g.settled_at is not null or not g.to_vault then return; end if;
  if exists (select 1 from orbit.time_grants p where p.carry_to = g.id and p.settled_at is null) then
    raise exception 'carry_pending';
  end if;
  perform set_config('orbit.grant_bypass', '1', true);
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
  perform set_config('orbit.grant_bypass', '', true);
end; $$;
