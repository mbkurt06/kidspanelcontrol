-- Kiosk uygulamaları: kilitliyken Orbit ekranından açılabilir, süreden düşmez.
alter table orbit.child_apps
  add column if not exists kiosk boolean not null default false,
  add column if not exists kiosk_windows jsonb not null default '[]'::jsonb;
comment on column orbit.child_apps.kiosk_windows is 'Kiosk zaman aralıkları [{start:"HH:MM",end:"HH:MM"}]; boş = her zaman';
