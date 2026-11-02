import { useCallback, useEffect, useState } from "react";
import { TimeField } from "../components/DateTime";
import { Link, useSearchParams } from "react-router-dom";
import { useFamily } from "../lib/family";
import { errorText, supabase } from "../lib/supabase";
import { sendCommand } from "../lib/actions";
import { mins, nowBerlin } from "../lib/sections";
import { relTime } from "../lib/util";
import { type Child, type KioskSettings } from "../lib/types";
import { Icon } from "../components/Icon";
import { Info } from "../components/Info";
import { RuleCard, ScreenPicker, WeekGrid, addRule } from "../components/RuleEditor";

const DEFAULT_KIOSK: KioskSettings = { message: null, screens: ["tasks", "messages", "music", "timer", "alarms"], calls: "emergency" };
export const kioskOf = (c: Child): KioskSettings => ({ ...DEFAULT_KIOSK, ...(c.kiosk_settings ?? {}) });

/** "now" | dakika | "until" saat → until_at (ISO) ya da null (süresiz) */
export function untilFrom(dur: string, until: string): string | null {
  if (dur === "none") return null;
  if (dur === "until") {
    const diff = (mins(until) - nowBerlin().minute + 1440) % 1440 || 1440;
    return new Date(Date.now() + diff * 60000).toISOString();
  }
  return new Date(Date.now() + Number(dur) * 60000).toISOString();
}

/** Kilitle (tam kilit) ya da Sınırla — elle, süreli. */
export async function lockNow(childId: string, kind: "kiosk" | "limit", untilAt: string | null, message?: string | null) {
  if (kind === "kiosk") await sendCommand(childId, "kiosk_start", { message: message || null }, untilAt);
  else await sendCommand(childId, "lock", {}, untilAt);
}

/** Elle ve programdaki kilidi kaldırır (Kilitle + Sınırla). */
export async function unlockNow(childId: string) {
  await sendCommand(childId, "kiosk_end", {});
  await sendCommand(childId, "unlock", {});
}

/** Kilit sayfası: şimdi kilitle, haftalık program, kilit ekranı, ana sayfa tuşu. */
export default function Lock({ embeddedChildId, inline = false }: { embeddedChildId?: string; inline?: boolean } = {}) {
  const fam = useFamily();
  const [params] = useSearchParams();
  const childParam = embeddedChildId ?? params.get("child");
  const [kid, setKid] = useState<string>(childParam ?? (fam.selectedChildId === "all" ? "all" : fam.selectedChildId));
  const [openRule, setOpenRule] = useState<string | null>(null);
  const [err, setErr] = useState("");
  const kinds = ["kiosk", "limit", "free"] as const;
  const shownChildren = fam.visibleChildren.filter((c) => !childParam || c.id === childParam);
  const rules = fam.timeRules.filter((r) => (kinds as readonly string[]).includes(r.kind) && (kid === "all" || !r.child_ids.length || r.child_ids.includes(kid)));

  async function add() {
    try {
      const id = await addRule(fam.familyId, "kiosk", kid === "all" ? null : kid, "Yeni kural", "21:00", "07:00", [1, 2, 3, 4, 5, 6, 7]);
      await fam.reload();
      setOpenRule(id);
    } catch (e) {
      setErr(errorText(e));
    }
  }

  return (
    <div className={embeddedChildId || inline ? "stack" : "page"}>
      {!embeddedChildId && !inline && <header className="page-head">
        <Link to="/rules" className="icon-btn" aria-label="Geri">
          <Icon name="back" />
        </Link>
        <h1>🔒 Kilit</h1>
        <span />
      </header>}
      {err && <p className="error">{err}</p>}
      <h2 className="section-title">Kilit <Info>Kilitle Orbit dışında her şeyi kapatır. Sınırla yalnızca her zaman açık uygulamalara izin verir. Serbest kural sınırları kaldırır.</Info></h2>

      <section className="stack">
        <h2 className="section-title">Şimdi</h2>
        {shownChildren.map((c) => (
          <NowCard key={c.id} child={c} onErr={setErr} />
        ))}
      </section>

      <details className="card section-collapse-card">
        <summary className="section-collapse-head"><span>Haftalık program <Info>Aynı saate iki kural denk gelirse güçlü olan geçerli: Kilitle → Sınırla → Serbest.</Info></span><span>⌄</span></summary>
        <div className="stack">
          <div className="row between">
            <span className="muted small">Kurallar</span>
            <button className="btn small" onClick={add}>
              <Icon name="plus" size={16} /> Kural
            </button>
          </div>
          <div className="row gap-xs wrap">
            <button className={`chip small ${kid === "all" ? "on" : ""}`} onClick={() => setKid("all")}>Hepsi</button>
            {shownChildren.map((c) => <button key={c.id} className={`chip small ${kid === c.id ? "on" : ""}`} onClick={() => setKid(c.id)}>{c.name}</button>)}
          </div>
          <div className="card">
            <WeekGrid
              rules={rules}
              onPick={(id) => {
                setOpenRule(id);
                setTimeout(() => document.getElementById(`rule-${id}`)?.scrollIntoView({ behavior: "smooth", block: "center" }), 50);
              }}
            />
          </div>
          {!rules.length && <p className="muted small">Henüz kural yok. "Kural" ile ekle.</p>}
          {rules.map((r) => <RuleCard key={r.id} r={r} kinds={["kiosk", "limit", "free"]} open={openRule === r.id} onToggle={() => setOpenRule(openRule === r.id ? null : r.id)} onErr={setErr} />)}
        </div>
      </details>

      <details className="card section-collapse-card">
        <summary className="section-collapse-head"><span>Kilit ekranı</span><span>⌄</span></summary>
        <div className="stack">{shownChildren.map((c) => <KioskLook key={c.id} child={c} onErr={setErr} />)}</div>
      </details>

      {!inline && <details className="card section-collapse-card">
        <summary className="section-collapse-head"><span>Ana sayfadaki kilit tuşu</span><span>⌄</span></summary>
        <LockButtonCard onErr={setErr} />
      </details>}
    </div>
  );
}

type Cmd = { type: string; until_at: string | null; created_at: string };

function NowCard({ child, onErr }: { child: Child; onErr: (e: string) => void }) {
  const fam = useFamily();
  const st = fam.statuses[child.id];
  const [last, setLast] = useState<Cmd | null>(null);
  const [dur, setDur] = useState("60");
  const [until, setUntil] = useState("19:00");
  const [msg, setMsg] = useState("");

  const load = useCallback(async () => {
    const { data } = await supabase
      .from("commands")
      .select("type,until_at,created_at")
      .eq("child_id", child.id)
      .in("type", ["kiosk_start", "kiosk_end", "lock", "unlock"])
      .is("cancelled_at", null)
      .order("created_at", { ascending: false })
      .limit(4);
    const list = (data ?? []) as Cmd[];
    // En son komut kilit ise ve süresi dolmadıysa elle kilit sürüyor
    const n = list[0];
    setLast(n && (n.type === "kiosk_start" || n.type === "lock") && (!n.until_at || Date.parse(n.until_at) > Date.now()) ? n : null);
  }, [child.id]);
  useEffect(() => {
    load();
  }, [load]);

  async function go(kind: "kiosk" | "limit") {
    onErr("");
    try {
      await lockNow(child.id, kind, untilFrom(dur, until), kioskOf(child).message);
      setMsg(kind === "kiosk" ? "Kilitleniyor…" : "Sınırlanıyor…");
      await load();
      setTimeout(() => fam.reload(), 5000);
    } catch (e) {
      onErr(errorText(e));
    }
  }
  async function release() {
    onErr("");
    try {
      await unlockNow(child.id);
      setMsg("Kaldırılıyor…");
      await load();
      setTimeout(() => fam.reload(), 5000);
    } catch (e) {
      onErr(errorText(e));
    }
  }

  const reason = st?.lock_reason ?? null;
  const state = reason?.startsWith("🔒") ? "🔒 Kilitli" : st?.locked ? "🌙 Sınırlı" : "Açık";
  return (
    <div className="card">
      <div className="row between">
        <b>
          <span className="dot" style={{ background: child.color, marginTop: 0 }} /> {child.name}
        </b>
        <span className={`pill ${state === "Açık" ? "quiet" : "danger"}`}>
          {state}
          {reason && state !== "Açık" ? ` · ${reason.replace("🔒 ", "")}` : ""}
        </span>
      </div>
      {last && (
        <p className="muted small">
          Elle {last.type === "kiosk_start" ? "kilit" : "sınırlama"} · {last.until_at ? `${new Date(last.until_at).toLocaleTimeString("tr-TR", { hour: "2-digit", minute: "2-digit" })}'e kadar` : "sen kaldırana kadar"} · {relTime(last.created_at)}
        </p>
      )}
      <div className="row gap-s wrap" style={{ alignItems: "center" }}>
        <select value={dur} onChange={(e) => setDur(e.target.value)} aria-label="Süre">
          <option value="15">15 dk</option>
          <option value="30">30 dk</option>
          <option value="60">1 saat</option>
          <option value="120">2 saat</option>
          <option value="until">Saate kadar</option>
          <option value="none">Ben kaldırana kadar</option>
        </select>
        {dur === "until" && <TimeField value={until} onChange={(v) => setUntil(v)} label="Bitiş" />}
      </div>
      <div className="row gap-s wrap">
        <button className="btn primary" onClick={() => go("kiosk")}>
          🔒 Kilitle
        </button>
        <button className="btn" onClick={() => go("limit")}>
          🌙 Sınırla
        </button>
        <button className="btn ghost" onClick={release}>
          Kaldır <Info>Elle verilen kilidi ve o an süren programlı kilidi/sınırlamayı bitirir.</Info>
        </button>
      </div>
      {msg && <p className="ok small">{msg}</p>}
    </div>
  );
}

function KioskLook({ child, onErr }: { child: Child; onErr: (e: string) => void }) {
  const fam = useFamily();
  const ks = kioskOf(child);
  const [m, setM] = useState(ks.message ?? "");
  async function save(v: Partial<KioskSettings>) {
    onErr("");
    const { error } = await supabase.from("children").update({ kiosk_settings: { ...ks, ...v } }).eq("id", child.id);
    if (error) onErr(errorText(error));
    fam.reload();
  }
  return (
    <div className="card">
      <b>{child.name}</b>
      <input value={m} onChange={(e) => setM(e.target.value)} onBlur={() => m !== (ks.message ?? "") && save({ message: m.trim() || null })} placeholder="Kilit ekranında mesaj (ör. Ders saati)" />
      <span className="small">Kilitliyken Orbit'te açık ekranlar <Info>Burada seçilen ekranlar telefon kilitliyken görülebilir.</Info></span>
      <ScreenPicker value={ks.screens} onChange={(v) => save({ screens: v })} />
      <label className="field">
        <span>Telefon aramaları</span>
        <select value={ks.calls} onChange={(e) => save({ calls: e.target.value as KioskSettings["calls"] })}>
          <option value="emergency">Sadece acil arama</option>
          <option value="all">Aramalar açık</option>
        </select>
      </label>
    </div>
  );
}

function LockButtonCard({ onErr }: { onErr: (e: string) => void }) {
  const fam = useFamily();
  const f = fam.family;
  if (!f) return null;
  async function save(v: Record<string, unknown>) {
    onErr("");
    const { error } = await supabase.from("families").update(v).eq("id", f!.id);
    if (error) onErr(errorText(error));
    fam.reload();
  }
  return (
    <div className="card">
      <h2>Ana sayfadaki kilit tuşu</h2>
      <label className="field">
        <span>Basınca</span>
        <select value={f.lock_button} onChange={(e) => save({ lock_button: e.target.value })}>
          <option value="kiosk">🔒 Kilitle</option>
          <option value="limit">🌙 Sınırla</option>
          <option value="ask">Her seferinde sor</option>
        </select>
      </label>
      <label className="field">
        <span>Ne kadar</span>
        <select value={f.lock_button_minutes ?? ""} onChange={(e) => save({ lock_button_minutes: e.target.value ? Number(e.target.value) : null })}>
          <option value="15">15 dk</option>
          <option value="30">30 dk</option>
          <option value="60">1 saat</option>
          <option value="120">2 saat</option>
          <option value="">Ben kaldırana kadar</option>
        </select>
      </label>
    </div>
  );
}
