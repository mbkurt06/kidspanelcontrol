-- Orbit günü "gün bitişi"nde (varsayılan 05:00, Ayarlar'dan değişir) kapanır.
-- Verilen / kazanılan süre o güne aittir: bugün 23:59'a kadar + ertesi gün 00:00–gün bitişi (carry_to); sadece telefon açıkken kullanılır, kalan gün bitişinde kasaya.
alter table orbit.families add column if not exists day_end time not null default '05:00';
create or replace function orbit.day_end_min(p_child uuid) returns int
language sql stable security definer set search_path to '' as $$
  select coalesce((select orbit.tmins(f.day_end) from orbit.families f join orbit.children c on c.family_id = f.id where c.id = p_child), 300)
$$;
-- give_time: bkz. veritabanı (uygulandı) — t < gün bitişi ise [t, gün bitişi]; değilse [t, 23:59] + ertesi gün [00:00, gün bitişi]
