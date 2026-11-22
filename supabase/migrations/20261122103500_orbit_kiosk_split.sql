-- Kilitliyken (kiosk) ayrı bir katman: uygulamanın normal durumu (app_group) ondan bağımsız.
-- kiosk_minutes: kilitliyken günde en fazla dk (null = sınırsız). app_grants.scope: normal | kiosk (kilitliyken geçerli süre)
alter table orbit.child_apps add column if not exists kiosk_minutes int;
alter table orbit.app_grants add column if not exists scope text not null default 'normal' check (scope in ('normal','kiosk'));
update orbit.child_apps set app_group = 'timed' where kiosk = true and app_group = 'always_open';
