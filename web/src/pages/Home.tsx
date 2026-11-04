import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useFamily } from "../lib/family";
import { supabase, errorText } from "../lib/supabase";
import { grantMinutes, insertGrant, nowPatch, seedDefaults, sendCommand } from "../lib/actions";
import { kioskOf, lockNow, unlockNow, untilFrom } from "./Lock";
import { currentSectionFor, hm, mins, nowBerlin, timedPossible } from "../lib/sections";
import { TimeField } from "../components/DateTime";
import { timerElapsed, timerRemaining } from "../lib/types";
import { hhmm, minutesText } from "../lib/util";
import { Ring } from "../components/Ring";
import { Icon } from "../components/Icon";
import { Info } from "../components/Info";
import type { Child, Section } from "../lib/types";

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
        {fam.visibleChildren.map((c) => (
          <ChildCard key={c.id} child={c} />
        ))}
      </div>
    </div>
  );
}

/** Basılı tutunca tekrarlayan düğme: önce tek adım, sonra hızlanarak seri artar/azalır. */
function useHold(fn: () => void) {
  const t = useRef<number | null>(null);
  const f = useRef(fn);
  f.current = fn;
  const stop = () => {
    if (t.current != null) window.clearTimeout(t.current);
    t.current = null;
  };
  useEffect(() => stop, []);
  const loop = (delay: number) => {
    t.current = window.setTimeout(() => {
      f.current();
      loop(Math.max(40, delay * 0.85));
    }, delay);
  };
  return {
    onPointerDown: (e: React.PointerEvent<HTMLButtonElement>) => {
      e.preventDefault();
      e.currentTarget.setPointerCapture?.(e.pointerId);
      f.current();
      stop();
      t.current = window.setTimeout(() => loop(120), 400);
    },
    onPointerUp: stop,
    onPointerCancel: stop,
    onLostPointerCapture: stop,
    onContextMenu: (e: React.MouseEvent) => e.preventDefault(),
    onKeyDown: (e: React.KeyboardEvent) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        f.current();
      }
    },
  };
}

type LockKind = "kiosk" | "limit" | string;

function ChildCard({ child }: { child: Child }) {
  const fam = useFamily();
  const st = fam.statuses[child.id];
  const [busy, setBusy] = useState("");
  const [msg, setMsg] = useState("");
  const [lockOpen, setLockOpen] = useState(false);
  const [lockKind, setLockKind] = useState<LockKind>("kiosk");
  const [lockDur, setLockDur] = useState("none");
  const [lockUntil, setLockUntil] = useState("19:00");
  const [give, setGive] = useState(0);
  const [giveText, setGiveText] = useState<string | null>(null);
  const [sec, setSec] = useState<Section | null>(null);
  const timer = fam.timers[child.id];

  useEffect(() => {
    currentSectionFor(child.id, fam.sections).then(setSec);
  }, [child.id, fam.sections, st?.updated_at]);

  const staleMin = st ? Math.floor((Date.now() - new Date(st.updated_at).getTime()) / 60000) : 0;
  // Telefonun bildirdiği durum
  const realKiosk = !!st?.lock_reason?.startsWith("🔒");
  const realLimited = !realKiosk && !!st?.locked;
  // Tuşa basınca ekran hemen değişir; telefon onaylayınca gerçek duruma geçilir (en fazla 20 sn bekler)
  const [pending, setPending] = useState<{ kind: "kiosk" | "limit" | "open"; at: number } | null>(null);
  const realKind = realKiosk ? "kiosk" : realLimited ? "limit" : "open";
  useEffect(() => {
    if (!pending) return;
    if (pending.kind === realKind) {
      setPending(null);
      return;
    }
    // Telefon onaylayana kadar sık yokla
    const iv = window.setInterval(() => {
      if (Date.now() - pending.at > 20000) {
        setPending(null);
        window.clearInterval(iv);
      } else fam.reload();
    }, 1500);
    return () => window.clearInterval(iv);
  }, [pending, realKind]); // eslint-disable-line react-hooks/exhaustive-deps
  const kiosk = pending ? pending.kind === "kiosk" : realKiosk;
  const limited = pending ? pending.kind === "limit" : realLimited;
  const waiting = !!pending;
  const unlimited = !!st && st.remaining_minutes >= 1440;
  const closed = !!st && !kiosk && !limited && st.remaining_minutes === 0 && st.allowance_minutes >= 1440;
  const finished = !!st && !kiosk && !limited && !closed && st.remaining_minutes === 0;
  const open = !!st && !kiosk && !limited && !closed && !finished;

  // Kapalıysa bir sonraki açık saat
  const nextOpen = (() => {
    const { minute } = nowBerlin();
    const timed = fam.sections.filter((x) => x.profile_id === sec?.profile_id && timedPossible(x, fam.sectionRules)).map((x) => mins(x.start_time)).sort((a, b) => a - b);
    const today = timed.find((m) => m > minute);
    if (today != null) return `${hm(today)}'de açılır`;
    return timed.length ? `Yarın ${hm(timed[0])}'de açılır` : null;
  })();

  async function run(key: string, fn: () => Promise<unknown>, ok: string | ((r: unknown) => string)) {
    setBusy(key);
    setMsg("");
    try {
      const r = await fn();
      setMsg(typeof ok === "function" ? ok(r) : ok);
      await fam.reload();
      // Telefon yeni kuralı birkaç saniyede alıp durumunu gönderir; halka o zaman güncellenir
      setTimeout(() => fam.reload(), 5000);
      setTimeout(() => fam.reload(), 12000);
    } catch (e) {
      setPending(null);
      setMsg(errorText(e));
    }
    setBusy("");
  }

  function applyLock() {
    const until =
      lockDur === "none" ? null : lockDur === "until" ? untilFrom("until", lockUntil) : new Date(Date.now() + Number(lockDur) * 60000).toISOString();
    setLockOpen(false);
    if (lockKind === "kiosk") {
      setPending({ kind: "kiosk", at: Date.now() });
      run("lock", () => lockNow(child.id, "kiosk", until, kioskOf(child).message), "");
    } else if (lockKind === "limit") {
      setPending({ kind: "limit", at: Date.now() });
      run("lock", () => lockNow(child.id, "limit", until), "");
    }
    else run("lock", () => sendCommand(child.id, "start_mode", { mode_id: lockKind }, until), "Profil uygulanıyor");
  }

  function giveTime() {
    const m = give;
    if (!m) return;
    run(
      "give",
      async () => {
        if (kiosk) {
          // Kilitliyken kilit açılmaz: süre kalan süreye eklenir, kilit kalkınca kullanır
          await grantMinutes(child.id, m, {});
          return "kalan süreye eklendi · kilit kalkınca kullanır";
        }
        const { patch, text } = await nowPatch(child.id, m, fam, { closed: limited || closed || finished });
        await insertGrant(child.id, m, patch);
        return text;
      },
      (r) => `+${minutesText(m)} · ${r}`
    );
    setGive(0);
    setGiveText(null);
  }
  const step = (d: number) => setGive((g) => Math.max(0, Math.min(600, g + d)));
  const holdUp = useHold(() => step(1));
  const holdDown = useHold(() => step(-1));

  // Halka içi
  const ringColor = kiosk ? "var(--bad)" : limited || closed ? "var(--warn)" : child.color;
  const ringInner = !st ? (
    <b>—</b>
  ) : kiosk ? (
    <span className="ring-state bad"><Icon name="lock" size={22} /><small>Kilitli</small></span>
  ) : limited || closed ? (
    <span className="ring-state warn"><span aria-hidden="true">☾</span><small>{limited ? "Sınırlı" : "Kapalı"}</small></span>
  ) : unlimited ? (
    <span className="ring-state"><b>∞</b><small>sınırsız</small></span>
  ) : (
    <span className="ring-state"><b>{minutesText(st.remaining_minutes)}</b><small>kaldı</small></span>
  );

  const stateLine = !st
    ? null
    : kiosk
      ? { cls: "bad", text: waiting && !realKiosk ? "Kilitli · telefona iletiliyor…" : `Kilitli · ${(st.lock_reason ?? "").replace("🔒", "").trim() || "sen kaldırana kadar"}` }
      : limited
        ? { cls: "warn", text: waiting && !realLimited ? "Sınırlı · telefona iletiliyor…" : `Sınırlı · ${st.lock_reason ?? ""}`.replace(/ · $/, "") }
        : closed
          ? { cls: "warn", text: [st.current_mode_name ?? "Kapalı saatler", nextOpen].filter(Boolean).join(" · ") }
          : finished
            ? { cls: "warn", text: `${st.current_mode_name ?? "Bugün"} · süresi bitti` }
            : { cls: "good", text: [st.current_mode_name ?? "Açık", sec && open ? `${hhmm(sec.end_time)}'e kadar` : null].filter(Boolean).join(" · ") };

  return (
    <div className="card child-card">
      <Link to={`/child/${child.id}`} className="child-main">
        <Ring value={open && !unlimited ? st!.remaining_minutes : kiosk || limited || closed ? 1 : 0} max={open && !unlimited ? st!.allowance_minutes || 1 : 1} color={ringColor} size={92}>
          {ringInner}
        </Ring>
        <div className="grow">
          <div className="row between">
            <h2>{child.name}</h2>
            <Icon name="chevron" size={18} />
          </div>
          {st ? (
            <>
              {stateLine && (
                <span className={`state-line ${stateLine.cls}`}>
                  <span className="state-dot" />
                  {stateLine.text}
                </span>
              )}
              {kiosk && st.remaining_minutes > 0 && st.remaining_minutes < 1440 && <span className="muted small">Kalan süresi {minutesText(st.remaining_minutes)} · kilit kalkınca kullanır</span>}
              <span className="muted small">Bugün {minutesText(st.used_minutes)} kullandı</span>
              {timer && (
                <span className="pill accent">
                  {timer.icon ?? "⏱"} {timer.title}
                  {timer.status === "paused"
                    ? " · mola"
                    : timerRemaining(timer) != null
                      ? ` · ${Math.ceil((timerRemaining(timer) ?? 0) / 60)} dk kaldı`
                      : ` · ${Math.floor(timerElapsed(timer) / 60)} dk`}
                </span>
              )}
            </>
          ) : (
            <p className="muted small">Telefon henüz eşleşmedi. Çocuğun sayfasından eşleştirme kodu al.</p>
          )}
        </div>
      </Link>

      <div className="card-actions">
        <button
          className={`btn grow ${lockOpen ? "on" : ""} ${kiosk ? "lock-on" : limited ? "limit-on" : ""}`}
          disabled={!!busy}
          onClick={() => {
            if (kiosk || limited) {
              setLockOpen(false);
              setPending({ kind: "open", at: Date.now() });
              run("unlock", () => unlockNow(child.id), "");
            } else setLockOpen(!lockOpen);
          }}
          aria-expanded={kiosk || limited ? undefined : lockOpen}
        >
          <Icon name={kiosk || limited ? "unlock" : "lock"} size={18} /> {kiosk || limited ? "Kilidi kaldır" : "Kilitle…"}
        </button>
        <div className="give-box">
          <button type="button" aria-label="1 dk azalt" disabled={give === 0} {...holdDown}>
            −
          </button>
          <input
            inputMode="numeric"
            aria-label="Verilecek dakika"
            value={giveText ?? String(give)}
            onFocus={(e) => {
              setGiveText(String(give));
              e.target.select();
            }}
            onChange={(e) => {
              const t = e.target.value.replace(/\D/g, "").slice(0, 3);
              setGiveText(t);
              setGive(Math.min(600, Number(t) || 0));
            }}
            onBlur={() => setGiveText(null)}
            onKeyDown={(e) => {
              if (e.key === "Enter") giveTime();
              if (e.key === "ArrowUp") { e.preventDefault(); setGiveText(null); step(1); }
              if (e.key === "ArrowDown") { e.preventDefault(); setGiveText(null); step(-1); }
            }}
          />
          <span className="give-unit">dk</span>
          <button type="button" aria-label="1 dk artır" {...holdUp}>
            +
          </button>
        </div>
        <button className="btn primary give-btn" disabled={!!busy || give === 0} onClick={giveTime}>
          Ver
        </button>
      </div>

      {lockOpen && (
        <div className="lock-panel">

          <div className="field">
            <span>Ne olsun</span>
            <select value={lockKind} onChange={(e) => setLockKind(e.target.value)}>
              <option value="kiosk">🔒 Kilitle — ekranda sadece Orbit</option>
              <option value="limit">🌙 Sınırla — sadece temel uygulamalar</option>
              {fam.modes.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <span>Ne kadar</span>
            <select value={lockDur} onChange={(e) => setLockDur(e.target.value)}>
              <option value="none">{lockKind === "kiosk" || lockKind === "limit" ? "Kilidi kaldırana kadar" : "Programa dönene kadar"}</option>
              <option value="15">15 dk</option>
              <option value="30">30 dk</option>
              <option value="60">1 saat</option>
              <option value="120">2 saat</option>
              <option value="until">Belirli saate kadar…</option>
            </select>
          </div>
          {lockDur === "until" && <TimeField value={lockUntil} onChange={setLockUntil} label="Bitiş saati" />}
          <div className="row gap-s">
            <button className="btn primary grow" disabled={!!busy} onClick={applyLock}>
              {lockKind === "kiosk" ? "Kilitle" : lockKind === "limit" ? "Sınırla" : "Uygula"}
            </button>
            <button className="btn ghost" onClick={() => setLockOpen(false)}>
              Vazgeç
            </button>
          </div>
        </div>
      )}

      <Link to={`/messages/${child.id}`} className="btn ghost small">
        <Icon name="chat" size={16} /> {child.name}'e mesaj yaz
      </Link>
      {st && staleMin > 15 && (
        <p className="small warn-text">⚠ Telefon {staleMin >= 60 ? `${Math.floor(staleMin / 60)} saattir` : `${staleMin} dakikadır`} bağlanmadı</p>
      )}
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
      <h2>Başlangıç kuralları <Info>Hafta içi ve hafta sonu süreleri, temel durumlar ve uyku saati oluşturulur; sonradan değiştirebilirsin.</Info></h2>
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
