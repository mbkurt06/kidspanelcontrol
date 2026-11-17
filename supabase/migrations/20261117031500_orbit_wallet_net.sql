-- Cüzdan takası: eksi (borç) ve artı süreler en eskiden başlayarak birbirini götürür; borç sadece cüzdanı etkiler.
create or replace function orbit.wallet_net(p_child uuid) returns void
language plpgsql security definer set search_path to '' as $$
declare n record; p record; amt int;
begin
  perform set_config('orbit.grant_bypass', '1', true);
  loop
    select id, minutes into n from orbit.time_grants
     where child_id = p_child and not vault and valid_on is null and activated_on is null and settled_at is null and window_start is null and minutes < 0
     order by created_at limit 1 for update;
    exit when not found;
    select id, minutes into p from orbit.time_grants
     where child_id = p_child and not vault and valid_on is null and activated_on is null and settled_at is null and window_start is null and minutes > 0
       and (expires_on is null or expires_on >= (now() at time zone 'Europe/Berlin')::date)
     order by created_at limit 1 for update;
    exit when not found;
    amt := least(-n.minutes, p.minutes);
    update orbit.time_grants set minutes = minutes - amt,
      settled_at = case when minutes - amt = 0 then now() else settled_at end,
      note = case when minutes - amt = 0 then coalesce(note, 'Süre') || ' · borca sayıldı' else note end
     where id = p.id;
    update orbit.time_grants set minutes = minutes + amt,
      settled_at = case when minutes + amt = 0 then now() else settled_at end,
      note = case when minutes + amt = 0 then coalesce(note, 'Borç') || ' · ödendi' else note end
     where id = n.id;
  end loop;
  perform set_config('orbit.grant_bypass', '', true);
end $$;

create or replace function orbit.wallet_net_trg() returns trigger
language plpgsql security definer set search_path to '' as $$
begin
  if pg_trigger_depth() > 1 then return null; end if;
  if not new.vault and new.valid_on is null and new.activated_on is null and new.settled_at is null and new.window_start is null and new.minutes <> 0 then
    perform orbit.wallet_net(new.child_id);
  end if;
  return null;
end $$;

drop trigger if exists wallet_net on orbit.time_grants;
create trigger wallet_net after insert or update of minutes, valid_on, vault, activated_on, settled_at on orbit.time_grants
for each row execute function orbit.wallet_net_trg();

-- Ebeveyn kararı: Ayşe ve Zeynep'in mevcut cüzdan borçları sıfırlandı
do $$ begin
  perform set_config('orbit.grant_bypass', '1', true);
  update orbit.time_grants g set note = coalesce(g.note, 'Borç') || ' · sıfırlandı (' || g.minutes || ' dk)', minutes = 0, settled_at = now()
   where not g.vault and g.valid_on is null and g.activated_on is null and g.settled_at is null and g.window_start is null and g.minutes < 0;
  perform set_config('orbit.grant_bypass', '', true);
end $$;
