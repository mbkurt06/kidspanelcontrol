-- Erişimi kaldırılmış (veya onay bekleyen) bir ebeveyn cihazını listeden tamamen siler.
create or replace function orbit.delete_parent_device(p_device_id uuid)
returns void
language plpgsql volatile security definer set search_path = ''
as $$
declare fam uuid := orbit.parent_family();
begin
  if fam is null then raise exception 'not_allowed'; end if;
  if p_device_id = orbit.current_parent_device() then raise exception 'not_allowed'; end if;
  delete from orbit.parent_devices
   where id = p_device_id and family_id = fam and status in ('revoked', 'pending');
end;
$$;
revoke all on function orbit.delete_parent_device(uuid) from public, anon;
grant execute on function orbit.delete_parent_device(uuid) to authenticated;
