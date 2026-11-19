-- Genel süre kısıtının kapsamı: day = bugün verilen bütün süreler · now = sadece kısıt konduğu andaki süre (budget dk); sonradan verilen süre serbest
alter table orbit.day_app_limits add column if not exists scope text not null default 'day' check (scope in ('day','now'));
alter table orbit.day_app_limits add column if not exists budget int;
