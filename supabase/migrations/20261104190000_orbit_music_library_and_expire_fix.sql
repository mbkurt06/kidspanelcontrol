-- 20261101210000 hiç uygulanmamıştı: müzik kataloğu eşitlenemiyor, çalma listesine şarkı eklenemiyordu
alter table orbit.music_meta add column if not exists file_name text;
alter table orbit.music_meta add column if not exists relative_path text;
alter table orbit.music_meta add column if not exists duration_ms bigint;
alter table orbit.music_meta add column if not exists missing boolean not null default false;
alter table orbit.music_meta add column if not exists last_seen_at timestamptz;
create index if not exists music_meta_child_missing_idx on orbit.music_meta(child_id, missing);

-- expire_runs: "select r2" satırı uuid alanına yazmaya çalışıyordu (device_tasks hata veriyordu)
do $do$
begin
  execute replace(pg_get_functiondef('orbit.expire_runs(date)'::regprocedure), 'select r2 from orbit.task_runs r2', 'select r2.* from orbit.task_runs r2');
end $do$;
