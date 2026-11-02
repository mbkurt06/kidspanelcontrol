-- Usage profiles own kiosk/menu behaviour. Existing rows stay valid and remain
-- usable as ordinary profiles when kiosk_enabled is false.
alter table orbit.modes
  add column if not exists kiosk_enabled boolean not null default false,
  add column if not exists kiosk_screens text[] not null default '{}',
  add column if not exists kiosk_calls text not null default 'emergency';

alter table orbit.modes drop constraint if exists modes_kiosk_calls_check;
alter table orbit.modes add constraint modes_kiosk_calls_check
  check (kiosk_calls in ('emergency', 'all'));

-- Do not break existing schedules. New writes are validated in the editor,
-- while the Android engine resolves overlaps deterministically by priority.
