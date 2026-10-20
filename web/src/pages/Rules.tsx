import { Link, useNavigate } from "react-router-dom";
import { useFamily } from "../lib/family";
import { supabase, errorText } from "../lib/supabase";
import { daysText, hhmm, minutesText } from "../lib/util";
import { Icon } from "../components/Icon";
import { useState } from "react";

export default function Rules() {
  const fam = useFamily();
  const nav = useNavigate();
  const [err, setErr] = useState("");

  async function newProfile() {
    const { data, error } = await supabase
      .from("rule_profiles")
      .insert({ family_id: fam.familyId, name: "Yeni profil", daily_minutes: 90 })
      .select("id")
      .single();
    if (error) return setErr(errorText(error));
    await fam.reload();
    nav(`/rules/profile/${data.id}`);
  }

  async function newMode() {
    const { data, error } = await supabase
      .from("modes")
      .insert({ family_id: fam.familyId, name: "Yeni durum", allowed_groups: ["always_open"] })
      .select("id")
      .single();
    if (error) return setErr(errorText(error));
    await fam.reload();
    nav(`/rules/mode/${data.id}`);
  }

  return (
    <div className="page">
      <header className="page-head">
        <h1>Kurallar</h1>
      </header>
      {err && <p className="error">{err}</p>}

      <section className="stack">
        <div className="row between">
          <h2 className="section-title">Kural profilleri</h2>
          <button className="btn small" onClick={newProfile}>
            <Icon name="plus" size={16} /> Yeni
          </button>
        </div>
        <p className="muted small">Bir profil bir günün kurallarıdır: günlük süre, izinli saatler ve o gün geçerli durumlar.</p>
        {fam.profiles.map((p) => {
          const slots = fam.slots.filter((s) => s.profile_id === p.id);
          return (
            <Link to={`/rules/profile/${p.id}`} className="card link-card" key={p.id}>
              <div className="grow">
                <b>{p.name}</b>
                <div className="muted small">
                  Günlük {minutesText(p.daily_minutes)}
                  {p.max_total_minutes ? ` · en fazla ${minutesText(p.max_total_minutes)}` : ""}
                </div>
                {slots.length > 0 && (
                  <div className="row wrap gap-s">
                    {slots.map((s) => {
                      const m = fam.modes.find((x) => x.id === s.mode_id);
                      return (
                        <span className="pill" key={s.id} style={{ borderColor: m?.color }}>
                          {m?.name} {hhmm(s.start_time)}–{hhmm(s.end_time)}
                          {s.days.length < 7 ? ` · ${daysText(s.days)}` : ""}
                        </span>
                      );
                    })}
                  </div>
                )}
              </div>
              <Icon name="chevron" size={18} />
            </Link>
          );
        })}
      </section>

      <section className="stack">
        <div className="row between">
          <h2 className="section-title">Durumlar</h2>
          <button className="btn small" onClick={newMode}>
            <Icon name="plus" size={16} /> Yeni
          </button>
        </div>
        <p className="muted small">
          Ders, uyku, oyun zamanı gibi kendi durumlarını oluştur: hangi uygulamalar açık, kendi süresi var mı, günlük süreyi
          etkiliyor mu.
        </p>
        {fam.modes.map((m) => (
          <Link to={`/rules/mode/${m.id}`} className="card link-card" key={m.id}>
            <span className="dot" style={{ background: m.color }} />
            <div className="grow">
              <b>{m.name}</b>
              <div className="muted small">
                {m.budget_minutes != null ? `${minutesText(m.budget_minutes)} süre` : "Süre sınırı yok"}
                {" · "}
                {m.counts_toward_daily ? "günlük süreden düşer" : "günlük süreyi etkilemez"}
                {" · "}
                {m.others_blocked ? "diğerleri kapalı" : "diğerleri normal"}
              </div>
            </div>
            <Icon name="chevron" size={18} />
          </Link>
        ))}
      </section>
    </div>
  );
}
