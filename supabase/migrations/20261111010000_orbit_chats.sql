-- Mesajlaşma: sohbetler (birebir çocuk↔anne / çocuk↔baba, gruplar), durdurma, alıntılı yanıt, silme.
create table if not exists orbit.chats (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references orbit.families(id) on delete cascade,
  kind text not null check (kind in ('direct', 'group')),
  title text,
  child_ids uuid[] not null default '{}',
  parent_ids uuid[] not null default '{}',
  -- Grupta birden çok çocuk varsa: çocuklar yazabilsin mi (varsayılan kapalı; tek çocuklu grupta çocuk hep yazar)
  kids_can_write boolean not null default false,
  frozen_until timestamptz,
  frozen_by uuid,
  created_by uuid,
  created_at timestamptz not null default now(),
  archived boolean not null default false
);
create index if not exists chats_family on orbit.chats (family_id);
alter table orbit.chats enable row level security;
drop policy if exists parent_all on orbit.chats;
create policy parent_all on orbit.chats for all to authenticated
  using (family_id = orbit.parent_family()) with check (family_id = orbit.parent_family());
drop policy if exists phone_read on orbit.chats;
create policy phone_read on orbit.chats for select to authenticated
  using (orbit.device_child() = any (child_ids) and not archived);
grant select, insert, update, delete on orbit.chats to authenticated;

-- Okundu bilgisi: üye başına son okuma (c:<çocuk> / p:<ebeveyn>)
create table if not exists orbit.chat_reads (
  chat_id uuid not null references orbit.chats(id) on delete cascade,
  member text not null,
  read_at timestamptz not null default now(),
  primary key (chat_id, member)
);
alter table orbit.chat_reads enable row level security;
drop policy if exists family_read on orbit.chat_reads;
create policy family_read on orbit.chat_reads for select to authenticated
  using (exists (select 1 from orbit.chats c where c.id = chat_id and (c.family_id = orbit.parent_family() or orbit.device_child() = any (c.child_ids))));
grant select on orbit.chat_reads to authenticated;

alter table orbit.messages add column if not exists chat_id uuid references orbit.chats(id) on delete cascade;
alter table orbit.messages add column if not exists reply_to uuid references orbit.messages(id) on delete set null;
alter table orbit.messages add column if not exists deleted_at timestamptz;
alter table orbit.messages add column if not exists deleted_by text;
alter table orbit.messages alter column child_id drop not null;
create index if not exists messages_chat on orbit.messages (chat_id, created_at desc);

-- Silinen mesajın içeriği: sadece ebeveyn görür
create table if not exists orbit.message_trash (
  message_id uuid primary key references orbit.messages(id) on delete cascade,
  family_id uuid not null,
  body text not null
);
alter table orbit.message_trash enable row level security;
drop policy if exists parent_all on orbit.message_trash;
create policy parent_all on orbit.message_trash for select to authenticated using (family_id = orbit.parent_family());
grant select on orbit.message_trash to authenticated;

-- Her çocuk için: anneyle, babayla birebir + eski ortak konuşma ("Anne & Baba")
create or replace function orbit.ensure_chats(p_family uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare c record; p record; legacy uuid;
begin
  for c in select id from orbit.children where family_id = p_family loop
    for p in select user_id from orbit.parents where family_id = p_family loop
      if not exists (select 1 from orbit.chats where kind = 'direct' and child_ids = array[c.id] and parent_ids = array[p.user_id]) then
        insert into orbit.chats (family_id, kind, child_ids, parent_ids) values (p_family, 'direct', array[c.id], array[p.user_id]);
      end if;
    end loop;
    if exists (select 1 from orbit.messages m where m.child_id = c.id and m.chat_id is null) then
      select id into legacy from orbit.chats where family_id = p_family and kind = 'group' and child_ids = array[c.id] and title = 'Anne & Baba';
      if legacy is null then
        insert into orbit.chats (family_id, kind, title, child_ids, parent_ids)
        values (p_family, 'group', 'Anne & Baba', array[c.id], (select coalesce(array_agg(user_id), '{}') from orbit.parents where family_id = p_family))
        returning id into legacy;
      end if;
      perform set_config('orbit.msg_bypass', '1', true);
      update orbit.messages set chat_id = legacy where child_id = c.id and chat_id is null;
    end if;
  end loop;
end $$;


-- Yeni çocuk / ebeveyn eklenince birebir sohbetler
create or replace function orbit.chats_on_member() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  perform orbit.ensure_chats(new.family_id);
  return new;
end $$;
drop trigger if exists chats_on_child on orbit.children;
create trigger chats_on_child after insert on orbit.children for each row execute function orbit.chats_on_member();
drop trigger if exists chats_on_parent on orbit.parents;
create trigger chats_on_parent after insert on orbit.parents for each row execute function orbit.chats_on_member();

-- Sohbet şu an durdurulmuş mu
create or replace function orbit.chat_frozen(c orbit.chats) returns boolean
language sql stable set search_path = '' as $$ select c.frozen_until is not null and c.frozen_until > now() $$;

-- Mesaj kuralları: üyelik, durdurma, çocukların grupta yazma izni
create or replace function orbit.guard_messages() returns trigger
language plpgsql security definer set search_path = '' as $$
declare ch orbit.chats; dev_child uuid;
begin
  if tg_op = 'INSERT' then
    new.from_parent := orbit.parent_family() is not null;
    if new.chat_id is null then
      -- Eski telefon sürümleri: çocuğun ortak konuşmasına
      select id into new.chat_id from orbit.chats where kind = 'group' and title = 'Anne & Baba' and child_ids = array[new.child_id] limit 1;
      if new.chat_id is null then
        perform orbit.ensure_chats(new.family_id);
        select id into new.chat_id from orbit.chats where kind = 'direct' and child_ids = array[new.child_id] order by created_at limit 1;
      end if;
    end if;
    select * into ch from orbit.chats where id = new.chat_id;
    if ch.id is null or ch.family_id <> new.family_id or ch.archived then raise exception 'chat_not_found'; end if;
    if new.from_parent then
      new.sender_user := auth.uid();
      select coalesce(display_name, 'Ebeveyn') into new.sender_name from orbit.parents where user_id = auth.uid();
      new.child_id := case when cardinality(ch.child_ids) = 1 then ch.child_ids[1] else null end;
    else
      dev_child := orbit.device_child();
      if dev_child is null or not (dev_child = any (ch.child_ids)) then raise exception 'not_allowed'; end if;
      if orbit.chat_frozen(ch) then raise exception 'chat_frozen'; end if;
      if cardinality(ch.child_ids) > 1 and not ch.kids_can_write then raise exception 'chat_readonly'; end if;
      new.child_id := dev_child;
      new.sender_user := null;
      select coalesce(nullif(c.profile_nickname, ''), c.name) into new.sender_name from orbit.children c where c.id = dev_child;
    end if;
    if new.reply_to is not null and not exists (select 1 from orbit.messages m where m.id = new.reply_to and m.chat_id = new.chat_id) then
      new.reply_to := null;
    end if;
    new.created_at := now();
    new.read_at := null;
    new.deleted_at := null;
    new.deleted_by := null;
    return new;
  end if;
  if current_setting('orbit.msg_bypass', true) = '1' then return new; end if;
  if (new.body, new.from_parent, new.child_id, new.family_id, new.created_at, new.sender_user, new.chat_id, new.reply_to, new.deleted_at)
     is distinct from (old.body, old.from_parent, old.child_id, old.family_id, old.created_at, old.sender_user, old.chat_id, old.reply_to, old.deleted_at) then
    raise exception 'not_allowed';
  end if;
  return new;
end $$;

select orbit.ensure_chats(id) from orbit.families;

-- Telefon: üyesi olduğu sohbetlerin mesajları
drop policy if exists phone_read on orbit.messages;
create policy phone_read on orbit.messages for select to authenticated
  using (chat_id in (select id from orbit.chats where orbit.device_child() = any (child_ids) and not archived));
drop policy if exists phone_insert on orbit.messages;
create policy phone_insert on orbit.messages for insert to authenticated
  with check (family_id = orbit.device_family() and not from_parent);

-- Mesaj sil: ebeveyn her mesajı; çocuk kendi mesajını 10 dk içinde. İçerik herkesten kalkar (ebeveyn çöpte görür).
create or replace function orbit.message_delete(p_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare m orbit.messages; fam uuid := orbit.parent_family(); dev_child uuid := orbit.device_child();
begin
  select * into m from orbit.messages where id = p_id;
  if m.id is null or m.deleted_at is not null then return; end if;
  if fam is not null then
    if m.family_id <> fam then raise exception 'not_allowed'; end if;
  elsif dev_child is not null then
    if m.from_parent or m.child_id is distinct from dev_child or m.created_at < now() - interval '10 minutes' then raise exception 'not_allowed'; end if;
  else
    raise exception 'not_allowed';
  end if;
  insert into orbit.message_trash (message_id, family_id, body) values (m.id, m.family_id, m.body) on conflict do nothing;
  perform set_config('orbit.msg_bypass', '1', true);
  update orbit.messages set body = '', deleted_at = now(),
         deleted_by = case when fam is not null then 'parent' else 'child' end
   where id = p_id;
end $$;
grant execute on function orbit.message_delete(uuid) to authenticated;

-- Okundu: üyenin son okuma zamanı (eski read_at da doldurulur)
create or replace function orbit.chat_mark_read(p_chat uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare ch orbit.chats; who text; fam uuid := orbit.parent_family(); dev_child uuid := orbit.device_child();
begin
  select * into ch from orbit.chats where id = p_chat;
  if ch.id is null then return; end if;
  if fam is not null and ch.family_id = fam then who := 'p:' || auth.uid();
  elsif dev_child is not null and dev_child = any (ch.child_ids) then who := 'c:' || dev_child;
  else raise exception 'not_allowed'; end if;
  insert into orbit.chat_reads (chat_id, member, read_at) values (p_chat, who, now())
  on conflict (chat_id, member) do update set read_at = now();
  perform set_config('orbit.msg_bypass', '1', true);
  update orbit.messages set read_at = now()
   where chat_id = p_chat and read_at is null
     and (case when fam is not null then not from_parent or sender_user is distinct from auth.uid() else from_parent or child_id is distinct from dev_child end);
end $$;
grant execute on function orbit.chat_mark_read(uuid) to authenticated;

-- Telefon güncellemesi bildirim kanalı: sohbet değişince de haber gitsin
drop trigger if exists rt_notify on orbit.chats;
create or replace function orbit.rt_notify_chat() returns trigger
language plpgsql security definer set search_path = '' as $$
declare c uuid;
begin
  foreach c in array coalesce(case when tg_op = 'DELETE' then old.child_ids else new.child_ids end, '{}') loop
    begin perform realtime.send(jsonb_build_object('table', 'chats'), 'changed', 'orbit-' || c::text, false); exception when others then null; end;
  end loop;
  return null;
end $$;
create trigger rt_notify after insert or update or delete on orbit.chats for each row execute function orbit.rt_notify_chat();

-- Grup mesajı: gruptaki bütün çocuklara haber
create or replace function orbit.rt_notify_message() returns trigger
language plpgsql security definer set search_path = '' as $$
declare c uuid; ids uuid[];
begin
  select child_ids into ids from orbit.chats where id = (case when tg_op = 'DELETE' then old.chat_id else new.chat_id end);
  foreach c in array coalesce(ids, '{}') loop
    begin perform realtime.send(jsonb_build_object('table', 'messages'), 'changed', 'orbit-' || c::text, false); exception when others then null; end;
  end loop;
  return null;
end $$;
drop trigger if exists rt_notify on orbit.messages;
create trigger rt_notify after insert or update or delete on orbit.messages for each row execute function orbit.rt_notify_message();
