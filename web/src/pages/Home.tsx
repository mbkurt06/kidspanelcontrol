import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Link } from "react-router-dom";
import { useFamily } from "../lib/family";
import { supabase, errorText } from "../lib/supabase";
import { giveNow, parentModeUntil, seedDefaults, sendCommand, stopParentMode } from "../lib/actions";
import { kioskOf, lockNow, unlockNow, untilFrom } from "./Lock";
import { EXT_NOTE, extendOpenToday, isoAtAbs, openUntil, setOpenEnd, setTempEnd, undoExtendOpen } from "../lib/openness";
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
  const [pmUntil, setPmUntil] = useCached<Date | null>(`${child.id}:pm`, null);
  const loadPm = async () => setPmUntil(await parentModeUntil(child.id));
  useEffect(() => {
    loadPm();
    const t = setInterval(loadPm, 30000);
    return () => clearInterval(t);
  }, [child.id]); // eslint-disable-line react-hooks/exhaustive-deps
  // Şu an süren saat aralıklı ekstra süre (kilit saatinde verilen süre dahil)
  const [extras, setExtras] = useCached<{ id: string; minutes: number; window_start: string; window_end: string; use_mode: string | null; source: string | null; note: string | null; orig_window_end?: string | null }[]>(`${child.id}:extras`, []);
  const loadExtras = async () => {
    const { data } = await supabase
      .from("time_grants")
      .select("id,minutes,window_start,window_end,use_mode,source,note,orig_window_end")
      .eq("child_id", child.id)
      .eq("valid_on", todayISO())
      .eq("vault", false)
      .gt("minutes", 0)
      .not("window_start", "is", null);
    setExtras((data ?? []) as typeof extras);
    // Gece yarısını geçen açma: yarının 00:00'dan başlayan parçası (bitişi doğru göstermek için)
    const { data: nx } = await supabase.from("time_grants").select("window_end").eq("child_id", child.id)
      .eq("valid_on", todayISO("Europe/Berlin", 1)).eq("source", "manual").like("note", "Geçici açma%").eq("window_start", "00:00:00").is("settled_at", null).limit(1);
    setTempNext((nx?.[0] as { window_end: string } | undefined)?.window_end?.slice(0, 5) ?? null);
  };
  useEffect(() => {
    loadExtras();
    const t = setInterval(loadExtras, 30000);
    return () => clearInterval(t);
  }, [child.id, st?.updated_at]); // eslint-disable-line react-hooks/exhaustive-deps
  // Telefona henüz ulaşmamış değişiklikler: telefonun son bildiriminden sonra verilen süreler + onaylanmamış komutlar
  const [pend, setPend] = useCached<{ give: number; kind: "kiosk" | "limit" | "open" | null; count: number; items: { text: string; at: string }[] }>(`${child.id}:pend`, { give: 0, kind: null, count: 0, items: [] });
  const loadPend = async () => {
    if (!st) return;
    const [g, c] = await Promise.all([
      supabase.from("time_grants").select("id,minutes,carry_to,note,vault,window_start,window_end,valid_on,created_at").eq("child_id", child.id).gt("created_at", st.updated_at).is("settled_at", null),
      supabase.from("commands").select("type,payload,created_at").eq("child_id", child.id).is("acked_at", null).is("cancelled_at", null).gt("created_at", new Date(Date.now() - 36 * 3600e3).toISOString()).order("created_at"),
    ]);
    type G = { id: string; minutes: number; carry_to: string | null; note: string | null; vault: boolean; window_start: string | null; window_end: string | null; valid_on: string | null; created_at: string };
    const rows = (g.data ?? []) as G[];
    const carry = new Set(rows.map((r) => r.carry_to).filter(Boolean));
    let give = 0, count = 0, kind: "kiosk" | "limit" | "open" | null = null, kAt = "";
    const items: { text: string; at: string }[] = [];
    const nowM = nowBerlin().minute;
    for (const r of rows) {
      if (r.note?.startsWith("Geçici açma")) {
        const a = r.window_start ? mins(r.window_start) : 0, b = r.window_end ? (r.window_end.startsWith("23:59") ? 1440 : mins(r.window_end)) : 0;
        if (r.valid_on === todayISO() && nowM >= a && nowM < b && r.created_at > kAt && !r.note.includes("uzatıldı")) { kind = "open"; kAt = r.created_at; count++; items.push({ text: "🔓 Kilit açma", at: r.created_at }); }
        continue;
      }
      if (r.vault || carry.has(r.id) || r.minutes <= 0) continue;
      give += r.minutes;
      count++;
      items.push({ text: `⏱ +${minutesText(r.minutes)} süre verildi`, at: r.created_at });
    }
    for (const x of (c.data ?? []) as { type: string; payload: { minutes?: number; reason?: string } | null; created_at: string }[]) {
      if (x.type === "resync") {
        const r = Number((x.payload as { reduced?: number } | null)?.reduced ?? 0);
        if (r > 0) { give -= r; count++; items.push({ text: `⏱ −${minutesText(r)} süre düşüldü`, at: x.created_at }); }
        continue;
      }
      if (x.type === "adjust_minutes") { const m = Number(x.payload?.minutes ?? 0); give += m; count++; items.push({ text: `⏱ ${m >= 0 ? "+" : "−"}${minutesText(Math.abs(m))} süre ${m >= 0 ? "verildi" : "düşüldü"}`, at: x.created_at }); continue; }
      if (x.type === "kiosk_start" && x.payload?.reason === "shorten") continue;
      const k = x.type === "kiosk_start" ? "kiosk" : x.type === "lock" ? "limit" : x.type === "kiosk_end" || x.type === "unlock" ? "open" : null;
      if (k && x.created_at >= kAt) { kind = k; kAt = x.created_at; count++; }
      if (k) items.push({ text: k === "kiosk" ? "🔒 Kilitleme" : k === "limit" ? "Sınırlama" : "🔓 Kilit açma", at: x.created_at });
    }
    items.sort((a, b) => a.at.localeCompare(b.at));
    setPend({ give, kind, count, items });
  };
  useEffect(() => {
    loadPend();
    const t = setInterval(loadPend, 20000);
    return () => clearInterval(t);
  }, [child.id, st?.updated_at, busy]); // eslint-disable-line react-hooks/exhaustive-deps
  const [lockKind, setLockKind] = useState<LockKind>("kiosk");
  const [lockDur, setLockDur] = useState("open");
  const [lockMin, setLockMin] = useState(45);
  const [uDur, setUDur] = useState("closed");
  const [xOpen, setXOpen] = useState(false);
  const [ringMenuOpen, setRingMenuOpen] = useState(false);
  const [pendOpen, setPendOpen] = useState(false);
  const [infoOpen, setInfoOpen] = useState(false);
  const [tempNext, setTempNext] = useCached<string | null>(`${child.id}:tempNext`, null);
  const [dialThen, setDialThen] = useState<"none" | "unlock" | "time" | "lock">("none");
  const [pendingGive, setPendingGive] = useState(0);
  const [xDur, setXDur] = useState("60");
  const [xMin, setXMin] = useState(75);
  const [xMinM, setXMinM] = useState(45);
  const [xUntil, setXUntil] = useState("22:30");
  const [xAll, setXAll] = useState(false);
  const [uMin, setUMin] = useState(45);
  const [uUntil, setUUntil] = useState("19:30");
  const [uDate, setUDate] = useState(() => todayISO("Europe/Berlin", 1));
  const [uDateTime, setUDateTime] = useState("08:00");
  const [lockDate, setLockDate] = useState(() => todayISO("Europe/Berlin", 1));
  const [lockDateTime, setLockDateTime] = useState("08:00");
  const [lockRun, setLockRun] = useState("");
  const [openRuns, setOpenRuns] = useState<{ id: string; title: string; mandatory: boolean }[]>([]);
  const [manualLock, setManualLock] = useCached<{ id: string; until: string | null; runs: string[]; from: string | null } | null>(`${child.id}:manualLock`, null);
  const [lockUntil, setLockUntil] = useState("19:00");
  const [give, setGive] = useState(0);
  const [giveText, setGiveText] = useState<string | null>(null);
  const [sec, setSec] = useCached<Section | null>(`${child.id}:sec`, null);
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
  // Telefon kapalıyken yapılan kilit / açma: panel hemen yeni durumu gösterir (⏳ iletilmedi)
  const offKind = pend.kind && pend.kind !== realKind ? pend.kind : null;
  // Geçici açma az önce bitti ama telefon henüz yeni durumu bildirmedi: "21:00'e kadar açık" yerine kilitleniyor göster
  const tempEnded = (() => {
    if (!st || realKiosk || realLimited || pending || offKind) return false;
    const bm = (iso: string) => { const [h, m] = new Date(iso).toLocaleTimeString("en-GB", { timeZone: "Europe/Berlin", hour: "2-digit", minute: "2-digit", hour12: false }).split(":").map(Number); return (h % 24) * 60 + m; };
    const nowM = nowBerlin().minute;
    const stM = bm(st.updated_at);
    return extras.some((g) => {
      if (!g.note?.startsWith("Geçici açma") || g.note.includes("uzatıldı") || !g.window_end || g.window_end.startsWith("23:59")) return false;
      const e = mins(g.window_end);
      return nowM >= e && nowM - e < 3 && stM < e;
    });
  })();
  const kiosk = pending ? pending.kind === "kiosk" : offKind ? offKind === "kiosk" : tempEnded || realKiosk;
  const limited = pending ? pending.kind === "limit" : offKind ? offKind === "limit" : realLimited;
  const waiting = !!pending || !!offKind || tempEnded;
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
  const secNameAt = (startHm: string | null, closedKind: boolean) => {
    if (!startHm) return null;
    const x = fam.sections.find((y) => y.profile_id === sec?.profile_id && mins(y.start_time) === mins(startHm) && (closedKind ? (y.default_rule === "blocked" || !timedPossible(y, fam.sectionRules)) : timedPossible(y, fam.sectionRules)));
    return x?.name ?? null;
  };
  const nextClosedStart = (() => {
    const { minute } = nowBerlin();
    const st0 = fam.sections.filter((x) => x.profile_id === sec?.profile_id && (x.default_rule === "blocked" || !timedPossible(x, fam.sectionRules))).map((x) => mins(x.start_time)).sort((a, b) => a - b);
    const m = st0.find((v) => v > minute) ?? st0[0];
    return m == null ? null : hm(m);
  })();
  // Kilit penceresi açılınca bugünün bitmemiş görevleri
  useEffect(() => {
    if (!lockOpen) return;
    supabase.from("task_runs").select("id, status, task:tasks(title, mandatory)").eq("child_id", child.id).eq("day", todayISO())
      .in("status", ["open", "started", "submitted", "rejected"])
      .then(({ data }) => {
        const rs = ((data ?? []) as unknown as { id: string; task: { title: string; mandatory: boolean } | null }[])
          .map((x) => ({ id: x.id, title: x.task?.title ?? "Görev", mandatory: !!x.task?.mandatory }));
        setOpenRuns(rs);
        setLockRun((v) => (rs.some((x) => x.id === v) ? v : rs[0]?.id ?? ""));
      });
  }, [lockOpen, child.id]);
  // Elle kilidin ne zamana kadar sürdüğü (kartta gösterilir)
  useEffect(() => {
    supabase.from("commands").select("id, type, payload, until_at, created_at").eq("child_id", child.id).in("type", ["kiosk_start", "kiosk_end"]).is("cancelled_at", null)
      .order("created_at", { ascending: false }).limit(1)
      .then(({ data }) => {
        const c = data?.[0] as { id: string; type: string; payload: { until_runs?: string[]; from_at?: string } | null; until_at: string | null } | undefined;
        if (!c || c.type !== "kiosk_start" || (c.until_at && new Date(c.until_at).getTime() < Date.now())) setManualLock(null);
        else setManualLock({ id: c.id, until: c.until_at, runs: c.payload?.until_runs ?? [], from: c.payload?.from_at ?? null });
      });
  }, [child.id, st?.updated_at]);

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
  /** Belirli bir zamana kadar geçici aç: gün gün aralıklar (gece yarısını geçerse ertesi günlere bölünür) */
  async function tempUntil(endIso: string) {
    const reason = taskLock ? `Görev: ${taskLock}` : kiosk ? ((st?.lock_reason ?? "").replace("🔒", "").trim() || "Tam kilit") : limited ? "Sınırlı" : "Kapalı saat";
    await openUntil(child.id, endIso, reason, openEndToday);
    await loadExtras();
    return `🔓 ${untilText(endIso)} açık · sonra yine ${reason}`;
  }
  function unlockPlan(): { end: string | null; text: string } {
    const plus = (m: number) => new Date(Date.now() + m * 60000).toISOString();
    switch (uDur) {
      case "full": return { end: null, text: "Elle kilit biter, telefon programa döner (açık saatse açık, kapalı saatse kapalı)." };
      case "closed": { const u = untilFrom("until", nextClosedStart ?? "00:00"); return { end: u, text: `🔓 ${untilText(u)} açık` }; }
      case "midnight": { const u = untilFrom("until", "00:00"); return { end: u, text: `🔓 ${untilText(u)} açık` }; }
      case "morning": { const u = untilFrom("until", "07:00"); return { end: u, text: `🔓 ${untilText(u)} açık` }; }
      case "min": { const u = plus(uMin); return { end: u, text: `🔓 ${untilText(u)} açık` }; }
      case "until": { const u = untilFrom("until", uUntil); return { end: u, text: `🔓 ${untilText(u)} açık` }; }
      case "date": { const d = new Date(`${uDate}T${uDateTime}:00`); return isNaN(d.getTime()) ? { end: "", text: "Tarih seç" } : { end: d.toISOString(), text: `🔓 ${untilText(d.toISOString())} açık` }; }
      default: { const u = plus(Number(uDur)); return { end: u, text: `🔓 ${untilText(u)} açık` }; }
    }
  }
  const extended = extras.filter((g) => g.orig_window_end);
  const openSecToday = fam.sections.filter((x) => x.profile_id === sec?.profile_id && timedPossible(x, fam.sectionRules) && mins(x.end_time) > mins(x.start_time)).sort((a, b) => mins(b.end_time) - mins(a.end_time))[0] ?? null;
  // Bugünkü açık saatlerin (süreli bölümlerin) programdaki bitişi
  const openEndToday = (() => {
    const e = fam.sections.filter((x) => x.profile_id === sec?.profile_id && timedPossible(x, fam.sectionRules) && mins(x.end_time) > mins(x.start_time)).map((x) => mins(x.end_time));
    return e.length ? hm(Math.max(...e)) : null;
  })();
  const extWin = extras.find((g) => g.note === EXT_NOTE);
  const shortenAt = manualLock?.from && new Date(manualLock.from).getTime() > Date.now() ? (() => {
    const [h, m] = new Date(manualLock.from!).toLocaleTimeString("en-GB", { timeZone: "Europe/Berlin", hour: "2-digit", minute: "2-digit", hour12: false }).split(":").map(Number);
    return (h % 24) * 60 + m;
  })() : null;
  // Şu an açık bir bölümdeyse telefon, arka arkaya gelen açık bölümlerin sonunda kapanır
  // (ör. 06:40–06:50 Serbest, sonra kapalı: 21:00 değil 06:50)
  const runEnd = (() => {
    if (!sec || !(timedPossible(sec, fam.sectionRules) || sec.default_rule === "open")) return null;
    const same = fam.sections.filter((x) => x.profile_id === sec.profile_id);
    let end = mins(sec.end_time);
    if (end <= mins(sec.start_time)) return null;
    for (let guard = 0; guard < 24; guard++) {
      const next = same.find((x) => mins(x.start_time) === end && mins(x.end_time) > end && (timedPossible(x, fam.sectionRules) || x.default_rule === "open"));
      if (!next) break;
      end = mins(next.end_time);
    }
    return end;
  })();
  const dayOpenEnd = openEndToday ? (runEnd != null && runEnd < mins(openEndToday) ? runEnd : mins(openEndToday)) : null;
  const baseEnd = extWin ? (extWin.window_end.startsWith("23:59") ? 1439 : mins(extWin.window_end)) : shortenAt != null ? shortenAt : dayOpenEnd != null ? dayOpenEnd : sec ? mins(sec.end_time) : nowBerlin().minute;
  /** ⏰ hedef bitiş: bugünün 00:00'ından dakika (1440+ = yarın) */
  function extendPlan(): { end: string | null; abs: number; text: string } {
    const now = nowBerlin().minute;
    const b = xMode === "open" ? baseEnd : xBase;
    let abs: number;
    switch (xDur) {
      case "-15": case "-30": case "-60": abs = Math.max(b + Number(xDur), now + 1); break;
      case "min": abs = b + xMin; break;
      case "minus": abs = Math.max(b - xMinM, now + 1); break;
      case "until": { const m = mins(xUntil); abs = m > now ? m : m + 1440; break; }
      case "midnight": abs = 1440; break;
      default: abs = b + Number(xDur);
    }
    abs = Math.min(abs, 1440 + 720);
    const end = abs >= 1440 ? `yarın ${hm(abs - 1440)}` : hm(abs);
    return { end: abs === 1440 ? "gece yarısı" : end, abs, text: "" };
  }
  function applyExtend() {
    const p = extendPlan();
    if (p.abs <= nowBerlin().minute) { alert("Bitiş saati geçmiş."); return; }
    setXOpen(false);
    if (xMode === "lock" && manualLock) {
      run("lock", async () => {
        const iso = isoAtAbs(p.abs);
        const { error } = await supabase.from("commands").update({ until_at: iso }).eq("id", manualLock.id);
        if (error) throw error;
        await sendCommand(child.id, "resync", {});
        setManualLock({ ...manualLock, until: iso });
        return giveAfter(`🔒 Kilit ${untilText(iso)}`);
      }, (r) => String(r));
      return;
    }
    if (xMode === "temp" && tempOpen) {
      run("unlock", async () => {
        const note = extras.find((g) => g.id === tempOpen.id)?.note ?? `Geçici açma · ${tempOpen.reason}`;
        if (note === EXT_NOTE && openEndToday) await setOpenEnd(child.id, p.abs, openEndToday);
        else await setTempEnd(child.id, note, p.abs, openEndToday);
        await loadExtras();
        return giveAfter(`🔓 ${p.end}'e kadar açık`);
      }, (r) => String(r));
      return;
    }
    if (!openEndToday) { alert("Bugün için açık saat bulunamadı."); return; }
    const ids = xAll ? fam.children.map((c) => c.id) : [child.id];
    run("give", async () => {
      for (const id of ids) await setOpenEnd(id, p.abs, openEndToday);
      await loadExtras();
      return giveAfter(`⏰ Bugün açık saatler ${p.end}'e kadar${ids.length > 1 ? " (hepsi)" : ""}`);
    }, (r) => String(r));
  }
  function applyUnlock() {
    const p = unlockPlan();
    setUnlockOpen(false);
    setPending({ kind: "open", at: Date.now() });
    if (p.end === null) run("unlock", async () => { await unlockNow(child.id); return giveAfter("🔓 Kilit kaldırıldı"); }, (r) => String(r));
    else run("unlock", async () => giveAfter(String(await tempUntil(p.end!))), (r) => String(r));
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
      .eq("child_id", child.id).eq("source", "manual").gte("valid_on", todayISO()).like("note", "Geçici açma%").is("settled_at", null);
    if (error) throw error;
    await sendCommand(child.id, "resync", {});
    await loadExtras();
    return `Kilit kaldığı yerden sürüyor · ${tempOpen.reason}`;
  }

  function untilText(iso: string | null) {
    if (!iso) return "sen kaldırana kadar";
    const d = new Date(iso);
    const day = d.toLocaleDateString("sv-SE", { timeZone: "Europe/Berlin" });
    const t = d.toLocaleTimeString("tr-TR", { timeZone: "Europe/Berlin", hour: "2-digit", minute: "2-digit" });
    if (day === todayISO()) return `${t}'e kadar`;
    if (day === todayISO("Europe/Berlin", 1)) return `yarın ${t}'e kadar`;
    return `${d.toLocaleDateString("tr-TR", { timeZone: "Europe/Berlin", day: "numeric", month: "short", weekday: "short" })} ${t}'e kadar`;
  }
  function lockPlan(): { until: string | null; runs: string[] | null; text: string } {
    const mid = untilFrom("until", "00:00");
    switch (lockDur) {
      case "none": return { until: null, runs: null, text: "Kendiliğinden bitmez" };
      case "open": { const u = untilFrom("until", nextOpenStart ?? "00:00"); return { until: u, runs: null, text: untilText(u) }; }
      case "closed": { const u = untilFrom("until", nextClosedStart ?? "00:00"); return { until: u, runs: null, text: untilText(u) }; }
      case "midnight": return { until: mid, runs: null, text: untilText(mid) };
      case "morning": { const u = untilFrom("until", "07:00"); return { until: u, runs: null, text: untilText(u) }; }
      case "tasks": {
        const m = openRuns.filter((x) => x.mandatory);
        const rs = m.length ? m : openRuns;
        return { until: mid, runs: rs.map((x) => x.id), text: rs.length ? `${rs.map((x) => x.title).join(", ")} onaylanınca açılır · en geç gece yarısı` : "Bugün bitmemiş görev yok" };
      }
      case "task": {
        const t = openRuns.find((x) => x.id === lockRun);
        return { until: mid, runs: t ? [t.id] : [], text: t ? `${t.title} onaylanınca açılır · en geç gece yarısı` : "Görev seç" };
      }
      case "min": { const u = new Date(Date.now() + lockMin * 60000).toISOString(); return { until: u, runs: null, text: untilText(u) }; }
      case "until": { const u = untilFrom("until", lockUntil); return { until: u, runs: null, text: untilText(u) }; }
      case "date": { const d = new Date(`${lockDate}T${lockDateTime}:00`); return { until: isNaN(d.getTime()) ? null : d.toISOString(), runs: null, text: isNaN(d.getTime()) ? "Tarih seç" : untilText(d.toISOString()) }; }
      default: { const u = new Date(Date.now() + Number(lockDur) * 60000).toISOString(); return { until: u, runs: null, text: untilText(u) }; }
    }
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
    const plan = lockPlan();
    if (plan.runs && !plan.runs.length) { alert("Bitmemiş görev yok; başka bir seçenek seç."); return; }
    if (plan.until && new Date(plan.until).getTime() <= Date.now()) { alert("Bitiş zamanı geçmiş."); return; }
    const until = plan.until;
    setLockOpen(false);
    if (lockKind === "kiosk") {
      setPending({ kind: "kiosk", at: Date.now() });
      run("lock", async () => { await (plan.runs ? sendCommand(child.id, "kiosk_start", { message: kioskOf(child).message || null, until_runs: plan.runs }, until) : lockNow(child.id, "kiosk", until, kioskOf(child).message)); return giveAfter("🔒 Kilitlendi"); }, (r) => String(r));
    } else if (lockKind === "limit") {
      setPending({ kind: "limit", at: Date.now() });
      run("lock", async () => { await (plan.runs ? sendCommand(child.id, "lock", { until_runs: plan.runs }, until) : lockNow(child.id, "limit", until)); return giveAfter("Sınırlandı"); }, (r) => String(r));
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
  // Çarkta düşülebilecek en fazla: gün bitişine kadar kalan hak (kilitliyken de), iletilmemiş değişiklikler dahil
  const hakNow = st ? (st.day_left_minutes ?? st.remaining_minutes) : 0;
  const remainingNow = !st ? 0 : hakNow >= 1440 ? 600 : Math.max(0, hakNow + pend.give);
  /** Çarktan "süre + zaman": önce zaman penceresi açılır, uygulanınca süre de verilir */
  async function giveAfter(note: string) {
    const g = pendingGive;
    setPendingGive(0);
    if (g === 0) return note;
    if (g < 0) return `${note} · −${minutesText(-g)} ${await reduceTime(-g)}`;
    const r = await giveNow(child.id, g, fam, st, {});
    return `${note} · +${minutesText(g)} ${r}`;
  }
  /** Süre azalt: önce bugün verilen ekstra süreler sunucuda geri alınır; artan kısım telefona komut olarak gider */
  async function reduceTime(m: number) {
    const { data, error } = await supabase.rpc("parent_reduce_time", { p_child: child.id, p_minutes: m });
    if (error) throw error;
    const rest = Number(data ?? 0);
    if (rest > 0) await sendCommand(child.id, "adjust_minutes", { minutes: -rest });
    // Sunucuda geri alınan kısım: telefon alana kadar panel ⏳ ile gösterir
    if (m - rest > 0) await sendCommand(child.id, "resync", { reduced: m - rest });
    fam.reload();
    return rest === m ? "telefona iletildi" : rest > 0 ? `ekstra süre geri alındı · ${minutesText(rest)} telefona iletildi` : "ekstra süre geri alındı";
  }
  function applyDial() {
    const d = dial;
    if (!d) return;
    setDial(0);
    if (dialThen !== "none") {
      setPendingGive(d);
      if (dialThen === "unlock") setUnlockOpen(true);
      else if (dialThen === "time") { setXDur("60"); setXOpen(true); }
      else { setLockKind("kiosk"); setLockOpen(true); }
      return;
    }
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

  // ⏰ neyi ayarlar: elle kilit varsa kilidin bitişi, geçici açıksa açmanın bitişi, yoksa açık saatlerin bitişi
  const xMode: "lock" | "temp" | "open" = manualLock && kiosk ? "lock" : tempOpen ? "temp" : "open";
  // Elle kilidin bitişi: bugünün 00:00'ından dakika (yarına taşabilir)
  const lockEndAbs = manualLock?.until ? Math.max(nowBerlin().minute, nowBerlin().minute + Math.round((new Date(manualLock.until).getTime() - Date.now()) / 60000)) : nowBerlin().minute;
  const xBase = xMode === "lock" ? lockEndAbs : xMode === "temp" && tempOpen ? (tempOpen.end >= 1439 && tempNext ? 1440 + mins(tempNext) : tempOpen.end) : baseEnd;
  const tempEndText = tempOpen ? (tempOpen.end >= 1439 && tempNext ? `yarın ${tempNext}` : hm(Math.min(tempOpen.end, 1439))) : "";
  // Açma bitince ne olur: kayıttaki eski sebep yerine o anki kurallara göre hesaplanır (her çocukta aynı dil)
  const afterOpen = (() => {
    if (!tempOpen) return "";
    const endAbs = tempOpen.end >= 1439 && tempNext ? 1440 + mins(tempNext) : tempOpen.end;
    const endMs = Date.now() + (endAbs - nowBerlin().minute) * 60000;
    if (manualLock && !manualLock.from && (!manualLock.until || new Date(manualLock.until).getTime() > endMs)) return "🔒 Tam kilit (elle)";
    const m = endAbs % 1440;
    const inSec = (x: Section) => { const a = mins(x.start_time), b = mins(x.end_time); return a < b ? m >= a && m < b : m >= a || m < b; };
    const at = fam.sections.find((x) => x.profile_id === sec?.profile_id && inSec(x));
    if (!at) return "program neyse o";
    const icon = timedPossible(at, fam.sectionRules) || at.default_rule === "open" ? "🟢" : "🔒";
    return `${icon} ${at.name} (${hhmm(at.end_time)}'e kadar)`;
  })();
  // --- İki halka: solda hak (süre), sağda açıklık (zaman) ---
  const nowMin = nowBerlin().minute;
  const nextAtMs = (hmStr: string) => Date.now() + ((((mins(hmStr) - nowMin) % 1440) + 1440) % 1440 || 1440) * 60000;
  const dayEndHm = (fam.family?.day_end ?? "05:00").slice(0, 5);
  const dayEndMs = nextAtMs(dayEndHm);
  const isLocked = kiosk || limited || closed;
  // Sol halka: gün bitişine kadar kalan hak (telefon kilitliyken de bildirir; eski sürümde kalan süre)
  const hak = Math.max(0, (st?.day_left_minutes ?? st?.remaining_minutes ?? 0) + (st && (st.day_left_minutes ?? st.remaining_minutes) < 1440 ? pend.give : 0));
  const hakUnl = hak >= 1440;
  const lockEnd: { label: string; ms: number | null; task: boolean } | null = !st || !isLocked
    ? null
    : manualLock && kiosk && !manualLock.from
      ? manualLock.runs.length
        ? { label: "görev", ms: null, task: true }
        : { label: manualLock.until ? new Date(manualLock.until).toLocaleTimeString("tr-TR", { timeZone: "Europe/Berlin", hour: "2-digit", minute: "2-digit" }) : "sen açana kadar", ms: manualLock.until ? new Date(manualLock.until).getTime() : null, task: false }
      : taskLock
        ? { label: "görev", ms: null, task: true }
        : sec && !timedPossible(sec, fam.sectionRules)
          ? { label: hhmm(sec.end_time), ms: nextAtMs(hhmm(sec.end_time)), task: false }
          : nextOpenStart
            ? { label: nextOpenStart, ms: nextAtMs(nextOpenStart), task: false }
            : { label: "—", ms: null, task: false };
  const lockPastDayEnd = !!lockEnd && !lockEnd.task && (lockEnd.ms == null || lockEnd.ms >= dayEndMs);
  const openEndAbs = xMode === "temp" ? xBase : baseEnd;
  const openLeft = st && !isLocked && (sec || tempOpen || extWin) ? Math.max(0, openEndAbs - nowMin) : null;
  const openShort = openLeft != null && !hakUnl && openLeft < hak;
  const [ringMenu, setRingMenu] = [ringMenuOpen, setRingMenuOpen];
  const openLock = () => {
    setRingMenu(false); setUnlockOpen(false);
    if (tempOpen || pmActive) setLockKind("resume");
    else if (lockKind === "resume") setLockKind("kiosk");
    setLockOpen(true);
  };
  const openExtend = () => { setRingMenu(false); setLockOpen(false); setUnlockOpen(false); setXDur("60"); setXOpen(true); };
  const openUnlock = () => { setRingMenu(false); setLockOpen(false); setUnlockOpen(true); };

  const stateLine = !st
    ? null
    : tempOpen && !waiting && !kiosk
      ? tempOpen.reason === "Açık saatler uzatıldı"
        ? { cls: "good", text: `🟢 Açık saatler · ${tempEndText}'e kadar (bugün uzatıldı)` }
        : { cls: "good", text: `🔓 Açıldı · ${tempEndText}'e kadar · sonra ${afterOpen}` }
      : kiosk
      ? { cls: "bad", text: waiting && !realKiosk ? "Kilitli · telefona iletiliyor…" : manualLock && !manualLock.from
          ? `🔒 Tam kilit (elle) · ${manualLock.runs.length ? "görev bitene kadar" : untilText(manualLock.until)}`
          : taskLock
            ? `🔒 Önce görev: ${taskLock}`
            : sec && !timedPossible(sec, fam.sectionRules)
              ? `🔒 ${sec.name} · ${hhmm(sec.end_time)}'e kadar`
              : `🔒 ${(st.lock_reason ?? "").replace("🔒", "").trim() || "Kilitli"}` }
      : limited
        ? { cls: "warn", text: waiting && !realLimited ? "Sınırlı · telefona iletiliyor…" : `Sınırlı · ${st.lock_reason ?? ""}`.replace(/ · $/, "") }
        : closed
          ? { cls: "warn", text: [`🔒 ${sec && !timedPossible(sec, fam.sectionRules) ? sec.name : st.current_mode_name ?? "Kapalı saatler"}`, sec && !timedPossible(sec, fam.sectionRules) ? `${hhmm(sec.end_time)}'e kadar` : nextOpen].filter(Boolean).join(" · ") }
          : finished
            ? { cls: "warn", text: [sec && !timedPossible(sec, fam.sectionRules) ? `🔒 ${sec.name}` : st.current_mode_name ?? "Bugün", sec ? `${hhmm(sec.end_time)}'e kadar` : null].filter(Boolean).join(" · ") }
            : { cls: "good", text: [st.current_mode_name ?? "Açık", extWin || extended.length ? `${hm(Math.min(baseEnd, 1439))}'e kadar (bugün uzatıldı)` : shortenAt != null ? `${hm(shortenAt)}'e kadar (bugün kısaltıldı)` : sec && open ? `${hhmm(sec.end_time)}'e kadar` : null].filter(Boolean).join(" · ") };

  // Açıklamalar kartta yazmaz; ⓘ'ye basınca görünür
  const infoLines: string[] = [];
  if (st) {
    infoLines.push(`${conn === "on" ? "🟢 Telefon bağlı" : conn === "idle" ? "🟡 Telefon birkaç dakikadır sessiz" : "⚪ Telefon bağlı değil"} · son bağlantı ${timeText(st.updated_at)} (${ago(st.updated_at)})`);
    if (st.battery != null) infoLines.push(`🔋 Şarj %${st.battery}${st.battery <= 15 ? " · çok düşük, telefon kapanabilir" : ""}`);
    if (staleMin > 15) infoLines.push(`⚠ Telefon ${staleMin >= 60 ? `${Math.floor(staleMin / 60)} sa ${staleMin % 60} dk` : `${staleMin} dk`} süredir bağlanmadı (son bağlantı ${timeText(st.updated_at)})`);
    if (isLocked && hak > 0 && !hakUnl) infoLines.push(lockPastDayEnd
      ? `⏱ ${minutesText(hak)} süresi var; kilit gün bitişinden (${dayEndHm}) sonra kalkacağı için ${dayEndHm}'te kasaya geçer. Kilidi ${dayEndHm}'ten önce açarsan kullanabilir.`
      : `⏱ ${minutesText(hak)} süresi var; telefon açılınca kullanır.`);
    if (openShort && openLeft != null) infoLines.push(`⏰ Telefon ${minutesText(openLeft)} sonra kapanır; kullanmadığı süre ${dayEndHm}'te kasaya geçer.`);
    if (staleMin <= 15 && st.power_exempt === false) infoLines.push("🔋 Telefonda Orbit pil optimizasyonunda · ekran kapalıyken değişiklikler gecikebilir (telefonda Orbit'i açıp “İzin ver” de)");
    if (staleMin <= 15 && st.power_exempt !== false && st.live === false) infoLines.push("📡 Anlık bağlantı kopuk · telefon değişiklikleri en geç 30 sn içinde yoklayarak alır");
  }
  return (
    <div className="card child-card">
      <Link to={`/child/${child.id}`} className="child-main">
        <span
          className="dial"
          role="button"
          aria-label="Süreyi çarkla ayarla"
          onClick={(e) => { e.preventDefault(); e.stopPropagation(); if (st) { setDial(0); setDialThen("none"); setDialOpen(true); } }}
        >
          <Ring value={hakUnl ? 1 : hak} max={hakUnl ? 1 : Math.max(st?.allowance_minutes ?? 0, hak + (st?.used_minutes ?? 0), 1)} color={!hakUnl && hak <= 10 ? "var(--warn)" : child.color} size={80}>
            {!st ? <b>—</b> : hakUnl ? <span className="ring-state"><b>∞</b><small>süre</small></span> : <span className="ring-state"><b>{minutesText(hak)}</b><small>süre</small></span>}
          </Ring>
        </span>
        <div className="grow">
          <div className="row between name-row">
            <h2>{child.name}</h2>
              {conn && (
                <span
                  role="button"
                  tabIndex={0}
                  className="stat-chip"
                  aria-label={`${conn === "on" ? "Telefon bağlı" : conn === "idle" ? "Telefon birkaç dakikadır sessiz" : "Telefon bağlı değil"}${st?.battery != null ? ` · şarj yüzde ${st.battery}` : ""}`}
                  title={`Son bağlantı ${timeText(st!.updated_at)}`}
                  onClick={(e) => { e.preventDefault(); e.stopPropagation(); setInfoOpen(true); }}
                >
                  <span className={`chip-dot ${conn}`} />
                  {st?.battery != null && <Battery level={st.battery} />}
                  {pend.items.length > 0 && (
                    <span className="chip-ico pend" role="button" aria-label="Telefona iletilmeyen değişiklikler" onClick={(e) => { e.preventDefault(); e.stopPropagation(); setPendOpen(true); }}>
                      <svg width="14" height="16" viewBox="0 0 14 16" aria-hidden="true"><path d="M2 1h10M2 15h10M3 1v2.5c0 2 4 3 4 4.5s-4 2.5-4 4.5V15M11 1v2.5c0 2-4 3-4 4.5s4 2.5 4 4.5V15" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" /></svg>
                    </span>
                  )}
                  {infoLines.length > 0 && (
                    <span className="chip-ico info" role="button" aria-label="Açıklamalar" onClick={(e) => { e.preventDefault(); e.stopPropagation(); setInfoOpen(true); }}>
                      <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="7" fill="none" stroke="currentColor" strokeWidth="1.4" /><circle cx="8" cy="4.9" r="0.95" fill="currentColor" /><path d="M8 7.2v4.4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>
                    </span>
                  )}
                </span>
              )}
          </div>
          {showSeen && st && (
            <span className="seen-box tiny">
              <span className="muted">Son bağlantı {timeText(st.updated_at)} ({ago(st.updated_at)}){st.battery != null ? ` · şarj %${st.battery}` : ""}</span>
            </span>
          )}
          {st ? (
            <>
              {stateLine && (
                <span className={`state-line ${stateLine.cls}`}>
                  <span className="state-ico" aria-hidden>🕘</span>
                  {stateLine.text}
                </span>
              )}
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
        {st && (
          <span
            className="dial"
            role="button"
            aria-label="Kilitle / aç / uzat"
            onClick={(e) => { e.preventDefault(); e.stopPropagation(); setRingMenu(true); }}
          >
            {isLocked ? (
              <Ring value={1} max={1} color={limited || closed ? "var(--warn)" : "var(--bad)"} size={80}>
                <span className="ring-state bad"><Icon name="lock" size={18} /><small>{lockEnd?.label ?? "Kilitli"}</small></span>
              </Ring>
            ) : (
              <Ring value={openLeft ?? 1} max={openLeft == null || unlimited ? 1 : Math.max(openLeft, hakUnl ? 1 : hak, 1)} color={openShort ? "var(--warn)" : "var(--accent)"} size={80}>
                <span className="ring-state"><b>{openLeft == null ? "açık" : minutesText(openLeft)}</b><small>{openLeft == null ? "telefon" : `${hm(Math.min(openEndAbs % 1440, 1439))}'e`}</small></span>
              </Ring>
            )}
          </span>
        )}
      </Link>

      {pmUntil && pmUntil.getTime() > Date.now() && (
        <div className="row gap-s pm-row" style={{ alignItems: "center" }}>
          <span className="grow small">🛠 Ebeveyn modu açık · {pmUntil.toLocaleTimeString("tr-TR", { hour: "2-digit", minute: "2-digit" })}'e kadar <span className="muted tiny">· bitince kilitler kaldığı yerden sürer</span></span>
          <button className="pill-btn" disabled={!!busy} onClick={() => run("unlock", async () => { await stopParentMode(child.id); setPmUntil(null); return "Ebeveyn modu kapatıldı"; }, (r) => String(r))}>
            Kapat
          </button>
        </div>
      )}
      <div className="card-actions" style={{ display: "contents" }}>
        <div className="lock-wrap">
          {unlockOpen && createPortal(
            <>
              <div className="pop-backdrop sheet-like" onClick={() => { setUnlockOpen(false); setPendingGive(0); }} />
              <div className="lock-pop sheet-pop" role="dialog" aria-label="Kilidi aç">
                <b className="sheet-pop-title">{child.name}</b>
                {pendingGive !== 0 && <p className={`small ${pendingGive > 0 ? "good-text" : "bad-text"}`} style={{ margin: 0 }}>⏱ Uygulayınca {pendingGive > 0 ? `+${minutesText(pendingGive)} süre de verilecek` : `${minutesText(-pendingGive)} süre de düşülecek`}</p>}
                <p className="small" style={{ margin: 0 }}>
                  {kiosk || limited || taskLock ? <>🔒 <b>Neden kilitli:</b> {taskLock ? `Görev: ${taskLock}` : (st?.lock_reason ?? "").replace("🔒", "").trim() || "Telefon kilitli"}</> : <>🟢 Şu an açık. Seçtiğin süre boyunca kilitler ve kapalı saatler devreye girmez.</>}
                </p>
                {tempOpen && <p className="small muted" style={{ margin: 0 }}>🔓 Şu an {tempEndText}'e kadar açık · süreyi ⏰ ile uzat / kısalt</p>}
                <span className="pop-label">NE KADAR AÇIK KALSIN <Info>Seçtiğin zamana kadar telefon normal açık saat gibi çalışır. Süre dolunca (telefon kapalı ya da internetsiz olsa da) aynı sebepten yine kilitlenir. Beklemeden kilitlemek için “Kilitle → Kaldığı yerden devam et”.</Info></span>
                {(() => {
                  const chip = (k: string, l: string) => (
                    <button key={k} className={`chip-btn ${uDur === k ? "on" : ""}`} onClick={() => setUDur(k)}>{l}</button>
                  );
                  const p = unlockPlan();
                  const reason = taskLock ? `Görev: ${taskLock}` : kiosk ? ((st?.lock_reason ?? "").replace("🔒", "").trim() || "Tam kilit") : limited ? "Sınırlı" : "Kapalı saat";
                  return (
                    <div className="stack-s">
                      <span className="small muted">Hazır</span>
                      <div className="chips">
                        {!closed && nextClosedStart && chip("closed", `${sec && timedPossible(sec, fam.sectionRules) ? sec.name : "Açık saatler"} bitene kadar · ${nextClosedStart}`)}
                        {chip("midnight", "Gece yarısına kadar")}
                        {chip("morning", "Yarın sabaha kadar · 07:00")}
                      </div>
                      <span className="small muted">Süreyle</span>
                      <div className="chips">
                        {chip("5", "5 dk")}{chip("15", "15 dk")}{chip("30", "30 dk")}{chip("60", "1 sa")}{chip("120", "2 sa")}{chip("min", "Süre…")}
                      </div>
                      {uDur === "min" && <MinuteStepper value={uMin} onChange={setUMin} min={1} max={1440} label="Açık kalma süresi" />}
                      <span className="small muted">Saatle</span>
                      <div className="chips">{chip("until", "Saate kadar…")}{chip("date", "Tarih + saate kadar…")}</div>
                      {uDur === "until" && <TimeField value={uUntil} onChange={setUUntil} label="Bitiş saati" />}
                      {uDur === "date" && (
                        <div className="row gap-s" style={{ alignItems: "center" }}>
                          <input type="date" value={uDate} min={todayISO()} onChange={(e) => setUDate(e.target.value)} />
                          <TimeField value={uDateTime} onChange={setUDateTime} label="Saat" />
                        </div>
                      )}
                      {!taskLock && <div className="chips">{chip("full", "🔓 Tamamen kaldır")}</div>}
                      <p className="small muted" style={{ margin: 0 }}>
                        → {p.text}{p.end ? `, sonra yine 🔒 ${reason}` : ""}
                      </p>
                      <div className="pop-actions">
                        <button className="pill-btn ghost" onClick={() => setUnlockOpen(false)}>Vazgeç</button>
                        <button className="pill-btn primary" disabled={!!busy || p.end === ""} onClick={applyUnlock}>{uDur === "full" ? "Kilidi kaldır" : "Aç"}</button>
                      </div>
                    </div>
                  );
                })()}
                <span className="pop-label">🛠 EBEVEYN MODU</span>
                <div className="row gap-s" style={{ alignItems: "center" }}>
                  <MinuteStepper value={parentMin} onChange={setParentMin} min={1} max={240} step={1} label="Ebeveyn modu süresi" />
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
                  Ebeveyn modu ({minutesText(parentMin)})
                </button>
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
              <div className="pop-backdrop sheet-like" onClick={() => { setLockOpen(false); setPendingGive(0); }} />
              <div className="lock-pop sheet-pop" role="dialog" aria-label="Kilit">
                <b className="sheet-pop-title">{child.name}</b>
                {pendingGive !== 0 && <p className={`small ${pendingGive > 0 ? "good-text" : "bad-text"}`} style={{ margin: 0 }}>⏱ Uygulayınca {pendingGive > 0 ? `+${minutesText(pendingGive)} süre de verilecek` : `${minutesText(-pendingGive)} süre de düşülecek`}</p>}
                <span className="pop-label">NE OLSUN</span>
                <div className="chips">
                  {[
                    ...(tempOpen ? [{ id: "resume", name: "🔁 Kaldığı yerden devam et (açmayı bitir)" }] : pmActive ? [{ id: "resume", name: "🔁 Kaldığı yerden devam et (ebeveyn modunu kapat)" }] : []),
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
                {lockKind !== "resume" && (() => {
                  const manual = lockKind === "kiosk" || lockKind === "limit";
                  const chip = (k: string, l: string) => (
                    <button key={k} className={`chip-btn ${lockDur === k ? "on" : ""}`} onClick={() => setLockDur(k)}>{l}</button>
                  );
                  const plan = lockPlan();
                  return (
                    <div className="stack-s">
                      <span className="small muted">Hazır</span>
                      <div className="chips">
                        {chip("open", `${secNameAt(nextOpenStart, false) ?? "Açık saatler"} başlayana kadar${nextOpenStart ? ` · ${nextOpenStart}` : ""}`)}
                        {nextClosedStart && sec && timedPossible(sec, fam.sectionRules) && chip("closed", `${secNameAt(nextClosedStart, true) ?? "Kapalı saatler"} başlayana kadar · ${nextClosedStart}`)}
                        {chip("midnight", "Gece yarısına kadar")}
                        {chip("morning", "Yarın sabaha kadar · 07:00")}
                      </div>
                      {manual && (
                        <>
                          <span className="small muted">Görevle</span>
                          <div className="chips">
                            {chip("tasks", "Görevler bitene kadar")}
                            {chip("task", "Şu görev bitene kadar")}
                          </div>
                          {lockDur === "task" && (
                            openRuns.length ? (
                              <select value={lockRun} onChange={(e) => setLockRun(e.target.value)}>
                                {openRuns.map((x) => <option key={x.id} value={x.id}>{x.title}</option>)}
                              </select>
                            ) : <p className="muted small" style={{ margin: 0 }}>Bugün bitmemiş görev yok</p>
                          )}
                        </>
                      )}
                      <span className="small muted">Süreyle</span>
                      <div className="chips">
                        {chip("15", "15 dk")}{chip("30", "30 dk")}{chip("60", "1 sa")}{chip("120", "2 sa")}{chip("min", "Süre…")}
                      </div>
                      {lockDur === "min" && <MinuteStepper value={lockMin} onChange={setLockMin} min={1} max={1440} label="Kilit süresi" />}
                      <span className="small muted">Saatle</span>
                      <div className="chips">
                        {chip("until", "Saate kadar…")}{chip("date", "Tarih + saate kadar…")}
                      </div>
                      {lockDur === "until" && <TimeField value={lockUntil} onChange={setLockUntil} label="Bitiş saati" />}
                      {lockDur === "date" && (
                        <div className="row gap-s" style={{ alignItems: "center" }}>
                          <input type="date" value={lockDate} min={todayISO()} onChange={(e) => setLockDate(e.target.value)} />
                          <TimeField value={lockDateTime} onChange={setLockDateTime} label="Saat" />
                        </div>
                      )}
                      <div className="chips">{chip("none", manual ? "Ben kaldırana kadar" : "Programa dönene kadar")}</div>
                      <p className={`small ${lockDur === "none" && manual ? "warn-text" : "muted"}`} style={{ margin: 0 }}>
                        {lockDur === "none"
                          ? manual ? "⚠ Kendiliğinden bitmez. Tamamen açmak için “Kilidi aç → Kilidi tamamen kaldır”." : "Program kendi saatinde döner."
                          : `🔒 ${plan.text}${plan.runs ? "" : ", sonra program neyse o."}`}
                      </p>
                    </div>
                  );
                })()}
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
      </div>
      {infoOpen && createPortal(
        <>
          <div className="pop-backdrop sheet-like" onClick={() => setInfoOpen(false)} />
          <div className="lock-pop sheet-pop" role="dialog" aria-label="Açıklamalar">
            <b className="sheet-pop-title">{child.name}</b>
            <div className="stack-s">
              {infoLines.map((l, n) => <p key={n} className="small" style={{ margin: 0 }}>{l}</p>)}
            </div>
            <div className="pop-actions">
              <button className="pill-btn ghost" onClick={() => setInfoOpen(false)}>Kapat</button>
            </div>
          </div>
        </>,
        document.body
      )}
      {pendOpen && createPortal(
        <>
          <div className="pop-backdrop sheet-like" onClick={() => setPendOpen(false)} />
          <div className="lock-pop sheet-pop" role="dialog" aria-label="Telefona iletilmeyenler">
            <b className="sheet-pop-title">⏳ {child.name} · telefona iletilmedi</b>
            <p className="small muted" style={{ margin: 0 }}>Telefon son {st ? `${timeText(st.updated_at)}'de (${ago(st.updated_at)})` : "—"} bağlandı. Telefon bağlanınca uygulanır.</p>
            <div className="stack-s">
              {pend.items.length === 0 ? <span className="small">Bekleyen değişiklik yok.</span> : pend.items.map((it, n) => (
                <div key={n} className="row between small"><span>{it.text}</span><span className="muted">{ago(it.at)}</span></div>
              ))}
            </div>
            <div className="pop-actions">
              <button className="pill-btn ghost" onClick={() => setPendOpen(false)}>Kapat</button>
            </div>
          </div>
        </>,
        document.body
      )}
      {ringMenu && createPortal(
        <>
          <div className="pop-backdrop sheet-like" onClick={() => setRingMenu(false)} />
          <div className="lock-pop sheet-pop" role="dialog" aria-label="Telefon ne zaman açık">
            <b className="sheet-pop-title">{child.name} · telefon</b>
            <p className="small muted" style={{ margin: 0 }}>{stateLine?.text}</p>
            <div className="stack-s">
              {(isLocked
                ? [["unlock", "🔓 Kilidi aç", openUnlock], ["ext", "⏰ Kilidin süresini uzat / kısalt", openExtend], ["lock", "🔒 Kilit seçeneklerini değiştir", openLock]]
                : [["lock", "🔒 Kilitle", openLock], ["ext", "⏰ Açık kalma süresini uzat / kısalt", openExtend], ["unlock", "🔓 Kilidi aç (kapalı saatleri de)", openUnlock]]
              ).map(([k, l, fn]) => (
                <button key={k as string} type="button" className="pill-btn" style={{ justifyContent: "flex-start", width: "100%" }} disabled={!!busy} onClick={fn as () => void}>{l as string}</button>
              ))}
            </div>
            <div className="pop-actions">
              <button className="pill-btn ghost" onClick={() => setRingMenu(false)}>Vazgeç</button>
            </div>
          </div>
        </>,
        document.body
      )}
      {xOpen && createPortal(
        <>
          <div className="pop-backdrop sheet-like" onClick={() => { setXOpen(false); setPendingGive(0); }} />
          <div className="lock-pop sheet-pop" role="dialog" aria-label="Açık saatleri uzat">
            <b className="sheet-pop-title">{child.name} · {xMode === "lock" ? "Kilidin süresini uzat / kısalt" : xMode === "temp" ? "Geçici açmayı uzat / kısalt" : `${openSecToday?.name ?? "Açık saatler"}${openSecToday ? ` (${hhmm(openSecToday.start_time)}–${hhmm(openSecToday.end_time)})` : ""} · uzat / kısalt (sadece bugün)`}</b>
            {pendingGive !== 0 && <p className={`small ${pendingGive > 0 ? "good-text" : "bad-text"}`} style={{ margin: 0 }}>⏱ Uygulayınca {pendingGive > 0 ? `+${minutesText(pendingGive)} süre de verilecek` : `${minutesText(-pendingGive)} süre de düşülecek`}</p>}
            <p className="small" style={{ margin: 0 }}>
              {xMode === "lock"
                ? `🔒 Şu an kilitli · ${manualLock?.runs.length ? "görev bitene kadar" : untilText(manualLock?.until ?? null)}`
                : xMode === "temp"
                  ? `🔓 Açık · ${tempEndText}'e kadar`
                  : `Bugün: ${hm(Math.min(baseEnd, 1439))}'de kapanıyor${extended.length ? " (uzatılmış)" : ""}${st && st.remaining_minutes < 1440 ? ` · kalan süre ${minutesText(st.remaining_minutes)}` : ""}`}
            </p>
            {(() => {
              const chip = (k: string, l: string) => (
                <button key={k} className={`chip-btn ${xDur === k ? "on" : ""}`} onClick={() => setXDur(k)}>{l}</button>
              );
              const p = extendPlan();
              return (
                <div className="stack-s">
                  <span className="small muted">Ne kadar</span>
                  <div className="chips">
                    {chip("15", "+15 dk")}{chip("30", "+30 dk")}{chip("60", "+1 sa")}{chip("90", "+1,5 sa")}{chip("120", "+2 sa")}{chip("min", "+ Süre…")}
                  </div>
                  <span className="small muted">Kısalt</span>
                  <div className="chips">{chip("-15", "−15 dk")}{chip("-30", "−30 dk")}{chip("-60", "−1 sa")}{chip("minus", "− Süre…")}</div>
                  {xDur === "minus" && <MinuteStepper value={xMinM} onChange={setXMinM} min={1} max={600} label="Kısaltma" />}
                  <span className="small muted">Saatle</span>
                  {xDur === "min" && <MinuteStepper value={xMin} onChange={setXMin} min={5} max={600} label="Uzatma" />}
                  <div className="chips">{chip("until", "Saate kadar…")}{chip("midnight", "Gece yarısına kadar")}</div>
                  {xDur === "until" && <TimeField value={xUntil} onChange={setXUntil} label="Yeni bitiş" />}
                  {xMode === "open" && fam.children.length > 1 && (
                    <label className="row gap-s small" style={{ alignItems: "center" }}>
                      <input type="checkbox" checked={xAll} onChange={(e) => setXAll(e.target.checked)} /> Bütün çocuklara uygula
                    </label>
                  )}
                  <p className="small muted" style={{ margin: 0 }} hidden={xMode !== "open"}>
                    → Bugün {p.end}'e kadar açık. Bugünkü süresini kullanabilir; süresi biterse daha önce kilitlenir. Kullanmadığı süre gün bitişinde ({(fam.family?.day_end ?? "05:00").slice(0, 5)}) kasaya geçer. Yarın program yine aynı.
                  </p>
                  {xMode !== "open" && <p className="small muted" style={{ margin: 0 }}>→ {xMode === "lock" ? `🔒 ${p.end}'e kadar kilitli, sonra program neyse o.` : `🔓 ${p.end}'e kadar açık, sonra yine kilit.`}</p>}
                  <div className="pop-actions">
                    {xMode === "open" && extended.length > 0 && (
                      <button className="pill-btn ghost" disabled={!!busy} onClick={() => {
                        setXOpen(false);
                        const ids = xAll ? fam.children.map((c) => c.id) : [child.id];
                        run("give", async () => { for (const id of ids) await undoExtendOpen(id); await loadExtras(); return "Uzatma geri alındı"; }, (r) => String(r));
                      }}>Geri al</button>
                    )}
                    <button className="pill-btn ghost" onClick={() => setXOpen(false)}>Vazgeç</button>
                    <button className="pill-btn primary" disabled={!!busy} onClick={applyExtend}>{extendPlan().abs < (xMode === "open" ? baseEnd : xBase) ? "Kısalt" : "Uzat"}</button>
                  </div>
                </div>
              );
            })()}
          </div>
        </>,
        document.body
      )}
      {dialOpen && createPortal(
        <DialSheet
          name={child.name}
          remaining={remainingNow}
          showRemaining={!!st && hakNow < 1440}
          value={dial}
          onChange={setDial}
          then={dialThen}
          onThen={setDialThen}
          onClose={() => { setDialOpen(false); setDial(0); }}
          onApply={() => { setDialOpen(false); applyDial(); }}
        />,
        document.body
      )}
      {msg && <p className="small muted center">{msg}</p>}
    </div>
  );
}

/** Büyük süre çarkı: tam tur 60 dk, her çentik 1 dk; saat yönü artırır, ters yönü azaltır (kalan sürenin altına inmez). */
function DialSheet({ name, remaining, showRemaining, value, onChange, onClose, onApply, then, onThen }: {
  name: string; remaining: number; showRemaining: boolean; value: number;
  onChange: (v: number) => void; onClose: () => void; onApply: () => void;
  then: "none" | "unlock" | "time" | "lock"; onThen: (v: "none" | "unlock" | "time" | "lock") => void;
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
          {[-60, -30, -15, -5, 5, 15, 30, 60].map((d) => (
            <button key={d} className="chip-btn" disabled={d < 0 && value + d < -remaining} onClick={() => onChange(clamp(value + d))}>{d > 0 ? "+" : "−"}{d === 60 ? "1 sa" : Math.abs(d)}</button>
          ))}
        </div>
        {value !== 0 && (
          <div className="stack-s">
            <span className="pop-label">TELEFON NE ZAMAN AÇIK OLSUN</span>
            <div className="chips">
              {([["none", "Değiştirme"], ["unlock", "🔓 Kilidi aç"], ["time", "⏰ Uzat / kısalt"], ["lock", "🔒 Kilitle"]] as const).map(([k, l]) => (
                <button key={k} className={`chip-btn ${then === k ? "on" : ""}`} onClick={() => onThen(k)}>{l}</button>
              ))}
            </div>
            {then !== "none" && <p className="muted tiny" style={{ margin: 0 }}>Devam’a basınca {then === "unlock" ? "kilidi aç" : then === "time" ? "uzat / kısalt" : "kilitle"} seçenekleri açılır; onaylayınca süre de {value > 0 ? "verilir" : "düşülür"}.</p>}
          </div>
        )}
        <div className="row gap-xs">
          <button className="pill-btn grow" onClick={onClose}>Vazgeç</button>
          <button className="pill-btn primary grow" disabled={!value} onClick={onApply}>{value !== 0 && then !== "none" ? "Devam →" : "✓ Uygula"}</button>
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

/** Telefonun şarjı: ince çerçeveli pil, doluluk rengi (≤%15 kırmızı, ≤%30 sarı) + yüzde */
function Battery({ level }: { level: number }) {
  const v = Math.max(0, Math.min(100, level));
  const color = v <= 15 ? "var(--bad)" : v <= 30 ? "var(--warn)" : "var(--good)";
  return (
    <span className="batt" style={{ color: v <= 15 ? "var(--bad)" : undefined }}>
      <svg width="20" height="11" viewBox="0 0 20 11" aria-hidden="true">
        <rect x="0.6" y="0.6" width="16.8" height="9.8" rx="2.4" fill="none" stroke="currentColor" strokeOpacity="0.6" strokeWidth="1.2" />
        <rect x="18.2" y="3.5" width="1.4" height="4" rx="0.7" fill="currentColor" fillOpacity="0.6" />
        <rect x="2" y="2" width={Math.max(1.2, (14 * v) / 100)} height="7" rx="1.2" fill={color} />
      </svg>
      {v}%
    </span>
  );
}

/** "az önce" / "12 dk önce" / "1 sa 5 dk önce" */
function ago(iso: string) {
  const m = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 60000));
  if (m < 1) return "az önce";
  if (m < 60) return `${m} dk önce`;
  return `${Math.floor(m / 60)} sa${m % 60 ? ` ${m % 60} dk` : ""} önce`;
}

/** Sayfalar arası geçişte son bilinen değer hemen görünsün (eski sayı yanıp sönmesin) */
const cardCache = new Map<string, unknown>();
function useCached<T>(key: string, init: T): [T, (v: T | ((p: T) => T)) => void] {
  const [v, setV] = useState<T>(() => (cardCache.has(key) ? (cardCache.get(key) as T) : init));
  const set = useCallback((x: T | ((p: T) => T)) => {
    setV((p) => {
      const n = typeof x === "function" ? (x as (p: T) => T)(p) : x;
      cardCache.set(key, n);
      return n;
    });
  }, [key]);
  return [v, set];
}
