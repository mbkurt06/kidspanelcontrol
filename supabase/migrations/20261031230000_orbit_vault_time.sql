-- Süre kasası, saat aralıklı ekstra süre, bölüm simgesi/mesajı, uygulama isteği.

-- Süre kasası: çocuk kendisi kullanamaz; ebeveyn sonradan bir güne / bölüme / saat aralığına aktarır.
alter table orbit.time_grants add column if not exists vault boolean not null default false;
-- Saat aralığı: o gün bu saatler arasında, süreli uygulamalar için ekstra süre (bölüm kapalı olsa bile).
alter table orbit.time_grants add column if not exists window_start time;
alter table orbit.time_grants add column if not exists window_end time;
alter table orbit.time_grants drop constraint if exists time_grants_window_check;
alter table orbit.time_grants add constraint time_grants_window_check
  check ((window_start is null) = (window_end is null) and (window_start is null or window_start <> window_end));

-- Görev ödülü "süre kasasına" gidebilir
alter table orbit.tasks drop constraint if exists tasks_reward_validity_check;
alter table orbit.tasks add constraint tasks_reward_validity_check check (reward_validity in ('today', 'tomorrow', 'date', 'wallet', 'vault'));
alter table orbit.task_templates drop constraint if exists task_templates_reward_validity_check;
alter table orbit.task_templates add constraint task_templates_reward_validity_check check (reward_validity in ('today', 'tomorrow', 'date', 'wallet', 'vault'));

-- Görevden gelen süre: bölüm ve kasa bilgisi görevden alınır
create or replace function orbit.grant_task_section()
returns trigger language plpgsql security definer set search_path = ''
as $$
declare t orbit.tasks;
begin
  if new.task_run_id is not null then
    select t2.* into t from orbit.task_runs r join orbit.tasks t2 on t2.id = r.task_id where r.id = new.task_run_id;
    if new.valid_on is null and t.reward_validity = 'vault' then
      new.vault := true;
      new.expires_on := null;
    end if;
    if new.section_id is null and new.valid_on is not null then
      new.section_id := t.reward_section_id;
    end if;
  end if;
  return new;
end;
$$;

-- Telefon: sadece activated_on değiştirebilir; kasadaki süreyi kullanamaz
create or replace function orbit.guard_phone_grants()
returns trigger language plpgsql security definer set search_path = ''
as $$
begin
  if orbit.device_child() is not null then
    if (new.minutes, new.valid_on, new.expires_on, new.child_id, new.source, new.note, new.created_by,
        new.vault, new.section_id, new.window_start, new.window_end)
       is distinct from (old.minutes, old.valid_on, old.expires_on, old.child_id, old.source, old.note, old.created_by,
        old.vault, old.section_id, old.window_start, old.window_end)
       or old.activated_on is not null or old.vault then
      raise exception 'not_allowed';
    end if;
  end if;
  return new;
end;
$$;

-- Bölüm simgesi ve çocuğa mesaj
alter table orbit.profile_sections add column if not exists icon text;
alter table orbit.profile_sections add column if not exists message text;

-- Çocuk onay bekleyen bir uygulama için istek gönderebilir → bildirim
create or replace function orbit.on_event_push()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if new.type in ('task_submitted', 'time_request', 'app_request', 'app_installed', 'parent_device_pending',
                  'device_owner_lost', 'offline_long', 'device_paired', 'push_test') then
    perform orbit.call_function('orbit-push', jsonb_build_object('event_id', new.id));
  end if;
  return new;
end;
$$;
