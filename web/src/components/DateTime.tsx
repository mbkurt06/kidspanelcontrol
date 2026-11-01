import { useEffect, useRef, useState } from "react";

const pad = (n: number) => String(n).padStart(2, "0");
const MONTHS = ["Ocak", "Şubat", "Mart", "Nisan", "Mayıs", "Haziran", "Temmuz", "Ağustos", "Eylül", "Ekim", "Kasım", "Aralık"];
const WD = ["Pzt", "Sal", "Çar", "Per", "Cum", "Cmt", "Paz"];

function parseTime(v: string): [number, number] {
  const [h, m] = (v || "00:00").slice(0, 5).split(":").map(Number);
  return [Number.isFinite(h) ? h : 0, Number.isFinite(m) ? m : 0];
}

/** Basılı tutunca tekrarlayan düğme (ok tuşları) */
function useRepeat(fn: () => void) {
  const t = useRef<number | null>(null);
  const stop = () => {
    if (t.current != null) {
      window.clearTimeout(t.current);
      window.clearInterval(t.current);
      t.current = null;
    }
  };
  useEffect(() => stop, []);
  return {
    onPointerDown: (e: React.PointerEvent) => {
      e.preventDefault();
      fn();
      stop();
      t.current = window.setTimeout(() => {
        t.current = window.setInterval(fn, 90);
      }, 400);
    },
    onPointerUp: stop,
    onPointerLeave: stop,
    onPointerCancel: stop,
  };
}

/**
 * Saat seçici: saat ve dakika ayrı; oklarla (basılı tutunca hızlı) artır/azalt, klavyeyle yaz (↑↓ da çalışır),
 * ya da ▾ ile açılan listeden seç. `onChange` her değişimde, `onCommit` değişiklik bitince (kaydetmek için) çağrılır.
 */
export function TimeField({
  value,
  onChange,
  onCommit,
  clearable,
  label,
  step = 1,
}: {
  value: string;
  onChange?: (v: string) => void;
  onCommit?: (v: string) => void;
  clearable?: boolean;
  label?: string;
  step?: number;
}) {
  const [h, setH] = useState(() => parseTime(value)[0]);
  const [m, setM] = useState(() => parseTime(value)[1]);
  const [hText, setHText] = useState<string | null>(null);
  const [mText, setMText] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const commitT = useRef<number | null>(null);
  const cur = useRef({ h, m });
  cur.current = { h, m };

  useEffect(() => {
    if (!value) return;
    const [a, b] = parseTime(value);
    setH(a);
    setM(b);
  }, [value]);

  function emit(nh: number, nm: number) {
    const hh = ((nh % 24) + 24) % 24;
    const mm = ((nm % 60) + 60) % 60;
    setH(hh);
    setM(mm);
    const v = `${pad(hh)}:${pad(mm)}`;
    onChange?.(v);
    if (onCommit) {
      if (commitT.current) window.clearTimeout(commitT.current);
      commitT.current = window.setTimeout(() => onCommit(v), 700);
    }
  }
  // Dakika taşınca saati de kaydır
  const addMin = (d: number) => {
    const { h: ch, m: cm } = cur.current;
    const total = (((ch * 60 + cm + d) % 1440) + 1440) % 1440;
    emit(Math.floor(total / 60), total % 60);
  };
  const addHour = (d: number) => emit(cur.current.h + d, cur.current.m);

  const hUp = useRepeat(() => addHour(1));
  const hDown = useRepeat(() => addHour(-1));
  const mUp = useRepeat(() => addMin(step));
  const mDown = useRepeat(() => addMin(-step));

  if (clearable && !value) {
    return (
      <button type="button" className="btn small ghost dt-empty" onClick={() => emit(18, 0)}>
        + Saat ekle
      </button>
    );
  }

  const seg = (kind: "h" | "m") => {
    const v = kind === "h" ? h : m;
    const text = kind === "h" ? hText : mText;
    const setText = kind === "h" ? setHText : setMText;
    const max = kind === "h" ? 23 : 59;
    return (
      <div className="tf-seg">
        <button type="button" className="tf-arrow" aria-label={kind === "h" ? "Saati artır" : "Dakikayı artır"} {...(kind === "h" ? hUp : mUp)}>
          ▲
        </button>
        <input
          className="tf-num"
          inputMode="numeric"
          aria-label={kind === "h" ? "Saat" : "Dakika"}
          value={text ?? pad(v)}
          onFocus={(e) => {
            setText(pad(v));
            e.target.select();
          }}
          onChange={(e) => {
            const t = e.target.value.replace(/\D/g, "").slice(-2);
            setText(t);
            const n = Number(t);
            if (t.length === 2 && n <= max) {
              if (kind === "h") emit(n, m);
              else emit(h, n);
            }
          }}
          onBlur={() => {
            if (text != null && text !== "") {
              const n = Math.min(max, Number(text));
              if (kind === "h") emit(n, m);
              else emit(h, n);
            }
            setText(null);
          }}
          onKeyDown={(e) => {
            if (e.key === "ArrowUp") {
              e.preventDefault();
              setText(null);
              if (kind === "h") addHour(1);
              else addMin(step);
            }
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setText(null);
              if (kind === "h") addHour(-1);
              else addMin(-step);
            }
            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          }}
        />
        <button type="button" className="tf-arrow" aria-label={kind === "h" ? "Saati azalt" : "Dakikayı azalt"} {...(kind === "h" ? hDown : mDown)}>
          ▼
        </button>
      </div>
    );
  };

  return (
    <div className="tf" role="group" aria-label={label ?? "Saat"}>
      {seg("h")}
      <span className="tf-colon">:</span>
      {seg("m")}
      <button type="button" className="tf-more" aria-label="Listeden seç" onClick={() => setOpen(true)}>
        ▾
      </button>
      {clearable && (
        <button type="button" className="tf-more" aria-label="Saati kaldır" onClick={() => { onChange?.(""); onCommit?.(""); }}>
          ✕
        </button>
      )}
      {open && (
        <div className="sheet-backdrop" onClick={() => setOpen(false)}>
          <div className="sheet" onClick={(e) => e.stopPropagation()}>
            <h2>{label ?? "Saat seç"}</h2>
            <div className="tf-big">
              {pad(h)}:{pad(m)}
            </div>
            <span className="small muted">Saat</span>
            <div className="tf-grid">
              {Array.from({ length: 24 }, (_, i) => (
                <button type="button" key={i} className={`chip small ${i === h ? "on" : ""}`} onClick={() => emit(i, m)}>
                  {pad(i)}
                </button>
              ))}
            </div>
            <span className="small muted">Dakika</span>
            <div className="tf-grid">
              {Array.from({ length: 12 }, (_, i) => i * 5).map((i) => (
                <button type="button" key={i} className={`chip small ${i === m ? "on" : ""}`} onClick={() => emit(h, i)}>
                  {pad(i)}
                </button>
              ))}
            </div>
            <button type="button" className="btn primary wide" onClick={() => setOpen(false)}>
              Tamam
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

const iso = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const fromIso = (s: string) => {
  const [y, mo, d] = s.split("-").map(Number);
  return new Date(y, (mo || 1) - 1, d || 1, 12);
};
export function dateLabel(s: string) {
  if (!s) return "";
  const d = fromIso(s);
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}, ${WD[(d.getDay() + 6) % 7]}`;
}

/** Tarih seçici: büyük takvim (Pazartesi başlar), ◀ ▶ ile gün gün, Bugün / Yarın kısayolları. */
export function DateField({
  value,
  onChange,
  clearable,
  label,
  placeholder = "Tarih seç",
}: {
  value: string;
  onChange: (v: string) => void;
  clearable?: boolean;
  label?: string;
  placeholder?: string;
}) {
  const [open, setOpen] = useState(false);
  const base = value ? fromIso(value) : new Date();
  const [view, setView] = useState({ y: base.getFullYear(), m: base.getMonth() });
  useEffect(() => {
    if (open) {
      const b = value ? fromIso(value) : new Date();
      setView({ y: b.getFullYear(), m: b.getMonth() });
    }
  }, [open, value]);

  const shift = (days: number) => {
    const d = value ? fromIso(value) : new Date();
    d.setDate(d.getDate() + days);
    onChange(iso(d));
  };
  const today = iso(new Date());
  const tomorrow = (() => {
    const d = new Date();
    d.setDate(d.getDate() + 1);
    return iso(d);
  })();

  const first = new Date(view.y, view.m, 1, 12);
  const lead = (first.getDay() + 6) % 7;
  const daysIn = new Date(view.y, view.m + 1, 0).getDate();
  const cells: (string | null)[] = [...Array(lead).fill(null), ...Array.from({ length: daysIn }, (_, i) => iso(new Date(view.y, view.m, i + 1, 12)))];
  while (cells.length % 7) cells.push(null);
  const moveMonth = (d: number) => {
    const n = new Date(view.y, view.m + d, 1);
    setView({ y: n.getFullYear(), m: n.getMonth() });
  };

  return (
    <div className="df">
      {value && (
        <button type="button" className="tf-more" aria-label="Önceki gün" onClick={() => shift(-1)}>
          ◀
        </button>
      )}
      <button type="button" className="df-value" onClick={() => setOpen(true)} aria-label={label ?? "Tarih"}>
        📅 {value ? dateLabel(value) : placeholder}
      </button>
      {value && (
        <button type="button" className="tf-more" aria-label="Sonraki gün" onClick={() => shift(1)}>
          ▶
        </button>
      )}
      {clearable && value && (
        <button type="button" className="tf-more" aria-label="Tarihi kaldır" onClick={() => onChange("")}>
          ✕
        </button>
      )}
      {open && (
        <div className="sheet-backdrop" onClick={() => setOpen(false)}>
          <div className="sheet" onClick={(e) => e.stopPropagation()}>
            {label && <h2>{label}</h2>}
            <div className="row gap-xs wrap">
              <button type="button" className={`chip small ${value === today ? "on" : ""}`} onClick={() => { onChange(today); setOpen(false); }}>
                Bugün
              </button>
              <button type="button" className={`chip small ${value === tomorrow ? "on" : ""}`} onClick={() => { onChange(tomorrow); setOpen(false); }}>
                Yarın
              </button>
              {clearable && (
                <button type="button" className="chip small" onClick={() => { onChange(""); setOpen(false); }}>
                  Tarih yok
                </button>
              )}
            </div>
            <div className="cal-head">
              <button type="button" className="tf-more" onClick={() => moveMonth(-1)} aria-label="Önceki ay">
                ◀
              </button>
              <b>
                {MONTHS[view.m]} {view.y}
              </b>
              <button type="button" className="tf-more" onClick={() => moveMonth(1)} aria-label="Sonraki ay">
                ▶
              </button>
            </div>
            <div className="cal">
              {WD.map((w) => (
                <span key={w} className="cal-wd">
                  {w}
                </span>
              ))}
              {cells.map((c, i) =>
                c ? (
                  <button
                    type="button"
                    key={i}
                    className={`cal-day ${c === value ? "on" : ""} ${c === today ? "today" : ""}`}
                    onClick={() => {
                      onChange(c);
                      setOpen(false);
                    }}
                  >
                    {Number(c.slice(8))}
                  </button>
                ) : (
                  <span key={i} />
                )
              )}
            </div>
            <button type="button" className="btn ghost wide" onClick={() => setOpen(false)}>
              Kapat
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
