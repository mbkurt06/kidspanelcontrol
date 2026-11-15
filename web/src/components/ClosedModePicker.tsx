import type { ClosedMode } from "../lib/actions";
import { Info } from "./Info";
import { TimeField } from "./DateTime";
import { hm, nowBerlin } from "../lib/sections";

const OPTS: { k: ClosedMode["mode"]; title: string; hint: string }[] = [
  { k: "none", title: "Verilemesin", hint: "Bu profil sürerken verilen süre telefonu açmaz, doğrudan kasaya gider." },
  { k: "clock", title: "Saat gibi aksın", hint: "Hangi saat olursa olsun telefon hemen bu kadar dakikalığına açılır, kullanmasa da süre akar. Kullanmadığı dakikalar kasaya gider." },
  { k: "usage", title: "Süre bitene kadar", hint: "Telefon hemen açılır, kullandıkça düşer; süre bitene kadar telefon kapalı duruma geçmez. Kapalı saatler bitince (programdaki ilk açık saat) kalan kasaya gider." },
  { k: "within", title: "Belirli süre içinde", hint: "Telefon hemen açılır, kullandıkça düşer ama seçilen süre içinde kullanılmalı. Süre dolunca kalan kasaya gider." },
  { k: "open", title: "Açık saatlerde kullan", hint: "Sadece açık saatlerde (programdaki açık bölümler) kullanılır, kullandıkça düşer. Açık saatler bitince kalan kasaya gider; kapalı saatte verilirse doğrudan kasaya gider." },
];

export function closedModeLabel(v: ClosedMode) {
  const o = OPTS.find((x) => x.k === v.mode)!;
  if (v.mode !== "within") return o.title;
  if (v.range) return `${o.title} · ${v.range.start}–${v.range.end}`;
  return `${o.title} · ${v.withinFactor ? `${v.withinFactor} katı` : `${(v.withinMinutes ?? 120) / 60} sa`}`;
}

export function sameClosedMode(a: ClosedMode, b: ClosedMode) {
  if (a.mode !== b.mode) return false;
  if (a.mode !== "within") return true;
  if (a.range || b.range) return a.range?.start === b.range?.start && a.range?.end === b.range?.end;
  return (a.withinFactor ?? null) === (b.withinFactor ?? null) && (a.withinFactor ? true : (a.withinMinutes ?? 120) === (b.withinMinutes ?? 120));
}

/** Kapalı / sınırlı saatte verilen sürenin davranışı: küçük çipler, açıklamalar (i) içinde. */
export function ClosedModePicker({ value, onChange, allowNone, noFactor, allowRange }: { value: ClosedMode; onChange: (v: ClosedMode) => void; allowNone?: boolean; noFactor?: boolean; allowRange?: boolean }) {
  const within = value.range ? "range" : value.withinFactor ? `x${value.withinFactor}` : String(value.withinMinutes ?? 120);
  const opts: [string, string][] = [["60", "1 saat"], ["120", "2 saat"], ["180", "3 saat"], ...(noFactor ? [] : ([["x2", "2 katı"], ["x4", "4 katı"]] as [string, string][])), ...(allowRange ? ([["range", "🕘 Saat aralığı"]] as [string, string][]) : [])];
  const pick = (v: string) => {
    if (v === "range") {
      const { minute } = nowBerlin();
      onChange({ mode: "within", withinMinutes: null, withinFactor: null, range: { start: hm(minute), end: hm(Math.min(minute + 120, 1439)) } });
    } else if (v.startsWith("x")) onChange({ mode: "within", withinFactor: Number(v.slice(1)), withinMinutes: null, range: null });
    else onChange({ mode: "within", withinMinutes: Number(v), withinFactor: null, range: null });
  };
  return (
    <div className="closed-mode">
      <div className="chips">
        {OPTS.filter((o) => allowNone || o.k !== "none").map((o) => (
          <span key={o.k} className={`chip-btn with-info ${value.mode === o.k ? "on" : ""}`}>
            <button type="button" onClick={() => onChange({ ...value, mode: o.k, range: null })}>
              {o.title}
            </button>
            <Info>{o.hint}</Info>
          </span>
        ))}
      </div>
      {value.mode === "within" && (
        <div className="chips" role="group" aria-label="Kullanma süresi">
          {opts.map(([k, l]) => (
            <button key={k} type="button" className={`chip-btn ${within === k ? "on" : ""}`} onClick={() => pick(k)}>{l}{k.startsWith("x") || k === "range" ? "" : " içinde"}</button>
          ))}
        </div>
      )}
      {value.mode === "within" && value.range && (
        <div className="row gap-s" style={{ alignItems: "center" }}>
          <TimeField value={value.range.start} onChange={(v) => onChange({ ...value, range: { ...value.range!, start: v } })} label="Başlangıç" />
          <span className="small muted">–</span>
          <TimeField value={value.range.end} onChange={(v) => onChange({ ...value, range: { ...value.range!, end: v } })} label="Bitiş" />
        </div>
      )}
    </div>
  );
}
