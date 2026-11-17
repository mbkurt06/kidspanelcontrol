import { useCallback, useEffect, useMemo, useState } from "react";
import { errorText, supabase } from "../lib/supabase";
import { todayISO } from "../lib/util";

type Item = {
  id: string; day: string; title: string; category: string | null; emoji: string | null; at: string | null;
  remind: boolean; remind_before: number; repeat: "none" | "daily" | "weekdays" | "days"; repeat_days: number[]; ends_on: string | null; created_at: string;
};
type Check = { item_id: string; day: string; done: boolean; skipped: boolean; at: string };

const isoDow = (d: string) => { const w = new Date(d + "T12:00:00").getDay(); return w === 0 ? 7 : w; };
const addDays = (d: string, n: number) => { const x = new Date(d + "T12:00:00"); x.setDate(x.getDate() + n); return x.toISOString().slice(0, 10); };
function occurs(i: Item, d: string) {
  if (i.repeat === "none") return i.day === d;
  if (d < i.day || (i.ends_on && d > i.ends_on)) return false;
  if (i.repeat === "daily") return true;
  if (i.repeat === "weekdays") return isoDow(d) <= 5;
  return i.repeat_days.includes(isoDow(d));
}
const REPEAT: Record<string, string> = { daily: "her gün", weekdays: "hafta içi", days: "seçili günler" };
const dayLabel = (d: string, today: string) => {
  const s = new Date(d + "T12:00:00").toLocaleDateString("tr-TR", { weekday: "short", day: "numeric", month: "short" });
  return d === today ? `Bugün · ${s}` : d === addDays(today, 1) ? `Yarın · ${s}` : d === addDays(today, -1) ? `Dün · ${s}` : s;
};

/** Çocuğun kendi planı (Planım): ebeveyn sadece görür. */
export default function PlanTab({ childId }: { childId: string }) {
  const today = todayISO();
  const [day, setDay] = useState(today);
  const [items, setItems] = useState<Item[] | null>(null);
  const [checks, setChecks] = useState<Check[]>([]);
  const [err, setErr] = useState("");

  const load = useCallback(async () => {
    const since = addDays(today, -40);
    const [a, b] = await Promise.all([
      supabase.from("plan_items").select("*").eq("child_id", childId).or(`repeat.neq.none,day.gte.${since}`).order("created_at"),
      supabase.from("plan_checks").select("item_id,day,done,skipped,at").eq("child_id", childId).gte("day", since),
    ]);
    if (a.error || b.error) setErr(errorText(a.error ?? b.error));
    setItems((a.data ?? []) as Item[]);
    setChecks((b.data ?? []) as Check[]);
  }, [childId, today]);
  useEffect(() => { load(); }, [load]);

  const chk = useMemo(() => new Map(checks.map((c) => [`${c.item_id}@${c.day}`, c])), [checks]);
  const list = (items ?? [])
    .filter((i) => occurs(i, day) && !chk.get(`${i.id}@${day}`)?.skipped)
    .sort((x, y) => (x.at ?? "99") .localeCompare(y.at ?? "99") || x.created_at.localeCompare(y.created_at));
  const done = list.filter((i) => chk.get(`${i.id}@${day}`)?.done).length;

  // Son 7 gün özeti
  const week = Array.from({ length: 7 }, (_, k) => addDays(today, k - 6)).map((d) => {
    const l = (items ?? []).filter((i) => occurs(i, d) && !chk.get(`${i.id}@${d}`)?.skipped);
    return { d, n: l.length, ok: l.filter((i) => chk.get(`${i.id}@${d}`)?.done).length };
  });

  if (!items) return <p className="muted">Yükleniyor…</p>;
  return (
    <div className="stack">
      {err && <p className="error">{err}</p>}
      <div className="card">
        <div className="row between">
          <button className="btn ghost small" onClick={() => setDay(addDays(day, -1))} aria-label="Önceki gün">‹</button>
          <div style={{ textAlign: "center" }}>
            <b>{dayLabel(day, today)}</b>
            {list.length > 0 && <div className="muted small">{done} / {list.length} tamam</div>}
          </div>
          <button className="btn ghost small" onClick={() => setDay(addDays(day, 1))} aria-label="Sonraki gün">›</button>
        </div>
        {day !== today && <div style={{ textAlign: "center" }}><button className="link-btn plan-link" onClick={() => setDay(today)}>Bugüne dön</button></div>}
        <div className="plan-list">
          {list.length === 0 && <p className="muted">Bu gün için plan yok.</p>}
          {list.map((i) => {
            const c = chk.get(`${i.id}@${day}`);
            return (
              <div key={i.id} className={`plan-row${c?.done ? " done" : ""}`}>
                <span className="plan-check">{c?.done ? "☑" : "☐"}</span>
                <span className="plan-time">{i.at?.slice(0, 5) ?? "—"}</span>
                <span>{i.emoji ?? "📌"}</span>
                <span className="plan-title">{i.title}</span>
                <span className="muted tiny">
                  {i.remind && i.at ? `🔔${i.remind_before ? ` ${i.remind_before} dk önce` : ""} ` : ""}
                  {i.repeat !== "none" ? `🔁 ${REPEAT[i.repeat]}` : ""}
                  {c?.done && c.at ? ` · ${new Date(c.at).toLocaleTimeString("tr-TR", { hour: "2-digit", minute: "2-digit" })}` : ""}
                </span>
              </div>
            );
          })}
        </div>
      </div>
      <div className="card">
        <h2>Son 7 gün</h2>
        <div className="plan-week">
          {week.map((w) => (
            <button key={w.d} className={`plan-day${w.d === day ? " on" : ""}`} onClick={() => setDay(w.d)}>
              <span className="muted tiny">{new Date(w.d + "T12:00:00").toLocaleDateString("tr-TR", { weekday: "short" })}</span>
              <b>{w.n ? `${w.ok}/${w.n}` : "–"}</b>
            </button>
          ))}
        </div>
      </div>
      <p className="muted tiny">Planı çocuk telefonda (📋 Planım) kendisi yapar; süre ve kurallarla bağlantısı yoktur. <button className="link-btn plan-link" onClick={load}>Yenile</button></p>
    </div>
  );
}
