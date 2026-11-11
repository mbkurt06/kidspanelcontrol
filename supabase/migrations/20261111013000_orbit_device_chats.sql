-- Telefon: sohbet listesi (başlık, yazabilir mi, durduruldu mu, son okuma)
create or replace function orbit.device_chats() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare child uuid := orbit.device_child();
begin
  if child is null then raise exception 'not_allowed'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object(
      'id', c.id, 'kind', c.kind,
      'title', case
        when c.kind = 'direct' then (select coalesce(p.display_name, 'Ebeveyn') from orbit.parents p where p.user_id = c.parent_ids[1])
        else coalesce(nullif(c.title, ''), (select string_agg(x, ', ') from (
               select coalesce(nullif(k.profile_nickname, ''), k.name) x from orbit.children k where k.id = any (c.child_ids) and k.id <> child
               union all select coalesce(p.display_name, 'Ebeveyn') from orbit.parents p where p.user_id = any (c.parent_ids)) n)) end,
      'frozen_until', case when c.frozen_until > now() then c.frozen_until end,
      'can_write', not (c.frozen_until is not null and c.frozen_until > now()) and (cardinality(c.child_ids) <= 1 or c.kids_can_write),
      'readonly', case when c.frozen_until is not null and c.frozen_until > now() then 'frozen'
                       when cardinality(c.child_ids) > 1 and not c.kids_can_write then 'parents_only' end,
      'read_at', (select r.read_at from orbit.chat_reads r where r.chat_id = c.id and r.member = 'c:' || child)
    ) order by c.kind, c.created_at)
    from orbit.chats c where child = any (c.child_ids) and not c.archived), '[]'::jsonb);
end $$;
grant execute on function orbit.device_chats() to authenticated;
