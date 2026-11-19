import { useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { supabase, errorText } from "../lib/supabase";
import { sendCommand } from "../lib/actions";
import { minutesText, orbitTodayISO } from "../lib/util";
import { MinuteStepper } from "./MinuteStepper";
import type { DeviceStatus } from "../lib/types";

/** Uygulamaya özel süreler ve bugünlük genel süre kısıtı (Ana sayfa çocuk kartı) */
export type AppLimit = { only_apps: boolean; apps: string[]; caps: Record<string, number>; scope?: "day" | "now"; budget?: number | null };
export type ChildApp = { package: string; label: string };

export function useAppTime(childId: string, st: DeviceStatus | undefined) {
  const [apps, setApps] = useState<ChildApp[]>([]);
  const [totals, setTotals] = useState<Record<string, number>>({});
  const [limit, setLimit] = useState<AppLimit | null>(null);
  const day = orbitTodayISO();
  const reload = useCallback(async () => {
    const [g, l] = await Promise.all([
      supabase.from("app_grants").select("package,minutes").eq("child_id", childId).eq("day", day),
      supabase.from("day_app_limits").select("only_apps,apps,caps,scope,budget").eq("child_id", childId).eq("day", day).maybeSingle(),
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
  // "Sadece şu anki süre" kısıtından kalan dk (telefon kısıtlı uygulamalarda harcananı "dl" olarak bildirir)
  const restrictedLeft = limit?.scope === "now" ? Math.max(0, (limit.budget ?? 0) - Number((st?.grant_used as Record<string, number> | null | undefined)?.dl ?? 0)) : 0;
  return { apps, totals, left, limit, reload, name, used, day, restrictedLeft };
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

export function limitText(limit: AppLimit | null, name: (p: string) => string, restrictedLeft = 0) {
  if (!limit) return null;
  const caps = Object.entries(limit.caps ?? {}).filter(([, v]) => v > 0);
  if (limit.scope === "now") {
    if (restrictedLeft <= 0) return "Kısıtlı süre bitti · şimdiki süre serbest";
    const list = limit.only_apps ? limit.apps.map((a) => name(a) + (limit.caps?.[a] ? ` (en fazla ${limit.caps[a]} dk)` : "")).join(", ") : caps.map(([p, v]) => `${name(p)} en fazla ${v} dk`).join(", ");
    return `Şu anki sürenin ${minutesText(restrictedLeft)}'sı sadece: ${list} · sonradan verilen süre serbest`;
  }
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
  const [scope, setScope] = useState<"day" | "now">(limit?.scope ?? "day");
  const [sel, setSel] = useState<string[]>(limit?.apps ?? []);
  const [caps, setCaps] = useState<Record<string, number>>(limit?.caps ?? {});
  const [pick, setPick] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const name = (p: string) => apps.find((a) => a.package === p)?.label ?? p;
  async function save() {
    // Hiç uygulama seçili değilse ve sınır yoksa: kısıt kalkar
    if (!sel.length) { if (limit) await clear(); else onClose(); return; }
    setBusy(true); setErr("");
    const c = Object.fromEntries(Object.entries(caps).filter(([p, v]) => v > 0 && sel.includes(p)));
    const { error } = await supabase.from("day_app_limits").upsert({ child_id: childId, family_id: familyId, day, only_apps: only, apps: sel, caps: c, scope, budget: scope === "now" ? (limit?.scope === "now" && limit.budget ? limit.budget : remaining) : null, updated_at: new Date().toISOString() });
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
        <div className="row between" style={{ alignItems: "center" }}>
          <b className="sheet-pop-title">🎯 Genel süreyi kısıtla</b>
          {limit && <button type="button" className="pill-btn ghost" disabled={busy} onClick={clear}>🗑 Kısıtı kaldır</button>}
        </div>
        <p className="small muted" style={{ margin: 0 }}>Şu anki genel süre: {minutesText(remaining)} · gün bitince kısıt kalkar</p>
        <span className="pop-label">KISIT NEYE UYGULANSIN</span>
        <label className="row gap-s" style={{ alignItems: "flex-start" }}><input type="radio" checked={scope === "day"} onChange={() => setScope("day")} />
          <span><b>📅 Bugün boyunca</b><br /><span className="muted tiny">Sonradan vereceğin süreler de bu kısıta uyar. Yeni süre verince bu uygulamalara nasıl dağıtılacağını sorarım.</span></span></label>
        <label className="row gap-s" style={{ alignItems: "flex-start" }}><input type="radio" checked={scope === "now"} onChange={() => setScope("now")} />
          <span><b>⏱ Sadece şu anki {minutesText(remaining)}</b><br /><span className="muted tiny">Kısıt yalnız bu süreye uygulanır. Sonradan vereceğin süre serbest: istediği uygulamada kullanır.</span></span></label>
        <span className="pop-label">HANGİ UYGULAMALAR</span>
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
          {limit && <button className="pill-btn ghost" disabled={busy} onClick={clear}>🗑 Kısıtı kaldır</button>}
          {scope === "now" && remaining <= 0 && <span className="error tiny">Şu an genel süre yok</span>}
          <span className="grow" />
          <button className="pill-btn" onClick={onClose}>Vazgeç</button>
          <button className="pill-btn primary" disabled={busy || (!!sel.length && scope === "now" && remaining <= 0 && !(limit?.scope === "now"))} onClick={save}>{!sel.length && limit ? "✓ Kaydet (kısıt kalkar)" : "✓ Uygula"}</button>
        </div>
      </div>
      {pick && <AppPicker apps={apps} selected={sel} onChange={setSel} onClose={() => setPick(false)} title="Genel süre hangi uygulamalarda" />}
    </>,
    document.body,
  );
}

/** "Bugün boyunca" kısıtı varken yeni genel süre: bu uygulamalara nasıl dağıtılsın (üst sınırlar artar) */
export function DistributeSheet({ minutes, limit, name, onClose, onApply }: {
  minutes: number; limit: AppLimit; name: (p: string) => string; onClose: () => void; onApply: (alloc: Record<string, number> | null) => void;
}) {
  const capped = limit.apps.filter((p) => (limit.caps?.[p] ?? 0) > 0);
  const each = capped.length ? Math.floor(minutes / capped.length) : 0;
  const [alloc, setAlloc] = useState<Record<string, number>>(() => Object.fromEntries(capped.map((p, i) => [p, each + (i < minutes - each * capped.length ? 1 : 0)])));
  const sum = Object.values(alloc).reduce((a, b) => a + b, 0);
  return createPortal(
    <>
      <div className="pop-backdrop sheet-like" style={{ zIndex: 1050 }} onClick={onClose} />
      <div className="lock-pop sheet-pop" role="dialog" aria-label="Süreyi dağıt" style={{ zIndex: 1051, maxHeight: "85vh", overflowY: "auto" }}>
        <b className="sheet-pop-title">+{minutesText(minutes)} · uygulamalara dağıt</b>
        <p className="small muted" style={{ margin: 0 }}>Bugün genel süre sadece şu uygulamalarda. Yeni sürenin her uygulamaya ne kadar ekleneceğini seç (üst sınırları artar).</p>
        {capped.map((p) => (
          <div key={p} className="row between" style={{ alignItems: "center", gap: 8 }}>
            <span className="small">{name(p)} <span className="muted tiny">şimdi en fazla {limit.caps[p]} dk</span></span>
            <MinuteStepper value={alloc[p] ?? 0} onChange={(v) => setAlloc({ ...alloc, [p]: v })} min={0} max={600} label="" />
          </div>
        ))}
        {limit.apps.filter((p) => !capped.includes(p)).length > 0 && <p className="muted tiny" style={{ margin: 0 }}>Sınırı olmayanlar: {limit.apps.filter((p) => !capped.includes(p)).map(name).join(", ")} (zaten sınırsız)</p>}
        <p className={`small ${sum === minutes ? "muted" : "warn-text"}`} style={{ margin: 0 }}>Dağıtılan: {minutesText(sum)} / {minutesText(minutes)}</p>
        <div className="pop-actions">
          <button className="pill-btn ghost" onClick={() => onApply(null)}>Sınırlar aynı kalsın</button>
          <span className="grow" />
          <button className="pill-btn" onClick={onClose}>Vazgeç</button>
          <button className="pill-btn primary" onClick={() => onApply(alloc)}>✓ Ver ve dağıt</button>
        </div>
      </div>
    </>,
    document.body,
  );
}

/** Dağıtımı kaydet: üst sınırlara eklenir */
export async function raiseCaps(childId: string, day: string, limit: AppLimit, alloc: Record<string, number>) {
  const caps = { ...(limit.caps ?? {}) };
  for (const [p, v] of Object.entries(alloc)) if (v > 0 && caps[p]) caps[p] += v;
  const { error } = await supabase.from("day_app_limits").update({ caps, updated_at: new Date().toISOString() }).eq("child_id", childId).eq("day", day);
  if (error) throw error;
}

/** Çocuk sayfası → Süre: uygulamaya özel süreler ve genel süre kısıtı */
export function AppTimeCard({ childId, familyId, st }: { childId: string; familyId: string; st: DeviceStatus | undefined }) {
  const at = useAppTime(childId, st);
  const [sel, setSel] = useState<string[]>([]);
  const [pick, setPick] = useState(false);
  const [min, setMin] = useState(10);
  const [limitOpen, setLimitOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const gen = st ? (st.day_left_minutes ?? st.remaining_minutes) : 0;
  const unl = gen >= 1440;
  const bd = breakdownText(gen, unl, at.left, at.name);
  const lt = limitText(at.limit, at.name, at.restrictedLeft);
  async function give(sign: 1 | -1) {
    if (!sel.length || !min) return;
    setBusy(true); setMsg("");
    try {
      const r = await applyAppTime(childId, familyId, at.day, sel, sign * min, at.totals, at.used);
      await at.reload();
      setMsg(`${sign > 0 ? "+" : "−"}${minutesText(min)} · ${sel.map(at.name).join(", ")} · ${r}`);
      setSel([]);
    } catch (e) { setMsg(errorText(e as Error)); }
    setBusy(false);
  }
  return (
    <div className="card">
      <h2 style={{ marginTop: 0 }}>📱 Uygulama süreleri</h2>
      {bd ? <p className="small" style={{ margin: 0 }}>⏱ {bd}</p> : <p className="small muted" style={{ margin: 0 }}>Bugün uygulamaya özel süre yok.</p>}
      {Object.entries(at.left).length > 0 && (
        <div className="stack-s" style={{ marginTop: 6 }}>
          {Object.entries(at.totals).filter(([, m]) => m > 0).map(([p, m]) => (
            <div key={p} className="row between small"><span>{at.name(p)}</span><span className="muted">{minutesText(at.left[p] ?? 0)} kaldı · {minutesText(m)} verildi</span></div>
          ))}
        </div>
      )}
      <div className="stack-s" style={{ marginTop: 10 }}>
        <span className="pop-label">UYGULAMAYA SÜRE VER</span>
        <button type="button" className={`pill-btn ${sel.length ? "primary" : ""}`} onClick={() => setPick(true)}>📱 {sel.length ? sel.map(at.name).join(", ") : "Uygulama seç"}</button>
        <MinuteStepper value={min} onChange={setMin} min={1} max={600} label="Süre" />
        <div className="row gap-xs">
          <button className="pill-btn grow" disabled={busy || !sel.length} onClick={() => give(-1)}>− Geri al</button>
          <button className="pill-btn primary grow" disabled={busy || !sel.length} onClick={() => give(1)}>+ Ver</button>
        </div>
        <p className="muted tiny" style={{ margin: 0 }}>Süre sadece seçilen uygulama açıkken düşer; önce kendi süresi, bitince genel süre. Kullanılmayan kısım gün bitince silinir.</p>
      </div>
      <div className="stack-s" style={{ marginTop: 10 }}>
        <span className="pop-label">GENEL SÜRE KISITI</span>
        {lt ? <p className="small warn-text" style={{ margin: 0 }}>🎯 {lt}</p> : <p className="small muted" style={{ margin: 0 }}>Kısıt yok: genel süre tüm uygulamalarda kullanılır.</p>}
        <button className="pill-btn" onClick={() => setLimitOpen(true)}>🎯 {at.limit ? "Kısıtı düzenle" : "Genel süreyi kısıtla"}</button>
        {(at.limit || Object.keys(at.left).length > 0) && (
          <button className="pill-btn ghost" disabled={busy} onClick={async () => {
            setBusy(true);
            try { await resetAppTime(childId, familyId, at.day, at.totals, at.used); await at.reload(); setMsg("Uygulama kısıtları ve süreleri sıfırlandı"); }
            catch (e) { setMsg(errorText(e as Error)); }
            setBusy(false);
          }}>♻ Hepsini sıfırla (kısıt + uygulama süreleri)</button>
        )}
      </div>
      {msg && <p className="small muted" style={{ marginBottom: 0 }}>{msg}</p>}
      {pick && <AppPicker apps={at.apps} selected={sel} onChange={setSel} onClose={() => setPick(false)} title="Süre hangi uygulamalar için" />}
      {limitOpen && <DayLimitSheet childId={childId} familyId={familyId} day={at.day} apps={at.apps} limit={at.limit} remaining={unl ? 0 : gen}
        onClose={() => setLimitOpen(false)} onSaved={(m) => { setLimitOpen(false); setMsg(m); void at.reload(); }} />}
    </div>
  );
}

/** Bugünkü bütün uygulama ayarlarını sıfırla: genel süre kısıtı kalkar, uygulamalara verilen süreler geri alınır (kullanılan kalır) */
export async function resetAppTime(childId: string, familyId: string, day: string, totals: Record<string, number>, used: (p: string) => number) {
  await supabase.from("day_app_limits").delete().eq("child_id", childId).eq("day", day);
  const rows = Object.entries(totals).map(([p, m]) => ({ family_id: familyId, child_id: childId, day, package: p, minutes: -Math.max(0, m - used(p)) })).filter((r) => r.minutes < 0);
  if (rows.length) { const { error } = await supabase.from("app_grants").insert(rows); if (error) throw error; }
  await sendCommand(childId, "resync", {});
}
