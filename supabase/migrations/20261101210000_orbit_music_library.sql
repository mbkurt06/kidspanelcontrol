-- Extend the existing Orbit music tables; do not recreate or replace them.
alter table orbit.music_meta add column if not exists file_name text;
alter table orbit.music_meta add column if not exists relative_path text;
alter table orbit.music_meta add column if not exists duration_ms bigint;
alter table orbit.music_meta add column if not exists missing boolean not null default false;
alter table orbit.music_meta add column if not exists last_seen_at timestamptz;
create index if not exists music_meta_child_missing_idx on orbit.music_meta(child_id, missing);
-- Keep existing RLS, playlist IDs, and item ordering unchanged.
