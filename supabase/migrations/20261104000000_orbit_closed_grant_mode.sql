-- Kapalı / sınırlı saatte verilen süre nasıl davranır (çocuk başına):
-- clock  = saat gibi akar (verilen süre kadar zaman açık)
-- usage  = kullandıkça düşer; açık saatler başlayınca ya da gece yarısı biter
-- within = kullandıkça düşer ama belirli süre içinde kullanılmalı (dakika ya da verilen sürenin katı)
alter table orbit.children add column if not exists closed_grant_mode text not null default 'usage'
  check (closed_grant_mode in ('clock', 'usage', 'within'));
alter table orbit.children add column if not exists closed_grant_within_minutes int check (closed_grant_within_minutes is null or closed_grant_within_minutes > 0);
alter table orbit.children add column if not exists closed_grant_within_factor int check (closed_grant_within_factor is null or closed_grant_within_factor between 2 and 10);
