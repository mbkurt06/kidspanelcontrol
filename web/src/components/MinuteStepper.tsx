import { useEffect, useRef, useState } from "react";

/** Basılı tutunca hızlanarak tekrar eden tuş. */
export function useHold(fn: () => void) {
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

/** Ana sayfadaki gibi küçük − [dk] + kutusu. 60 dk ve üstünü "1 sa 20 dk" diye de gösterir. */
export function MinuteStepper({
  value,
  onChange,
  onEnter,
  max = 600,
  step = 1,
  label = "Dakika",
}: {
  value: number;
  onChange: (v: number) => void;
  onEnter?: () => void;
  max?: number;
  step?: number;
  label?: string;
}) {
  const [text, setText] = useState<string | null>(null);
  const set = (v: number) => onChange(Math.max(0, Math.min(max, v)));
  const up = useHold(() => set(value + step));
  const down = useHold(() => set(value - step));
  const hint = value >= 60 ? `${Math.floor(value / 60)} sa${value % 60 ? ` ${value % 60} dk` : ""}` : null;
  return (
    <div className="give-box stepper">
      <button type="button" aria-label={`${step} dk azalt`} disabled={value === 0} {...down}>
        −
      </button>
      <input
        inputMode="numeric"
        aria-label={label}
        value={text ?? String(value)}
        onFocus={(e) => {
          setText(String(value));
          e.target.select();
        }}
        onChange={(e) => {
          const t = e.target.value.replace(/\D/g, "").slice(0, 3);
          setText(t);
          set(Number(t) || 0);
        }}
        onBlur={() => setText(null)}
        onKeyDown={(e) => {
          if (e.key === "Enter") onEnter?.();
          if (e.key === "ArrowUp") { e.preventDefault(); setText(null); set(value + step); }
          if (e.key === "ArrowDown") { e.preventDefault(); setText(null); set(value - step); }
        }}
      />
      <span className="give-unit">dk{hint ? ` · ${hint}` : ""}</span>
      <button type="button" aria-label={`${step} dk artır`} {...up}>
        +
      </button>
    </div>
  );
}
