import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { Icon } from "../components/Icon";
import { useFamily } from "../lib/family";
import { errorText, supabase } from "../lib/supabase";
import type { AppUsageRule } from "../lib/types";

export default function AppRuleEdit() {
  const { id } = useParams(); const fam = useFamily(); const nav = useNavigate(); const isNew = !id || id === "new";
  const [rule, setRule] = useState<Partial<AppUsageRule>>({ name: "Yeni uygulama kuralı", mode: "timed", max_minutes: 30, counts_toward_daily: true, start_time: "", end_time: "" });
  const [err, setErr] = useState(""); const [busy, setBusy] = useState(false);
  useEffect(() => { if (!isNew) setRule(fam.appUsageRules.find((x) => x.id === id) ?? {}); }, [fam.appUsageRules, id, isNew]);
  const set = (key: keyof AppUsageRule, value: unknown) => setRule((x) => ({ ...x, [key]: value }));
  async function save() {
    setErr(""); if (!rule.name?.trim()) return setErr("Kural adı yaz."); setBusy(true);
    if (!!rule.start_time !== !!rule.end_time) { setBusy(false); return setErr("Saat aralığı için başlangıç ve bitiş birlikte seçilmeli."); }
    const row = { family_id: fam.familyId, name: rule.name.trim(), mode: rule.mode ?? "timed", max_minutes: rule.mode === "timed" && rule.max_minutes != null ? Number(rule.max_minutes) : null, counts_toward_daily: !!rule.counts_toward_daily, start_time: rule.start_time || null, end_time: rule.end_time || null };
    const result = isNew ? await supabase.from("app_usage_rules").insert(row).select("id").single() : await supabase.from("app_usage_rules").update(row).eq("id", id).select("id").single();
    setBusy(false); if (result.error) return setErr(errorText(result.error)); await fam.reload(); nav("/rules");
  }
  async function remove() { if (!id || !confirm("Bu uygulama kuralı silinsin mi? Atanmış uygulamalar normal kurallara döner.")) return; const { error } = await supabase.from("app_usage_rules").delete().eq("id", id); if (error) return setErr(errorText(error)); await fam.reload(); nav("/rules"); }
  return <div className="page"><header className="page-head"><Link to="/rules" className="icon-btn" aria-label="Geri"><Icon name="back" /></Link><h1>Uygulama kuralı</h1><span /></header>{err && <p className="error">{err}</p>}<div className="card">
    <label className="field"><span>Ad</span><input value={rule.name ?? ""} onChange={(e) => set("name", e.target.value)} placeholder="Ders zamanı" /></label>
    <label className="field"><span>Davranış</span><select value={rule.mode ?? "timed"} onChange={(e) => set("mode", e.target.value)}><option value="open">Açık</option><option value="timed">Süreli</option><option value="blocked">Kapalı</option></select></label>
    {rule.mode === "timed" && <><label className="field"><span>En fazla (dk, boş = sınırsız)</span><input type="number" min={0} value={rule.max_minutes ?? ""} onChange={(e) => set("max_minutes", e.target.value === "" ? null : Number(e.target.value))} /></label><label className="check"><input type="checkbox" checked={!!rule.counts_toward_daily} onChange={(e) => set("counts_toward_daily", e.target.checked)} /> Günlük süreden düşsün</label></>}
    <div className="grid2"><label className="field"><span>Başlangıç (isteğe bağlı)</span><input type="time" value={rule.start_time ?? ""} onChange={(e) => set("start_time", e.target.value)} /></label><label className="field"><span>Bitiş</span><input type="time" value={rule.end_time ?? ""} onChange={(e) => set("end_time", e.target.value)} /></label></div>
    <p className="muted tiny">Saat aralığı boşsa kural gün boyunca geçerlidir. Kuralı Uygulamalar ekranında birden fazla uygulamaya atayabilirsin.</p><button className="btn primary wide" disabled={busy} onClick={save}>Kaydet</button>{!isNew && <button className="btn ghost danger-text wide" onClick={remove}>Sil</button>}
  </div></div>;
}
