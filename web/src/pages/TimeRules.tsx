import { useState } from "react";
import { Link } from "react-router-dom";
import { useFamily } from "../lib/family";
import { errorText, supabase } from "../lib/supabase";
import { hhmm } from "../lib/util";
import type { KioskScreen, TimeRule } from "../lib/types";
import { Icon } from "../components/Icon";
import { DayPicker } from "../components/Windows";
import { ScreenPicker } from "./LockTab";

const KINDS: [TimeRule["kind"], string][] = [
  ["kiosk", "🔒 Tam kilit"],
  ["music_off", "🔇 Müzik kapalı"],
  ["music_on", "🎵 Müzik açık"],
];

/** Bölümlerden bağımsız zaman kuralları: tam kilit, müzik kapalı / açık. */
export default function TimeRules() {
  const fam = useFamily();
  const [err, setErr] = useState("");

  async function add() {
    setErr("");
    const { error } = await supabase.from("time_rules").insert({
      family_id: fam.familyId,
      name: "Ders saati",
      kind: "kiosk",
      start_time: "16:00",
      end_time: "17:00",
      days: [1, 2, 3, 4, 5],
    });
    if (error) setErr(errorText(error));
    fam.reload();
  }

  return (
    <div className="page">
      <header className="page-head">
        <Link to="/rules" className="icon-btn" aria-label="Geri">
          <Icon name="back" />
        </Link>
        <h1>Zaman kuralları</h1>
        <button className="btn small" onClick={add}>
          <Icon name="plus" size={16} /> Ekle
        </button>
      </header>
      {err && <p className="error">{err}</p>}
      <p className="muted small">
        Gün bölümlerinden bağımsız saatler: belirli günlerde belirli saatlerde tam kilit, ya da müziği kapat / aç. "Müzik açık" kuralı bölümün müziği kapatmasını o saatte geçersiz kılar.
      </p>
      {!fam.timeRules.length && <p className="muted small">Henüz kural yok.</p>}
      {fam.timeRules.map((r) => (
        <RuleCard key={r.id} r={r} onErr={setErr} />
      ))}
    </div>
  );
}

function RuleCard({ r, onErr }: { r: TimeRule; onErr: (e: string) => void }) {
  const fam = useFamily();
  const [name, setName] = useState(r.name);
  const [message, setMessage] = useState(r.message ?? "");

  async function patch(v: Partial<TimeRule>) {
    onErr("");
    const { error } = await supabase.from("time_rules").update(v).eq("id", r.id);
    if (error) onErr(errorText(error));
    fam.reload();
  }
  async function remove() {
    if (!confirm(`"${r.name}" silinsin mi?`)) return;
    await supabase.from("time_rules").delete().eq("id", r.id);
    fam.reload();
  }
  const toggleChild = (id: string) =>
    patch({ child_ids: r.child_ids.includes(id) ? r.child_ids.filter((x) => x !== id) : [...r.child_ids, id] });

  return (
    <div className={`card ${r.active ? "" : "muted"}`}>
      <div className="row gap-s">
        <input className="grow" value={name} onChange={(e) => setName(e.target.value)} onBlur={() => name.trim() && name !== r.name && patch({ name: name.trim() })} aria-label="Ad" />
        <label className="check">
          <input type="checkbox" checked={r.active} onChange={(e) => patch({ active: e.target.checked })} /> Etkin
        </label>
        <button className="icon-btn" aria-label="Sil" onClick={remove}>
          <Icon name="trash" size={18} />
        </button>
      </div>
      <div className="row gap-xs wrap">
        {KINDS.map(([k, l]) => (
          <button key={k} className={`chip small ${r.kind === k ? "on" : ""}`} onClick={() => patch({ kind: k })}>
            {l}
          </button>
        ))}
      </div>
      <div className="row gap-s" style={{ alignItems: "center" }}>
        <input type="time" defaultValue={hhmm(r.start_time)} key={`s${r.start_time}`} onBlur={(e) => e.target.value && e.target.value !== hhmm(r.start_time) && patch({ start_time: e.target.value })} aria-label="Başlangıç" />
        <span className="muted">–</span>
        <input type="time" defaultValue={hhmm(r.end_time)} key={`e${r.end_time}`} onBlur={(e) => e.target.value && e.target.value !== hhmm(r.end_time) && patch({ end_time: e.target.value })} aria-label="Bitiş" />
      </div>
      <DayPicker value={r.days} onChange={(d) => patch({ days: d })} />
      <div className="row gap-xs wrap">
        <span className="small">Kime:</span>
        <button className={`chip small ${!r.child_ids.length ? "on" : ""}`} onClick={() => patch({ child_ids: [] })}>
          Hepsi
        </button>
        {fam.children.map((c) => (
          <button key={c.id} className={`chip small ${r.child_ids.includes(c.id) ? "on" : ""}`} onClick={() => toggleChild(c.id)}>
            {c.name}
          </button>
        ))}
      </div>
      {r.kind === "kiosk" && (
        <>
          <input value={message} onChange={(e) => setMessage(e.target.value)} onBlur={() => message !== (r.message ?? "") && patch({ message: message.trim() || null })} placeholder="Çocuğa mesaj (boş = varsayılan)" />
          <label className="check">
            <input type="checkbox" checked={r.screens == null} onChange={(e) => patch({ screens: e.target.checked ? null : ["tasks", "messages"] })} /> Açık ekranlar: çocuğun varsayılanı
          </label>
          {r.screens != null && <ScreenPicker value={r.screens} onChange={(v: KioskScreen[]) => patch({ screens: v })} />}
        </>
      )}
    </div>
  );
}
