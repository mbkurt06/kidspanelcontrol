import { useCallback, useEffect, useMemo, useState } from "react";
import { DateField, TimeField } from "../components/DateTime";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useFamily } from "../lib/family";
import { errorText, supabase } from "../lib/supabase";
import { fromPatch, grantMinutes, insertGrant, nowPatch, sendCommand, type GrantPatch } from "../lib/actions";
import { dateText, hhmm, minutesText, relTime, todayISO } from "../lib/util";
import { GROUP_HINT, GROUP_LABEL, WEEKDAYS_LONG, type AppGroup, type Assignment, type ChildApp, type DayOverride, type Device, type ExtraTarget, type Section, type TimeGrant } from "../lib/types";
import { Icon } from "../components/Icon";
import TimerTab from "./TimerTab";
import { currentSectionFor, suggestGroup, timedPossible } from "../lib/sections";

type Tab = "apps" | "program" | "time" | "timer" | "report" | "device";

export default function ChildPage() {
  const { id } = useParams();
  const fam = useFamily();
  const child = fam.children.find((c) => c.id === id);
  const [tab, setTab] = useState<Tab>("apps");

  if (!child) return <div className="page"><p className="muted">Çocuk bulunamadı.</p></div>;

  return (
    <div className="page">
      <header className="page-head">
        <Link to="/" className="icon-btn" aria-label="Geri">
          <Icon name="back" />
        </Link>
        <h1>{child.name}</h1>
        <Link to="/rules/lock" className="btn small">
          🔒 Kilit
        </Link>
        <Link to={`/child/${child.id}/vault`} className="btn small">
          <Icon name="key" size={16} /> Şifreler
        </Link>
      </header>
      <ParentModeCard childId={child.id} />
      <div className="segmented">
        {(
          [
            ["apps", "Uygulamalar"],
            ["program", "Program"],
            ["time", "Süre"],
            ["timer", "Sayaç"],
            ["report", "Rapor"],
            ["device", "Telefon"],
          ] as [Tab, string][]
        ).map(([k, l]) => (
          <button key={k} className={tab === k ? "on" : ""} onClick={() => setTab(k)}>
            {l}
          </button>
        ))}
      </div>
      {tab === "apps" && <AppsTab childId={child.id} />}
      {tab === "program" && <ProgramTab childId={child.id} />}
      {tab === "time" && <TimeTab childId={child.id} />}
      {tab === "report" && <ReportTab childId={child.id} />}
      {tab === "timer" && <TimerTab childId={child.id} />}
      {tab === "device" && <DeviceTab childId={child.id} />}
    </div>
  );
}

// ---------------------------------------------------------------------------

/** Telefondaki Orbit'i hemen güncelle: telefon komutu alınca (≤30 sn) kurulum/version.json'a bakar ve yeni sürümü sessizce kurar. */
function UpdateCard({ childId, current }: { childId: string; current: string | null }) {
  const [latest, setLatest] = useState<number | null>(null);
  const [msg, setMsg] = useState("");
  useEffect(() => {
    fetch("/kurulum/version.json", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => setLatest(j?.version ?? null))
      .catch(() => {});
  }, []);
  const cur = current ? Number(current.split(".").pop()) : null;
  const behind = latest != null && cur != null && latest > cur;
  return (
    <div className="card">
      <h2>Orbit güncellemesi</h2>
      <p className="muted small">
        Telefondaki sürüm: {current ?? "?"}
        {latest != null && ` · en yeni: ${latest}`}
        {behind ? " — güncelleme var." : latest != null && cur != null ? " — güncel." : ""} Telefon saatte bir kendisi de bakar.
      </p>
      <button
        className="btn"
        onClick={async () => {
          try {
            await sendCommand(childId, "resync", { update: true });
            setMsg("Gönderildi. Telefon 30 sn içinde kontrol eder; varsa 1–2 dk içinde kurulur ve sürüm burada değişir.");
          } catch (e) {
            setMsg(errorText(e));
          }
        }}
      >
        Güncellemeyi şimdi kontrol et
      </button>
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
          <h2 style={{ margin: 0 }}>Ebeveyn modu{active ? " açık" : ""}</h2>
          <p className="muted small" style={{ margin: "4px 0 0" }}>
            {active
              ? `${until!.toLocaleTimeString("tr-TR", { hour: "2-digit", minute: "2-digit" })}'e kadar bütün sınırlamalar kalktı. Süre bitince kurallar kendiliğinden geri gelir.`
              : "Telefonda sen işlem yaparken bütün sınırlamaları kaldırır: tüm uygulamalar açık, süre sayılmaz, uygulama yükleme, ayarlar ve izinler serbest."}
          </p>
        </div>
        {active ? (
          <button className="btn" disabled={busy} onClick={stop}>
            Bitir
          </button>
        ) : (
          <div className="row gap-s">
            {[30, 60, 180].map((m) => (
              <button key={m} className="btn" disabled={busy} onClick={() => start(m)}>
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
          <h2>Onay bekleyen ({pending.length})</h2>
          <p className="muted small">
            Grubunu seç ve onayla. "Kurallara göre" uygulamalar grubunun bölüm kurallarına uyar. Onaylanmayan uygulama kapalı kalır.
          </p>
          {pending.map((a) => (
            <div className="app-row wrap" key={a.package}>
              <div className="grow">
                <b>{a.label}</b>
                <div className="muted tiny">{a.package}</div>
              </div>
              {groupSelect(pendingGroup[a.package] ?? fam.members[a.package] ?? suggestedId(a), (v) =>
                setPendingGroup((m) => ({ ...m, [a.package]: v }))
              )}
              <select value="" onChange={(e) => e.target.value && approve(a, e.target.value as Mode3)} aria-label="Onayla">
                <option value="">Onayla…</option>
                {(["rules", "always_open", "blocked"] as Mode3[]).map((m) => (
                  <option key={m} value={m}>
                    {MODE3_LABEL[m]}
                  </option>
                ))}
              </select>
            </div>
          ))}
        </div>
      )}
      {sections.map((g) => {
        const list = approved.filter((a) => (fam.members[a.package] ?? "") === g.id);
        if (!list.length) return null;
        return (
          <div className="card" key={g.id || "none"}>
            <h2>
              <span className="dot" style={{ background: g.color }} /> {g.name} <span className="muted small">· {list.length}</span>
            </h2>
            {list.map((a) => (
              <div className="app-row wrap" key={a.package}>
                <div className="grow">
                  <b>{a.label}</b>
                  <div className="muted tiny">{a.package}</div>
                </div>
                {groupSelect(fam.members[a.package] ?? "", (v) => setGroup(a.package, v))}
                <select value={mode3(a.app_group)} onChange={(e) => update(a, { app_group: fromMode3(e.target.value as Mode3) })} aria-label="Durum">
                  {(["rules", "always_open", "blocked"] as Mode3[]).map((m) => (
                    <option key={m} value={m}>
                      {MODE3_LABEL[m]}
                    </option>
                  ))}
                </select>
                {mode3(a.app_group) === "rules" && (
                  <input
                    className="mini"
                    type="number"
                    min={0}
                    placeholder="gün dk"
                    value={a.daily_limit_minutes ?? ""}
                    onChange={(e) => update(a, { daily_limit_minutes: e.target.value === "" ? null : Number(e.target.value) })}
                    aria-label="Bu uygulama için günlük üst sınır (dakika)"
                  />
                )}
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
      <div className="card">
        <h2>Haftalık program</h2>
        <p className="muted small">Her gün için bir gün tipi seç. Gün tiplerini (bölümler ve kurallar) Kurallar sekmesinden düzenleyebilirsin.</p>
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
      </div>

      <div className="card">
        <h2>Durumu şimdi başlat</h2>
        <p className="muted small">Örneğin "Oyun zamanı"nı programı beklemeden şimdi açabilirsin.</p>
        <div className="row gap-s wrap">
          <select value={modeId} onChange={(e) => setModeId(e.target.value)} className="grow">
            <option value="">Durum seç</option>
            {fam.modes.map((m) => (
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
      </div>

      <div className="card">
        <h2>Gün istisnaları</h2>
        <p className="muted small">Tek bir gün için başka profil veya farklı günlük süre (örneğin bayram günü 3 saat).</p>
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
            <DateField value={od.day} onChange={(v) => setOd({ ...od, day: v })} />
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
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

type When = "now" | "from" | "today" | "tomorrow" | "date" | "child" | "vault";

function TimeTab({ childId }: { childId: string }) {
  const fam = useFamily();
  const child = fam.children.find((c) => c.id === childId)!;
  const [grants, setGrants] = useState<TimeGrant[]>([]);
  const [minutes, setMinutes] = useState("20");
  const [when, setWhen] = useState<When>(child.extra_default === "wallet" ? "child" : child.extra_default === "now" ? "now" : "today");
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
    () => grants.filter((g) => !g.vault && ((g.valid_on && g.valid_on >= today) || g.activated_on === today)),
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
      if (when === "now") {
        const { patch, text } = await nowPatch(childId, m, fam);
        await insertGrant(childId, m, patch, note);
        setMsg(`${minutesText(m)} verildi · ${text}`);
      } else if (when === "from") {
        const day = fromDay === "today" ? today : todayISO("Europe/Berlin", 1);
        const { patch, text } = await fromPatch(childId, fam, day, start, endMode, until);
        await insertGrant(childId, m, patch, note);
        setMsg(`${minutesText(m)} verildi · ${dateText(day)} ${text}`);
      } else if (when === "vault") {
        await grantMinutes(childId, m, { validOn: null, vault: true, note: note || undefined });
        setMsg(`${minutesText(m)} süre kasasına kaydedildi`);
      } else {
        const validOn = when === "today" ? today : when === "tomorrow" ? todayISO("Europe/Berlin", 1) : when === "date" ? date : null;
        const sectionId = when === "child" ? null : target === "current" ? (when === "today" ? cur?.id ?? null : null) : target === "pool" ? null : target;
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

  async function saveDefault(v: ExtraTarget) {
    await supabase.from("children").update({ extra_default: v }).eq("id", childId);
    fam.reload();
  }

  async function saveWalletMax() {
    const v = walletMax.trim() === "" ? null : Math.max(0, Math.round(Number(walletMax)));
    const { error } = await supabase.from("children").update({ wallet_daily_max: v }).eq("id", childId);
    if (error) return setErr(errorText(error));
    setMsg(v == null ? "Cüzdan günlük sınırı kaldırıldı" : `Cüzdandan günde en fazla ${minutesText(v)}`);
    fam.reload();
  }

  const nowHint = curOpen
    ? `Şu an ${cur!.name} bölümü açık: süre bu bölüme eklenir, kalan süre hemen artar.`
    : `Şu an telefon kapalı saatlerde: şu andan itibaren ${minutes || "?"} dk açılır, sonra yine kapanır.`;

  const grantRow = (g: TimeGrant, kind: "wallet" | "vault") => (
    <div className="app-row wrap" key={g.id}>
      <div className="grow">
        <b>{minutesText(g.minutes)}</b>
        <div className="muted tiny">
          {g.note ?? (g.source === "task" ? "görev ödülü" : "ekstra süre")} · {dateText(g.created_at.slice(0, 10))}
          {kind === "wallet" && g.expires_on ? ` · son ${dateText(g.expires_on)}` : ""}
        </div>
      </div>
      <button className="btn small primary" onClick={() => setPlan({ g, where: "now" })}>
        Şimdi ver
      </button>
      <button className="btn small" onClick={() => setPlan({ g, where: "pool" })}>
        Planla
      </button>
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
      <div className="card">
        <h2>Ekstra süre ver</h2>
        <div className="row gap-s wrap">
          {["10", "15", "20", "30", "45", "60"].map((m) => (
            <button key={m} className={`chip ${minutes === m ? "on" : ""}`} onClick={() => setMinutes(m)}>
              {m} dk
            </button>
          ))}
          <input className="mini" type="number" min={1} value={minutes} onChange={(e) => setMinutes(e.target.value)} aria-label="Dakika" />
        </div>
        <label className="field">
          <span>Ne zaman</span>
          <select value={when} onChange={(e) => setWhen(e.target.value as When)}>
            <option value="now">Hemen kullansın</option>
            <option value="from">Belirli saatten itibaren</option>
            <option value="today">Bugün (bölüme / gün boyu)</option>
            <option value="tomorrow">Yarın</option>
            <option value="date">Belirli bir gün</option>
            <option value="child">Cüzdan: çocuk istediği gün kullansın</option>
            <option value="vault">Süre kasası: sonra ben veririm</option>
          </select>
        </label>
        {when === "now" && <p className="muted small">{nowHint}</p>}
        {when === "from" && (
          <>
            <div className="row gap-s wrap" style={{ alignItems: "center" }}>
              <select value={fromDay} onChange={(e) => setFromDay(e.target.value as typeof fromDay)} aria-label="Gün">
                <option value="today">Bugün</option>
                <option value="tomorrow">Yarın</option>
              </select>
              <span className="small">saat</span>
              <TimeField value={start} onChange={(v) => setStart(v)} label="Başlangıç" />
              <span className="small">'den itibaren</span>
            </div>
            <label className="field">
              <span>Ne zamana kadar kullanabilir</span>
              <select value={endMode} onChange={(e) => setEndMode(e.target.value as typeof endMode)}>
                <option value="open">Açık saatler bitene kadar</option>
                <option value="until">Belirli saate kadar</option>
                <option value="eod">Gün sonuna kadar</option>
              </select>
            </label>
            {endMode === "until" && <TimeField value={until} onChange={(v) => setUntil(v)} label="Bitiş" />}
            <p className="muted tiny">O saat gelince süre çocuğun kalan süresine eklenir. Bitiş saatine kadar kullanmazsa düşer. Kapalı saatlere denk gelirse o aralıkta telefon bu süre kadar açılır.</p>
          </>
        )}
        {when === "date" && (
          <div className="field">
            <span>Gün</span>
            <DateField value={date} onChange={(v) => setDate(v)} />
          </div>
        )}
        {(when === "today" || when === "tomorrow" || when === "date") && (
          <label className="field">
            <span>Nereye eklensin</span>
            <select value={target} onChange={(e) => setTarget(e.target.value)}>
              {when === "today" && <option value="current">Şu anki bölüm{cur ? ` (${cur.name})` : " (şu an bölüm yok → gün boyu)"}</option>}
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
          <div className="field">
            <span>Son kullanma (isteğe bağlı)</span>
            <DateField clearable value={expires} onChange={(v) => setExpires(v)} placeholder="Son kullanma yok" />
          </div>
        )}
        <label className="field">
          <span>Not</span>
          <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="İyi davrandın" />
        </label>
        {err && <p className="error">{err}</p>}
        {msg && <p className="ok">{msg}</p>}
        <button className="btn primary" onClick={give}>
          Süre ver
        </button>
        <button
          className="btn ghost"
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
          Bugünden {minutes} dk düş
        </button>
        <label className="field">
          <span>Ana sayfadaki +15 / +30 nereye gitsin</span>
          <select value={child.extra_default} onChange={(e) => saveDefault(e.target.value as ExtraTarget)}>
            <option value="now">Hemen kullansın</option>
            <option value="current">O anki bölüme</option>
            <option value="pool">Gün boyu</option>
            <option value="wallet">Cüzdana</option>
          </select>
        </label>
      </div>

      <div className="card">
        <h2>Çocuğun cüzdanı</h2>
        <p className="muted small">Cüzdandaki süreyi çocuk kendisi "bugün kullan" diyerek açabilir; sadece izin verilen (açık) saatlerde kullanılır.</p>
        {!wallet.length && <p className="muted small">Cüzdanda süre yok.</p>}
        {wallet.length > 0 && (
          <p>
            <b>Toplam {minutesText(wallet.reduce((a, g) => a + g.minutes, 0))}</b>
          </p>
        )}
        {wallet.map((g) => grantRow(g, "wallet"))}
        <div className="row gap-s wrap" style={{ alignItems: "center" }}>
          <span className="small">Günde en fazla</span>
          <input className="mini" type="number" min={0} placeholder="sınırsız" value={walletMax} onChange={(e) => setWalletMax(e.target.value)} aria-label="Cüzdan günlük sınır" />
          <span className="small">dk kullanabilsin</span>
          <button className="btn small" onClick={saveWalletMax}>
            Kaydet
          </button>
        </div>
      </div>

      <div className="card">
        <h2>Süre kasası</h2>
        <p className="muted small">Kasadaki süreyi çocuk kendisi kullanamaz. "Şimdi ver" ile hemen açarsın ya da bir güne / bölüme / saate planlarsın; istersen bir kısmını.</p>
        {!vault.length && <p className="muted small">Kasada süre yok.</p>}
        {vault.length > 0 && (
          <p>
            <b>Toplam {minutesText(vault.reduce((a, g) => a + g.minutes, 0))}</b>
          </p>
        )}
        {vault.map((g) => grantRow(g, "vault"))}
      </div>
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
      <div className="card">
        <h2>Verilen süreler</h2>
        {!live.length && <p className="muted small">Bekleyen ekstra süre yok.</p>}
        {live.map((g) => (
          <div className="app-row wrap" key={g.id}>
            <div className="grow">
              <b>{minutesText(g.minutes)}</b>
              <div className="muted tiny">
                {g.activated_on && !g.valid_on ? `cüzdandan · ${dateText(g.activated_on)}` : dateText(g.valid_on!)}
                {g.window_start ? ` · ${hhmm(g.window_start)}–${hhmm(g.window_end ?? "")} arası` : g.section_id ? ` · ${secName(g.section_id)}` : " · gün boyu"}
                {g.note ? ` · ${g.note}` : ""}
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
                  <option value="wallet">Cüzdana</option>
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
      </div>
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

  async function save() {
    setErr("");
    const m = Math.round(Number(minutes));
    if (!m || m < 1 || m > grant.minutes) return setErr(`1 ile ${grant.minutes} dk arası yaz.`);
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

  const dated = where !== "wallet" && where !== "now";
  return (
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
            <option value="window">Belirli saatten itibaren</option>
            <option value="pool">Gün boyu: süreli her bölümde</option>
            {sections.map((o) => (
              <option key={o.id} value={o.id}>
                {o.label}
              </option>
            ))}
            {!(!grant.vault && !grant.valid_on) && <option value="wallet">Çocuğun cüzdanına (kendisi kullansın)</option>}
          </select>
        </label>
        {where === "now" && <p className="muted tiny">Açık saatlerdeyse kalan süresine hemen eklenir; kapalı saatlerdeyse şu andan itibaren bu süre kadar telefon açılır.</p>}
        {dated && (
          <label className="field">
            <span>Hangi gün</span>
            <select value={day} onChange={(e) => setDay(e.target.value as typeof day)}>
              <option value="today">Bugün</option>
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
    </div>
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

  const load = useCallback(async () => {
    const { data } = await supabase.from("devices").select("*").eq("child_id", childId).order("created_at", { ascending: false });
    setDevices((data ?? []) as Device[]);
  }, [childId]);
  useEffect(() => {
    load();
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
        <h2>Telefonu eşleştir</h2>
        <p className="muted small">
          Orbit çocuğun telefonuna kurulunca eşleştirme kodunu ister. Kod 15 dakika geçerli ve tek kullanımlık.
        </p>
        {code ? (
          <div className="code">{code.slice(0, 4)} {code.slice(4)}</div>
        ) : (
          <button className="btn primary" onClick={newCode}>
            <Icon name="phone" size={18} /> Eşleştirme kodu al
          </button>
        )}
      </div>
      <UpdateCard childId={childId} current={devices[0]?.app_version ?? null} />

      <div className="card">
        <h2>Kuralları gönder</h2>
        <p className="muted small">Telefon kuralları zaten 30 saniyede bir alır; beklemek istemezsen hemen gönderir.</p>
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
                son görülme {relTime(d.last_seen_at)}
              </div>
            </div>
            {d.status === "active" ? (
              <button
                className="btn small danger-text"
                onClick={async () => {
                  if (!confirm("Bu telefonun bağlantısı kesilsin mi? Telefon kuralları almayı durdurur.")) return;
                  await supabase.from("devices").update({ status: "revoked" }).eq("id", d.id);
                  load();
                }}
              >
                Bağlantıyı kes
              </button>
            ) : (
              <span className="pill quiet">kesildi</span>
            )}
          </div>
        ))}
      </div>
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
            if (!confirm(`${child.name} ve tüm kayıtları silinsin mi? Bu geri alınamaz.`)) return;
            await supabase.from("children").delete().eq("id", childId);
            await fam.reload();
            nav("/");
          }}
        >
          Çocuğu sil
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
  const [day, setDay] = useState(todayISO());

  useEffect(() => {
    (async () => {
      const since = todayISO("Europe/Berlin", -6);
      const [u, a] = await Promise.all([
        supabase.from("usage_daily").select("day, package, minutes, counted_minutes").eq("child_id", childId).gte("day", since),
        supabase.from("child_apps").select("package, label").eq("child_id", childId),
      ]);
      setRows((u.data ?? []) as UsageRow[]);
      setLabels(Object.fromEntries(((a.data ?? []) as { package: string; label: string }[]).map((x) => [x.package, x.label])));
    })();
  }, [childId]);

  const days = Array.from({ length: 7 }, (_, i) => todayISO("Europe/Berlin", i - 6));
  const totals = days.map((d) => ({
    d,
    total: rows.filter((r) => r.day === d).reduce((a, r) => a + r.minutes, 0),
    counted: rows.filter((r) => r.day === d).reduce((a, r) => a + r.counted_minutes, 0),
  }));
  const max = Math.max(60, ...totals.map((t) => t.total));
  const dayRows = rows.filter((r) => r.day === day && r.minutes > 0).sort((a, b) => b.minutes - a.minutes);
  const short = (d: string) => new Date(d + "T12:00:00").toLocaleDateString("tr-TR", { weekday: "short" });

  return (
    <div className="stack">
      <div className="card">
        <h2>Son 7 gün</h2>
        <p className="muted tiny">Koyu kısım günlük süreden düşen kullanım, açık kısım süre dışı (sınırsız, her zaman açık, durumlar).</p>
        <div className="bars">
          {totals.map((t) => (
            <button key={t.d} className={`bar ${t.d === day ? "on" : ""}`} onClick={() => setDay(t.d)}>
              <span className="bar-val">{t.total ? minutesText(t.total) : ""}</span>
              <span className="bar-track">
                <span className="bar-all" style={{ height: `${(t.total / max) * 100}%` }}>
                  <span className="bar-counted" style={{ height: t.total ? `${(t.counted / t.total) * 100}%` : 0 }} />
                </span>
              </span>
              <span className="bar-day">{short(t.d)}</span>
            </button>
          ))}
        </div>
      </div>
      <div className="card">
        <h2>{dateText(day)}</h2>
        {!dayRows.length && <p className="muted small">Bu gün için kayıt yok.</p>}
        {dayRows.map((r) => (
          <div className="app-row" key={r.package}>
            <div className="grow">
              <b>{labels[r.package] ?? r.package}</b>
              <div className="muted tiny">{r.counted_minutes ? `${minutesText(r.counted_minutes)} süreden düştü` : "süreden düşmedi"}</div>
            </div>
            <b>{minutesText(r.minutes)}</b>
          </div>
        ))}
      </div>
    </div>
  );
}
