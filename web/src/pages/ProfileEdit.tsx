import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useFamily } from "../lib/family";
import { errorText, supabase } from "../lib/supabase";
import { daysText, hhmm, minutesText } from "../lib/util";
import type { ModeSlot, Profile } from "../lib/types";
import { DayPicker, WindowsEditor } from "../components/Windows";
import { Icon } from "../components/Icon";

export default function ProfileEdit() {
  const { id } = useParams();
  const fam = useFamily();
  const nav = useNavigate();
  const orig = fam.profiles.find((p) => p.id === id);
  const [p, setP] = useState<Profile | undefined>(orig);
  const [err, setErr] = useState("");
  const [saved, setSaved] = useState(false);
  const [slot, setSlot] = useState({ mode_id: "", days: [1, 2, 3, 4, 5, 6, 7], start: "16:00", end: "18:00" });

  useEffect(() => {
    if (orig && !p) setP(orig);
  }, [orig, p]);

  if (!p) return <div className="page"><p className="muted">Profil bulunamadı.</p></div>;
  const slots = fam.slots.filter((s) => s.profile_id === p.id);

  async function save() {
    setErr("");
    const { error } = await supabase
      .from("rule_profiles")
      .update({
        name: p!.name,
        daily_minutes: p!.daily_minutes,
        max_total_minutes: p!.max_total_minutes,
        timed_windows: p!.timed_windows,
        unlimited_windows: p!.unlimited_windows,
        warn_minutes: p!.warn_minutes,
      })
      .eq("id", p!.id);
    if (error) return setErr(errorText(error));
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
    fam.reload();
  }

  async function addSlot() {
    if (!slot.mode_id || !slot.days.length) return setErr("Durum ve gün seç.");
    if (slot.start === slot.end) return setErr("Başlangıç ve bitiş aynı olamaz.");
    const { error } = await supabase
      .from("mode_slots")
      .insert({ profile_id: p!.id, mode_id: slot.mode_id, days: slot.days, start_time: slot.start, end_time: slot.end });
    if (error) return setErr(errorText(error));
    setErr("");
    fam.reload();
  }

  async function removeSlot(s: ModeSlot) {
    await supabase.from("mode_slots").delete().eq("id", s.id);
    fam.reload();
  }

  async function duplicate() {
    const { data, error } = await supabase
      .from("rule_profiles")
      .insert({
        family_id: p!.family_id,
        name: `${p!.name} (kopya)`,
        daily_minutes: p!.daily_minutes,
        max_total_minutes: p!.max_total_minutes,
        timed_windows: p!.timed_windows,
        unlimited_windows: p!.unlimited_windows,
        warn_minutes: p!.warn_minutes,
      })
      .select("id")
      .single();
    if (error) return setErr(errorText(error));
    if (slots.length) {
      await supabase
        .from("mode_slots")
        .insert(slots.map((s) => ({ profile_id: data.id, mode_id: s.mode_id, days: s.days, start_time: s.start_time, end_time: s.end_time })));
    }
    await fam.reload();
    setP(undefined);
    nav(`/rules/profile/${data.id}`);
  }

  async function remove() {
    if (!confirm(`"${p!.name}" silinsin mi? Bu profile atanmış günler profilsiz kalır.`)) return;
    await supabase.from("rule_profiles").delete().eq("id", p!.id);
    await fam.reload();
    nav("/rules");
  }

  return (
    <div className="page">
      <header className="page-head">
        <Link to="/rules" className="icon-btn" aria-label="Geri">
          <Icon name="back" />
        </Link>
        <h1>Profil</h1>
        <span />
      </header>
      {err && <p className="error">{err}</p>}
      <div className="card">
        <label className="field">
          <span>Ad</span>
          <input value={p.name} onChange={(e) => setP({ ...p, name: e.target.value })} />
        </label>
        <div className="grid2">
          <label className="field">
            <span>Günlük süre (dk)</span>
            <input type="number" min={0} value={p.daily_minutes} onChange={(e) => setP({ ...p, daily_minutes: Number(e.target.value) })} />
            <small className="muted">{minutesText(p.daily_minutes)}</small>
          </label>
          <label className="field">
            <span>Ekstralarla en fazla (dk)</span>
            <input
              type="number"
              min={0}
              value={p.max_total_minutes ?? ""}
              placeholder="sınırsız"
              onChange={(e) => setP({ ...p, max_total_minutes: e.target.value === "" ? null : Number(e.target.value) })}
            />
          </label>
        </div>
        <label className="field">
          <span>Uyarı (bitmeden kaç dk önce, virgülle)</span>
          <input
            value={p.warn_minutes.join(", ")}
            onChange={(e) =>
              setP({
                ...p,
                warn_minutes: e.target.value
                  .split(",")
                  .map((x) => Number(x.trim()))
                  .filter((x) => x > 0),
              })
            }
          />
        </label>
      </div>
      <div className="card">
        <h2>Süreli uygulamaların izinli saatleri</h2>
        <WindowsEditor value={p.timed_windows} onChange={(w) => setP({ ...p, timed_windows: w })} emptyText="Gün boyu (süre bitene kadar)." />
      </div>
      <div className="card">
        <h2>Sınırsız uygulamaların açık olduğu saatler</h2>
        <WindowsEditor value={p.unlimited_windows} onChange={(w) => setP({ ...p, unlimited_windows: w })} emptyText="Gün boyu açık." />
      </div>
      <button className="btn primary wide" onClick={save}>
        {saved ? "Kaydedildi" : "Kaydet"}
      </button>

      <div className="card">
        <h2>Bu profildeki durumlar</h2>
        <p className="muted small">Örneğin Oyun zamanı 16:00–18:00, Uyku 21:00–07:00. Gece yarısını geçen aralıklar da olur.</p>
        {slots.map((s) => {
          const m = fam.modes.find((x) => x.id === s.mode_id);
          return (
            <div className="app-row" key={s.id}>
              <span className="dot" style={{ background: m?.color }} />
              <div className="grow">
                <b>{m?.name}</b>
                <div className="muted tiny">
                  {hhmm(s.start_time)}–{hhmm(s.end_time)} · {daysText(s.days)}
                </div>
              </div>
              <button className="icon-btn" aria-label="Sil" onClick={() => removeSlot(s)}>
                <Icon name="trash" size={18} />
              </button>
            </div>
          );
        })}
        <div className="sub-card">
          <select value={slot.mode_id} onChange={(e) => setSlot({ ...slot, mode_id: e.target.value })}>
            <option value="">Durum seç</option>
            {fam.modes.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
          <div className="row gap-s">
            <input type="time" value={slot.start} onChange={(e) => setSlot({ ...slot, start: e.target.value })} />
            <span className="muted">–</span>
            <input type="time" value={slot.end} onChange={(e) => setSlot({ ...slot, end: e.target.value })} />
          </div>
          <DayPicker value={slot.days} onChange={(d) => setSlot({ ...slot, days: d })} />
          <button className="btn" onClick={addSlot}>
            <Icon name="plus" size={16} /> Ekle
          </button>
        </div>
      </div>
      <div className="row gap-s">
        <button className="btn ghost" onClick={duplicate}>
          Kopyasını oluştur
        </button>
        <button className="btn ghost danger-text" onClick={remove}>
          Profili sil
        </button>
      </div>
    </div>
  );
}
