import { useState } from "react";
import { Link } from "react-router-dom";
import { useFamily } from "../lib/family";
import { errorText, supabase } from "../lib/supabase";
import type { Child } from "../lib/types";
import { Icon } from "../components/Icon";
import { RuleCard, WeekGrid, addRule } from "../components/RuleEditor";

/** Müzik: çocuk başına ne zaman çalabileceği, klasör ve müzik programı. */
export default function Music() {
  const fam = useFamily();
  const [err, setErr] = useState("");
  const [openRule, setOpenRule] = useState<string | null>(null);
  const rules = fam.timeRules.filter((r) => r.kind === "music_off" || r.kind === "music_on");

  async function add() {
    try {
      const id = await addRule(fam.familyId, "music_off", null, "Gece müzik yok", "22:00", "07:00", [1, 2, 3, 4, 5, 6, 7]);
      await fam.reload();
      setOpenRule(id);
    } catch (e) {
      setErr(errorText(e));
    }
  }

  return (
    <div className="page">
      <header className="page-head">
        <Link to="/rules" className="icon-btn" aria-label="Geri">
          <Icon name="back" />
        </Link>
        <h1>🎵 Müzik</h1>
        <span />
      </header>
      {err && <p className="error">{err}</p>}
      <p className="muted small">Orbit'teki müzik çalar süreden düşmez; arka planda ve ekran kapalıyken de çalar. Kilitliyken çalması için kilit ekranında "Müzik" açık olmalı.</p>
      {fam.children.map((c) => (
        <ChildMusic key={c.id} child={c} onErr={setErr} />
      ))}
      <section className="stack">
        <div className="row between">
          <h2 className="section-title">Müzik programı</h2>
          <button className="btn small" onClick={add}>
            <Icon name="plus" size={16} /> Kural
          </button>
        </div>
        <p className="muted small">"Programa göre" seçili çocuklarda geçerli. "Müzik açık" kuralı, aynı saatteki "Müzik kapalı" kuralını geçersiz kılar.</p>
        {rules.length > 0 && (
          <div className="card">
            <WeekGrid rules={rules} onPick={(id) => setOpenRule(id)} />
          </div>
        )}
        {rules.map((r) => (
          <RuleCard key={r.id} r={r} kinds={["music_off", "music_on"]} open={openRule === r.id} onToggle={() => setOpenRule(openRule === r.id ? null : r.id)} onErr={setErr} />
        ))}
      </section>
    </div>
  );
}

function ChildMusic({ child, onErr }: { child: Child; onErr: (e: string) => void }) {
  const fam = useFamily();
  async function save(v: Record<string, unknown>) {
    onErr("");
    const { error } = await supabase.from("children").update(v).eq("id", child.id);
    if (error) onErr(errorText(error));
    fam.reload();
  }
  return (
    <div className="card">
      <b>
        <span className="dot" style={{ background: child.color, marginTop: 0 }} /> {child.name}
      </b>
      <label className="field">
        <span>Ne zaman çalabilir</span>
        <select value={child.music_mode ?? "rules"} onChange={(e) => save({ music_mode: e.target.value })}>
          <option value="rules">Programa göre</option>
          <option value="always">Her zaman</option>
          <option value="never">Hiç (müzik kapalı)</option>
        </select>
      </label>
      <label className="field">
        <span>Klasör</span>
        <select value={child.music_folder ?? ""} onChange={(e) => save({ music_folder: e.target.value || null })}>
          <option value="">Çocuk kendisi seçsin</option>
          {(child.music_folders ?? []).map((f) => (
            <option key={f} value={f}>
              📁 {f}
            </option>
          ))}
        </select>
      </label>
      {!(child.music_folders ?? []).length && <p className="muted tiny">Klasörler, çocuk telefonda Müzik ekranını ilk açtığında burada görünür.</p>}
    </div>
  );
}
