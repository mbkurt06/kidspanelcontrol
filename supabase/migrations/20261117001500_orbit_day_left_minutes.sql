alter table orbit.device_status add column if not exists day_left_minutes integer;
notify pgrst, 'reload schema';
