-- Keep playlist rows scoped to the child's catalog without replacing the existing tables.
create index if not exists music_meta_child_sort_idx on orbit.music_meta(child_id, sort);
create index if not exists music_playlist_items_order_idx on orbit.music_playlist_items(playlist_id, sort);

alter table orbit.music_playlists
  add constraint music_playlists_name_check
  check (length(trim(name)) between 1 and 100) not valid;

create or replace function orbit.music_playlist_item_same_child()
returns trigger
language plpgsql
set search_path = orbit
as $$
begin
  if not exists (
    select 1
    from orbit.music_playlists p
    join orbit.music_meta m on m.child_id = p.child_id
    where p.id = new.playlist_id and m.track_key = new.track_key
  ) then
    raise exception 'playlist_track_child_mismatch';
  end if;
  return new;
end;
$$;

drop trigger if exists music_playlist_item_child_check on orbit.music_playlist_items;
create trigger music_playlist_item_child_check
before insert or update on orbit.music_playlist_items
for each row execute function orbit.music_playlist_item_same_child();
