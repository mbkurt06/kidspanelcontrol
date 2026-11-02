import { useEffect, useState } from "react";
import { useFamily } from "../lib/family";
import { supabase } from "../lib/supabase";

export default function TaskSettingsCard() {
  const fam = useFamily();
  const [open, setOpen] = useState(false);
  const defaults = {
    beforeMin: fam.family?.task_before_photo_min ?? 1,
    beforeMax: fam.family?.task_before_photo_max ?? 4,
    afterMin: fam.family?.task_after_photo_min ?? 1,
    afterMax: fam.family?.task_after_photo_max ?? 4,
  };
  const [v, setV] = useState(defaults);
  useEffect(() => setV(defaults), [fam.family]);
  async function save() {
    const next = {
      beforeMin: Math.min(4, Math.max(1, Math.min(v.beforeMin || 1, v.beforeMax || 4))),
      beforeMax: Math.min(4, Math.max(1, v.beforeMax || 4)),
      afterMin: Math.min(4, Math.max(1, Math.min(v.afterMin || 1, v.afterMax || 4))),
      afterMax: Math.min(4, Math.max(1, v.afterMax || 4)),
    };
    next.beforeMax = Math.max(next.beforeMax, next.beforeMin);
    next.afterMax = Math.max(next.afterMax, next.afterMin);
    setV(next);
    await supabase.from("families").update({ task_before_photo_min: next.beforeMin, task_before_photo_max: next.beforeMax, task_after_photo_min: next.afterMin, task_after_photo_max: next.afterMax }).eq("id", fam.familyId);
    await fam.reload();
  }
  return (
    <section className="card">
      <button className="row between wide plain" onClick={() => setOpen((x) => !x)}><h2>Görev ayarları</h2><span aria-hidden>{open ? "⌃" : "⌄"}</span></button>
      {open && <div className="stack">
        <div>
          <h3>Görev kanıtları</h3>
          <select value={fam.family?.proof_retention_days ?? 0} onChange={(e) => supabase.from("families").update({ proof_retention_days: Number(e.target.value) }).eq("id", fam.familyId).then(() => fam.reload())}>
            <option value={0}>Fotoğraflar hemen silinsin</option><option value={7}>7 gün saklansın</option><option value={30}>30 gün saklansın</option>
          </select>
        </div>
        <div>
          <h3>Görev fotoğraf varsayılanları</h3>
          <div className="grid2">
            <label className="field"><span>Başlangıç: en az / en fazla</span><div className="row gap-xs"><input type="number" min={1} max={4} value={v.beforeMin} onChange={(e) => setV({ ...v, beforeMin: Number(e.target.value) })} /><input type="number" min={1} max={4} value={v.beforeMax} onChange={(e) => setV({ ...v, beforeMax: Number(e.target.value) })} /></div></label>
            <label className="field"><span>Tamamlanma: en az / en fazla</span><div className="row gap-xs"><input type="number" min={1} max={4} value={v.afterMin} onChange={(e) => setV({ ...v, afterMin: Number(e.target.value) })} /><input type="number" min={1} max={4} value={v.afterMax} onChange={(e) => setV({ ...v, afterMax: Number(e.target.value) })} /></div></label>
          </div>
          <button className="btn small" onClick={save}>Varsayılanı kaydet</button>
        </div>
      </div>}
    </section>
  );
}
