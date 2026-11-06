-- Wi-Fi: çocuk telefonunda ağ ekleme/bağlanma ayarları ve bildirim.
-- Ağlar (ad, şifre) şifre kasasında uçtan uca şifreli durur (kind = "wifi").
alter table orbit.children add column if not exists wifi_settings jsonb not null
  default '{"child_add": true, "notify": true, "show_passwords": true}'::jsonb;

-- "wifi_alert" bildirimi (yeni ağ eklendi / onay sayfalı ağa bağlandı); "wifi" sadece olay kaydı
do $do$
declare src text := pg_get_functiondef('orbit.on_event_push()'::regprocedure);
begin
  if position('wifi_alert' in src) = 0 then
    src := replace(src, '''pin_unlock'', ''pin_fail'')', '''pin_unlock'', ''pin_fail'', ''wifi_alert'')');
    execute src;
  end if;
end $do$;
