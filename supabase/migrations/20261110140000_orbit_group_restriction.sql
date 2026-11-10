-- Görev grubu kısıtlaması: grup için bir kullanım profili seçilir, şu olana kadar telefonda geçerli olur:
--   mandatory = zorunlu görevler onaylanana kadar, condition = grubun koşulu (en az N / zorunlular) sağlanana kadar,
--   all = gruptaki bütün görevler onaylanana kadar.
alter table orbit.task_groups add column if not exists restriction text not null default 'none'
  check (restriction in ('none', 'limit', 'kiosk', 'mode'));
alter table orbit.task_groups add column if not exists restriction_mode_id uuid references orbit.modes(id) on delete set null;
alter table orbit.task_groups add column if not exists restriction_until text not null default 'mandatory'
  check (restriction_until in ('mandatory', 'condition', 'all'));
alter table orbit.task_groups add column if not exists restricted_allowed jsonb not null default '[]'::jsonb;

-- Grubun koşulu sağlandı mı (zorunlular bitti ve en az N görev onaylandı)
create or replace function orbit.group_met(p_group uuid, p_child uuid, p_day date) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((s ->> 'mandatory_left')::int, 0) = 0 and coalesce((s ->> 'approved')::int, 0) >= coalesce((s ->> 'need')::int, 0)
    from (select orbit.group_state(p_group, p_child, p_day) s) x
$$;

-- Telefona giden görev listesinde grup kısıtlaması görevlere uygulanır
do $$
declare src text := pg_get_functiondef('orbit.device_tasks'::regproc);
  old_r text := $q$'restriction', case when g.id is null or t.mandatory then t.phone_restriction else 'none' end,
       'restriction_mode_id', t.restriction_mode_id, 'restricted_allowed', t.restricted_allowed,$q$;
  new_r text := $q$'restriction', case when gr.applies then g.restriction when g.id is null or t.mandatory then t.phone_restriction else 'none' end,
       'restriction_mode_id', case when gr.applies then g.restriction_mode_id else t.restriction_mode_id end,
       'restricted_allowed', case when gr.applies and coalesce(jsonb_array_length(t.restricted_allowed), 0) = 0 then g.restricted_allowed else t.restricted_allowed end,$q$;
  old_j text := $q$  left join orbit.task_groups g on g.id = t.group_id
  join orbit.families f on f.id = t.family_id$q$;
  new_j text := $q$  left join orbit.task_groups g on g.id = t.group_id
  left join lateral (select g.id is not null and g.restriction <> 'none' and (
      (g.restriction_until = 'mandatory' and t.mandatory)
      or g.restriction_until = 'all'
      or (g.restriction_until = 'condition' and not orbit.group_met(g.id, r.child_id, r.day))) as applies) gr on true
  join orbit.families f on f.id = t.family_id$q$;
begin
  if position(old_r in src) = 0 or position(old_j in src) = 0 then raise exception 'device_tasks beklenen metni içermiyor'; end if;
  src := replace(replace(src, old_r, new_r), old_j, new_j);
  execute src;
end $$;
