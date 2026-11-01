import type { Window } from "../lib/types";
import { TimeField } from "./DateTime";
import { Icon } from "./Icon";

// Saat aralıkları düzenleyici. Boş liste = gün boyu.
export function WindowsEditor({ value, onChange, emptyText }: { value: Window[]; onChange: (w: Window[]) => void; emptyText: string }) {
  return (
    <div className="stack-s">
      {!value.length && <p className="muted small">{emptyText}</p>}
      {value.map((w, i) => (
        <div className="row gap-s" key={i}>
          <TimeField value={w.start} onChange={(v) => onChange(value.map((x, j) => (j === i ? { ...x, start: v } : x)))} />
          <span className="muted">–</span>
          <TimeField value={w.end} onChange={(v) => onChange(value.map((x, j) => (j === i ? { ...x, end: v } : x)))} />
          <button className="icon-btn" aria-label="Sil" onClick={() => onChange(value.filter((_, j) => j !== i))}>
            <Icon name="trash" size={18} />
          </button>
        </div>
      ))}
      <button className="link" onClick={() => onChange([...value, { start: "16:00", end: "18:00" }])}>
        + Saat aralığı ekle
      </button>
    </div>
  );
}

export function DayPicker({ value, onChange }: { value: number[]; onChange: (d: number[]) => void }) {
  const names = ["Pzt", "Sal", "Çar", "Per", "Cum", "Cmt", "Paz"];
  return (
    <div className="row gap-xs wrap">
      {names.map((n, i) => {
        const d = i + 1;
        const on = value.includes(d);
        return (
          <button key={n} className={`chip small ${on ? "on" : ""}`} onClick={() => onChange(on ? value.filter((x) => x !== d) : [...value, d].sort())}>
            {n}
          </button>
        );
      })}
    </div>
  );
}
