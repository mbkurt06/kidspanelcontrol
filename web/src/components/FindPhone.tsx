import { useEffect, useRef, useState } from "react";
import { sendCommand } from "../lib/actions";
import { supabase } from "../lib/supabase";

type State = "idle" | "sent" | "ringing" | "found" | "stopped" | "timeout";
const LABEL: Record<State, string> = {
  idle: "",
  sent: "Telefona gönderildi…",
  ringing: "🔊 Çalıyor",
  found: "📍 Bulundu ✓",
  stopped: "Durduruldu",
  timeout: "2 dakika çaldı, durdu",
};

function savedVolume(): number {
  try {
    const v = Number(localStorage.getItem("orbit.findVolume"));
    return v >= 5 && v <= 100 ? v : 40;
  } catch {
    return 40;
  }
}

/** Telefonu bul: panelden çaldır; ses seviyesi çalarken de değişir. Sessiz/titreşimde de çalar. */
export function FindPhone({ childId, name, staleMin }: { childId: string; name: string; staleMin: number }) {
  const [open, setOpen] = useState(false);
  const [vol, setVol] = useState(savedVolume);
  const [state, setState] = useState<State>("idle");
  const [since, setSince] = useState<string | null>(null);
  const volTimer = useRef<number | null>(null);
  const active = state === "sent" || state === "ringing";

  // Durum: telefonun gönderdiği "find_phone" olayları
  useEffect(() => {
    if (!since || !active) return;
    let n = 0;
    const t = window.setInterval(async () => {
      if (++n > 90) { window.clearInterval(t); setState("idle"); return; }
      const { data } = await supabase
        .from("events")
        .select("payload, created_at")
        .eq("child_id", childId)
        .eq("type", "find_phone")
        .gte("created_at", since)
        .order("created_at", { ascending: false })
        .limit(1);
      const s = (data?.[0]?.payload as { state?: State } | undefined)?.state;
      if (s && s !== state) setState(s);
    }, 2000);
    return () => window.clearInterval(t);
  }, [since, active, childId, state]);

  async function start() {
    const now = new Date(Date.now() - 5000).toISOString();
    setSince(now);
    setState("sent");
    await sendCommand(childId, "resync", { find: "start", volume: vol }).catch(() => setState("idle"));
  }
  async function stop() {
    setState("stopped");
    await sendCommand(childId, "resync", { find: "stop" }).catch(() => {});
  }
  function changeVol(v: number) {
    setVol(v);
    try { localStorage.setItem("orbit.findVolume", String(v)); } catch { /* yok */ }
    if (!active) return;
    if (volTimer.current) window.clearTimeout(volTimer.current);
    volTimer.current = window.setTimeout(() => sendCommand(childId, "resync", { find: "volume", volume: v }).catch(() => {}), 400);
  }

  return (
    <div className="find-phone">
      <button type="button" className={`link-btn small ${open ? "on" : ""}`} onClick={() => setOpen(!open)} aria-expanded={open}>
        🔊 Telefonu bul
      </button>
      {open && (
        <div className="find-box">
          <div className="row gap-s" style={{ alignItems: "center" }}>
            <span aria-hidden>🔈</span>
            <input type="range" min={5} max={100} step={5} value={vol} onChange={(e) => changeVol(Number(e.target.value))} className="grow" aria-label="Ses seviyesi" />
            <span aria-hidden>🔊</span>
            <b className="find-vol">%{vol}</b>
          </div>
          <div className="row gap-s" style={{ alignItems: "center" }}>
            {active ? (
              <button className="pill-btn danger" onClick={stop}>■ Durdur</button>
            ) : (
              <button className="pill-btn primary" onClick={start}>🔊 Çaldır</button>
            )}
            <span className="small muted grow">
              {LABEL[state] || `${name}'in telefonu sessizde de çalar; "Buldum" deyince ya da 2 dk sonra durur.`}
              {state === "sent" && staleMin > 5 ? " Telefon şu an bağlı görünmüyor; bağlanınca çalacak (10 dk içinde)." : ""}
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
