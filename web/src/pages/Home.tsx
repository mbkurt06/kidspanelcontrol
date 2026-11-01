import { useState } from "react";
import { Link } from "react-router-dom";
import { useFamily } from "../lib/family";
import { supabase, errorText } from "../lib/supabase";
import { quickGrant, seedDefaults, sendCommand } from "../lib/actions";
import { timerElapsed, timerRemaining } from "../lib/types";
import { minutesText, relTime } from "../lib/util";
import { Ring } from "../components/Ring";
import { Icon } from "../components/Icon";
import type { Child } from "../lib/types";

const COLORS = ["#4F7CFF", "#FF7A59", "#2BB673", "#C25BFF"];

export default function Home() {
  const fam = useFamily();

  if (fam.loading) return <div className="page"><p className="muted">Yükleniyor…</p></div>;
  if (!fam.children.length) return <Onboarding />;

  return (
    <div className="page">
      <header className="page-head">
        <h1>Orbit</h1>
        {fam.pendingApprovals > 0 && (
          <Link to="/tasks" className="pill accent">
            {fam.pendingApprovals} görev onay bekliyor
          </Link>
        )}
        {fam.pendingApprovals === 0 && fam.unreadEvents > 0 && (
          <Link to="/events" className="pill accent">
            {fam.unreadEvents} yeni olay
          </Link>
        )}
      </header>
      {!fam.profiles.length && <SeedCard />}
      <div className="stack">
        {fam.children.map((c) => (
          <ChildCard key={c.id} child={c} />
        ))}
      </div>
    </div>
  );
}

function ChildCard({ child }: { child: Child }) {
  const fam = useFamily();
  const st = fam.statuses[child.id];
  const [busy, setBusy] = useState("");
  const [msg, setMsg] = useState("");
  const stale = !st || Date.now() - new Date(st.updated_at).getTime() > 15 * 60000;

  async function run(key: string, fn: () => Promise<unknown>, ok: string | ((r: unknown) => string)) {
    setBusy(key);
    setMsg("");
    try {
      const r = await fn();
      setMsg(typeof ok === "function" ? ok(r) : ok);
      await fam.reload();
    } catch (e) {
      setMsg(errorText(e));
    }
    setBusy("");
  }

  return (
    <div className="card child-card">
      <Link to={`/child/${child.id}`} className="child-main">
        <Ring value={st?.remaining_minutes ?? 0} max={st?.allowance_minutes || 1} color={child.color}>
          <b>{st ? (st.remaining_minutes >= 1440 ? "∞" : minutesText(st.remaining_minutes)) : "—"}</b>
        </Ring>
        <div className="grow">
          <div className="row between">
            <h2>{child.name}</h2>
            <Icon name="chevron" size={18} />
          </div>
          {st ? (
            <>
              <p className="muted small">
                {minutesText(st.used_minutes)} kullandı
                {st.allowance_minutes < 1440 ? ` · hakkı ${minutesText(st.allowance_minutes)}` : " · süre sınırı yok"}
              </p>
              <div className="row wrap gap-s">
                {st.locked && <span className="pill danger">Kilitli{st.lock_reason ? ` · ${st.lock_reason}` : ""}</span>}
                {st.current_mode_name && <span className="pill">{st.current_mode_name}</span>}
                {fam.timers[child.id] && (
                  <span className="pill accent">
                    {fam.timers[child.id].icon ?? "⏱"} {fam.timers[child.id].title}
                    {fam.timers[child.id].status === "paused"
                      ? " · mola"
                      : timerRemaining(fam.timers[child.id]) != null
                        ? ` · ${Math.ceil((timerRemaining(fam.timers[child.id]) ?? 0) / 60)} dk kaldı`
                        : ` · ${Math.floor(timerElapsed(fam.timers[child.id]) / 60)} dk`}
                  </span>
                )}
                <span className={`pill ${stale ? "warn" : "quiet"}`}>{relTime(st.updated_at)}</span>
              </div>
            </>
          ) : (
            <p className="muted small">Telefon henüz eşleşmedi. Çocuğun sayfasından eşleştirme kodu al.</p>
          )}
        </div>
      </Link>
      <div className="actions">
        {st?.locked ? (
          <button className="btn" disabled={!!busy} onClick={() => run("unlock", () => sendCommand(child.id, "unlock"), "Kilit kaldırılıyor")}>
            <Icon name="unlock" size={18} /> Kilidi kaldır
          </button>
        ) : (
          <button className="btn" disabled={!!busy} onClick={() => run("lock", () => sendCommand(child.id, "lock"), "Telefon kilitleniyor")}>
            <Icon name="lock" size={18} /> Şimdi kilitle
          </button>
        )}
        <button className="btn" disabled={!!busy} onClick={() => run("15", () => quickGrant(child, 15, fam.sections), (r) => `+15 dk ${r} verildi`)}>
          +15 dk
        </button>
        <button className="btn" disabled={!!busy} onClick={() => run("30", () => quickGrant(child, 30, fam.sections), (r) => `+30 dk ${r} verildi`)}>
          +30 dk
        </button>
      </div>
      <Link to={`/messages/${child.id}`} className="btn ghost small">
        <Icon name="chat" size={16} /> {child.name}'e mesaj yaz
      </Link>
      {msg && <p className="small muted center">{msg}</p>}
    </div>
  );
}

function SeedCard() {
  const fam = useFamily();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  return (
    <div className="card soft">
      <h2>Başlangıç kuralları</h2>
      <p className="muted small">
        Hafta içi 1 sa 30 dk, hafta sonu 2 sa günlük süre; Ders, Dinlenme ve Uyku durumları; her gece uyku saati. Hepsini
        sonradan değiştirebilirsin.
      </p>
      {err && <p className="error">{err}</p>}
      <button
        className="btn primary"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          try {
            await seedDefaults(fam.familyId!, fam.children.map((c) => c.id));
            await fam.reload();
          } catch (e) {
            setErr(errorText(e));
          }
          setBusy(false);
        }}
      >
        Başlangıç kurallarını oluştur
      </button>
    </div>
  );
}

function Onboarding() {
  const fam = useFamily();
  const [names, setNames] = useState(["", ""]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  async function save() {
    const list = names.map((n) => n.trim()).filter(Boolean);
    if (!list.length) return;
    setBusy(true);
    setErr("");
    const { error } = await supabase
      .from("children")
      .insert(list.map((name, i) => ({ family_id: fam.familyId, name, color: COLORS[i % COLORS.length], sort_order: i })));
    if (error) setErr(errorText(error));
    else await fam.reload();
    setBusy(false);
  }

  return (
    <div className="page">
      <header className="page-head">
        <h1>Hoş geldin</h1>
      </header>
      <div className="card">
        <h2>Çocuklar</h2>
        <p className="muted small">Önce çocukların adlarını gir. Sonra her birinin telefonunu eşleştireceğiz.</p>
        {names.map((n, i) => (
          <label className="field" key={i}>
            <span>{i + 1}. çocuk</span>
            <input value={n} onChange={(e) => setNames(names.map((x, j) => (j === i ? e.target.value : x)))} placeholder="Ad" />
          </label>
        ))}
        <button className="link" onClick={() => setNames([...names, ""])}>
          + Bir çocuk daha
        </button>
        {err && <p className="error">{err}</p>}
        <button className="btn primary wide" disabled={busy} onClick={save}>
          Kaydet
        </button>
      </div>
    </div>
  );
}
