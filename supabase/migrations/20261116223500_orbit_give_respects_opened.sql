-- Süre verirken ebeveynin açtığı / uzattığı zaman (Geçici açma aralıkları) da açık sayılır:
-- açıksa süre ŞİMDİ kullanılır ve o açıklığın bitişine kadar geçerlidir. (give_time de buna göre güncellendi; bkz. veritabanı)
create or replace function orbit.opened_until(p_child uuid) returns int
language sql stable security definer set search_path to '' as $$
  select max(case when g.window_end >= '23:59' then 1439 else orbit.tmins(g.window_end) end)
    from orbit.time_grants g
   where g.child_id = p_child and g.source = 'manual' and g.note like 'Geçici açma%'
     and g.valid_on = (now() at time zone 'Europe/Berlin')::date and g.settled_at is null and g.minutes > 0
     and g.window_end > ((now() at time zone 'Europe/Berlin')::time)
     and (g.note like 'Geçici açma · Açık saatler%'
          or orbit.tmins(g.window_start) <= orbit.tmins((now() at time zone 'Europe/Berlin')::time) + 1)
$$;
-- Görev ödülü: "nasıl kullanılsın" kalktı, hep kullandıkça düşer
update orbit.tasks set use_mode = 'usage' where use_mode is distinct from 'usage';
