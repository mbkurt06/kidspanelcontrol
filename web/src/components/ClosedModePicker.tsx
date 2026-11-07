import type { ClosedMode } from "../lib/actions";
import { Info } from "./Info";

const OPTS: { k: ClosedMode["mode"]; title: string; hint: string }[] = [
  { k: "clock", title: "Saat gibi aksın", hint: "Hangi saat olursa olsun telefon hemen bu kadar dakikalığına açılır, kullanmasa da süre akar. Kullanmadığı dakikalar kasaya gider." },
  { k: "usage", title: "Süre bitene kadar", hint: "Telefon hemen açılır, kullandıkça düşer; süre bitene kadar telefon kapalı duruma geçmez. Kapalı saatler bitince (programdaki ilk açık saat) kalan kasaya gider." },
  { k: "within", title: "Belirli süre içinde", hint: "Telefon hemen açılır, kullandıkça düşer ama seçilen süre içinde kullanılmalı. Süre dolunca kalan kasaya gider." },
  { k: "open", title: "Açık saatlerde kullan", hint: "Sadece açık saatlerde (programdaki açık bölümler) kullanılır, kullandıkça düşer. Açık saatler bitince kalan kasaya gider; kapalı saatte verilirse doğrudan kasaya gider." },
];

export function closedModeLabel(v: ClosedMode) {
  const o = OPTS.find((x) => x.k === v.mode)!;
  if (v.mode !== "within") return o.title;
  return `${o.title} · ${v.withinFactor ? `${v.withinFactor} katı` : `${(v.withinMinutes ?? 120) / 60} sa`}`;
}

export function sameClosedMode(a: ClosedMode, b: ClosedMode) {
  if (a.mode !== b.mode) return false;
  if (a.mode !== "within") return true;
  return (a.withinFactor ?? null) === (b.withinFactor ?? null) && (a.withinFactor ? true : (a.withinMinutes ?? 120) === (b.withinMinutes ?? 120));
}

/** Kapalı / sınırlı saatte verilen sürenin davranışı: küçük çipler, açıklamalar (i) içinde. */
export function ClosedModePicker({ value, onChange }: { value: ClosedMode; onChange: (v: ClosedMode) => void }) {
  const within = value.withinFactor ? `x${value.withinFactor}` : String(value.withinMinutes ?? 120);
  return (
    <div className="closed-mode">
      <div className="chips">
        {OPTS.map((o) => (
          <span key={o.k} className={`chip-btn with-info ${value.mode === o.k ? "on" : ""}`}>
            <button type="button" onClick={() => onChange({ ...value, mode: o.k })}>
              {o.title}
            </button>
            <Info>{o.hint}</Info>
          </span>
        ))}
      </div>
      {value.mode === "within" && (
        <select
          className="compact-select"
          value={within}
          aria-label="Kullanma süresi"
          onChange={(e) => {
            const v = e.target.value;
            onChange(v.startsWith("x") ? { mode: "within", withinFactor: Number(v.slice(1)), withinMinutes: null } : { mode: "within", withinMinutes: Number(v), withinFactor: null });
          }}
        >
          <option value="60">1 saat içinde</option>
          <option value="120">2 saat içinde</option>
          <option value="180">3 saat içinde</option>
          <option value="x2">Verilen sürenin 2 katı içinde</option>
          <option value="x4">Verilen sürenin 4 katı içinde</option>
        </select>
      )}
    </div>
  );
}
