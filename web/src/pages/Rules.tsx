import { Link, useNavigate } from "react-router-dom";
import { useFamily } from "../lib/family";
import { supabase, errorText } from "../lib/supabase";
import { daysText, hhmm, minutesText } from "../lib/util";
import { Icon } from "../components/Icon";
import { Info } from "../components/Info";
import { useState } from "react";
import { createDefaultSections } from "./ProfileEdit";
import { mins } from "../lib/sections";
import type { Profile } from "../lib/types";
import Lock from "./Lock";

export default function Rules() {
  const fam = useFamily();
  const nav = useNavigate();
  const [err, setErr] = useState("");
  const [open, setOpen] = useState({ days: false, focus: false, modes: false, groups: false, lock: false });

  async function newProfile() {
    const { data, error } = await supabase
      .from("rule_profiles")
      .insert({ family_id: fam.familyId, name: "Yeni gün tipi", daily_minutes: 90 })
      .select("*")
      .single();
    if (error) return setErr(errorText(error));
    await createDefaultSections(data as Profile);
    await fam.reload();
    nav(`/rules/profile/${data.id}`);
  }

  async function newFocus() {
    const { data, error } = await supabase
      .from("focus_profiles")
      .insert({ family_id: fam.familyId, name: "Yeni odak", icon: "🎯", sort_order: fam.focusProfiles.length })
      .select("id")
      .single();
    if (error) return setErr(errorText(error));
    await fam.reload();
    nav(`/rules/focus/${data.id}`);
  }

  async function newMode() {
    const { data, error } = await supabase
      .from("modes")
      .insert({ family_id: fam.familyId, name: "Yeni kullanım profili", allowed_groups: ["always_open"] })
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

      <details className="card section-collapse-card" open={open.lock} onToggle={(e) => setOpen((v) => ({ ...v, lock: e.currentTarget.open }))}>
        <summary className="section-collapse-head"><span>🔒 Kilit <Info>Eski kilit kuralları korunur; yeni kullanım profilleri bunların yerine geçebilir.</Info></span><span>⌄</span></summary>
        {open.lock && <Lock inline />}
      </details>

      <details className="card section-collapse-card" open={open.groups} onToggle={(e) => setOpen((v) => ({ ...v, groups: e.currentTarget.open }))}>
        <summary className="section-collapse-head"><span>Uygulama grupları</span><span>⌄</span></summary>
        {open.groups && <Link to="/rules/groups" className="link-card inner-link">
          <div className="row wrap gap-s">
            {fam.groups.map((g) => <span className="pill" key={g.id} style={{ borderColor: g.color }}>{g.name} · {Object.values(fam.members).filter((x) => x === g.id).length}</span>)}
          </div>
          <Icon name="chevron" size={18} />
        </Link>}
      </details>

      <section className="stack">
        <div className="row between">
          <button type="button" className="section-title row gap-xs collapse-title" onClick={() => setOpen((v) => ({ ...v, days: !v.days }))}>
            <span>{open.days ? "⌃" : "⌄"}</span><span>Günlük program</span><Info>Hafta içi, hafta sonu ve özel günlerin hangi kullanım profiline bağlanacağını ve saatlerini tutar.</Info>
          </button>
          {open.days && <button className="btn small" onClick={newProfile}>
            <Icon name="plus" size={16} /> Yeni
          </button>}
        </div>
        {open.days && fam.profiles.map((p) => {
          const slots = fam.slots.filter((s) => s.profile_id === p.id);
          const secs = fam.sections.filter((s) => s.profile_id === p.id).sort((a, b) => mins(a.start_time) - mins(b.start_time));
          return (
            <Link to={`/rules/profile/${p.id}`} className="card link-card" key={p.id}>
              <div className="grow">
                <b>{p.name}</b>
                <div className="muted small">
                  {secs.length ? `${secs.length} bölüm` : `Günlük ${minutesText(p.daily_minutes)} (eski düzen)`}
                  {p.max_total_minutes ? ` · günde en fazla ${minutesText(p.max_total_minutes)}` : ""}
                </div>
                {secs.length > 0 && (
                  <div className="row wrap gap-s">
                    {secs.map((s) => (
                      <span className="pill" key={s.id} style={{ borderColor: s.color }}>
                        {s.name} {hhmm(s.start_time)}–{hhmm(s.end_time)}
                        {s.budget_minutes != null ? ` · ${minutesText(s.budget_minutes)}` : ""}
                      </span>
                    ))}
                  </div>
                )}
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
          <button type="button" className="section-title row gap-xs collapse-title" onClick={() => setOpen((v) => ({ ...v, focus: !v.focus }))}>
            <span>{open.focus ? "⌃" : "⌄"}</span><span>Odak profilleri</span><Info>Sayaç çalışırken telefonda nelerin açık kalacağını belirler. Kuralların üstüne yalnızca ek kısıt koyar.</Info>
          </button>
          {open.focus && <button className="btn small" onClick={newFocus}>
            <Icon name="plus" size={16} /> Yeni
          </button>}
        </div>
        {open.focus && fam.focusProfiles.map((f) => (
          <Link to={`/rules/focus/${f.id}`} className="card link-card" key={f.id}>
            <span style={{ fontSize: 22 }}>{f.icon ?? "🎯"}</span>
            <div className="grow">
              <b>{f.name}</b>
              <div className="muted small">
                {f.allowed_groups.length + f.allowed_packages.length
                  ? `${f.allowed_groups.length} grup, ${f.allowed_packages.length} uygulama açık`
                  : "hiçbir uygulama açık değil"}
                {f.allowed_screens.length ? ` · ${f.allowed_screens.length} Orbit menüsü` : ""}
                {" · "}
                {f.messages_allowed ? "mesaj açık" : "mesaj kapalı"}
                {f.calls_allowed ? "" : " · arama kapalı"}
              </div>
            </div>
            <Icon name="chevron" size={18} />
          </Link>
        ))}
        {open.focus && <Link to="/rules/activities" className="card link-card">
          <div className="grow">
            <b>Etkinlikler</b>
            <div className="row wrap gap-s">
              {fam.activities.map((a) => (
                <span className="pill" key={a.id}>
                  {a.icon} {a.name}
                </span>
              ))}
            </div>
          </div>
          <Icon name="chevron" size={18} />
        </Link>}
      </section>

      <section className="stack">
        <div className="row between">
          <button type="button" className="section-title row gap-xs collapse-title" onClick={() => setOpen((v) => ({ ...v, modes: !v.modes }))}>
            <span>{open.modes ? "⌃" : "⌄"}</span><span>Kullanım profilleri</span><Info>Uyku, ders, dinlenme ve serbest gibi profillerde kiosk, menü, uygulama ve süre davranışını belirler.</Info>
          </button>
          {open.modes && <button className="btn small" onClick={newMode}>
            <Icon name="plus" size={16} /> Yeni
          </button>}
        </div>
        {open.modes && fam.modes.map((m) => (
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
                {m.kiosk_enabled ? ` · kiosk${m.kiosk_screens?.length ? ` · ${m.kiosk_screens.length} menü` : ""}` : ""}
              </div>
            </div>
            <Icon name="chevron" size={18} />
          </Link>
        ))}
      </section>
    </div>
  );
}
