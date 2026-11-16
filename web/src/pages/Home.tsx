import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Link } from "react-router-dom";
import { useFamily } from "../lib/family";
import { supabase, errorText } from "../lib/supabase";
import { giveNow, parentModeUntil, seedDefaults, sendCommand, stopParentMode } from "../lib/actions";
import { kioskOf, lockNow, unlockNow, untilFrom } from "./Lock";
import { currentSectionFor, hm, mins, nowBerlin, timedPossible } from "../lib/sections";
import { TimeField } from "../components/DateTime";
import { timerElapsed, timerRemaining } from "../lib/types";
import { hhmm, minutesText, todayISO } from "../lib/util";
import { Ring } from "../components/Ring";
import { Icon } from "../components/Icon";
import { Info } from "../components/Info";
import { MinuteStepper } from "../components/MinuteStepper";
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

const timeText = (iso: string) => new Date(iso).toLocaleTimeString("tr-TR", { hour: "2-digit", minute: "2-digit" });

function ChildCard({ child }: { child: Child }) {
  const fam = useFamily();
  const st = fam.statuses[child.id];
  const [busy, setBusy] = useState("");
  const [msg, setMsg] = useState("");
  const [lockOpen, setLockOpen] = useState(false);
  // Kilidi aç: geçici aç (ebeveyn modu, dakika seçilir) ya da tamamen kaldır (görev kilidi değilse)
  const [unlockOpen, setUnlockOpen] = useState(false);
  const [parentMin, setParentMin] = useState(5);
  const [extOpen, setExtOpen] = useState(false);
  const [extMin, setExtMin] = useState(30);
  // Açık ebeveyn modu (geçici açma): bitiş saati ve erken kapatma
  const [pmUntil, setPmUntil] = useState<Date | null>(null);
  const loadPm = async () => setPmUntil(await parentModeUntil(child.id));
  useEffect(() => {
    loadPm();
    const t = setInterval(loadPm, 30000);
    return () => clearInterval(t);
  }, [child.id]); // eslint-disable-line react-hooks/exhaustive-deps
  // Şu an süren saat aralıklı ekstra süre (kilit saatinde verilen süre dahil)
  const [extras, setExtras] = useState<{ id: string; minutes: number; window_start: string; window_end: string; use_mode: string | null; source: string | null; note: string | null }[]>([]);
  const loadExtras = async () => {
    const { data } = await supabase
      .from("time_grants")
      .select("id,minutes,window_start,window_end,use_mode,source,note")
      .eq("child_id", child.id)
      .eq("valid_on", todayISO())
      .eq("vault", false)
      .gt("minutes", 0)
      .not("window_start", "is", null);
    setExtras((data ?? []) as typeof extras);
  };
  useEffect(() => {
    loadExtras();
    const t = setInterval(loadExtras, 30000);
    return () => clearInterval(t);
  }, [child.id, st?.updated_at]); // eslint-disable-line react-hooks/exhaustive-deps
  const [lockKind, setLockKind] = useState<LockKind>("kiosk");
  const [lockDur, setLockDur] = useState("open");
  const [lockUntil, setLockUntil] = useState("19:00");
  const [give, setGive] = useState(0);
  const [giveText, setGiveText] = useState<string | null>(null);
  const [sec, setSec] = useState<Section | null>(null);
  const timer = fam.timers[child.id];

  useEffect(() => {
    currentSectionFor(child.id, fam.sections).then(setSec);
  }, [child.id, fam.sections, st?.updated_at]);

  const staleMin = st ? Math.floor((Date.now() - new Date(st.updated_at).getTime()) / 60000) : 0;
  // Bağlantı: yeşil = son 4 dk (telefon değişiklik yoksa 3 dk'da bir bildirir), sarı = 4–15 dk, gri = daha uzun
  const conn = !st ? null : staleMin < 4 ? "on" : staleMin < 15 ? "idle" : "off";
  const [showSeen, setShowSeen] = useState(false);
  // Telefonun bildirdiği durum
  const realKiosk = !!st?.lock_reason?.startsWith("🔒");
  // Kilit bir görevden mi ("Önce görev: Ödev")
  const taskLock = (st?.lock_reason ?? "").replace("🔒", "").trim().match(/^Önce görev:\s*(.+)$/)?.[1] ?? null;
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
  // Elle kilit için: bir sonraki açık saatlerin başlangıcı (bugün ya da yarın)
  const nextOpenStart = (() => {
    const { minute } = nowBerlin();
    const st0 = fam.sections.filter((x) => x.profile_id === sec?.profile_id && x.default_rule !== "blocked" && timedPossible(x, fam.sectionRules)).map((x) => mins(x.start_time)).sort((a, b) => a - b);
    const m = st0.find((v) => v > minute) ?? st0[0];
    return m == null ? null : hm(m);
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

  /** Geçici açma: saat gibi akan süre; bitince (ya da "Kaldığı yerden") telefon kilitlendiği sebebe döner */
  async function tempUnlock(minutes: number) {
    const reason = taskLock ? `Görev: ${taskLock}` : (st?.lock_reason ?? "").replace("🔒", "").trim() || "Kilit";
    const { minute } = nowBerlin();
    const { error } = await supabase.from("time_grants").insert({
      child_id: child.id, minutes, valid_on: todayISO(), source: "manual", note: `Geçici açma · ${reason}`,
      window_start: hm(minute), window_end: hm(Math.min(minute + minutes, 1439)), use_mode: "clock", to_vault: false, vault: false,
    });
    if (error) throw error;
    await loadExtras();
    return `${minutesText(minutes)} geçici açıldı · sonra yine ${reason}`;
  }
  /** Süren geçici açmanın bitişini ileri alır (yeni açma eklemez) */
  async function extendTemp(add: number) {
    if (!tempOpen) return "Geçici açma bitmiş";
    const end = Math.min(tempOpen.end + add, 1439);
    const { error } = await supabase.from("time_grants").update({ window_end: hm(end), minutes: Math.max(1, end - tempOpen.start) }).eq("id", tempOpen.id);
    if (error) throw error;
    await sendCommand(child.id, "resync", {});
    await loadExtras();
    return `Geçici açma ${hm(end)}'e kadar uzatıldı`;
  }
  async function resumeLock() {
    if (pmActive && !tempOpen) {
      await stopParentMode(child.id);
      setPmUntil(null);
      return "Ebeveyn modu kapandı · kilit kaldığı yerden sürüyor";
    }
    if (!tempOpen) return "";
    const { error } = await supabase.from("time_grants").update({ minutes: 0, settled_at: new Date().toISOString() })
      .eq("child_id", child.id).eq("source", "manual").eq("valid_on", todayISO()).like("note", "Geçici açma%").is("settled_at", null);
    if (error) throw error;
    await sendCommand(child.id, "resync", {});
    await loadExtras();
    return `Kilit kaldığı yerden sürüyor · ${tempOpen.reason}`;
  }

  function applyLock() {
    if (lockKind === "resume") {
      setLockOpen(false);
      setPending({ kind: "kiosk", at: Date.now() });
      run("lock", resumeLock, (r) => String(r));
      return;
    }
    const what = lockKind === "kiosk" ? "kilitlensin" : lockKind === "limit" ? "sınırlansın" : "profili başlasın";
    if (!confirm(`${child.name} ${what} mı?`)) return;
    const until =
      lockDur === "none" ? null
      : lockDur === "until" ? untilFrom("until", lockUntil)
      : lockDur === "midnight" ? untilFrom("until", "00:00")
      : lockDur === "open" ? (nextOpenStart ? untilFrom("until", nextOpenStart) : untilFrom("until", "00:00"))
      : new Date(Date.now() + Number(lockDur) * 60000).toISOString();
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
        // Kilitliyse kalan süreye eklenir; sınırlı / kapalı / bitmişse Kurallar'daki ayara göre açılır
        return giveNow(child.id, m, fam, st, { kiosk, limited: limited || closed || finished });
      },
      (r) => `+${minutesText(m)} · ${r}`
    );
    setGive(0);
    setGiveText(null);
  }
  const step = (d: number) => setGive((g) => Math.max(0, Math.min(600, g + d)));
  const holdUp = useHold(() => step(1));
  const holdDown = useHold(() => step(-1));

  // Halkaya dokununca büyük çark açılır; çevirerek süre eklenir / düşülür, "Uygula" ile onaylanır
  const [dialOpen, setDialOpen] = useState(false);
  const [dial, setDial] = useState(0);
  const remainingNow = st && open && !unlimited ? st.remaining_minutes : 0;
  function applyDial() {
    const d = dial;
    if (!d) return;
    setDial(0);
    if (d > 0) {
      run("give", async () => giveNow(child.id, d, fam, st, { kiosk, limited: limited || closed || finished }), (r) => `+${minutesText(d)} · ${r}`);
    } else {
      // Önce bugün verilen ekstra süreler sunucuda geri alınır (telefon çevrimdışı olsa da); artan kısım telefona komut olarak gider
      run(
        "give",
        async () => {
          const { data, error } = await supabase.rpc("parent_reduce_time", { p_child: child.id, p_minutes: -d });
          if (error) throw error;
          const rest = Number(data ?? 0);
          if (rest > 0) await sendCommand(child.id, "adjust_minutes", { minutes: -rest });
          fam.reload();
          return rest === -d ? "telefona iletildi" : rest > 0 ? `ekstra süre geri alındı · ${minutesText(rest)} telefona iletildi` : "ekstra süre geri alındı";
        },
        (r) => `−${minutesText(-d)} · ${r}`
      );
    }
  }

  // Halka içi
  const extraNow = (() => {
    const { minute } = nowBerlin();
    let total = 0;
    let end: string | null = null;
    let task = true;
    for (const g of extras) {
      const a = mins(g.window_start), b = g.window_end.startsWith("23:59") ? 1440 : mins(g.window_end);
      if (minute < a || minute >= b) continue;
      const usedMin = st?.grant_used?.[g.id] ?? 0; // telefon dakika olarak bildirir
      const left = g.use_mode === "clock" ? b - minute : Math.min(g.minutes - usedMin, b - minute);
      if (left <= 0) continue;
      total += left;
      end = end ?? (g.use_mode === "clock" ? hm(Math.min(b, 1439)) : null);
      task = task && g.source === "task";
    }
    return total > 0 ? { left: total, end, task } : null;
  })();
  /** Geçici açma sürüyor mu: kalan dakika ve kilidin sebebi */
  const tempOpen = (() => {
    const { minute } = nowBerlin();
    let best: { id: string; left: number; reason: string; start: number; end: number } | null = null;
    for (const g of extras) {
      if (g.source !== "manual" || !g.note?.startsWith("Geçici açma")) continue;
      const a = mins(g.window_start), b = g.window_end.startsWith("23:59") ? 1440 : mins(g.window_end);
      if (minute >= a && minute < b && (!best || b > best.end)) best = { id: g.id, left: b - minute, reason: g.note.replace(/^Geçici açma · /, ""), start: a, end: b };
    }
    return best;
  })();
  const pmActive = !!pmUntil && pmUntil.getTime() > Date.now();
  /** Halkada tek sayı: telefonun bildirdiği, o an kullanabileceği toplam süre (görev/ekstra süreler dahil) */
  const extraLive = !!extraNow && !kiosk && !waiting;
  const shownLeft = st?.remaining_minutes ?? 0;
  const ringColor = kiosk ? "var(--bad)" : extraLive ? child.color : limited || closed ? "var(--warn)" : child.color;
  const ringInner = !st ? (
    <b>—</b>
  ) : kiosk ? (
    <span className="ring-state bad"><Icon name="lock" size={22} /><small>Kilitli</small></span>
  ) : extraLive ? (
    <span className="ring-state"><b>{minutesText(shownLeft)}</b><small>kaldı</small></span>
  ) : limited || closed ? (
    <span className="ring-state warn"><span aria-hidden="true">☾</span><small>{limited ? "Sınırlı" : "Kapalı"}</small></span>
  ) : unlimited ? (
    <span className="ring-state"><b>∞</b><small>sınırsız</small></span>
  ) : (
    <span className="ring-state"><b>{minutesText(st.remaining_minutes)}</b><small>kaldı</small></span>
  );

  const stateLine = !st
    ? null
    : tempOpen && !waiting && !kiosk
      ? { cls: "good", text: `🔓 Geçici açık · ${minutesText(tempOpen.left)} kaldı · sonra: 🔒 ${tempOpen.reason}` }
      : kiosk
      ? { cls: "bad", text: waiting && !realKiosk ? "Kilitli · telefona iletiliyor…" : `Kilitli · ${(st.lock_reason ?? "").replace("🔒", "").trim() || "sen kaldırana kadar"}` }
      : limited
        ? { cls: "warn", text: waiting && !realLimited ? "Sınırlı · telefona iletiliyor…" : `Sınırlı · ${st.lock_reason ?? ""}`.replace(/ · $/, "") }
        : closed
          ? { cls: "warn", text: [st.current_mode_name ?? "Kapalı saatler", nextOpen].filter(Boolean).join(" · ") }
          : finished
            ? { cls: "warn", text: [st.current_mode_name ?? "Bugün", sec ? `${hhmm(sec.end_time)}'e kadar` : null].filter(Boolean).join(" · ") }
            : { cls: "good", text: [st.current_mode_name ?? "Açık", sec && open ? `${hhmm(sec.end_time)}'e kadar` : null].filter(Boolean).join(" · ") };

  return (
    <div className="card child-card">
      <Link to={`/child/${child.id}`} className="child-main">
        <span
          className="dial"
          role="button"
          aria-label="Süreyi çarkla ayarla"
          onClick={(e) => { e.preventDefault(); e.stopPropagation(); if (st) { setDial(0); setDialOpen(true); } }}
        >
          <Ring value={extraLive ? shownLeft : open && !unlimited ? st!.remaining_minutes : kiosk || limited || closed ? 1 : 0} max={extraLive ? Math.max(shownLeft + st!.used_minutes, 1) : open && !unlimited ? Math.max(st!.allowance_minutes, st!.remaining_minutes + st!.used_minutes, 1) : 1} color={ringColor} size={66}>
            {ringInner}
          </Ring>
        </span>
        <div className="grow">
          <div className="row between name-row">
            <h2>{child.name}</h2>
              {conn && (
                <span
                  role="button"
                  tabIndex={0}
                  className={`conn-dot ${conn}`}
                  aria-label={conn === "on" ? "Telefon bağlı" : conn === "idle" ? "Telefon birkaç dakikadır sessiz" : "Telefon bağlı değil"}
                  title={`Son bağlantı ${timeText(st!.updated_at)}`}
                  onClick={(e) => { e.preventDefault(); e.stopPropagation(); setShowSeen(!showSeen); }}
                />
              )}
            <Icon name="chevron" size={18} />
          </div>
          {showSeen && st && (
            <span className="muted tiny">Son bağlantı {timeText(st.updated_at)} ({staleMin < 1 ? "az önce" : `${staleMin} dk önce`})</span>
          )}
          {st ? (
            <>
              {stateLine && (
                <span className={`state-line ${stateLine.cls}`}>
                  <span className="state-ico" aria-hidden>🕘</span>
                  {stateLine.text}
                  {tempOpen && !kiosk && (
                    <button type="button" className="pill-btn small" style={{ marginLeft: 6 }} disabled={!!busy}
                      onClick={(e) => { e.preventDefault(); e.stopPropagation(); setExtMin(30); setExtOpen(true); }}>＋ Uzat</button>
                  )}
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

      <div className="card-divider" />
      {pmUntil && pmUntil.getTime() > Date.now() && (
        <div className="row gap-s pm-row" style={{ alignItems: "center" }}>
          <span className="grow small">🛠 Ebeveyn modu açık · {pmUntil.toLocaleTimeString("tr-TR", { hour: "2-digit", minute: "2-digit" })}'e kadar <span className="muted tiny">· bitince kilitler kaldığı yerden sürer</span></span>
          <button className="pill-btn" disabled={!!busy} onClick={() => run("unlock", async () => { await stopParentMode(child.id); setPmUntil(null); return "Ebeveyn modu kapatıldı"; }, (r) => String(r))}>
            Kapat
          </button>
        </div>
      )}
      <div className="card-actions">
        <div className="lock-wrap">
          <button
            className={`pill-btn ${lockOpen ? "on" : ""} ${kiosk ? "lock-on" : limited ? "limit-on" : ""}`}
            disabled={!!busy}
            onClick={() => {
              if (kiosk || limited) {
                setLockOpen(false);
                setUnlockOpen(true);
              } else {
                if (!lockOpen && (tempOpen || pmActive)) setLockKind("resume");
                else if (!lockOpen && lockKind === "resume") setLockKind("kiosk");
                setLockOpen(!lockOpen);
              }
            }}
            aria-expanded={kiosk || limited ? undefined : lockOpen}
          >
            <Icon name={kiosk || limited ? "unlock" : "lock"} size={15} /> {kiosk || limited ? "Kilidi aç" : "Kilitle"}
          </button>
          {unlockOpen && createPortal(
            <>
              <div className="pop-backdrop sheet-like" onClick={() => setUnlockOpen(false)} />
              <div className="lock-pop sheet-pop" role="dialog" aria-label="Kilidi aç">
                <b className="sheet-pop-title">{child.name}</b>
                <p className="small" style={{ margin: 0 }}>
                  🔒 <b>Neden kilitli:</b> {taskLock ? `Görev: ${taskLock}` : (st?.lock_reason ?? "").replace("🔒", "").trim() || "Telefon kilitli"}
                </p>
                {!taskLock && (
                  <>
                    <button
                      className="pill-btn primary"
                      disabled={!!busy}
                      onClick={() => {
                        setUnlockOpen(false);
                        setPending({ kind: "open", at: Date.now() });
                        run("unlock", () => unlockNow(child.id), "");
                      }}
                    >
                      🔓 Kilidi tamamen kaldır
                    </button>
                    <p className="muted small" style={{ margin: 0 }}>Elle kilit biter, telefon programa döner (açık saatse açık, kapalı saatse kapalı).</p>
                  </>
                )}
                {tempOpen && (
                  <button className="pill-btn" onClick={() => { setUnlockOpen(false); setExtMin(30); setExtOpen(true); }}>
                    🔓 Geçici açık · {hm(Math.min(tempOpen.end, 1439))}'e kadar · ＋ Uzat
                  </button>
                )}
                <span className="pop-label">⏱ GEÇİCİ AÇ <Info>Telefon bu süre boyunca normal açık saat gibi çalışır. Süre dolunca (telefon kapalı ya da internetsiz olsa da) aynı sebepten yine kilitlenir (elle kilit dahil). Beklemeden kilitlemek için “Kilitle → Kaldığı yerden devam et”.</Info></span>
                <div className="row gap-s" style={{ alignItems: "center" }}>
                  <MinuteStepper value={parentMin} onChange={setParentMin} min={1} max={240} step={1} label="Geçici açma süresi" />
                  <button
                    className="pill-btn primary"
                    disabled={!!busy}
                    onClick={() => {
                      setUnlockOpen(false);
                      setPending({ kind: "open", at: Date.now() });
                      run("unlock", () => tempUnlock(parentMin), (r) => String(r));
                    }}
                  >
                    Aç
                  </button>
                </div>
                <button
                  className="pill-btn ghost"
                  disabled={!!busy}
                  onClick={() => {
                    setUnlockOpen(false);
                    run("unlock", async () => {
                      await sendCommand(child.id, "resync", { maintenance: true }, new Date(Date.now() + parentMin * 60000).toISOString());
                      await loadPm();
                      return `🛠 Ebeveyn modu ${minutesText(parentMin)} açık`;
                    }, (r) => String(r));
                  }}
                >
                  🛠 Ebeveyn modu ({minutesText(parentMin)})
                </button>
                <div className="pop-actions">
                  <button className="pill-btn ghost" onClick={() => setUnlockOpen(false)}>Vazgeç</button>

                </div>
              </div>
            </>,
            document.body
          )}
          {extOpen && tempOpen && createPortal(
            <>
              <div className="pop-backdrop sheet-like" onClick={() => setExtOpen(false)} />
              <div className="lock-pop sheet-pop" role="dialog" aria-label="Geçici açmayı uzat">
                <b className="sheet-pop-title">{child.name} · Geçici açmayı uzat</b>
                <p className="small" style={{ margin: 0 }}>Şu an: {hm(Math.min(tempOpen.end, 1439))}'e kadar</p>
                <div className="chips">
                  {[15, 30, 60, 120].map((d) => (
                    <button key={d} className={`chip-btn ${extMin === d ? "on" : ""}`} onClick={() => setExtMin(d)}>+{d >= 60 ? `${d / 60} sa` : d}</button>
                  ))}
                </div>
                <MinuteStepper value={extMin} onChange={setExtMin} min={1} max={600} step={1} label="Uzatma" />
                <p className="muted small" style={{ margin: 0 }}>
                  → Yeni bitiş: {hm(Math.min(tempOpen.end + extMin, 1439))}{tempOpen.end + extMin > 1439 ? " (gün sonu)" : ""} · sonra yine 🔒 {tempOpen.reason}
                </p>
                <div className="pop-actions">
                  <button className="pill-btn ghost" onClick={() => setExtOpen(false)}>Vazgeç</button>
                  <button className="pill-btn primary" disabled={!!busy} onClick={() => { setExtOpen(false); run("unlock", () => extendTemp(extMin), (r) => String(r)); }}>Uzat</button>
                </div>
              </div>
            </>,
            document.body
          )}
          {lockOpen && createPortal(
            <>
              <div className="pop-backdrop sheet-like" onClick={() => setLockOpen(false)} />
              <div className="lock-pop sheet-pop" role="dialog" aria-label="Kilit">
                <b className="sheet-pop-title">{child.name}</b>
                <span className="pop-label">NE OLSUN</span>
                <div className="chips">
                  {[
                    ...(tempOpen ? [{ id: "resume", name: `🔁 Kaldığı yerden devam et: ${tempOpen.reason}` }] : pmActive ? [{ id: "resume", name: "🔁 Kaldığı yerden devam et (ebeveyn modunu kapat)" }] : []),
                    { id: "kiosk", name: "Kilitle" },
                    { id: "limit", name: "Sınırla" },
                    ...fam.modes.filter((m) => !m.builtin).map((m) => ({ id: m.id, name: m.name.replace(/ zamanı$/i, "") })),
                  ].map((o) => (
                    <button key={o.id} className={`chip-btn ${lockKind === o.id ? "on" : ""}`} onClick={() => setLockKind(o.id)}>
                      {o.name}
                    </button>
                  ))}
                </div>
                {lockKind === "resume" && <p className="muted small" style={{ margin: 0 }}>Geçici açma hemen biter, telefon kilitlendiği sebebe geri döner.</p>}
                {lockKind !== "resume" && <span className="pop-label">NE KADAR</span>}
                <div className="chips" hidden={lockKind === "resume"}>
                  {[
                    ["open", `Açık saatler başlayana kadar${nextOpenStart ? ` (${nextOpenStart})` : ""}`],
                    ["midnight", "Gece yarısına kadar"],
                    ["none", lockKind === "kiosk" || lockKind === "limit" ? "Ben kaldırana kadar" : "Programa dönene kadar"],
                    ["15", "15 dk"],
                    ["30", "30 dk"],
                    ["60", "1 sa"],
                    ["120", "2 sa"],
                    ["until", "Saate kadar…"],
                  ].map(([k, l]) => (
                    <button key={k} className={`chip-btn ${lockDur === k ? "on" : ""}`} onClick={() => setLockDur(k)}>
                      {l}
                    </button>
                  ))}
                </div>
                {lockKind !== "resume" && lockDur === "none" && (lockKind === "kiosk" || lockKind === "limit") && <p className="muted small" style={{ margin: 0 }}>Kendiliğinden bitmez. Geçici açınca süre bitiminde yine kilitlenir; tamamen açmak için “Kilidi aç → Kilidi tamamen kaldır”.</p>}
                {lockKind !== "resume" && lockDur === "until" && <TimeField value={lockUntil} onChange={setLockUntil} label="Bitiş saati" />}
                <div className="pop-actions">
                  <button className="pill-btn ghost" onClick={() => setLockOpen(false)}>
                    Vazgeç
                  </button>
                  <button className="pill-btn primary" disabled={!!busy} onClick={applyLock}>
                    {lockKind === "kiosk" || lockKind === "resume" ? "Kilitle" : lockKind === "limit" ? "Sınırla" : "Uygula"}
                  </button>
                </div>
              </div>
            </>,
            document.body
          )}
        </div>
        <span className="grow" />
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
        <button className="pill-btn primary" disabled={!!busy || give === 0} onClick={giveTime}>
          Ver
        </button>
        <Link to={`/messages/${child.id}`} className="icon-pill" aria-label={`${child.name}'e mesaj yaz`} title="Mesaj yaz">
          <Icon name="chat" size={16} />
        </Link>
      </div>
      {dialOpen && createPortal(
        <DialSheet
          name={child.name}
          remaining={remainingNow}
          showRemaining={open && !unlimited}
          value={dial}
          onChange={setDial}
          onClose={() => { setDialOpen(false); setDial(0); }}
          onApply={() => { setDialOpen(false); applyDial(); }}
        />,
        document.body
      )}
      {st && staleMin > 15 && (
        <p className="small warn-text">⚠ Telefon {staleMin >= 60 ? `${Math.floor(staleMin / 60)} saattir` : `${staleMin} dakikadır`} bağlanmadı</p>
      )}
      {st && staleMin <= 15 && st.power_exempt === false && (
        <p className="small warn-text">⚠ Telefonda Orbit pil optimizasyonunda · ekran kapalıyken değişiklikler gecikebilir (telefonda Orbit'i açıp “İzin ver” de)</p>
      )}
      {st && staleMin <= 15 && st.power_exempt !== false && st.live === false && (
        <p className="small muted">Canlı bağlantı kapalı · değişiklikler 30 sn içinde gelir</p>
      )}
      {msg && <p className="small muted center">{msg}</p>}
    </div>
  );
}

/** Büyük süre çarkı: tam tur 60 dk, her çentik 1 dk; saat yönü artırır, ters yönü azaltır (kalan sürenin altına inmez). */
function DialSheet({ name, remaining, showRemaining, value, onChange, onClose, onApply }: {
  name: string; remaining: number; showRemaining: boolean; value: number;
  onChange: (v: number) => void; onClose: () => void; onApply: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const drag = useRef<{ last: number; acc: number; base: number } | null>(null);
  const clamp = (v: number) => Math.max(-remaining, Math.min(600, v));
  const angle = (x: number, y: number) => {
    const r = ref.current!.getBoundingClientRect();
    return (Math.atan2(y - (r.top + r.height / 2), x - (r.left + r.width / 2)) * 180) / Math.PI;
  };
  const S = 260, C = S / 2, R = 108;
  const circ = 2 * Math.PI * R;
  const frac = Math.min(Math.abs(value), 60) / 60;
  const knobA = ((value % 60) * 6 * Math.PI) / 180;
  const ticks = Array.from({ length: 60 }, (_, i) => {
    const a = (i * 6 * Math.PI) / 180, r1 = i % 5 ? R - 7 : R - 13, r2 = R + 6;
    return <line key={i} x1={C + r1 * Math.sin(a)} y1={C - r1 * Math.cos(a)} x2={C + r2 * Math.sin(a)} y2={C - r2 * Math.cos(a)} stroke="var(--muted)" strokeWidth={i % 5 ? 1 : 2} opacity={0.6} />;
  });
  return (
    <>
      <div className="pop-backdrop sheet-like" onClick={onClose} />
      <div className="lock-pop sheet-pop dial-sheet" role="dialog" aria-label="Süre çarkı">
        <div className="row between">
          <b className="sheet-pop-title">{name} · süre ayarla</b>
          <button className="icon-btn" aria-label="Kapat" onClick={onClose}><Icon name="x" size={18} /></button>
        </div>
        <div
          ref={ref}
          className="dial-big"
          onPointerDown={(e) => { drag.current = { last: angle(e.clientX, e.clientY), acc: 0, base: value }; e.currentTarget.setPointerCapture(e.pointerId); }}
          onPointerMove={(e) => {
            const d = drag.current; if (!d) return;
            const a = angle(e.clientX, e.clientY);
            let x = a - d.last; if (x > 180) x -= 360; if (x < -180) x += 360;
            d.last = a; d.acc += x;
            const n = clamp(d.base + Math.trunc(d.acc / 6));
            if (n !== value) { try { navigator.vibrate?.(4); } catch { /* */ } onChange(n); }
          }}
          onPointerUp={() => { drag.current = null; }}
          onPointerCancel={() => { drag.current = null; }}
        >
          <svg width={S} height={S} viewBox={`0 0 ${S} ${S}`}>
            <circle cx={C} cy={C} r={R} fill="none" stroke="var(--line)" strokeWidth={18} />
            {ticks}
            <circle cx={C} cy={C} r={R} fill="none" stroke={value < 0 ? "var(--bad)" : "var(--good)"} strokeWidth={18} strokeLinecap="round"
              strokeDasharray={`${circ * frac} ${circ}`} transform={value < 0 ? `rotate(-90 ${C} ${C}) scale(1,-1) translate(0,-${S})` : `rotate(-90 ${C} ${C})`} />
            <circle cx={C + R * Math.sin(knobA)} cy={C - R * Math.cos(knobA)} r={15} fill="var(--surface)" stroke="var(--text)" strokeWidth={2} />
          </svg>
          <div className="dial-center">
            <b>{value > 0 ? "+" : value < 0 ? "−" : ""}{minutesText(Math.abs(value))}</b>
            {showRemaining && <span className="muted small">kalan {minutesText(remaining)} → {minutesText(Math.max(0, remaining + value))}</span>}
            <span className="muted tiny">çevir: sağa + · sola −</span>
          </div>
        </div>
        <div className="chips center-chips">
          {[-5, 5, 15, 30, 60].map((d) => (
            <button key={d} className="chip-btn" disabled={d < 0 && value + d < -remaining} onClick={() => onChange(clamp(value + d))}>{d > 0 ? "+" : "−"}{d === 60 ? "1 sa" : Math.abs(d)}</button>
          ))}
        </div>
        <div className="row gap-xs">
          <button className="pill-btn grow" onClick={onClose}>Vazgeç</button>
          <button className="pill-btn primary grow" disabled={!value} onClick={onApply}>✓ Uygula</button>
        </div>
      </div>
    </>
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
