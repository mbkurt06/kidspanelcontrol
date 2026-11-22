import { useState } from "react";
import { TimeField } from "./DateTime";
import type { ChildApp, KioskWindow } from "../lib/types";

/** Uygulama / web sayfası / video listesi için ortak durum seçenekleri */
export type Mode3 = "rules" | "always_open" | "kiosk" | "blocked";
/** Normal durum (telefon açıkken). Kilitliyken ayrı ayarlanır: KioskControl */
export const MODES: Mode3[] = ["rules", "always_open", "blocked"];
export const MODE3_LABEL: Record<Mode3, string> = { rules: "Kurallara göre", always_open: "Her zaman açık", kiosk: "Kiosk", blocked: "Hep kapalı" };
export const mode3 = (a: Pick<ChildApp, "app_group" | "kiosk">): Mode3 =>
  a.app_group === "always_open" ? "always_open" : a.app_group === "blocked" ? "blocked" : "rules";
/** Normal durum; kilitliyken ayarına dokunmaz ("kiosk" eski kayıtlar için: kilitliyken her zaman açık) */
export const fromMode3 = (m: Mode3): Partial<ChildApp> =>
  m === "kiosk" ? { app_group: "timed", kiosk: true } : { app_group: m === "rules" ? "timed" : m };

/** 🔒 Kilitliyken: kapalı / her zaman açık / saat aralığında / günde en fazla X dk — normal durumdan bağımsız */
export function KioskControl({ app, onSave }: { app: ChildApp; onSave: (p: Partial<ChildApp>) => void }) {
  const kind = !app.kiosk ? "off" : (app.kiosk_minutes ?? 0) > 0 ? "minutes" : (app.kiosk_windows ?? []).length ? "window" : "always";
  return (
    <div className="kiosk-ctl">
      <label className="row gap-s" style={{ alignItems: "center" }}>
        <span className="muted tiny">🔒 Kilitliyken</span>
        <select value={kind} aria-label="Kilitliyken" onChange={(e) => {
          const v = e.target.value;
          if (v === "off") onSave({ kiosk: false });
          else if (v === "always") onSave({ kiosk: true, kiosk_windows: [], kiosk_minutes: null });
          else if (v === "window") onSave({ kiosk: true, kiosk_minutes: null, kiosk_windows: (app.kiosk_windows ?? []).length ? app.kiosk_windows : [{ start: "15:00", end: "17:00" }] });
          else onSave({ kiosk: true, kiosk_windows: [], kiosk_minutes: app.kiosk_minutes && app.kiosk_minutes > 0 ? app.kiosk_minutes : 30 });
        }}>
          <option value="off">Kapalı</option>
          <option value="always">Her zaman açık</option>
          <option value="window">Saat aralığında</option>
          <option value="minutes">Günde en fazla…</option>
        </select>
        {kind === "minutes" && (
          <input className="mini" type="number" min={1} value={app.kiosk_minutes ?? 30} aria-label="Kilitliyken günde en fazla (dk)"
            onChange={(e) => onSave({ kiosk_minutes: Math.max(1, Number(e.target.value) || 1) })} />
        )}
        {kind === "minutes" && <span className="muted tiny">dk</span>}
      </label>
      {kind === "window" && <KioskWindows app={app} onSave={(w) => onSave({ kiosk_windows: w })} />}
    </div>
  );
}

export function KioskWindows({ app, onSave }: { app: ChildApp; onSave: (w: KioskWindow[]) => void }) {
  const wins = app.kiosk_windows ?? [];
  const [add, setAdd] = useState<KioskWindow | null>(null);
  return (
    <div className="kiosk-wins">
      <span className="muted tiny">Saatler:</span>
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

