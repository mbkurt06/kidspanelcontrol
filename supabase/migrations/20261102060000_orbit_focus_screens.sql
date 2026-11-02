-- Sayaç odak profillerinde Orbit menülerini de kısıtlayabil.
-- Boş liste eski davranışı korur: tüm Orbit menüleri açık kalır.
alter table orbit.focus_profiles
  add column if not exists allowed_screens text[] not null default '{}';
