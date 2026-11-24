-- Kullanım profilinin kendi süresi: ne zaman kullanılabilir ve uygulamalara paylaştırma; çocuğun temel Orbit ekranları
alter table orbit.modes add column if not exists budget_use text not null default 'any' check (budget_use in ('any','within','range','clock'));
alter table orbit.modes add column if not exists budget_within_minutes int;
alter table orbit.modes add column if not exists budget_range_start time;
alter table orbit.modes add column if not exists budget_range_end time;
alter table orbit.modes add column if not exists app_caps jsonb not null default '{}';
alter table orbit.children add column if not exists orbit_screens text[];
alter table orbit.device_status add column if not exists mode_left_minutes int;
