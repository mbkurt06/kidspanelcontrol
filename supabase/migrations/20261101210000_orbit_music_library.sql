-- Orbit music library: additive migration, existing tables and rules are preserved.
-- Catalog records metadata only; audio files remain on the child's SD card.
create table if not exists orbit.music_tracks (
  id uuid primary key default gen_random_uuid(),
  child_id uuid not null references orbit.children(id) on delete cascade,
  file_key text not null,
  file_name text not null,
  relative_path text not null,
  duration_ms bigint not null default 0,
  missing boolean not null default false,
  sort_order integer not null default 0,
  updated_at timestamptz not null default now(),
  unique (child_id, file_key)
);
create index if not exists music_tracks_child_order_idx on orbit.music_tracks (child_id, sort_order);
create table if not exists orbit.music_playlists (
  id uuid primary key default gen_random_uuid(),
  child_id uuid not null references orbit.children(id) on delete cascade,
  name text not null check (length(trim(name)) between 1 and 100),
  sort_order integer not null default 0,
  created_at timestamptz not null default now()
);
create index if not exists music_playlists_child_idx on orbit.music_playlists (child_id, sort_order);
create table if not exists orbit.music_playlist_tracks (
  playlist_id uuid not null references orbit.music_playlists(id) on delete cascade,
  track_id uuid not null references orbit.music_tracks(id) on delete cascade,
  sort_order integer not null default 0,
  primary key (playlist_id, track_id)
);
create index if not exists music_playlist_tracks_order_idx on orbit.music_playlist_tracks (playlist_id, sort_order);
-- A playlist may only contain tracks from its own child's library.
create or replace function orbit.music_playlist_track_same_child()
returns trigger language plpgsql set search_path = '' as $$
begin
  if not exists (
    select 1 from orbit.music_playlists p
    join orbit.music_tracks t on t.child_id = p.child_id
    where p.id = new.playlist_id and t.id = new.track_id
  ) then raise exception 'playlist_track_child_mismatch'; end if;
  return new;
end;
$$;
drop trigger if exists music_playlist_track_child_check on orbit.music_playlist_tracks;
create trigger music_playlist_track_child_check before insert or update
  on orbit.music_playlist_tracks for each row execute function orbit.music_playlist_track_same_child();
alter table orbit.music_tracks enable row level security;
alter table orbit.music_playlists enable row level security;
alter table orbit.music_playlist_tracks enable row level security;
create policy music_tracks_parent_read on orbit.music_tracks for select to authenticated
  using (child_id in (select id from orbit.children where family_id = orbit.parent_family()));
create policy music_tracks_phone_write on orbit.music_tracks for all to authenticated
  using (child_id = orbit.device_child()) with check (child_id = orbit.device_child());
create policy music_playlists_parent_read on orbit.music_playlists for select to authenticated
  using (child_id in (select id from orbit.children where family_id = orbit.parent_family()));
create policy music_playlists_phone_write on orbit.music_playlists for all to authenticated
  using (child_id = orbit.device_child()) with check (child_id = orbit.device_child());
create policy music_entries_parent_read on orbit.music_playlist_tracks for select to authenticated
  using (playlist_id in (select id from orbit.music_playlists where child_id in
    (select id from orbit.children where family_id = orbit.parent_family())));
create policy music_entries_phone_write on orbit.music_playlist_tracks for all to authenticated
  using (playlist_id in (select id from orbit.music_playlists where child_id = orbit.device_child()))
  with check (playlist_id in (select id from orbit.music_playlists where child_id = orbit.device_child()));
grant select, insert, update, delete on orbit.music_tracks, orbit.music_playlists, orbit.music_playlist_tracks to authenticated;
