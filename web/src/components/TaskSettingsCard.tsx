import { useEffect, useState } from "react";
import { useFamily } from "../lib/family";
import { supabase } from "../lib/supabase";
import { MinuteStepper } from "./MinuteStepper";
import { Info } from "./Info";

/** Kanıt varsayılanları: fotoğraf (öncesi + sonrası) adedi, kamera kaydında hangi kamera */
export default function TaskSettingsCard({ embedded = false }: { embedded?: boolean }) {
  const fam = useFamily();
  const [open, setOpen] = useState(false);
  const defaults = {
    beforeMin: fam.family?.task_before_photo_min ?? 1,
    beforeMax: fam.family?.task_before_photo_max ?? 4,
    afterMin: fam.family?.task_after_photo_min ?? 1,
    afterMax: fam.family?.task_after_photo_max ?? 4,
  };
  const [v, setV] = useState(defaults);
  const [saved, setSaved] = useState(false);
  useEffect(() => setV(defaults), [fam.family]); // eslint-disable-line react-hooks/exhaustive-deps
  async function save() {
    const next = { ...v, beforeMax: Math.max(v.beforeMax, v.beforeMin), afterMax: Math.max(v.afterMax, v.afterMin) };
    setV(next);
    await supabase.from("families").update({ task_before_photo_min: next.beforeMin, task_before_photo_max: next.beforeMax, task_after_photo_min: next.afterMin, task_after_photo_max: next.afterMax }).eq("id", fam.familyId);
    await fam.reload();
    setSaved(true);
  }
  const cam = fam.family?.task_record_camera ?? "choose";
  const setCam = (c: "back" | "front" | "choose") => supabase.from("families").update({ task_record_camera: c }).eq("id", fam.familyId).then(() => fam.reload());
  const row = (label: string, value: number, k: keyof typeof v) => (
    <div className="gt-stepper">
      <span className="small">{label}</span>
      <MinuteStepper value={value} onChange={(n) => { setSaved(false); setV({ ...v, [k]: n }); }} min={1} max={4} unit="foto" label={label} />
    </div>
  );
  const content = (
    <div className="stack">
      <div>
        <h3>Görev kanıtları</h3>
        <select value={fam.family?.proof_retention_days ?? 0} onChange={(e) => supabase.from("families").update({ proof_retention_days: Number(e.target.value) }).eq("id", fam.familyId).then(() => fam.reload())}>
          <option value={0}>Fotoğraflar hemen silinsin</option><option value={7}>7 gün saklansın</option><option value={30}>30 gün saklansın</option>
        </select>
      </div>
      <div className="stack-s">
        <h3>📷 Fotoğraf (öncesi + sonrası) <Info>Görevde “Fotoğraf” seçilince çocuk başlamadan önce ve bitirince bu kadar fotoğraf çeker.</Info></h3>
        {row("Öncesi en az", v.beforeMin, "beforeMin")}
        {row("Öncesi en fazla", v.beforeMax, "beforeMax")}
        {row("Sonrası en az", v.afterMin, "afterMin")}
        {row("Sonrası en fazla", v.afterMax, "afterMax")}
        <div className="row gap-s" style={{ alignItems: "center" }}>
          <button className="btn small" onClick={save}>Kaydet</button>
          {saved && <span className="good-text small">Kaydedildi</span>}
        </div>
      </div>
      <div className="stack-s">
        <h3>🎥 Kamera kaydı <Info>Çocuk seçsin: kayda başlarken ön ya da arka kamerayı çocuk seçer. Yeni görevler bu ayarla gelir; görevin kendisinde değiştirilebilir.</Info></h3>
        <div className="chips">
          {([["choose", "Çocuk seçsin"], ["back", "Arka"], ["front", "Ön"]] as const).map(([k, l]) => (
            <button key={k} type="button" className={`chip-btn ${cam === k ? "on" : ""}`} onClick={() => setCam(k)}>{l}</button>
          ))}
        </div>
      </div>
    </div>
  );
  if (embedded) return content;
  return (
    <section className="card">
      <button className="row between wide plain" onClick={() => setOpen((x) => !x)}><h2>Görev ayarları</h2><span className={`collapse-arrow${open ? " open" : ""}`} aria-hidden="true" /></button>
      {open && content}
    </section>
  );
}
