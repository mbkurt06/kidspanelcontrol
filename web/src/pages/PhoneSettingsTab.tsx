import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { useFamily } from "../lib/family";
import { errorText, supabase } from "../lib/supabase";
import { sendCommand } from "../lib/actions";
import { Info } from "../components/Info";
import type { ChildApp } from "../lib/types";

/**
 * Telefon ayarları: Orbit'in telefon yöneticisi olarak değiştirebildiği ayarlar.
 * - Değerler (Wi-Fi açık, ses, parlaklık…) panelde değişince telefonda bir kez uygulanır; çocuk sonra değiştirebilir (kilit yoksa).
 * - Kilitler (… ayarlarını kilitle, engeller) sürekli geçerlidir; ebeveyn modunda geçici kalkar.
 */
type Desired = Record<string, unknown> & { _rev?: Record<string, string>; hidden?: string[]; uninstall_blocked?: string[]; no_reinstall?: string[]; perms?: Record<string, Record<string, string>> };
type Reported = Record<string, unknown> & { restrictions?: Record<string, boolean>; errors?: Record<string, string> };
type Row = { device_settings_child?: string; desired: Desired; reported: Reported | null; reported_at: string | null };
type ActionEvent = { id: string; created_at: string; payload: { action?: string; package?: string | null; ok?: boolean; error?: string | null; why?: string | null } };

/** Kilit varsayılanları (telefondaki ile aynı) */
const RDEF: Record<string, boolean> = {
  lock_wifi: true, no_unknown: true, no_apps_control: true, lock_time: true, no_safe_boot: true, no_debug: true, no_add_user: true, no_factory_reset: true,
};

const PERM_GROUPS: [string, string][] = [
  ["camera", "Kamera"], ["mic", "Mikrofon"], ["location", "Konum"], ["contacts", "Rehber"], ["photos", "Fotoğraflar"], ["phone", "Telefon"], ["sms", "SMS"],
];

const DNS_PRESETS: [string, string][] = [
  ["", "Kapalı (otomatik)"],
  ["family.adguard-dns.com", "AdGuard Aile (yetişkin siteleri ve reklamları engeller)"],
  ["family-filter-dns.cleanbrowsing.org", "CleanBrowsing Aile"],
];

const ACTION_TEXT: Record<string, string> = {
  uninstall: "Kaldır", clear_data: "Veri temizle", reboot: "Yeniden başlat", lock_now: "Şimdi kilitle", ask_dnd: "Rahatsız etme izni", ask_power: "Pil izni", reapply: "Yeniden uygula",
};

export default function PhoneSettingsTab({ childId }: { childId: string }) {
  const fam = useFamily();
  const child = fam.children.find((c) => c.id === childId)!;
  const [row, setRow] = useState<Row | null>(null);
  const [apps, setApps] = useState<ChildApp[]>([]);
  const [events, setEvents] = useState<ActionEvent[]>([]);
  const [err, setErr] = useState("");
  const [msg, setMsg] = useState("");

  const load = useCallback(async () => {
    const [s, a, e] = await Promise.all([
      supabase.from("device_settings").select("desired,reported,reported_at").eq("child_id", childId).maybeSingle(),
      supabase.from("child_apps").select("*").eq("child_id", childId).order("label"),
      supabase.from("events").select("id,created_at,payload").eq("child_id", childId).eq("type", "phone_action").order("created_at", { ascending: false }).limit(6),
    ]);
    if (s.error) setErr(errorText(s.error));
    setRow((s.data as Row | null) ?? { desired: {}, reported: null, reported_at: null });
    setApps((a.data ?? []) as ChildApp[]);
    setEvents((e.data ?? []) as ActionEvent[]);
  }, [childId]);
  useEffect(() => {
    load();
    const t = setInterval(load, 8000);
    return () => clearInterval(t);
  }, [load]);

  const d: Desired = row?.desired ?? {};
  const r: Reported = row?.reported ?? {};
  const rs = r.restrictions ?? {};
  const errors = r.errors ?? {};

  async function save(patch: Partial<Desired>, revKeys: string[] = []) {
    setErr("");
    const rev = { ...(d._rev ?? {}) };
    for (const k of revKeys) rev[k] = String(Date.now());
    const next: Desired = { ...d, ...patch, _rev: rev };
    setRow((x) => ({ ...(x ?? { reported: null, reported_at: null }), desired: next }));
    const { error } = await supabase
      .from("device_settings")
      .upsert({ child_id: childId, family_id: fam.familyId, desired: next, updated_at: new Date().toISOString() }, { onConflict: "child_id" });
    if (error) setErr(errorText(error));
    else setMsg("Telefona gönderildi");
  }
  /** Değer: telefonda bir kez uygulanır (aynı değer tekrar seçilse de yeniden uygulanır) */
  const setValue = (k: string, v: unknown) => save({ [k]: v }, [k]);
  /** Kilit: sürekli geçerli */
  const lockOn = (k: string) => (k in d ? !!d[k] : rs[k] ?? (typeof r[k] === "boolean" ? (r[k] as boolean) : undefined) ?? RDEF[k] ?? false);
  const setLock = (k: string, v: boolean) => save({ [k]: v });

  async function act(action: string, pkg?: string, confirmText?: string) {
    if (confirmText && !confirm(confirmText)) return;
    setErr("");
    try {
      await sendCommand(childId, "resync", { phone: { action, ...(pkg ? { package: pkg } : {}) } });
      setMsg(`${ACTION_TEXT[action] ?? action}: telefona gönderildi`);
      setTimeout(load, 4000);
    } catch (e) {
      setErr(errorText(e));
    }
  }

  const st = fam.statuses[childId];
  const staleMin = st ? Math.floor((Date.now() - new Date(st.updated_at).getTime()) / 60000) : null;
  const repMin = row?.reported_at ? Math.floor((Date.now() - new Date(row.reported_at).getTime()) / 60000) : null;

  if (!row) return <p className="muted">Yükleniyor…</p>;

  const p: P = { d, r, rs, errors, setValue, setLock, lockOn };

  return (
    <div className="stack">
      <div className="card soft">
        <div className="row gap-s wrap" style={{ alignItems: "center" }}>
          <span className="grow small">
            {child.name} · {String(r.model ?? "telefon")} {r.android ? `· Android ${String(r.android)}` : ""}
            <br />
            <span className="muted tiny">
              {repMin == null ? "Telefon henüz ayarlarını bildirmedi (güncelleme gelince görünür)" : `Telefonun bildirdiği durum: ${repMin < 1 ? "az önce" : `${repMin} dk önce`}`}
              {staleMin != null && staleMin > 15 ? " · telefon bağlı değil, değişiklikler bağlanınca uygulanır" : ""}
            </span>
          </span>
          {r.battery != null && <span className="pill">🔋 %{String(r.battery)}{r.charging ? " ⚡" : ""}</span>}
        </div>
        {r.owner === false && <p className="error small">Orbit bu telefonda yönetici değil; ayarların çoğu uygulanamaz.</p>}
        <p className="muted tiny">Ayar değerleri (ses, parlaklık, Wi-Fi açık…) bir kez uygulanır, çocuk sonra değiştirebilir. Değiştiremesin istersen ilgili “kilitle” kutusunu işaretle. Ebeveyn modunda kilitler geçici kalkar.</p>
      </div>
      {err && <p className="error">{err}</p>}
      {msg && <p className="small muted">{msg}</p>}

      <Section icon="📶" title="Ağ ve internet" open>
        <ToggleRow p={p} k="wifi_on" label="Wi-Fi" />
        <LockRow p={p} k="lock_wifi" label="Wi-Fi ayarlarını kilitle" hint="Çocuk telefonun Wi-Fi ayarlarında ağ ekleyemez/değiştiremez. Orbit'in kendi Wi-Fi ekranı çalışır." />
        <LockRow p={p} k="lock_mobile" label="Mobil ağ ayarlarını kilitle" />
        <LockRow p={p} k="no_roaming" label="Veri dolaşımını engelle" />
        <LockRow p={p} k="no_tether" label="Hotspot / internet paylaşımını engelle" />
        <LockRow p={p} k="lock_airplane" label="Uçak modunu kilitle" hint="Uçak modu açılıp kapatılamaz." />
        <LockRow p={p} k="lock_vpn" label="VPN ayarlarını kilitle" hint="VPN ile filtre atlatılmasın." />
        <div className="field">
          <span>Özel DNS (internet filtresi) <Info>Telefonun bütün internet trafiği bu filtreden geçer. Aile filtreleri yetişkin ve zararlı siteleri engeller.</Info></span>
          <select value={(r.private_dns as string | undefined) ?? (d.private_dns as string | undefined) ?? ""} onChange={(e) => setValue("private_dns", e.target.value)}>
            {DNS_PRESETS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            {typeof r.private_dns === "string" && r.private_dns && !DNS_PRESETS.some(([v]) => v === r.private_dns) && <option value={r.private_dns as string}>{r.private_dns as string}</option>}
          </select>
          <ErrText p={p} k="private_dns" />
        </div>
        <p className="muted tiny">Ekran kapalıyken Wi-Fi: telefonda Orbit'in pil izni {r.power_exempt === true ? "var ✓" : r.power_exempt === false ? "yok — aşağıda Sistem'den iste" : "bilinmiyor"}.</p>
      </Section>

      <Section icon="🔵" title="Bağlı cihazlar">
        <ToggleRow p={p} k="bt_on" label="Bluetooth" />
        <LockRow p={p} k="lock_bt" label="Bluetooth ayarlarını kilitle" />
        <LockRow p={p} k="no_bt_share" label="Bluetooth ile dosya paylaşımını engelle" />
        <LockRow p={p} k="no_usb_file" label="USB ile dosya aktarımını engelle" />
      </Section>

      <Section icon="📱" title="Uygulamalar">
        <LockRow p={p} k="no_install" label="Uygulama yüklemeyi engelle (Play Store dahil)" hint="Orbit kendi güncellemesini yine kurar." />
        <LockRow p={p} k="no_uninstall" label="Uygulama kaldırmayı engelle" hint="Çocuk hiçbir uygulamayı silemez. Panelden kaldırma çalışır." />
        <LockRow p={p} k="no_unknown" label="Bilinmeyen kaynaklardan yüklemeyi engelle" />
        <LockRow p={p} k="no_apps_control" label="Uygulama ayarlarını kilitle" hint="Çocuk uygulamaları durduramaz, verilerini silemez, varsayılanlarını değiştiremez." />
        {events.length > 0 && (
          <div className="stack-xs">
            {events.map((e) => (
              <span key={e.id} className={`tiny ${e.payload.ok ? "muted" : "warn-text"}`}>
                {new Date(e.created_at).toLocaleTimeString("tr-TR", { hour: "2-digit", minute: "2-digit" })} · {ACTION_TEXT[e.payload.action ?? ""] ?? e.payload.action}
                {e.payload.package ? ` · ${apps.find((a) => a.package === e.payload.package)?.label ?? e.payload.package}` : ""} · {e.payload.ok ? "tamam" : e.payload.error ?? "olmadı"}
              </span>
            ))}
          </div>
        )}
        <AppList apps={apps} d={d} r={r} save={save} act={act} />
      </Section>

      <Section icon="🔊" title="Ses">
        <SliderRow p={p} k="vol_media" label="Medya" />
        <SliderRow p={p} k="vol_ring" label="Zil" />
        <SliderRow p={p} k="vol_alarm" label="Alarm" />
        <SliderRow p={p} k="vol_notif" label="Bildirim" />
        <span className="small">Zil modu</span>
        <SegRow p={p} k="ringer" opts={[["normal", "Normal"], ["vibrate", "Titreşim"], ["silent", "Sessiz"]]} />
        <span className="small">Rahatsız etme</span>
        <SegRow p={p} k="dnd" opts={[["off", "Kapalı"], ["priority", "Sadece öncelikli"], ["alarms", "Sadece alarmlar"], ["total", "Tam sessizlik"]]} />
        {r.dnd_access === false && (
          <div className="row gap-s wrap" style={{ alignItems: "center" }}>
            <span className="tiny warn-text grow">Telefonda “Rahatsız etme erişimi” izni yok; Orbit bunu değiştiremez.</span>
            <button type="button" className="chip-btn" onClick={() => act("ask_dnd")}>Telefonda izin ekranını aç</button>
          </div>
        )}
        <LockRow p={p} k="lock_volume" label="Ses seviyesini kilitle" hint="Ses tuşları ve ses ayarları çalışmaz. Orbit'in alarmları yine çalar." />
        <LockRow p={p} k="mic_off" label="Mikrofonu kapat" hint="Hiçbir uygulama mikrofonu kullanamaz (Orbit görev kayıtları da sessiz olur)." />
      </Section>

      <Section icon="☀️" title="Ekran">
        <SliderRow p={p} k="brightness" label="Parlaklık" />
        <ToggleRow p={p} k="brightness_auto" label="Otomatik parlaklık" />
        <span className="small">Ekran zaman aşımı</span>
        <SegRow p={p} k="timeout_sec" opts={[["15", "15 sn"], ["30", "30 sn"], ["60", "1 dk"], ["120", "2 dk"], ["300", "5 dk"], ["600", "10 dk"]]} />
        <ToggleRow p={p} k="stay_on" label="Şarjdayken ekran açık kalsın" />
        <LockRow p={p} k="lock_brightness" label="Parlaklığı kilitle" />
        <LockRow p={p} k="lock_timeout" label="Zaman aşımını kilitle" />
        <LockRow p={p} k="no_screenshot" label="Ekran görüntüsü ve kaydı engelle" hint="Orbit'in ekran kaydı görevleri de çalışmaz." />
        <LockRow p={p} k="no_wallpaper" label="Duvar kâğıdı değiştirmeyi engelle" />
      </Section>

      <Section icon="📍" title="Konum ve kamera">
        <ToggleRow p={p} k="location_on" label="Konum" />
        <LockRow p={p} k="lock_location" label="Konum ayarlarını kilitle" />
        <LockRow p={p} k="camera_off" label="Kamerayı kapat" hint="Hiçbir uygulama kamerayı kullanamaz (Orbit'in fotoğraflı görevleri de)." />
      </Section>

      <Section icon="👤" title="Hesaplar ve kullanıcılar">
        <LockRow p={p} k="no_accounts" label="Hesap eklemeyi / silmeyi engelle" hint="Google ve diğer hesaplar değiştirilemez." />
        <LockRow p={p} k="no_add_user" label="Yeni kullanıcı / profil eklemeyi engelle" />
      </Section>

      <Section icon="🕒" title="Tarih ve saat">
        <ToggleRow p={p} k="auto_time" label="Saati ağdan al" hint="Kapalıysa çocuk saati değiştirerek süre kazanabilir." />
        <LockRow p={p} k="lock_time" label="Tarih ve saat ayarlarını kilitle" />
      </Section>

      <Section icon="🔒" title="Güvenlik">
        <LockRow p={p} k="no_factory_reset" label="Fabrika ayarlarına dönmeyi engelle" fixed hint="Orbit'in yetkisi kaybolmasın diye hep açık." />
        <LockRow p={p} k="no_safe_boot" label="Güvenli modda açmayı engelle" />
        <LockRow p={p} k="no_debug" label="Geliştirici seçeneklerini kapat" />
        <LockRow p={p} k="kg_no_camera" label="Kilit ekranında kamerayı kapat" />
        <LockRow p={p} k="kg_no_notif" label="Kilit ekranında bildirim içeriklerini gizle" />
      </Section>

      <Section icon="⚙️" title="Sistem">
        <span className="small">Sistem güncellemeleri</span>
        <SegRow p={p} k="update_policy" opts={[["", "Telefona bırak"], ["auto", "Hemen kur"], ["night", "Gece kur (02–05)"], ["postpone", "30 gün ertele"]]} />
        <div className="row gap-s wrap">
          <button type="button" className="chip-btn" onClick={() => act("lock_now", undefined, `${child.name} telefonu şimdi kilitlensin mi?`)}>Şimdi kilitle</button>
          <button type="button" className="chip-btn" onClick={() => act("reboot", undefined, `${child.name} telefonu yeniden başlatılsın mı?`)}>Yeniden başlat</button>
          <button type="button" className="chip-btn" onClick={() => act("reapply")}>Ayarları yeniden uygula</button>
          {r.power_exempt === false && <button type="button" className="chip-btn" onClick={() => act("ask_power")}>Telefonda pil izni iste</button>}
        </div>
        <div className="muted tiny">
          {r.storage_free_mb != null && <>Depolama: {Math.round(Number(r.storage_free_mb) / 1024)} GB boş / {Math.round(Number(r.storage_total_mb) / 1024)} GB · </>}
          Pil izni: {r.power_exempt === true ? "var" : r.power_exempt === false ? "yok" : "?"} · Yönetici: {r.owner === true ? "evet" : r.owner === false ? "hayır" : "?"}
        </div>
      </Section>
    </div>
  );
}

function AppList({ apps, d, save, act }: {
  apps: ChildApp[];
  d: Desired;
  r: Reported;
  save: (patch: Partial<Desired>, revKeys?: string[]) => Promise<void>;
  act: (action: string, pkg?: string, confirmText?: string) => Promise<void>;
}) {
  const [q, setQ] = useState("");
  const [sys, setSys] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const hidden = new Set(d.hidden ?? []);
  const blocked = new Set(d.uninstall_blocked ?? []);
  const noRe = new Set(d.no_reinstall ?? []);
  const list = useMemo(
    () => apps.filter((a) => (a.installed || noRe.has(a.package)) && (sys || !a.is_system || hidden.has(a.package)) && (!q || a.label.toLowerCase().includes(q.toLowerCase()) || a.package.includes(q))),
    [apps, q, sys, d] // eslint-disable-line react-hooks/exhaustive-deps
  );
  const toggleIn = (key: "hidden" | "uninstall_blocked" | "no_reinstall", pkg: string, on: boolean) => {
    const cur = new Set(d[key] ?? []);
    if (on) cur.add(pkg); else cur.delete(pkg);
    return save({ [key]: [...cur] });
  };
  const perm = (pkg: string, g: string) => d.perms?.[pkg]?.[g] ?? "default";
  const setPerm = (pkg: string, g: string, v: string) => {
    const perms = { ...(d.perms ?? {}) };
    perms[pkg] = { ...(perms[pkg] ?? {}), [g]: v };
    return save({ perms }, ["perms"]);
  };
  return (
    <div className="stack-s">
      <div className="row gap-s" style={{ alignItems: "center" }}>
        <input className="grow" placeholder="Uygulama ara" value={q} onChange={(e) => setQ(e.target.value)} />
        <label className="check tiny"><input type="checkbox" checked={sys} onChange={(e) => setSys(e.target.checked)} /> Sistem</label>
      </div>
      {list.map((a) => (
        <div key={a.package} className="ps-app">
          <button type="button" className="ps-app-head" onClick={() => setOpen(open === a.package ? null : a.package)}>
            <span className="grow">
              {a.label}
              {!a.installed && <span className="tiny muted"> · kaldırıldı</span>}
              {hidden.has(a.package) && <span className="tiny muted"> · gizli</span>}
              {blocked.has(a.package) && <span className="tiny muted"> · kaldırılamaz</span>}
              {noRe.has(a.package) && <span className="tiny muted"> · tekrar yüklenemez</span>}
            </span>
            <span className="collapse-arrow" aria-hidden="true" />
          </button>
          {open === a.package && (
            <div className="stack-s ps-app-body">
              <span className="tiny muted">{a.package}{a.is_system ? " · sistem uygulaması" : ""}</span>
              <div className="row gap-s wrap">
                {a.installed && !a.is_system && (
                  <button type="button" className="chip-btn minus" onClick={() => act("uninstall", a.package, `${a.label} telefondan kaldırılsın mı?`)}>Kaldır</button>
                )}
                {a.installed && (
                  <button type="button" className="chip-btn" onClick={() => act("clear_data", a.package, `${a.label} uygulamasının bütün verileri silinsin mi? (oturumlar, kayıtlar)`)}>Veriyi temizle</button>
                )}
              </div>
              <label className="check"><input type="checkbox" checked={hidden.has(a.package)} onChange={(e) => toggleIn("hidden", a.package, e.target.checked)} /> Gizle <Info>Uygulama telefonda hiç görünmez ve açılamaz; işareti kaldırınca geri gelir. Sistem uygulamaları için kaldırma yerine bunu kullan.</Info></label>
              <label className="check"><input type="checkbox" checked={blocked.has(a.package)} onChange={(e) => toggleIn("uninstall_blocked", a.package, e.target.checked)} /> Kaldırılamasın</label>
              {!a.is_system && <label className="check"><input type="checkbox" checked={noRe.has(a.package)} onChange={(e) => toggleIn("no_reinstall", a.package, e.target.checked)} /> Tekrar yüklenemesin <Info>Kurulursa telefon hemen kaldırır.</Info></label>}
              {a.installed && (
                <div className="ps-perms">
                  <span className="small">İzinler <Info>Sadece uygulamanın istediği izinler uygulanır. “Varsayılan” = çocuk kendisi karar verir.</Info></span>
                  {PERM_GROUPS.map(([g, l]) => (
                    <div key={g} className="row gap-s" style={{ alignItems: "center" }}>
                      <span className="grow small">{l}</span>
                      <select className="compact-select" value={perm(a.package, g)} onChange={(e) => setPerm(a.package, g, e.target.value)}>
                        <option value="default">Varsayılan</option>
                        <option value="granted">İzin ver</option>
                        <option value="denied">Engelle</option>
                      </select>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      ))}
      {!list.length && <p className="muted small">Uygulama yok.</p>}
    </div>
  );
}

type P = {
  d: Desired;
  r: Reported;
  rs: Record<string, boolean>;
  errors: Record<string, string>;
  setValue: (k: string, v: unknown) => Promise<void>;
  setLock: (k: string, v: boolean) => Promise<void>;
  lockOn: (k: string) => boolean;
};

function ErrText({ p, k }: { p: P; k: string }) {
  return p.errors[k] ? <span className="tiny warn-text"> · {p.errors[k]}</span> : null;
}

/** Değer anahtarı (bir kez uygulanır): telefondaki güncel durumu gösterir */
function ToggleRow({ p, k, label, hint }: { p: P; k: string; label: string; hint?: string }) {
  const cur = typeof p.r[k] === "boolean" ? (p.r[k] as boolean) : undefined;
  const on = cur ?? !!p.d[k];
  return (
    <label className="check ps-row">
      <input type="checkbox" checked={on} onChange={(e) => p.setValue(k, e.target.checked)} />
      <span className="grow">
        {label} {hint && <Info>{hint}</Info>}
        {cur !== undefined && p.d[k] !== undefined && cur !== p.d[k] && <span className="tiny muted"> · telefona gidiyor…</span>}
        <ErrText p={p} k={k} />
      </span>
    </label>
  );
}

/** Kilit (sürekli geçerli) */
function LockRow({ p, k, label, hint, fixed }: { p: P; k: string; label: string; hint?: string; fixed?: boolean }) {
  const on = fixed ? true : p.lockOn(k);
  const applied = p.rs[k] ?? (typeof p.r[k] === "boolean" ? (p.r[k] as boolean) : undefined);
  return (
    <label className="check ps-row">
      <input type="checkbox" checked={on} disabled={fixed} onChange={(e) => p.setLock(k, e.target.checked)} />
      <span className="grow">
        {label} {hint && <Info>{hint}</Info>}
        {applied !== undefined && applied !== on && !fixed && <span className="tiny muted"> · telefona gidiyor…</span>}
      </span>
    </label>
  );
}

function SliderRow({ p, k, label }: { p: P; k: string; label: string }) {
  const cur = typeof p.r[k] === "number" ? (p.r[k] as number) : null;
  const [v, setV] = useState<number>(cur ?? (typeof p.d[k] === "number" ? (p.d[k] as number) : 50));
  const [drag, setDrag] = useState(false);
  useEffect(() => {
    if (cur != null && !drag) setV(cur);
  }, [cur, drag]);
  const commit = () => {
    setDrag(false);
    p.setValue(k, v);
  };
  return (
    <div className="ps-slider">
      <span className="ps-slider-label">{label}</span>
      <input
        type="range" min={0} max={100} step={5} value={v}
        onPointerDown={() => setDrag(true)}
        onChange={(e) => setV(Number(e.target.value))}
        onPointerUp={commit}
        onKeyUp={commit}
      />
      <span className="ps-slider-val">%{v}</span>
      <ErrText p={p} k={k} />
    </div>
  );
}

function SegRow({ p, k, opts }: { p: P; k: string; opts: [string, string][] }) {
  const raw = p.r[k] ?? p.d[k];
  const cur = raw == null ? "" : String(raw);
  return (
    <div className="chips">
      {opts.map(([v, l]) => (
        <button key={v} type="button" className={`chip-btn ${cur === v ? "on" : ""}`} onClick={() => p.setValue(k, v)}>
          {l}
        </button>
      ))}
      <ErrText p={p} k={k} />
    </div>
  );
}

function Section({ icon, title, children, open }: { icon: string; title: string; children: ReactNode; open?: boolean }) {
  return (
    <details className="card section-collapse-card" open={open}>
      <summary className="section-collapse-head">
        <span>{icon} {title}</span>
        <span className="collapse-arrow" aria-hidden="true" />
      </summary>
      <div className="stack-s">{children}</div>
    </details>
  );
}
