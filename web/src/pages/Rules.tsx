import { Link, useNavigate } from "react-router-dom";
import { ClosedModePicker } from "../components/ClosedModePicker";
import { closedModeOf, type ClosedMode } from "../lib/actions";
import { useFamily } from "../lib/family";
import { supabase, errorText } from "../lib/supabase";
import { daysText, hhmm, minutesText } from "../lib/util";
import { Icon } from "../components/Icon";
import { Info } from "../components/Info";
import { useState } from "react";
import { createDefaultSections } from "./ProfileEdit";
import { mins } from "../lib/sections";
import type { Child, Profile } from "../lib/types";
import Lock from "./Lock";

export default function Rules() {
  const fam = useFamily();
  const nav = useNavigate();
  const [err, setErr] = useState("");

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

  async function newAppRule() {
    const { data, error } = await supabase.from("app_usage_rules").insert({ family_id: fam.familyId, name: "Yeni uygulama kuralı", mode: "timed", max_minutes: 30, counts_toward_daily: true }).select("id").single();
    if (error) return setErr(errorText(error));
    await fam.reload();
    nav(`/rules/app-rule/${data.id}`);
  }

  return (
    <div className="page">
      <header className="page-head">
        <h1>Kurallar</h1>
      </header>
      {err && <p className="error">{err}</p>}

      <details className="card section-collapse-card">
        <summary className="section-collapse-head"><span>🔒 Kilit <Info>Eski kilit kuralları korunur; yeni kullanım profilleri bunların yerine geçebilir.</Info></span><span className="collapse-arrow" aria-hidden="true" /></summary>
        <Lock inline />
      </details>

      <details className="card section-collapse-card">
        <summary className="section-collapse-head"><span>⏳ Verilen süre nasıl kullanılsın · varsayılan <Info>Açık saatlerde “hemen” süre verince nasıl kullanılacağı (önce o anki kullanım profilinin “Bu profildeyken süre verirsem” ayarı geçerli). Kilit, Tam kilit ve kapalı saatlerde verilen süre bu ayardan bağımsız olarak her zaman saat gibi akar: verildiği andan itibaren o kadar dakika açık, bitince kilit geri gelir.</Info></span><span className="collapse-arrow" aria-hidden="true" /></summary>
        <div className="stack">
          {fam.children.map((c) => (
            <ClosedGrantSetting key={c.id} child={c} />
          ))}
        </div>
      </details>

      <details className="card section-collapse-card">
        <summary className="section-collapse-head"><span>Uygulama grupları</span><span className="collapse-arrow" aria-hidden="true" /></summary>
        <Link to="/rules/groups" className="link-card inner-link">
          <div className="row wrap gap-s">
            {fam.groups.map((g) => <span className="pill" key={g.id} style={{ borderColor: g.color }}>{g.name} · {Object.values(fam.members).filter((x) => x === g.id).length}</span>)}
            {!fam.groups.length && <span className="muted small">Grupları yönet</span>}
          </div>
          <Icon name="chevron" size={18} />
        </Link>
      </details>

      <details className="card section-collapse-card">
        <summary className="section-collapse-head"><span>Uygulama kullanım kuralları <Info>Uygulamanın ne kadar açık kalacağını ve günlük süreden düşüp düşmeyeceğini tanımlar.</Info></span><span className="collapse-arrow" aria-hidden="true" /></summary>
        <div className="stack">
          <div className="row between"><span className="muted small">Uygulamaların süre ve izin kuralları</span><button className="btn small" onClick={newAppRule}><Icon name="plus" size={16} /> Yeni</button></div>
          {fam.appUsageRules.map((r) => <Link to={`/rules/app-rule/${r.id}`} className="card link-card" key={r.id}><div className="grow"><b>{r.name}</b><div className="muted small">{r.mode === "open" ? "Açık" : r.mode === "blocked" ? "Kapalı" : `${r.max_minutes == null ? "Sınırsız" : `${r.max_minutes} dk`} · ${r.counts_toward_daily ? "günlük süreden düşer" : "günlük süreden düşmez"}`}{r.start_time && r.end_time ? ` · ${r.start_time.slice(0, 5)}–${r.end_time.slice(0, 5)}` : ""}</div></div><Icon name="chevron" size={18} /></Link>)}
        </div>
      </details>

      <details className="card section-collapse-card">
        <summary className="section-collapse-head"><span>Günlük program <Info>Hafta içi, hafta sonu ve özel günlerin hangi kullanım profiline bağlanacağını ve saatlerini tutar.</Info></span><span className="collapse-arrow" aria-hidden="true" /></summary>
        <div className="stack">
          <div className="row between"><span className="muted small">Gün ve saat profilleri</span><button className="btn small" onClick={newProfile}><Icon name="plus" size={16} /> Yeni</button></div>
          {fam.profiles.map((p) => {
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
        </div>
      </details>

      <details className="card section-collapse-card">
        <summary className="section-collapse-head"><span>Odak profilleri <Info>Sayaç çalışırken telefonda nelerin açık kalacağını belirler. Kuralların üstüne yalnızca ek kısıt koyar.</Info></span><span className="collapse-arrow" aria-hidden="true" /></summary>
        <div className="stack">
          <div className="row between"><span className="muted small">Sayaç ve etkinlik profilleri</span><button className="btn small" onClick={newFocus}><Icon name="plus" size={16} /> Yeni</button></div>
          {fam.focusProfiles.map((f) => (
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
          <Link to="/rules/activities" className="card link-card">
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
          </Link>
        </div>
      </details>

      <details className="card section-collapse-card">
        <summary className="section-collapse-head"><span>Kullanım profilleri <Info>Uyku, ders, dinlenme ve serbest gibi profillerde kiosk, menü, uygulama ve süre davranışını belirler.</Info></span><span className="collapse-arrow" aria-hidden="true" /></summary>
        <div className="stack">
          <div className="row between"><span className="muted small">Kiosk, uygulama ve süre profilleri</span><button className="btn small" onClick={newMode}><Icon name="plus" size={16} /> Yeni</button></div>
          {[...fam.modes].sort((a, b) => {
            const o = ["open", "timed", "blocked", "kiosk"];
            const ia = a.builtin ? o.indexOf(a.builtin) : 99, ib = b.builtin ? o.indexOf(b.builtin) : 99;
            return ia - ib || a.name.localeCompare(b.name, "tr");
          }).map((m) => (
          <Link to={`/rules/mode/${m.id}`} className="card link-card" key={m.id}>
            <span className="dot" style={{ background: m.color }} />
            <div className="grow">
              <b>{m.name}</b>{m.builtin && <span className="pill small"> hazır</span>}
              <div className="muted small">
                {m.budget_minutes != null ? `${minutesText(m.budget_minutes)} süre` : "Süre sınırı yok"}
                {" · "}
                {m.counts_toward_daily ? "günlük süreden düşer" : "günlük süreyi etkilemez"}
                {" · "}
                {m.others_blocked ? "diğerleri kapalı" : "diğerleri normal"}
                {m.kiosk_enabled ? " · tam kilit" : ""}
                {m.kiosk_screens?.length ? ` · Orbit'te ${m.kiosk_screens.length} ekran` : ""}
              </div>
            </div>
            <Icon name="chevron" size={18} />
          </Link>
          ))}
        </div>
      </details>
    </div>
  );
}

function ClosedGrantSetting({ child }: { child: Child }) {
  const fam = useFamily();
  const [err, setErr] = useState("");
  async function save(v: ClosedMode) {
    setErr("");
    const { error } = await supabase
      .from("children")
      .update({ closed_grant_mode: v.mode, closed_grant_within_minutes: v.mode === "within" ? v.withinMinutes : child.closed_grant_within_minutes ?? null, closed_grant_within_factor: v.mode === "within" ? v.withinFactor : child.closed_grant_within_factor ?? null })
      .eq("id", child.id);
    if (error) setErr(errorText(error));
    fam.reload();
  }
  return (
    <div className="closed-mode-row">
      <b className="closed-mode-name">
        <span className="dot" style={{ background: child.color, marginTop: 0 }} /> {child.name}
      </b>
      <ClosedModePicker value={closedModeOf(child)} onChange={save} />
      {err && <p className="error">{err}</p>}
    </div>
  );
}
