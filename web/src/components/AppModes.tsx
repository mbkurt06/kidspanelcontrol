import { useState } from "react";
import { TimeField } from "./DateTime";
import type { ChildApp, KioskWindow } from "../lib/types";

/** Uygulama / web sayfası / video listesi için ortak durum seçenekleri */
export type Mode3 = "rules" | "always_open" | "kiosk" | "blocked";
export const MODES: Mode3[] = ["rules", "always_open", "kiosk", "blocked"];
export const MODE3_LABEL: Record<Mode3, string> = { rules: "Kurallara göre", always_open: "Her zaman açık", kiosk: "Kiosk", blocked: "Hep kapalı" };
export const mode3 = (a: Pick<ChildApp, "app_group" | "kiosk">): Mode3 =>
  a.kiosk ? "kiosk" : a.app_group === "always_open" ? "always_open" : a.app_group === "blocked" ? "blocked" : "rules";
/** Kiosk: kilitliyken Orbit ekranından açılır, hiçbir zaman süreden düşmez (always_open + kiosk). */
export const fromMode3 = (m: Mode3): Partial<ChildApp> =>
  m === "kiosk" ? { app_group: "always_open", kiosk: true } : { app_group: m === "rules" ? "timed" : m, kiosk: false };

export function KioskWindows({ app, onSave }: { app: ChildApp; onSave: (w: KioskWindow[]) => void }) {
  const wins = app.kiosk_windows ?? [];
  const [add, setAdd] = useState<KioskWindow | null>(null);
  return (
    <div className="kiosk-wins">
      <span className="muted tiny">Kiosk saatleri:</span>
      {wins.length === 0 && <span className="chip-lite">Her zaman</span>}
      {wins.map((w, i) => (
        <span className="chip-lite" key={i}>
          {w.start}–{w.end}
          <button type="button" className="link-btn" aria-label="Aralığı sil" onClick={() => onSave(wins.filter((_, j) => j !== i))}>×</button>
        </span>
      ))}
      {add ? (
        <span className="row gap-s">
          <TimeField value={add.start} onChange={(v) => setAdd({ ...add, start: v })} label="Başlangıç" />
          <TimeField value={add.end} onChange={(v) => setAdd({ ...add, end: v })} label="Bitiş" />
          <button type="button" className="btn small" disabled={!add.start || !add.end || add.start === add.end}
            onClick={() => { onSave([...wins, add]); setAdd(null); }}>Ekle</button>
          <button type="button" className="link-btn" onClick={() => setAdd(null)}>Vazgeç</button>
        </span>
      ) : (
        <button type="button" className="link-btn" onClick={() => setAdd({ start: "07:00", end: "22:00" })}>+ Aralık</button>
      )}
    </div>
  );
}

