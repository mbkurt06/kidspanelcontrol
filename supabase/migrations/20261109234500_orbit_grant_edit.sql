alter table orbit.device_status add column if not exists grant_used jsonb not null default '{}'::jsonb;

-- Ebeveyn verilen bir sürenin dakikasını değiştirir (cüzdan, kasa, planlanan). Gece devreden ikinci parça da birlikte değişir.
create or replace function orbit.parent_set_grant_minutes(p_grant uuid, p_minutes int) returns int
language plpgsql security definer set search_path = '' as $$
declare fam uuid := orbit.parent_family(); g orbit.time_grants; used int; parent orbit.time_grants; m int;
begin
  if fam is null then raise exception 'not_allowed'; end if;
  select g2.* into g from orbit.time_grants g2 join orbit.children c on c.id = g2.child_id where g2.id = p_grant and c.family_id = fam for update;
  if g.id is null then raise exception 'not_allowed'; end if;
  if g.settled_at is not null then raise exception 'grant_closed'; end if;
  if p_minutes is null or p_minutes < 1 or p_minutes > 1440 then raise exception 'bad_minutes'; end if;
  select coalesce((s.grant_used ->> g.id::text)::int, 0) into used from orbit.device_status s where s.child_id = g.child_id;
  m := greatest(p_minutes, coalesce(used, 0));
  update orbit.time_grants set minutes = m where id = g.id;
  if g.carry_to is not null then
    update orbit.time_grants t set minutes = case when g.use_mode = 'clock' then least(m, t.minutes) else m end
     where t.id = g.carry_to and t.settled_at is null;
  end if;
  select p2.* into parent from orbit.time_grants p2 where p2.carry_to = g.id and p2.settled_at is null;
  if parent.id is not null then update orbit.time_grants set minutes = m where id = parent.id; end if;
  return m;
end $$;
grant execute on function orbit.parent_set_grant_minutes(uuid, int) to authenticated;
