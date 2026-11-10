import { FindPhone } from "../components/FindPhone";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { DateField, TimeField } from "../components/DateTime";
import { Link, useNavigate, useParams } from "react-router-dom";
import { createPortal } from "react-dom";
import { useFamily } from "../lib/family";
import { errorText, supabase } from "../lib/supabase";
import { closedModeFor, closedModeOf, fromPatch, giveNow, grantMinutes, insertGrant, nowPatch, sendCommand, type ClosedMode, type GrantPatch } from "../lib/actions";
import { ClosedModePicker, closedModeLabel, sameClosedMode } from "../components/ClosedModePicker";
import { dateText, dateTimeText, hhmm, minutesText, relTime, todayISO } from "../lib/util";
import { GROUP_HINT, GROUP_LABEL, WEEKDAYS_LONG, type AppGroup, type Assignment, type ChildApp, type DayOverride, type Device, type Section, type TimeGrant } from "../lib/types";
import { Icon } from "../components/Icon";
import { Info } from "../components/Info";
import { MinuteStepper } from "../components/MinuteStepper";
import TimerTab from "./TimerTab";
import PhoneSettingsTab from "./PhoneSettingsTab";
import { currentSectionFor, hm, mins, suggestGroup, timedPossible } from "../lib/sections";

type Tab = "apps" | "program" | "time" | "timer" | "alarms" | "report" | "phone" | "device";

export default function ChildPage() {
  const { id } = useParams();
  const fam = useFamily();
  const child = fam.children.find((c) => c.id === id);
  const nav = useNavigate();
  const [tab, setTab] = useState<Tab>(() => {
    let stored: string | null = null;
    try { stored = localStorage.getItem("orbit.childTab") ?? localStorage.getItem(`orbit.childTab.${id}`); } catch { /* yok */ }
    return stored && ["apps", "program", "time", "timer", "alarms", "report", "phone", "device"].includes(stored) ? stored as Tab : "apps";
  });
  // Çocuk değişince aynı sekme açık kalır
  useEffect(() => { try { localStorage.setItem("orbit.childTab", tab); } catch { /* yok */ } }, [tab]);
  // Açılıp kapanan bölümler çocuklar arasında aynı kalsın (panel açıkken): sekme + bölüm başlığına göre
  const sectionsRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const root = sectionsRef.current;
    if (!root) return;
    const keyOf = (d: HTMLDetailsElement) => `${tab}:${(d.querySelector("summary")?.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 60)}`;
    let state: Record<string, boolean> = {};
    try { state = JSON.parse(sessionStorage.getItem("orbit.childSections") ?? "{}"); } catch { /* yok */ }
    const apply = () => root.querySelectorAll("details").forEach((d) => {
      const k = keyOf(d);
      if (k in state && d.open !== state[k]) d.open = state[k];
    });
    const onToggle = (e: Event) => {
      const d = e.target as HTMLDetailsElement;
      if (d.tagName !== "DETAILS") return;
      state[keyOf(d)] = d.open;
      try { sessionStorage.setItem("orbit.childSections", JSON.stringify(state)); } catch { /* yok */ }
    };
    apply();
    // Bölümler veri gelince sonradan çizilebilir
    const mo = new MutationObserver(() => apply());
    mo.observe(root, { childList: true, subtree: true });
    const stop = window.setTimeout(() => mo.disconnect(), 4000);
    root.addEventListener("toggle", onToggle, true);
    return () => { mo.disconnect(); window.clearTimeout(stop); root.removeEventListener("toggle", onToggle, true); };
  }, [id, tab]);
  // Çocuk değişince sayfa aynı yerde kalsın: son kaydırma konumu, içerik yüklenince geri verilir
  const lastScroll = useRef(0);
  useEffect(() => {
    const sc = document.getElementById("scroller");
    if (!sc) return;
    const on = () => { lastScroll.current = sc.scrollTop; };
    sc.addEventListener("scroll", on, { passive: true });
    return () => sc.removeEventListener("scroll", on);
  }, []);
  const firstId = useRef(id);
  useLayoutEffect(() => {
    if (firstId.current === id) return;
    firstId.current = id;
    const sc = document.getElementById("scroller");
    const target = lastScroll.current;
    if (!sc || target <= 0) return;
    let tries = 0;
    const t = window.setInterval(() => {
      sc.scrollTop = target;
      if (Math.abs(sc.scrollTop - target) < 2 || ++tries > 30) window.clearInterval(t);
    }, 60);
    sc.scrollTop = target;
    return () => window.clearInterval(t);
  }, [id]);
  // Geçişte yeni çocuğun verisi gelene kadar sayfa boyu korunur: sayfa bir an yukarı zıplamaz
  const [lockH, setLockH] = useState(0);
  const lockTimer = useRef<number | null>(null);
  function goChild(cid: string) {
    const h = sectionsRef.current?.offsetHeight ?? 0;
    if (h > 0) {
      setLockH(h);
      if (lockTimer.current) window.clearTimeout(lockTimer.current);
      lockTimer.current = window.setTimeout(() => setLockH(0), 2500);
    }
    nav(`/child/${cid}`, { replace: true });
  }
  // Soldaki menüden başka çocuk seçilince bu sayfa o çocuğa geçer
  const prevSel = useRef(fam.selectedChildId);
  useEffect(() => {
    const sel = fam.selectedChildId;
    if (sel !== prevSel.current) {
      prevSel.current = sel;
      if (sel !== "all" && sel !== id) goChild(sel);
    }
  }, [fam.selectedChildId, id, nav]);

  if (!child) return <div className="page"><p className="muted">Çocuk bulunamadı.</p></div>;

  return (
    <div className="page">
      <header className="page-head child-head">
        <Link to="/" className="icon-btn" aria-label="Geri">
          <Icon name="back" />
        </Link>
        <div className="child-switch" role="tablist" aria-label="Çocuk seç">
          {fam.children.map((c) => (
            <button
              key={c.id}
              role="tab"
              aria-selected={c.id === child.id}
              className={`chip ${c.id === child.id ? "on" : ""}`}
              onClick={() => c.id !== child.id && goChild(c.id)}
            >
              <span className="dot" style={{ background: c.color }} /> {c.name}
            </button>
          ))}
        </div>
        <Link to={`/child/${child.id}/vault`} className="icon-btn" aria-label="Şifreler" title="Şifreler">
          <Icon name="key" size={18} />
        </Link>
      </header>
      <ParentModeCard key={`pm-${child.id}`} childId={child.id} />
      <div className="child-tabs-wrap">
        <div className="segmented child-tabs">
        {(
          [
            ["apps", "Uygulamalar"],
            ["program", "Program"],
            ["time", "Süre"],
            ["timer", "Sayaç"],
            ["alarms", "Hatırlatıcılar"],
            ["report", "Rapor"],
            ["phone", "Telefon ayarları"],
            ["device", "Telefon"],
          ] as [Tab, string][]
        ).map(([k, l]) => (
          <button key={k} className={tab === k ? "on" : ""} onClick={() => setTab(k)}>
            {l}
          </button>
        ))}
        </div>
      </div>
      <div key={child.id} className="stack" ref={sectionsRef} style={lockH ? { minHeight: lockH } : undefined}>
      {tab === "apps" && <AppsTab childId={child.id} />}
      {tab === "program" && <ProgramTab childId={child.id} />}
      {tab === "time" && <TimeTab childId={child.id} />}
      {tab === "report" && <ReportTab childId={child.id} />}
      {tab === "timer" && <TimerTab childId={child.id} />}
      {tab === "alarms" && <TimerTab childId={child.id} only="alarms" />}
      {tab === "phone" && <PhoneSettingsTab childId={child.id} />}
      {tab === "device" && <DeviceTab childId={child.id} />}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

/** Telefondaki Orbit'i hemen güncelle: telefon komutu alınca (≤30 sn) kurulum/version.json'a bakar ve yeni sürümü sessizce kurar. */
function UpdateCard({ childId, device }: { childId: string; device?: Device }) {
  const [latest, setLatest] = useState<number | null>(null);
  const [msg, setMsg] = useState("");
  useEffect(() => {
    fetch("/kurulum/version.json", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => setLatest(j?.version ?? null))
      .catch(() => {});
  }, []);
  const current = device?.app_version ?? null;
  const cur = current ? Number(current.split(".").pop()) : null;
  const behind = latest != null && cur != null && latest > cur;
  async function command(update: boolean) {
    try {
      await sendCommand(childId, "resync", update ? { update: true } : { check_update: true });
      setMsg(update ? "Güncelleme kontrolü ve gönderimi başlatıldı." : "Telefon güncellemeyi kontrol edecek; sonuç birazdan görünecek.");
    } catch (e) {
      setMsg(errorText(e));
    }
  }
  return (
    <div className="card">
      <h2>Orbit güncellemesi <Info>Kontrol et yalnızca sonucu sorgular. Güncelle seçilirse telefon yeni APK'yı indirip kurmayı dener.</Info></h2>
      <div className="muted small">Telefon: {current ?? "?"} · En yeni: {latest ?? "?"}{behind ? " · Yeni sürüm var" : ""}</div>
      {device?.update_status && <div className="muted small">Son durum: {device.update_status}</div>}
      <div className="muted small">Son güncelleme: {device?.last_update_at ? dateTimeText(device.last_update_at) : "henüz yok"}</div>
      {device?.update_error && <div className="error small">Güncelleme hatası: {device.update_error}</div>}
      <div className="row gap-s wrap">
        <button className="btn" onClick={() => command(false)}>Kontrol et</button>
        {behind && <button className="btn primary" onClick={() => command(true)}>Güncelle</button>}
        <button className="btn ghost" onClick={() => command(true)}>Kontrol et ve güncelle</button>
      </div>
      {msg && <p className="muted small">{msg}</p>}
    </div>
  );
}

/**
 * Ebeveyn modu: ebeveyn telefonda işlem yaparken bütün sınırlamalar kalkar
 * (tüm uygulamalar açık, süre sayılmaz, kilit yok, uygulama yükleme/ayar/izinler serbest, USB hata ayıklama açık).
 * Süre bitince telefon kendiliğinden normal kurallara döner.
 */
function ParentModeCard({ childId }: { childId: string }) {
  const [until, setUntil] = useState<Date | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [, tick] = useState(0);

  const load = useCallback(async () => {
    const { data } = await supabase
      .from("commands")
      .select("until_at")
      .eq("child_id", childId)
      .eq("type", "resync")
      .eq("payload->>maintenance", "true")
      .is("cancelled_at", null)
      .gt("until_at", new Date().toISOString())
      .order("until_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    const u = (data as { until_at: string } | null)?.until_at;
    setUntil(u ? new Date(u) : null);
  }, [childId]);

  useEffect(() => {
    load();
    const t = setInterval(() => tick((x) => x + 1), 30000);
    return () => clearInterval(t);
  }, [load]);

  async function start(minutes: number) {
    setBusy(true);
    setErr("");
    try {
      await sendCommand(childId, "resync", { maintenance: true }, new Date(Date.now() + minutes * 60000).toISOString());
      await load();
    } catch (e) {
      setErr(errorText(e));
    }
    setBusy(false);
  }

  async function stop() {
    setBusy(true);
    try {
      // Açık olan ebeveyn modu komutlarını iptal et, telefon hemen normal kurallara döner.
      const { error } = await supabase
        .from("commands")
        .update({ cancelled_at: new Date().toISOString() })
        .eq("child_id", childId)
        .eq("type", "resync")
        .eq("payload->>maintenance", "true")
        .is("cancelled_at", null);
      if (error) throw error;
      await sendCommand(childId, "resync", {});
      await load();
    } catch (e) {
      setErr(errorText(e));
    }
    setBusy(false);
  }

  const active = until && until.getTime() > Date.now();
  return (
    <div className={`card ${active ? "parent-mode-on" : ""}`}>
      <div className="row gap-s wrap" style={{ alignItems: "center" }}>
        <div className="grow">
          <h2 style={{ margin: 0 }}>Ebeveyn modu{active ? " açık" : ""} <Info>Telefonda işlem yaparken sınırlamaları geçici olarak kaldırır. Süre bitince kurallar geri gelir.</Info></h2>
          {active && <p className="muted tiny" style={{ margin: "4px 0 0" }}>{until!.toLocaleTimeString("tr-TR", { hour: "2-digit", minute: "2-digit" })}'e kadar açık.</p>}
        </div>
        {active ? (
          <button className="pill-btn" disabled={busy} onClick={stop}>
            Bitir
          </button>
        ) : (
          <div className="chips">
            {[30, 60, 180].map((m) => (
              <button key={m} className="chip-btn" disabled={busy} onClick={() => start(m)}>
                {m < 60 ? `${m} dk` : `${m / 60} sa`}
              </button>
            ))}
          </div>
        )}
      </div>
      {err && <p className="error">{err}</p>}
    </div>
  );
}

// ---------------------------------------------------------------------------

const GROUPS: AppGroup[] = ["always_open", "unlimited", "timed", "blocked"];

type Mode3 = "rules" | "always_open" | "blocked";
const MODE3_LABEL: Record<Mode3, string> = { rules: "Kurallara göre", always_open: "Her zaman açık", blocked: "Hep kapalı" };
const mode3 = (g: AppGroup): Mode3 => (g === "always_open" ? "always_open" : g === "blocked" ? "blocked" : "rules");
const fromMode3 = (m: Mode3): AppGroup => (m === "rules" ? "timed" : m);

function AppsTab({ childId }: { childId: string }) {
  const fam = useFamily();
  const [apps, setApps] = useState<ChildApp[] | null>(null);
  const [q, setQ] = useState("");
  const [showSystem, setShowSystem] = useState(false);
  // Açık uygulama grupları çocuklar arasında aynı kalır (panel açıkken)
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>(() => {
    try { return JSON.parse(sessionStorage.getItem("orbit.appGroupsOpen") ?? "{}"); } catch { return {}; }
  });
  useEffect(() => { try { sessionStorage.setItem("orbit.appGroupsOpen", JSON.stringify(openGroups)); } catch { /* yok */ } }, [openGroups]);
  const [err, setErr] = useState("");
  const [pendingGroup, setPendingGroup] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    const { data, error } = await supabase.from("child_apps").select("*").eq("child_id", childId).order("label");
    if (error) setErr(errorText(error));
    setApps((data ?? []) as ChildApp[]);
  }, [childId]);
  useEffect(() => {
    load();
  }, [load]);

  async function update(app: ChildApp, patch: Partial<ChildApp>) {
    setApps((list) => list?.map((a) => (a.package === app.package ? { ...a, ...patch } : a)) ?? null);
    const { error } = await supabase
      .from("child_apps")
      .update({ ...patch, updated_at: new Date().toISOString() })
      .eq("child_id", childId)
      .eq("package", app.package);
    if (error) {
      setErr(errorText(error));
      load();
    }
  }

  async function setGroup(pkg: string, groupId: string) {
    const { error } = groupId
      ? await supabase.from("app_group_members").upsert({ family_id: fam.familyId, package: pkg, group_id: groupId })
      : await supabase.from("app_group_members").delete().eq("package", pkg);
    if (error) setErr(errorText(error));
    fam.reload();
  }

  async function approve(a: ChildApp, how: Mode3) {
    const g = pendingGroup[a.package] ?? fam.members[a.package] ?? suggestedId(a);
    if (g && g !== fam.members[a.package]) await setGroup(a.package, g);
    await update(a, { approved: true, app_group: fromMode3(how) });
  }

  function suggestedId(a: ChildApp) {
    const name = suggestGroup(a.package, a.label, a.category);
    return name ? fam.groups.find((g) => g.name.toLocaleLowerCase("tr") === name.toLocaleLowerCase("tr"))?.id ?? "" : "";
  }

  if (!apps) return <p className="muted">Yükleniyor…</p>;
  if (!apps.length)
    return (
      <div className="card soft">
        <p className="muted">Telefon eşleşince yüklü uygulamalar burada listelenir.</p>
      </div>
    );

  const filtered = apps.filter(
    (a) =>
      a.installed &&
      (showSystem || !a.is_system) &&
      (!q || a.label.toLowerCase().includes(q.toLowerCase()) || a.package.includes(q.toLowerCase()))
  );
  const pending = filtered.filter((a) => !a.approved);
  const approved = filtered.filter((a) => a.approved);
  const sections = [
    ...fam.groups.map((g) => ({ id: g.id, name: g.name, color: g.color })),
    { id: "", name: "Gruba girmemiş", color: "#9AA0C3" },
  ];

  const groupSelect = (value: string, onChange: (v: string) => void) => (
    <select value={value} onChange={(e) => onChange(e.target.value)} aria-label="Grup">
      <option value="">Grupsuz</option>
      {fam.groups.map((g) => (
        <option key={g.id} value={g.id}>
          {g.name}
        </option>
      ))}
    </select>
  );

  return (
    <div className="stack">
      {err && <p className="error">{err}</p>}
      <input className="search" placeholder="Uygulama ara" value={q} onChange={(e) => setQ(e.target.value)} />
      {pending.length > 0 && (
        <div className="card attention">
          <h2>Onay bekleyen ({pending.length}) <Info>Grubunu seçip onayla. “Kurallara göre” uygulamalar grubunun bölüm kurallarına uyar.</Info></h2>
          {pending.map((a) => (
            <div className="app-setting-row" key={a.package}>
              <div className="app-setting-controls">
                {groupSelect(pendingGroup[a.package] ?? fam.members[a.package] ?? suggestedId(a), (v) =>
                  setPendingGroup((m) => ({ ...m, [a.package]: v }))
                )}
                <select value="" onChange={(e) => e.target.value && approve(a, e.target.value as Mode3)} aria-label="Onayla">
                  <option value="">Onayla…</option>
                  {(["rules", "always_open", "blocked"] as Mode3[]).map((m) => (
                    <option key={m} value={m}>{MODE3_LABEL[m]}</option>
                  ))}
                </select>
              </div>
              <div className="app-setting-name">
                <b>{a.label}</b>
                <div className="muted tiny">{a.package}</div>
              </div>
            </div>
          ))}
        </div>
      )}
      {sections.map((g) => {
        const list = approved.filter((a) => (fam.members[a.package] ?? "") === g.id);
        if (!list.length) return null;
        return (
          <div className="card" key={g.id || "none"}>
            <div
              className="row between link-card group-toggle"
              onClick={() => setOpenGroups((m) => ({ ...m, [g.id]: !(m[g.id] ?? false) }))}
              aria-expanded={openGroups[g.id] ?? false}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && setOpenGroups((m) => ({ ...m, [g.id]: !(m[g.id] ?? false) }))}
            >
              <span>
              <span className="dot" style={{ background: g.color }} /> {g.name} <span className="muted small">· {list.length}</span>
              <Info>Günlük sınır girilirse bu uygulama, kuralların izin verdiği toplam süreden ayrıca bu dakika kadar kullanılır.</Info>
              </span>
              <span className={`collapse-arrow${openGroups[g.id] ? " open" : ""}`} aria-hidden="true" />
            </div>
            {(openGroups[g.id] ?? false) && list.map((a) => (
              <div className="app-setting-row" key={a.package}>
                <div className="app-setting-name">
                  <b>{a.label}</b>
                  <div className="muted tiny">{a.package}</div>
                </div>
                <div className="app-setting-controls">
                  {groupSelect(fam.members[a.package] ?? "", (v) => setGroup(a.package, v))}
                  <select value={mode3(a.app_group)} onChange={(e) => update(a, { app_group: fromMode3(e.target.value as Mode3) })} aria-label="Durum">
                    {(["rules", "always_open", "blocked"] as Mode3[]).map((m) => (
                      <option key={m} value={m}>{MODE3_LABEL[m]}</option>
                    ))}
                  </select>
                  <select value={a.usage_rule_id ?? ""} onChange={(e) => update(a, { usage_rule_id: e.target.value || null })} aria-label="Uygulama kullanım kuralı">
                    <option value="">Özel kural yok</option>
                    {fam.appUsageRules.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
                  </select>
                  {mode3(a.app_group) === "rules" && !a.usage_rule_id ? (
                    <input
                      className="mini"
                      type="number"
                      min={0}
                      placeholder="dk"
                      value={a.daily_limit_minutes ?? ""}
                      onChange={(e) => update(a, { daily_limit_minutes: e.target.value === "" ? null : Number(e.target.value) })}
                      aria-label="Bu uygulama için günlük üst sınır (dakika)"
                    />
                  ) : <span />}
                </div>
              </div>
            ))}
          </div>
        );
      })}
      <p className="muted tiny">
        Grup kurallarını <Link to="/rules">Kurallar</Link> → gün tipi ekranında, grupları <Link to="/rules/groups">Uygulama grupları</Link> sayfasında
        düzenlersin.
      </p>
      <label className="check">
        <input type="checkbox" checked={showSystem} onChange={(e) => setShowSystem(e.target.checked)} /> Sistem uygulamalarını da göster
      </label>
    </div>
  );
}

// ---------------------------------------------------------------------------

function ProgramTab({ childId }: { childId: string }) {
  const fam = useFamily();
  const [assign, setAssign] = useState<Record<number, string>>({});
  const [overrides, setOverrides] = useState<DayOverride[]>([]);
  const [err, setErr] = useState("");
  const [od, setOd] = useState({ day: todayISO(), profile_id: "", daily_minutes: "", note: "" });
  const [modeId, setModeId] = useState("");
  const [modeMin, setModeMin] = useState("30");
  const [msg, setMsg] = useState("");

  const load = useCallback(async () => {
    const [a, o] = await Promise.all([
      supabase.from("profile_assignments").select("*").eq("child_id", childId),
      supabase.from("day_overrides").select("*").eq("child_id", childId).gte("day", todayISO()).order("day"),
    ]);
    const m: Record<number, string> = {};
    for (const r of (a.data ?? []) as Assignment[]) m[r.weekday] = r.profile_id;
    setAssign(m);
    setOverrides((o.data ?? []) as DayOverride[]);
  }, [childId]);
  useEffect(() => {
    load();
  }, [load]);

  async function setDay(weekday: number, profileId: string) {
    setAssign({ ...assign, [weekday]: profileId });
    const { error } = profileId
      ? await supabase.from("profile_assignments").upsert({ child_id: childId, weekday, profile_id: profileId })
      : await supabase.from("profile_assignments").delete().eq("child_id", childId).eq("weekday", weekday);
    if (error) setErr(errorText(error));
  }

  async function addOverride() {
    setErr("");
    const { error } = await supabase.from("day_overrides").upsert(
      {
        child_id: childId,
        day: od.day,
        profile_id: od.profile_id || null,
        daily_minutes: od.daily_minutes === "" ? null : Number(od.daily_minutes),
        note: od.note || null,
      },
      { onConflict: "child_id,day" }
    );
    if (error) setErr(errorText(error));
    else {
      setOd({ ...od, daily_minutes: "", note: "" });
      load();
    }
  }

  async function startMode() {
    if (!modeId) return;
    const until = modeMin ? new Date(Date.now() + Number(modeMin) * 60000).toISOString() : null;
    try {
      await sendCommand(childId, "start_mode", { mode_id: modeId }, until);
      setMsg("Durum başlatılıyor");
    } catch (e) {
      setErr(errorText(e));
    }
  }

  return (
    <div className="stack">
      {err && <p className="error">{err}</p>}
      <details className="card section-collapse-card">
        <summary className="section-collapse-head"><span>Haftalık program <Info>Her gün için bir gün tipi seç. Gün tiplerini Kurallar sekmesinden düzenleyebilirsin.</Info></span><span className="collapse-arrow" aria-hidden="true" /></summary>
        {WEEKDAYS_LONG.map((d, i) => (
          <div className="app-row" key={d}>
            <span className="grow">{d}</span>
            <select value={assign[i + 1] ?? ""} onChange={(e) => setDay(i + 1, e.target.value)}>
              <option value="">— Gün tipi yok —</option>
              {fam.profiles.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </div>
        ))}
      </details>

      <details className="card section-collapse-card">
        <summary className="section-collapse-head"><span>Durumu şimdi başlat <Info>Bir durumu programa bağlı kalmadan geçici olarak başlatır.</Info></span><span className="collapse-arrow" aria-hidden="true" /></summary>
        <div className="row gap-s wrap">
          <select value={modeId} onChange={(e) => setModeId(e.target.value)} className="grow">
            <option value="">Durum seç</option>
            {fam.modes.filter((x) => !x.builtin).map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
          <select value={modeMin} onChange={(e) => setModeMin(e.target.value)}>
            <option value="15">15 dk</option>
            <option value="30">30 dk</option>
            <option value="60">1 saat</option>
            <option value="120">2 saat</option>
            <option value="">Ben bitirene kadar</option>
          </select>
        </div>
        <div className="row gap-s">
          <button className="btn primary" onClick={startMode} disabled={!modeId}>
            <Icon name="play" size={16} /> Başlat
          </button>
          <button
            className="btn"
            onClick={async () => {
              try {
                await sendCommand(childId, "end_mode");
                setMsg("Elle başlatılan durum bitiriliyor");
              } catch (e) {
                setErr(errorText(e));
              }
            }}
          >
            <Icon name="stop" size={16} /> Bitir
          </button>
        </div>
        {msg && <p className="ok small">{msg}</p>}
      </details>

      <details className="card section-collapse-card">
        <summary className="section-collapse-head"><span>Gün istisnaları <Info>Tek bir gün için farklı profil veya günlük süre belirler.</Info></span><span className="collapse-arrow" aria-hidden="true" /></summary>
        {overrides.map((o) => (
          <div className="app-row" key={o.id}>
            <div className="grow">
              <b>{dateText(o.day)}</b>
              <div className="muted tiny">
                {o.profile_id ? fam.profiles.find((p) => p.id === o.profile_id)?.name ?? "Profil" : "Kendi profili"}
                {o.daily_minutes != null ? ` · ${minutesText(o.daily_minutes)}` : ""}
                {o.note ? ` · ${o.note}` : ""}
              </div>
            </div>
            <button
              className="icon-btn"
              aria-label="Sil"
              onClick={async () => {
                await supabase.from("day_overrides").delete().eq("id", o.id);
                load();
              }}
            >
              <Icon name="trash" size={18} />
            </button>
          </div>
        ))}
        <div className="grid2">
          <div className="field">
            <span>Gün</span>
            <DateField value={od.day} onChange={(v) => setOd({ ...od, day: v })} defaultMode="wheel" />
          </div>
          <label className="field">
            <span>Profil</span>
            <select value={od.profile_id} onChange={(e) => setOd({ ...od, profile_id: e.target.value })}>
              <option value="">Değişmesin</option>
              {fam.profiles.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Günlük süre (dk)</span>
            <input type="number" min={0} value={od.daily_minutes} onChange={(e) => setOd({ ...od, daily_minutes: e.target.value })} placeholder="değişmesin" />
          </label>
          <label className="field">
            <span>Not</span>
            <input value={od.note} onChange={(e) => setOd({ ...od, note: e.target.value })} placeholder="Bayram" />
          </label>
        </div>
        <button className="btn" onClick={addOverride}>
          İstisna ekle
        </button>
      </details>
    </div>
  );
}

// ---------------------------------------------------------------------------

function DurationField({ value, onChange, unlimited = true }: { value: string; onChange: (v: string) => void; unlimited?: boolean }) {
  const total = value === "" ? 0 : Math.max(0, Number(value) || 0);
  const hours = Math.floor(total / 60);
  const minutes = total % 60;
  const set = (h: number, m: number) => onChange(String(Math.min(24 * 60, h * 60 + m)));
  return <div className="duration-field">
    <input className="mini" inputMode="numeric" value={value === "" ? "" : hours} onChange={(e) => set(Math.min(24, Number(e.target.value.replace(/\D/g, "")) || 0), minutes)} aria-label="Saat" />
    <span>sa</span>
    <input className="mini" inputMode="numeric" value={value === "" ? "" : minutes} onChange={(e) => set(hours, Math.min(59, Number(e.target.value.replace(/\D/g, "")) || 0))} aria-label="Dakika" />
    <span>dk</span>
    {unlimited && <button type="button" className={`chip-btn ${value === "" ? "on" : ""}`} aria-label="Sınırsız" onClick={() => onChange("")}>∞</button>}
  </div>;
}

type When = "now" | "custom" | "child" | "vault";
type CustomWhen = "from" | "today" | "tomorrow" | "date";

function TimeTab({ childId }: { childId: string }) {
  const fam = useFamily();
  const child = fam.children.find((c) => c.id === childId)!;
  const [grants, setGrants] = useState<TimeGrant[]>([]);
  const [minutes, setMinutes] = useState("20");
  const [when, setWhen] = useState<When>(child.extra_default === "wallet" ? "child" : child.extra_default === "now" ? "now" : "custom");
  const [customWhen, setCustomWhen] = useState<CustomWhen>("today");
  const [plan, setPlan] = useState<{ g: TimeGrant; where: string } | null>(null);
  // Nereye: "current" (şu anki bölüm), "pool" (gün boyu) ya da bölüm id
  const [target, setTarget] = useState<string>(child.extra_default === "pool" ? "pool" : "current");
  const [date, setDate] = useState(todayISO("Europe/Berlin", 1));
  const [fromDay, setFromDay] = useState<"today" | "tomorrow">("today");
  const [start, setStart] = useState("18:00");
  const [endMode, setEndMode] = useState<"open" | "until" | "eod">("open");
  const [until, setUntil] = useState("19:00");
  const [expires, setExpires] = useState("");
  const [note, setNote] = useState("");
  // Kapalı / sınırlı saatte bu verişin davranışı; varsayılan Kurallar'daki ayar
  // Varsayılan: o anki bölümün kullanım profilinde seçim varsa o, yoksa çocuğun ayarı
  const [def, setDef] = useState<{ cm: ClosedMode; from: string | null }>({ cm: closedModeOf(child), from: null });
  const defMode = def.cm;
  const [cmode, setCmode] = useState<ClosedMode>(defMode);
  useEffect(() => {
    let on = true;
    closedModeFor(childId, fam).then((r) => {
      if (!on) return;
      setDef(r);
      setCmode(r.cm);
    });
    return () => {
      on = false;
    };
  }, [childId, child.closed_grant_mode, child.closed_grant_within_minutes, child.closed_grant_within_factor, fam.modes, fam.sections]); // eslint-disable-line react-hooks/exhaustive-deps
  const [err, setErr] = useState("");
  const [msg, setMsg] = useState("");
  const [cur, setCur] = useState<Section | null>(null);
  const [walletMax, setWalletMax] = useState(child.wallet_daily_max != null ? String(child.wallet_daily_max) : "");

  const load = useCallback(async () => {
    const { data } = await supabase
      .from("time_grants")
      .select("*")
      .eq("child_id", childId)
      .order("created_at", { ascending: false })
      .limit(60);
    setGrants((data ?? []) as TimeGrant[]);
  }, [childId]);
  useEffect(() => {
    load();
    currentSectionFor(childId, fam.sections).then(setCur);
  }, [load, childId, fam.sections]);

  const today = todayISO();
  const wallet = grants.filter((g) => !g.vault && !g.valid_on && !g.activated_on && (!g.expires_on || g.expires_on >= today));
  const live = useMemo(
    // Gece yarısını geçen sürenin ertesi gün devamı ayrı satır olarak gösterilmez (ilk satırda yazar)
    () => grants.filter((g) => !g.vault && ((g.valid_on && g.valid_on >= today) || g.activated_on === today) && !grants.some((x) => x.carry_to === g.id)),
    [grants, today]
  );
  const vault = grants.filter((g) => g.vault);
  const profName = (pid: string) => fam.profiles.find((p) => p.id === pid)?.name ?? "";
  const sectionOptions = fam.sections.map((sec) => ({ id: sec.id, label: `${profName(sec.profile_id)} · ${sec.name} ${hhmm(sec.start_time)}–${hhmm(sec.end_time)}` }));
  const secName = (id: string | null) => (id ? fam.sections.find((x) => x.id === id)?.name ?? "bölüm" : null);
  const curOpen = !!cur && timedPossible(cur, fam.sectionRules);

  async function give() {
    setErr("");
    setMsg("");
    const m = Number(minutes);
    if (!m) return;
    try {
      const detail = when === "custom" ? customWhen : null;
      if (when === "now") {
        const text = await giveNow(childId, m, fam, fam.statuses[childId], { override: cmode, note: note || undefined });
        setMsg(`${minutesText(m)} verildi · ${text}`);
      } else if (cmode.mode === "none" && when === "custom") {
        await grantMinutes(childId, m, { validOn: null, vault: true, note: note || undefined });
        setMsg(`${minutesText(m)} süre kasasına kaydedildi`);
      } else if (detail === "from" || (detail && cmode.mode !== "usage")) {
        const day = detail === "from" ? (fromDay === "today" ? today : todayISO("Europe/Berlin", 1)) : detail === "today" ? today : detail === "tomorrow" ? todayISO("Europe/Berlin", 1) : date;
        let patch: GrantPatch, text: string;
        if (detail === "from" && cmode.mode === "usage") ({ patch, text } = await fromPatch(childId, fam, day, start, endMode, until));
        else {
          const span = cmode.mode === "clock" ? m : cmode.withinFactor ? m * cmode.withinFactor : cmode.withinMinutes ?? 120;
          const end = hm(Math.min(mins(start) + span, 1439));
          patch = { valid_on: day, section_id: null, vault: false, window_start: start, window_end: end };
          text = `${start}–${end} arası`;
        }
        await insertGrant(childId, m, patch, note);
        setMsg(`${minutesText(m)} verildi · ${dateText(day)} ${text}`);
      } else if (when === "vault") {
        await grantMinutes(childId, m, { validOn: null, vault: true, note: note || undefined });
        setMsg(`${minutesText(m)} süre kasasına kaydedildi`);
      } else {
        const validOn = detail === "today" ? today : detail === "tomorrow" ? todayISO("Europe/Berlin", 1) : detail === "date" ? date : null;
        const sectionId = when === "child" ? null : target === "current" ? (detail === "today" ? cur?.id ?? null : null) : target === "pool" ? null : target;
        await grantMinutes(childId, m, { validOn, sectionId, expiresOn: when === "child" ? expires || null : null, note: note || undefined });
        setMsg(`${minutesText(m)} verildi${sectionId ? ` · ${secName(sectionId)}` : when === "child" ? " · cüzdana" : " · gün boyu"}`);
      }
      setNote("");
      load();
      fam.reload();
    } catch (e) {
      setErr(errorText(e));
    }
  }

  async function saveDefaultMode() {
    const v = cmode;
    const { error } = await supabase
      .from("children")
      .update({ closed_grant_mode: v.mode, ...(v.mode === "within" ? { closed_grant_within_minutes: v.withinMinutes, closed_grant_within_factor: v.withinFactor } : {}) })
      .eq("id", childId);
    if (error) return setErr(errorText(error));
    setMsg(`Varsayılan: ${closedModeLabel(v)}`);
    fam.reload();
  }

  async function retarget(g: TimeGrant, v: string) {
    const patch =
      v === "vault"
        ? { valid_on: null, section_id: null, vault: true, window_start: null, window_end: null, expires_on: null }
        : v === "wallet"
          ? { valid_on: null, section_id: null, window_start: null, window_end: null }
          : v === "pool"
            ? { valid_on: g.valid_on ?? today, section_id: null, window_start: null, window_end: null }
            : { valid_on: g.valid_on ?? today, section_id: v, window_start: null, window_end: null };
    const { error } = await supabase.from("time_grants").update(patch).eq("id", g.id);
    if (error) setErr(errorText(error));
    load();
  }


  async function saveWalletMax() {
    const v = walletMax.trim() === "" ? null : Math.max(0, Math.round(Number(walletMax)));
    const { error } = await supabase.from("children").update({ wallet_daily_max: v }).eq("id", childId);
    if (error) return setErr(errorText(error));
    setMsg(v == null ? "Cüzdan günlük sınırı kaldırıldı" : `Cüzdandan günde en fazla ${minutesText(v)}`);
    fam.reload();
  }

  const fromSpan = cmode.mode === "clock" ? Number(minutes) || 0 : cmode.withinFactor ? (Number(minutes) || 0) * cmode.withinFactor : cmode.withinMinutes ?? 120;
  const fromEnd = hm(Math.min(mins(start) + fromSpan, 1439));
  const stNow = fam.statuses[childId];
  const kioskNow = !!stNow?.lock_reason?.startsWith("🔒");
  const limitedNow = !kioskNow && (!!stNow?.locked || (!!stNow && stNow.remaining_minutes === 0));
  const mText = minutes || "?";
  const nowHint = kioskNow
    ? `Telefon kilitli: ${mText} dk kalan süreye eklenir, kilit kalkınca kullanır.`
    : curOpen && !limitedNow
      ? `Şu an ${cur!.name} bölümü açık: süre bu bölüme eklenir, kalan süre hemen artar.`
      : cmode.mode === "clock"
        ? `Telefon şimdi ${mText} dakikalığına açılır, kullanılmasa da sonunda kapanır.`
        : cmode.mode === "within"
          ? `Telefon şimdi açılır; ${mText} dk kullandıkça düşer, ${cmode.withinFactor ? `${cmode.withinFactor} katı süre` : `${(cmode.withinMinutes ?? 120) / 60} saat`} içinde kullanmalı.`
          : `Telefon şimdi açılır; ${mText} dk kullandıkça düşer, bitince kapanır.`;
  const whenHint =
    when === "now"
      ? nowHint
      : when === "vault"
        ? "Kasada bekler; istediğinde buradan “Şimdi ver” ile açarsın."
        : when === "child"
          ? "Çocuk bu süreyi kendisi açabilir; yalnızca izin verilen saatlerde kullanılır."
          : customWhen === "from"
            ? cmode.mode === "usage"
              ? `${start}'den itibaren ${mText} dk kullanabilir; kullandıkça düşer.`
              : cmode.mode === "clock"
                ? `${start}–${fromEnd} arası telefon açık; kullanılmasa da ${fromEnd}'de kapanır.`
                : `${start}'den itibaren ${mText} dk; kullandıkça düşer, ${fromEnd}'e kadar kullanmalı.`
            : cmode.mode === "usage"
              ? "Seçtiğin bölüme ya da gün boyu süreye eklenir; kullandıkça düşer."
              : cmode.mode === "clock"
                ? `O gün ${start}–${fromEnd} arası telefon açık; kullanılmasa da ${fromEnd}'de kapanır.`
                : `O gün ${start}'den itibaren ${mText} dk; kullandıkça düşer, ${fromEnd}'e kadar kullanmalı.`;

  const usedOf = (g: TimeGrant) => fam.statuses[childId]?.grant_used?.[g.id] ?? 0;
  const grantRow = (g: TimeGrant, kind: "wallet" | "vault") => (
    <div className="grant-row" key={g.id}>
      <div className="grow">
        {g.minutes > 0 ? <GrantMinutes g={g} used={0} onChanged={() => { load(); fam.reload(); }} /> : <b>{minutesText(g.minutes)}</b>}
        <div className="muted tiny">
          {g.note ?? (g.source === "task_penalty" ? "görev cezası" : g.source === "task" ? "görev ödülü" : "ekstra süre")} · {dateText(g.created_at.slice(0, 10))}
          {kind === "wallet" && g.expires_on ? ` · son ${dateText(g.expires_on)}` : ""}
        </div>
      </div>
      {g.minutes > 0 && (
        <>
          <button className="btn small primary" onClick={() => setPlan({ g, where: "now" })}>
            Şimdi ver
          </button>
          <button className="btn small" onClick={() => setPlan({ g, where: "pool" })}>
            Planla
          </button>
        </>
      )}
      <button
        className="icon-btn"
        aria-label="Sil"
        onClick={async () => {
          if (!confirm(kind === "vault" ? "Bu süre kasadan silinsin mi?" : "Bu süre cüzdandan silinsin mi?")) return;
          await supabase.from("time_grants").delete().eq("id", g.id);
          load();
          fam.reload();
        }}
      >
        <Icon name="trash" size={18} />
      </button>
    </div>
  );

  return (
    <div className="stack">
      <details className="card extra-card section-collapse-card" open>
        <summary className="section-collapse-head"><span>Ekstra süre ver</span><span className="collapse-arrow" aria-hidden="true" /></summary>
        <div className="extra-row">
          <MinuteStepper value={Number(minutes) || 0} onChange={(v) => setMinutes(String(v))} onEnter={give} label="Verilecek dakika" />
          <div className="chips">
            {[10, 15, 30, 60].map((m) => (
              <button key={m} type="button" className={`chip-btn ${Number(minutes) === m ? "on" : ""}`} onClick={() => setMinutes(String(m))}>
                {m < 60 ? `${m} dk` : `${m / 60} sa`}
              </button>
            ))}
          </div>
        </div>
        <div className="extra-group">
          <span className="pop-label">NE ZAMAN {whenHint && <Info>{whenHint}</Info>}</span>
          <div className="chips">
            {([["now", "Hemen"], ["vault", "Kasaya"], ["child", "Cüzdana"], ["custom", "Özel"]] as const).map(([v, l]) => (
              <button key={v} type="button" className={`chip-btn ${when === v ? "on" : ""}`} onClick={() => setWhen(v)}>
                {l}
              </button>
            ))}
          </div>
          {when === "custom" && (
            <div className="chips">
              {([["today", "Bugün"], ["from", "Saatten itibaren"], ["tomorrow", "Yarın"], ["date", "Belirli gün"]] as const).map(([v, l]) => (
                <button key={v} type="button" className={`chip-btn ${customWhen === v ? "on" : ""}`} onClick={() => setCustomWhen(v)}>
                  {l}
                </button>
              ))}
            </div>
          )}
          {(when === "now" || when === "custom") && (
            <details className="sub-collapse">
              <summary className="sub-collapse-head">
                <span>
                  Nasıl kullanılsın: <b className="text-strong">{closedModeLabel(cmode)}</b>
                  {sameClosedMode(cmode, defMode) ? " · varsayılan" : ""}
                </span>
                <span className="collapse-arrow" aria-hidden="true" />
              </summary>
              <div className="stack-s">
                <ClosedModePicker value={cmode} onChange={setCmode} allowNone={cmode.mode === "none" || defMode.mode === "none"} />
                <div className="row gap-s" style={{ alignItems: "center" }}>
                  <span className="muted tiny grow">
                    Varsayılan: {closedModeLabel(defMode)}{def.from ? ` · ${def.from} profilinden` : ""} <Info>Seçtiğin ayar sadece bu veriş için geçerli. “Varsayılan yap” dersen Kurallar’daki ayar da değişir. Telefon açık saatteyse süre o anki bölüme eklenir; bu ayar kapalı ya da sınırlı saatlerde geçerlidir.</Info>
                  </span>
                  {!sameClosedMode(cmode, defMode) && (def.from ? (
                    <button type="button" className="chip-btn" onClick={() => setCmode(defMode)}>Geri al</button>
                  ) : (
                    <>
                      <button type="button" className="chip-btn" onClick={() => setCmode(defMode)}>Geri al</button>
                      <button type="button" className="chip-btn" onClick={saveDefaultMode}>Varsayılan yap</button>
                    </>
                  ))}
                </div>
              </div>
            </details>
          )}
        </div>
        {when === "custom" && customWhen === "from" && (
          <div className="extra-group">
            <div className="extra-row">
              <div className="chips">
                {([["today", "Bugün"], ["tomorrow", "Yarın"]] as const).map(([v, l]) => (
                  <button key={v} type="button" className={`chip-btn ${fromDay === v ? "on" : ""}`} onClick={() => setFromDay(v)}>
                    {l}
                  </button>
                ))}
              </div>
              <span className="small muted">saat</span>
              <TimeField value={start} onChange={(v) => setStart(v)} label="Başlangıç" />
              <span className="small muted">'den itibaren</span>
            </div>
            {cmode.mode === "usage" && (
              <>
                <span className="pop-label">
                  NE ZAMANA KADAR <Info>O saat gelince süre kullanılabilir olur. Bitişe kadar kullanmazsa düşer; kapalı saatlere denk gelirse o aralıkta telefon bu süre kadar açılır.</Info>
                </span>
                <div className="extra-row">
                  <div className="chips">
                    {([["open", "Açık saatler bitene kadar"], ["until", "Belirli saate kadar"], ["eod", "Gün sonuna kadar"]] as const).map(([v, l]) => (
                      <button key={v} type="button" className={`chip-btn ${endMode === v ? "on" : ""}`} onClick={() => setEndMode(v)}>
                        {l}
                      </button>
                    ))}
                  </div>
                  {endMode === "until" && <TimeField value={until} onChange={(v) => setUntil(v)} label="Bitiş" />}
                </div>
              </>
            )}
          </div>
        )}
        {when === "custom" && customWhen === "date" && (
          <div className="field compact">
            <span>Gün</span>
            <DateField value={date} onChange={(v) => setDate(v)} />
          </div>
        )}
        {when === "custom" && customWhen !== "from" && cmode.mode !== "usage" && (
          <div className="extra-row">
            <span className="small muted">saat</span>
            <TimeField value={start} onChange={(v) => setStart(v)} label="Başlangıç" />
            <span className="small muted">'den itibaren</span>
          </div>
        )}
        {when === "custom" && (customWhen === "today" || customWhen === "tomorrow" || customWhen === "date") && cmode.mode === "usage" && (
          <label className="field compact">
            <span>Nereye eklensin</span>
            <select value={target} onChange={(e) => setTarget(e.target.value)}>
              {customWhen === "today" && <option value="current">Şu anki bölüm{cur ? ` (${cur.name})` : " (şu an bölüm yok → gün boyu)"}</option>}
              <option value="pool">Gün boyu: süreli her bölümde kullanılır</option>
              {sectionOptions.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
        )}
        {when === "child" && (
          <div className="field compact">
            <span>Son kullanma (isteğe bağlı)</span>
            <DateField clearable value={expires} onChange={(v) => setExpires(v)} placeholder="Son kullanma yok" />
          </div>
        )}
        <input className="compact-input" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Not (isteğe bağlı) · ör. İyi davrandın" aria-label="Not" />
        {err && <p className="error">{err}</p>}
        {msg && <p className="ok">{msg}</p>}
        <div className="extra-actions">
          <button
            type="button"
            className="pill-btn minus"
            disabled={!Number(minutes)}
            onClick={async () => {
              const m = Number(minutes);
              if (!m) return;
              try {
                await sendCommand(childId, "adjust_minutes", { minutes: -m });
                setMsg(`Bugünden ${minutesText(m)} düşülüyor`);
              } catch (e) {
                setErr(errorText(e));
              }
            }}
          >
            {minutes} dk düş
          </button>
          <span className="grow" />
          <button type="button" className="pill-btn primary" disabled={!Number(minutes)} onClick={give}>
            {minutes} dk ver
          </button>
        </div>
      </details>

      <details className="card section-collapse-card" open>
        <summary className="section-collapse-head"><span>Süre cüzdanı <Info>Çocuk bu süreyi kendisi açabilir; yalnızca izin verilen saatlerde kullanılır.</Info></span><span className="collapse-arrow" aria-hidden="true" /></summary>
        {!wallet.length && <p className="muted small">Cüzdanda süre yok.</p>}
        {wallet.length > 0 && (
          <p>
            <b>Toplam {minutesText(wallet.reduce((a, g) => a + g.minutes, 0))}</b>
          </p>
        )}
        {wallet.map((g) => grantRow(g, "wallet"))}
        <div className="row gap-s wrap" style={{ alignItems: "center" }}>
          <span className="small">Günlük sınır <Info>Çocuğun cüzdandan bir günde kullanabileceği en fazla süre.</Info></span>
          <DurationField value={walletMax} onChange={setWalletMax} />
          <button className="btn small" onClick={saveWalletMax}>
            Kaydet
          </button>
        </div>
      </details>

      <details className="card section-collapse-card" open>
        <summary className="section-collapse-head"><span>Süre kasası <Info>Bu süreyi çocuk kendisi kullanamaz. Hemen verebilir veya ileriye planlayabilirsin.</Info></span><span className="collapse-arrow" aria-hidden="true" /></summary>
        {!vault.length && <p className="muted small">Kasada süre yok.</p>}
        {vault.length > 0 && (
          <p>
            <b>Toplam {minutesText(vault.reduce((a, g) => a + g.minutes, 0))}</b>
          </p>
        )}
        {vault.map((g) => grantRow(g, "vault"))}
      </details>
      {plan && (
        <PlanSheet
          grant={plan.g}
          initialWhere={plan.where}
          sections={sectionOptions}
          onClose={() => setPlan(null)}
          onDone={(t) => {
            setPlan(null);
            setMsg(t);
            load();
            fam.reload();
          }}
        />
      )}
      <details className="card section-collapse-card" open>
        <summary className="section-collapse-head"><span>Planlanan süreler <Info>Bu liste kullanılmış süreler değil; cüzdandan veya görev ödülünden aktif plana ayrılmış, çocuğun kullanabileceği süreleri gösterir.</Info></span><span className="collapse-arrow" aria-hidden="true" /></summary>
        {!live.length && <p className="muted small">Planlanmış ekstra süre yok.</p>}
        {live.map((g) => (
          <div className="grant-row" key={g.id}>
            <div className="grow">
              {g.minutes > 0 && !g.settled_at ? <GrantMinutes g={g} used={usedOf(g)} onChanged={() => { load(); fam.reload(); }} /> : <b>{minutesText(g.minutes)}</b>}
              <div className="muted tiny">
                {g.activated_on && !g.valid_on ? `cüzdandan · ${dateText(g.activated_on)}` : dateText(g.valid_on!)}
                {g.window_start ? ` · ${hhmm(g.window_start)}–${hhmm(g.window_end ?? "")} arası` : g.section_id ? ` · ${secName(g.section_id)}` : " · gün boyu"}
                {g.note ? ` · ${g.note}` : ""}
                {(() => {
                  const next = g.carry_to ? grants.find((x) => x.id === g.carry_to) : null;
                  return next?.window_end ? ` · kullanılmayan kısmı gece ${hhmm(next.window_end)}'e kadar sürer` : "";
                })()}
              </div>
            </div>
            {!g.activated_on && (
              <>
                <select
                  value={g.window_start ? "window" : g.section_id ?? "pool"}
                  onChange={(e) => (e.target.value === "window" ? setPlan({ g, where: "window" }) : retarget(g, e.target.value))}
                  aria-label="Nereye"
                >
                  <option value="pool">Gün boyu</option>
                  <option value="window">Saat aralığı…</option>
                  <option value="wallet">Süre cüzdanına</option>
                  <option value="vault">Süre kasasına geri al</option>
                  {sectionOptions.map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.label}
                    </option>
                  ))}
                </select>
                <button
                  className="icon-btn"
                  aria-label="Geri al"
                  onClick={async () => {
                    await supabase.from("time_grants").delete().eq("id", g.id);
                    if (g.carry_to) await supabase.from("time_grants").delete().eq("id", g.carry_to);
                    load();
                    fam.reload();
                  }}
                >
                  <Icon name="trash" size={18} />
                </button>
              </>
            )}
          </div>
        ))}
      </details>
    </div>
  );
}

/** Verilen sürenin dakikası: − / + (1 dk, basılı tut hızlanır), elle yazılabilir. Değişince "✓ Kaydet" / "Vazgeç" çıkar; 0 → silinsin mi? */
function GrantMinutes({ g, used, onChanged }: { g: TimeGrant; used: number; onChanged: () => void }) {
  const [v, setV] = useState(g.minutes);
  const [state, setState] = useState<"" | "saving" | "saved" | "error">("");
  const dirty = v !== g.minutes;
  useEffect(() => { setV(g.minutes); }, [g.minutes]);

  async function remove() {
    await supabase.from("time_grants").delete().eq("id", g.id);
    if (g.carry_to) await supabase.from("time_grants").delete().eq("id", g.carry_to);
    onChanged();
  }
  function change(n: number) {
    if (n <= 0) {
      if (confirm("Bu süre silinsin mi?")) remove();
      else setV(Math.max(1, used));
      return;
    }
    setState("");
    setV(n);
  }
  async function save() {
    setState("saving");
    const { data, error } = await supabase.rpc("parent_set_grant_minutes", { p_grant: g.id, p_minutes: v });
    if (error) { setState("error"); return; }
    if (typeof data === "number") setV(data);
    setState("saved");
    onChanged();
    window.setTimeout(() => setState((x) => (x === "saved" ? "" : x)), 2000);
  }
  return (
    <div className="grant-minutes">
      <MinuteStepper value={v} onChange={change} min={used > 0 ? used : 0} max={1440} step={1} label="Dakika" />
      {dirty && (
        <div className="row gap-xs">
          <button className="btn small primary" disabled={state === "saving"} onClick={save}>{state === "saving" ? "Kaydediliyor…" : "✓ Kaydet"}</button>
          <button className="btn small ghost" onClick={() => { setV(g.minutes); setState(""); }}>Vazgeç</button>
          <span className="muted tiny">{minutesText(g.minutes)} → {minutesText(v)}</span>
        </div>
      )}
      <span className="muted tiny">
        {used > 0 ? `${used} dk kullanıldı` : ""}
        {state === "saved" ? " ✓ kaydedildi" : state === "error" ? " kaydedilemedi" : ""}
      </span>
    </div>
  );
}

/** Kasadaki / cüzdandaki (ya da verilmiş) bir süreyi hemen ya da bir güne / bölüme / saat aralığına aktar; istersen bir kısmını. */
function PlanSheet({
  grant,
  initialWhere,
  sections,
  onClose,
  onDone,
}: {
  grant: TimeGrant;
  initialWhere?: string;
  sections: { id: string; label: string }[];
  onClose: () => void;
  onDone: (msg: string) => void;
}) {
  const fam = useFamily();
  const [minutes, setMinutes] = useState(String(grant.minutes));
  const [day, setDay] = useState<"today" | "tomorrow" | "date">("today");
  const [date, setDate] = useState(todayISO("Europe/Berlin", 2));
  const [where, setWhere] = useState<string>(initialWhere ?? (grant.window_start ? "window" : "pool"));
  const [start, setStart] = useState(grant.window_start ? hhmm(grant.window_start) : "18:00");
  const [end, setEnd] = useState(grant.window_end ? hhmm(grant.window_end) : "19:00");
  const [endMode, setEndMode] = useState<"open" | "until" | "eod">(grant.window_end ? "until" : "open");
  const [err, setErr] = useState("");
  // Kapalı saatteyken bugüne süre eklemek işe yaramaz (kullanılamaz); bugün seçenekleri kapanır
  const [closedNow, setClosedNow] = useState<string | null>(null);
  useEffect(() => {
    (async () => {
      const { data } = await supabase.rpc("open_hours", { p_child: grant.child_id, p_day: todayISO() });
      const h = (Array.isArray(data) ? data[0] : data) as { os: number; oe: number } | null;
      if (!h) return;
      const p = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Berlin", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date()).split(":").map(Number);
      const t = p[0] * 60 + p[1];
      const f = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
      if (t < h.os || t >= h.oe) {
        setClosedNow(`${f(h.os)}–${f(h.oe)}`);
        setDay((d) => (d === "today" ? "tomorrow" : d));
      }
    })();
  }, [grant.child_id]);

  async function save() {
    setErr("");
    const m = Math.round(Number(minutes));
    if (!m || m < 1 || m > grant.minutes) return setErr(`1 ile ${grant.minutes} dk arası yaz.`);
    if (closedNow && dated && day === "today") return setErr("Kapalı saatte bugüne süre eklenemez.");
    const validOn = day === "today" ? todayISO() : day === "tomorrow" ? todayISO("Europe/Berlin", 1) : date;
    let target: GrantPatch;
    let text: string;
    try {
      if (where === "now") {
        ({ patch: target, text } = await nowPatch(grant.child_id, m, fam));
      } else if (where === "window") {
        ({ patch: target, text } = await fromPatch(grant.child_id, fam, validOn, start, endMode, end));
        text = `${dateText(validOn)} ${text}`;
      } else if (where === "wallet") {
        target = { valid_on: null, section_id: null, vault: false, window_start: null, window_end: null };
        text = "cüzdana";
      } else if (where === "vault") {
        target = { valid_on: null, section_id: null, vault: true, window_start: null, window_end: null };
        text = "kasaya";
      } else if (where === "pool") {
        target = { valid_on: validOn, section_id: null, vault: false, window_start: null, window_end: null };
        text = `${dateText(validOn)} gün boyu`;
      } else {
        target = { valid_on: validOn, section_id: where, vault: false, window_start: null, window_end: null };
        text = `${dateText(validOn)} · ${sections.find((x) => x.id === where)?.label ?? "bölüm"}`;
      }
    } catch (e) {
      return setErr(errorText(e));
    }
    let error;
    // Cüzdandan / kasadan aktarılınca son kullanma tarihi kalkar (cüzdana gidiyorsa korunur)
    const full = { ...target, ...(where === "wallet" ? {} : { expires_on: null }) };
    if (m === grant.minutes) {
      ({ error } = await supabase.from("time_grants").update(full).eq("id", grant.id));
    } else {
      // Bölerek: kalan kısım yerinde kalır
      const { data: u } = await supabase.auth.getUser();
      ({ error } = await supabase.from("time_grants").insert({
        child_id: grant.child_id,
        minutes: m,
        note: grant.note,
        source: grant.source,
        created_by: u.user?.id,
        ...full,
      }));
      if (!error) ({ error } = await supabase.from("time_grants").update({ minutes: grant.minutes - m }).eq("id", grant.id));
    }
    if (error) return setErr(errorText(error));
    onDone(`${minutesText(m)} → ${text}`);
  }

  const dated = where !== "wallet" && where !== "now" && where !== "vault";
  return createPortal(
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <h2>Süreyi ver / planla</h2>
        <label className="field">
          <span>Kaç dakika (en fazla {grant.minutes})</span>
          <input type="number" min={1} max={grant.minutes} value={minutes} onChange={(e) => setMinutes(e.target.value)} />
        </label>
        <label className="field">
          <span>Nereye</span>
          <select value={where} onChange={(e) => setWhere(e.target.value)}>
            <option value="now">Hemen kullansın</option>
            {!(!grant.vault && !grant.valid_on) && <option value="wallet">Cüzdana aktar (çocuk istediği gün kullanır)</option>}
            {!grant.vault && <option value="vault">Kasaya aktar (çocuk kullanamaz)</option>}
            <option value="window">Belirli saatten itibaren</option>
            <option value="pool">Gün boyu: süreli her bölümde</option>
            {sections.map((o) => (
              <option key={o.id} value={o.id}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
        {closedNow && dated && <p className="muted small">Şu an kapalı saat (açık: {closedNow}). Bugüne eklenen süre kullanılamaz; yarına ya da başka güne planla, veya "Hemen kullansın" ile telefonu şimdi aç.</p>}
        {where === "now" && <Info>Açık saatlerdeyse kalan süresine hemen eklenir; kapalı saatlerdeyse şu andan itibaren bu süre kadar telefon açılır.</Info>}
        {dated && (
          <label className="field">
            <span>Hangi gün</span>
            <select value={day} onChange={(e) => setDay(e.target.value as typeof day)}>
              <option value="today" disabled={!!closedNow}>Bugün{closedNow ? " (kapalı saat)" : ""}</option>
              <option value="tomorrow">Yarın</option>
              <option value="date">Belirli bir gün</option>
            </select>
          </label>
        )}
        {dated && day === "date" && <DateField value={date} onChange={(v) => setDate(v)} />}
        {where === "window" && (
          <>
            <div className="row gap-s" style={{ alignItems: "center" }}>
              <TimeField value={start} onChange={(v) => setStart(v)} label="Başlangıç" />
              <span className="small">'den itibaren</span>
            </div>
            <select value={endMode} onChange={(e) => setEndMode(e.target.value as typeof endMode)} aria-label="Bitiş">
              <option value="open">Açık saatler bitene kadar</option>
              <option value="until">Belirli saate kadar</option>
              <option value="eod">Gün sonuna kadar</option>
            </select>
            {endMode === "until" && <TimeField value={end} onChange={(v) => setEnd(v)} label="Bitiş saati" />}
          </>
        )}
        {err && <p className="error">{err}</p>}
        <div className="row gap-s">
          <button className="btn primary" onClick={save}>
            Kaydet
          </button>
          <button className="btn ghost" onClick={onClose}>
            Vazgeç
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

// ---------------------------------------------------------------------------

function DeviceTab({ childId }: { childId: string }) {
  const fam = useFamily();
  const nav = useNavigate();
  const child = fam.children.find((c) => c.id === childId)!;
  const [devices, setDevices] = useState<Device[]>([]);
  const [code, setCode] = useState("");
  const [err, setErr] = useState("");
  const [name, setName] = useState(child.name);
  const [color, setColor] = useState(child.color);
  const [confirmDisconnect, setConfirmDisconnect] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const load = useCallback(async () => {
    const { data } = await supabase.from("devices").select("*").eq("child_id", childId).order("created_at", { ascending: false });
    setDevices((data ?? []) as Device[]);
  }, [childId]);
  useEffect(() => {
    load();
    const timer = setInterval(load, 10000);
    return () => clearInterval(timer);
  }, [load]);

  async function newCode() {
    setErr("");
    const { data, error } = await supabase.rpc("create_pairing_code", { p_kind: "child_phone", p_child_id: childId });
    if (error) setErr(errorText(error));
    else setCode(String(data));
  }

  return (
    <div className="stack">
      {err && <p className="error">{err}</p>}
      <div className="card">
        <h2>Telefonu eşleştir <Info>Kod 15 dakika geçerli ve tek kullanımlıktır.</Info></h2>
        {code ? (
          <div className="code">{code.slice(0, 4)} {code.slice(4)}</div>
        ) : (
          <button className="btn primary" onClick={newCode}>
            <Icon name="phone" size={18} /> Eşleştirme kodu al
          </button>
        )}
      </div>
      <UpdateCard childId={childId} device={devices[0]} />

      <div className="card">
        <h2>Kuralları gönder <Info>Telefon kuralları normalde 30 saniyede bir alır; burada hemen gönderebilirsin.</Info></h2>
        <button
          className="btn ghost"
          onClick={async () => {
            await sendCommand(childId, "resync", {}).catch(() => {});
          }}
        >
          Kuralları hemen gönder
        </button>
      </div>

      <div className="card">
        <h2>Eşleşen telefonlar</h2>
        {!devices.length && <p className="muted small">Henüz telefon yok.</p>}
        {devices.map((d) => (
          <div className="app-row" key={d.id}>
            <div className="grow">
              <b>{d.model ?? d.label}</b>
              <div className="muted tiny">
                {d.os_version ? `Android ${d.os_version} · ` : ""}
                {d.app_version ? `Orbit ${d.app_version} · ` : ""}
                {d.is_device_owner === false ? "device owner DEĞİL · " : ""}
                Eşleşme: {d.created_at ? dateTimeText(d.created_at) : "—"} · son görülme {relTime(d.last_seen_at)}
              </div>
            </div>
            {d.status === "active" ? (
              <button
                className="btn small danger-text"
                onClick={async () => {
                  if (confirmDisconnect !== d.id) return setConfirmDisconnect(d.id);
                  await supabase.from("devices").update({ status: "revoked" }).eq("id", d.id);
                  setConfirmDisconnect(null);
                  load();
                }}
              >
                {confirmDisconnect === d.id ? "Kesilsin" : "Bağlantıyı kes"}
              </button>
            ) : (
              <span className="pill quiet">kesildi</span>
            )}
          </div>
        ))}
      </div>
      {devices.some((d) => d.status === "active") && (
        <FindPhone
          childId={childId}
          name={name}
          staleMin={(() => {
            const d = devices.find((x) => x.status === "active");
            return d?.last_seen_at ? Math.floor((Date.now() - new Date(d.last_seen_at).getTime()) / 60000) : 999;
          })()}
        />
      )}
      <div className="card">
        <h2>Çocuk bilgileri</h2>
        <label className="field">
          <span>Ad</span>
          <input value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label className="field">
          <span>Renk</span>
          <input type="color" value={color} onChange={(e) => setColor(e.target.value)} />
        </label>
        <button
          className="btn"
          onClick={async () => {
            const { error } = await supabase.from("children").update({ name, color }).eq("id", childId);
            if (error) setErr(errorText(error));
            else fam.reload();
          }}
        >
          Kaydet
        </button>
        <button
          className="btn ghost danger-text"
          onClick={async () => {
            if (!confirmDelete) return setConfirmDelete(true);
            await supabase.from("children").delete().eq("id", childId);
            await fam.reload();
            nav("/");
          }}
        >
          {confirmDelete ? "Tekrar bas: kalıcı sil" : "Çocuğu sil"}
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

type UsageRow = { day: string; package: string; minutes: number; counted_minutes: number };

function ReportTab({ childId }: { childId: string }) {
  const [rows, setRows] = useState<UsageRow[]>([]);
  const [labels, setLabels] = useState<Record<string, string>>({});
  // Seçilen aralık çocuklar arasında aynı kalır (panel açıkken), karşılaştırma için
  const ss = (k: string, d: string) => { try { return sessionStorage.getItem(`orbit.report.${k}`) ?? d; } catch { return d; } };
  const [range, setRange] = useState<"day" | "week" | "month" | "custom">(() => ss("range", "week") as "day" | "week" | "month" | "custom");
  const [from, setFrom] = useState(() => ss("from", todayISO("Europe/Berlin", -6)));
  const [to, setTo] = useState(() => ss("to", todayISO()));
  useEffect(() => {
    try {
      sessionStorage.setItem("orbit.report.range", range);
      sessionStorage.setItem("orbit.report.from", from);
      sessionStorage.setItem("orbit.report.to", to);
    } catch { /* yok */ }
  }, [range, from, to]);
  const [day, setDay] = useState(todayISO());

  useEffect(() => {
    (async () => {
      const since = todayISO("Europe/Berlin", -365);
      const [u, a] = await Promise.all([
        supabase.from("usage_daily").select("day, package, minutes, counted_minutes").eq("child_id", childId).gte("day", since),
        supabase.from("child_apps").select("package, label").eq("child_id", childId),
      ]);
      setRows((u.data ?? []) as UsageRow[]);
      setLabels(Object.fromEntries(((a.data ?? []) as { package: string; label: string }[]).map((x) => [x.package, x.label])));
    })();
  }, [childId]);

  const addDays = (value: string, amount: number) => {
    const d = new Date(`${value}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() + amount);
    return d.toISOString().slice(0, 10);
  };
  const today = todayISO();
  const isoDow = (v: string) => ((new Date(`${v}T12:00:00Z`).getUTCDay() + 6) % 7); // 0 = Pzt
  // Gün / hafta / ay: ‹ › ile geriye gidilir (gelecek yok)
  const [offset, setOffset] = useState(0);
  useEffect(() => { setOffset(0); }, [range]);
  const monthOf = (k: number) => {
    const [y, m] = today.split("-").map(Number);
    const d = new Date(Date.UTC(y, m - 1 + k, 1, 12));
    const s0 = d.toISOString().slice(0, 10);
    const e = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0, 12)).toISOString().slice(0, 10);
    return [s0, e] as const;
  };
  const weekStart = addDays(today, -isoDow(today) + offset * 7);
  const [mS, mE] = monthOf(offset);
  const dayD = addDays(today, offset);
  const start = range === "day" ? dayD : range === "week" ? weekStart : range === "month" ? mS : (from <= to ? from : to);
  const end = range === "day" ? dayD : range === "week" ? addDays(weekStart, 6) : range === "month" ? mE : (from <= to ? to : from);
  const days: string[] = [];
  for (let d = start; d <= end && days.length < 366; d = addDays(d, 1)) days.push(d);
  const totals = days.map((d) => {
    const r = rows.filter((x) => x.day === d);
    return { d, total: r.reduce((a, x) => a + x.minutes, 0), counted: r.reduce((a, x) => a + x.counted_minutes, 0) };
  });
  const max = Math.max(60, ...totals.map((t) => t.total));
  const totalMinutes = totals.reduce((a, t) => a + t.total, 0);
  const countedMinutes = totals.reduce((a, t) => a + t.counted, 0);
  const pastDays = totals.filter((t) => t.d <= today);
  const avg = pastDays.length ? Math.round(totalMinutes / pastDays.length) : 0;
  const past = days.filter((d) => d <= today);
  const selectedDay = range === "day" ? dayD : past.includes(day) ? day : past[past.length - 1] ?? today;
  const dayRows = rows.filter((r) => r.day === selectedDay && r.minutes > 0).sort((a, b) => b.minutes - a.minutes);
  const dayMax = Math.max(1, ...dayRows.map((r) => r.minutes));
  // Kısa süre yazısı: 2:35 / 45 dk
  const compact = (m: number) => (m >= 60 ? `${Math.floor(m / 60)}:${String(m % 60).padStart(2, "0")}` : `${m} dk`);
  const fmt = (d: string, o: Intl.DateTimeFormatOptions) => new Date(`${d}T12:00:00Z`).toLocaleDateString("tr-TR", { timeZone: "UTC", ...o });
  const periodLabel =
    range === "day" ? fmt(dayD, { weekday: "long", day: "numeric", month: "long" }) :
    range === "week" ? `${fmt(start, { day: "numeric", month: "short" })} – ${fmt(end, { day: "numeric", month: "short" })}` :
    range === "month" ? fmt(mS, { month: "long", year: "numeric" }) : "";
  const canNext = offset < 0;
  const lead = isoDow(start);

  return (
    <div className="stack">
      <div className="card report-card">
        <h2>Rapor <Info>Koyu kısım günlük süreden düşen, açık kısım süre dışı kullanımdır.</Info></h2>
        <div className="seg report-seg">
          {([["day", "Gün"], ["week", "Hafta"], ["month", "Ay"], ["custom", "Özel"]] as const).map(([key, label]) => <button key={key} className={range === key ? "on" : ""} onClick={() => setRange(key)}>{label}</button>)}
        </div>
        {range === "custom" ? (
          <div className="grid2"><label className="field"><span>Başlangıç</span><DateField value={from} onChange={setFrom} /></label><label className="field"><span>Bitiş</span><DateField value={to} onChange={setTo} /></label></div>
        ) : (
          <div className="report-nav">
            <button className="icon-btn" aria-label="Önceki" onClick={() => setOffset((o) => o - 1)}>‹</button>
            <b>{periodLabel}</b>
            <button className="icon-btn" aria-label="Sonraki" disabled={!canNext} onClick={() => setOffset((o) => Math.min(0, o + 1))}>›</button>
          </div>
        )}
        <div className="report-stats">
          <div><b>{minutesText(totalMinutes)}</b><span>toplam</span></div>
          <div><b>{minutesText(countedMinutes)}</b><span>süreden düştü</span></div>
          {range !== "day" && <div><b>{minutesText(avg)}</b><span>günlük ort.</span></div>}
        </div>

        {range === "week" && (
          <div className="rw">
            {totals.map((t) => (
              <button key={t.d} className={`rw-col ${t.d === selectedDay ? "on" : ""} ${t.d > today ? "future" : ""}`} disabled={t.d > today} onClick={() => setDay(t.d)}>
                <span className="rw-val">{t.total ? compact(t.total) : ""}</span>
                <span className="rw-track">
                  <span className="rw-all" style={{ height: `${(t.total / max) * 100}%` }}>
                    <span className="rw-counted" style={{ height: t.total ? `${(t.counted / t.total) * 100}%` : 0 }} />
                  </span>
                </span>
                <span className="rw-day">{fmt(t.d, { weekday: "short" })}</span>
                <span className="rw-date">{Number(t.d.slice(8))}</span>
              </button>
            ))}
          </div>
        )}

        {(range === "month" || range === "custom") && (
          <div className="rc">
            {["Pzt", "Sal", "Çar", "Per", "Cum", "Cmt", "Paz"].map((w) => <span key={w} className="rc-head">{w}</span>)}
            {Array.from({ length: lead }, (_, i) => <span key={`b${i}`} />)}
            {totals.map((t) => {
              const lvl = t.total ? Math.min(1, t.total / max) : 0;
              return (
                <button key={t.d} className={`rc-cell ${t.d === selectedDay ? "on" : ""} ${t.d > today ? "future" : ""}`} disabled={t.d > today} onClick={() => setDay(t.d)}
                  style={{ background: lvl ? `color-mix(in srgb, var(--accent) ${Math.round(12 + lvl * 50)}%, var(--surface))` : undefined }}>
                  <span className="rc-date">{Number(t.d.slice(8))}{range === "custom" && (t.d === start || t.d.endsWith("-01")) ? ` ${fmt(t.d, { month: "short" })}` : ""}</span>
                  <span className="rc-val">{t.total ? compact(t.total) : ""}</span>
                </button>
              );
            })}
          </div>
        )}
      </div>
      <div className="card">
        <h2>{dateText(selectedDay)}</h2>
        {!dayRows.length && <p className="muted small">Bu gün için kayıt yok.</p>}
        {dayRows.map((r) => (
          <div className="ra-row" key={r.package}>
            <div className="ra-top">
              <b>{labels[r.package] ?? r.package}</b>
              <b>{minutesText(r.minutes)}</b>
            </div>
            <div className="ra-track"><span style={{ width: `${(r.minutes / dayMax) * 100}%` }}><i style={{ width: `${(r.counted_minutes / r.minutes) * 100}%` }} /></span></div>
            <div className="muted tiny">{r.counted_minutes ? `${minutesText(r.counted_minutes)} süreden düştü` : "süreden düşmedi"}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
