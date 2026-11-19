import { useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { supabase, errorText } from "../lib/supabase";
import { sendCommand } from "../lib/actions";
import { minutesText, orbitTodayISO } from "../lib/util";
import { MinuteStepper } from "./MinuteStepper";
import type { DeviceStatus } from "../lib/types";

/** Uygulamaya özel süreler ve bugünlük genel süre kısıtı (Ana sayfa çocuk kartı) */
export type AppLimit = { only_apps: boolean; apps: string[]; caps: Record<string, number> };
export type ChildApp = { package: string; label: string };

export function useAppTime(childId: string, st: DeviceStatus | undefined) {
  const [apps, setApps] = useState<ChildApp[]>([]);
  const [totals, setTotals] = useState<Record<string, number>>({});
  const [limit, setLimit] = useState<AppLimit | null>(null);
  const day = orbitTodayISO();
  const reload = useCallback(async () => {
    const [g, l] = await Promise.all([
      supabase.from("app_grants").select("package,minutes").eq("child_id", childId).eq("day", day),
      supabase.from("day_app_limits").select("only_apps,apps,caps").eq("child_id", childId).eq("day", day).maybeSingle(),
    ]);
    const t: Record<string, number> = {};
    for (const r of (g.data ?? []) as { package: string; minutes: number }[]) t[r.package] = (t[r.package] ?? 0) + r.minutes;
    setTotals(t);
    setLimit((l.data as AppLimit | null) ?? null);
  }, [childId, day]);
  useEffect(() => { void reload(); }, [reload, st?.updated_at]);
  useEffect(() => {
    supabase.from("child_apps").select("package,label,approved").eq("child_id", childId).then(({ data }) => {
      const list = ((data ?? []) as (ChildApp & { approved: boolean })[])
        .filter((a) => a.approved && !a.package.startsWith("web:") && !a.package.startsWith("video:"))
        .map((a) => ({ package: a.package, label: a.label || a.package }))
        .sort((a, b) => a.label.localeCompare(b.label, "tr"));
      setApps(list);
    });
  }, [childId]);
  const used = (p: string) => Number((st?.grant_used as Record<string, number> | null | undefined)?.[`ap:${p}`] ?? 0);
  const left = useMemo(() => {
    const o: Record<string, number> = {};
    for (const [p, m] of Object.entries(totals)) { const x = Math.max(0, m - used(p)); if (x > 0) o[p] = x; }
    return o;
  }, [totals, st?.grant_used]); // eslint-disable-line react-hooks/exhaustive-deps
  const name = useCallback((p: string) => apps.find((a) => a.package === p)?.label ?? p.split(".").pop() ?? p, [apps]);
  return { apps, totals, left, limit, reload, name, used, day };
}

/** Seçilen uygulamalara süre ver / geri al (kullanılanın altına inmez) */
export async function applyAppTime(childId: string, familyId: string, day: string, pkgs: string[], d: number, totals: Record<string, number>, used: (p: string) => number) {
  const rows = pkgs.map((p) => {
    const m = d > 0 ? d : -Math.min(-d, Math.max(0, (totals[p] ?? 0) - used(p)));
    return { family_id: familyId, child_id: childId, day, package: p, minutes: m };
  }).filter((r) => r.minutes !== 0);
  if (!rows.length) return "değişiklik yok";
  const { error } = await supabase.from("app_grants").insert(rows);
  if (error) throw error;
  await sendCommand(childId, "resync", {});
  return "telefona iletildi";
}

export function limitText(limit: AppLimit | null, name: (p: string) => string) {
  if (!limit) return null;
  const caps = Object.entries(limit.caps ?? {}).filter(([, v]) => v > 0);
  if (limit.only_apps) return `Genel süre bugün sadece: ${limit.apps.map((a) => name(a) + (limit.caps?.[a] ? ` (en fazla ${limit.caps[a]} dk)` : "")).join(", ") || "—"}`;
  return caps.length ? `Bugün: ${caps.map(([p, v]) => `${name(p)} en fazla ${v} dk`).join(", ")}` : null;
}

/** "Toplam 55 dk · genel 30 dk · YouTube 15 dk · WhatsApp 10 dk" */
export function breakdownText(hak: number, unlimited: boolean, left: Record<string, number>, name: (p: string) => string) {
  const ent = Object.entries(left).sort((a, b) => b[1] - a[1]);
  if (!ent.length) return null;
  const sum = ent.reduce((s, [, v]) => s + v, 0);
  return [unlimited ? null : `Toplam ${minutesText(hak + sum)}`, unlimited ? "genel sınırsız" : `genel ${minutesText(hak)}`, ...ent.map(([p, v]) => `${name(p)} ${minutesText(v)}`)].filter(Boolean).join(" · ");
}

/** Uygulama listesi: tik koyulanlar seçilir */
export function AppPicker({ apps, selected, onChange, onClose, title }: { apps: ChildApp[]; selected: string[]; onChange: (s: string[]) => void; onClose: () => void; title: string }) {
  const [q, setQ] = useState("");
  const list = apps.filter((a) => !q || a.label.toLocaleLowerCase("tr").includes(q.toLocaleLowerCase("tr")));
  const sel = new Set(selected);
  // Seçilenler üstte
  list.sort((a, b) => Number(sel.has(b.package)) - Number(sel.has(a.package)));
  return createPortal(
    <>
      <div className="pop-backdrop sheet-like" style={{ zIndex: 1100 }} onClick={onClose} />
      <div className="lock-pop sheet-pop" role="dialog" aria-label={title} style={{ zIndex: 1101, maxHeight: "80vh", display: "flex", flexDirection: "column", gap: 8 }}>
        <div className="row between" style={{ alignItems: "center" }}>
          <b>{title}</b>
          <button type="button" className="pill-btn primary" onClick={onClose}>Tamam{selected.length ? ` (${selected.length})` : ""}</button>
        </div>
        <input placeholder="🔍 Uygulama ara…" value={q} onChange={(e) => setQ(e.target.value)} />
        <div style={{ overflowY: "auto", flex: 1 }}>
          {list.map((a) => (
            <label key={a.package} className="row gap-s app-pick-row">
              <input type="checkbox" checked={sel.has(a.package)} onChange={(e) => onChange(e.target.checked ? [...selected, a.package] : selected.filter((x) => x !== a.package))} />
              <span>{a.label}</span>
            </label>
          ))}
          {!list.length && <p className="muted small">Uygulama bulunamadı</p>}
        </div>
        {selected.length > 0 && <button type="button" className="link-btn small" onClick={() => onChange([])}>Seçimi temizle (süre tüm uygulamalar için)</button>}
      </div>
    </>,
    document.body,
  );
}

/** Bugünlük genel süre kısıtı: sadece seçilen uygulamalar + isteğe bağlı üst sınır */
export function DayLimitSheet({ childId, familyId, day, apps, limit, remaining, onClose, onSaved }: {
  childId: string; familyId: string; day: string; apps: ChildApp[]; limit: AppLimit | null; remaining: number; onClose: () => void; onSaved: (msg: string) => void;
}) {
  const [only, setOnly] = useState(limit?.only_apps ?? true);
  const [sel, setSel] = useState<string[]>(limit?.apps ?? []);
  const [caps, setCaps] = useState<Record<string, number>>(limit?.caps ?? {});
  const [pick, setPick] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const name = (p: string) => apps.find((a) => a.package === p)?.label ?? p;
  async function save() {
    setBusy(true); setErr("");
    const c = Object.fromEntries(Object.entries(caps).filter(([p, v]) => v > 0 && sel.includes(p)));
    const { error } = await supabase.from("day_app_limits").upsert({ child_id: childId, family_id: familyId, day, only_apps: only, apps: sel, caps: c, updated_at: new Date().toISOString() });
    if (error) { setErr(errorText(error)); setBusy(false); return; }
    await sendCommand(childId, "resync", {});
    setBusy(false);
    onSaved("Genel süre kısıtı kaydedildi");
  }
  async function clear() {
    setBusy(true);
    await supabase.from("day_app_limits").delete().eq("child_id", childId).eq("day", day);
    await sendCommand(childId, "resync", {});
    setBusy(false);
    onSaved("Kısıt kaldırıldı");
  }
  return createPortal(
    <>
      <div className="pop-backdrop sheet-like" style={{ zIndex: 1050 }} onClick={onClose} />
      <div className="lock-pop sheet-pop" role="dialog" aria-label="Genel süreyi kısıtla" style={{ zIndex: 1051, maxHeight: "85vh", overflowY: "auto" }}>
        <b className="sheet-pop-title">🎯 Genel süreyi kısıtla</b>
        <p className="small muted" style={{ margin: 0 }}>Şu anki genel süre: {minutesText(remaining)} · sadece bugün (gün bitince kalkar)</p>
        <label className="row gap-s"><input type="radio" checked={!only} onChange={() => setOnly(false)} /> Tüm uygulamalarda kullanabilir</label>
        <label className="row gap-s"><input type="radio" checked={only} onChange={() => setOnly(true)} /> Sadece seçtiğim uygulamalarda</label>
        <button type="button" className="pill-btn" onClick={() => setPick(true)}>📱 Uygulama seç{sel.length ? ` (${sel.length})` : ""}</button>
        {sel.map((p) => (
          <div key={p} className="row between" style={{ alignItems: "center", gap: 8 }}>
            <span className="small">{name(p)}</span>
            <span className="row gap-s" style={{ alignItems: "center" }}>
              <span className="muted tiny">en fazla</span>
              <MinuteStepper value={caps[p] ?? 0} onChange={(v) => setCaps({ ...caps, [p]: v })} min={0} max={600} label="" />
            </span>
          </div>
        ))}
        {sel.length > 0 && <p className="muted tiny" style={{ margin: 0 }}>"en fazla" 0 = sınır yok</p>}
        {err && <p className="error small">{err}</p>}
        <div className="pop-actions">
          {limit && <button className="pill-btn ghost" disabled={busy} onClick={clear}>Kısıtı kaldır</button>}
          <span className="grow" />
          <button className="pill-btn" onClick={onClose}>Vazgeç</button>
          <button className="pill-btn primary" disabled={busy || (only && !sel.length)} onClick={save}>✓ Uygula</button>
        </div>
      </div>
      {pick && <AppPicker apps={apps} selected={sel} onChange={setSel} onClose={() => setPick(false)} title="Genel süre hangi uygulamalarda" />}
    </>,
    document.body,
  );
}
