import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useFamily } from "../lib/family";
import { errorText, supabase } from "../lib/supabase";
import { daysText, hhmm, minutesText } from "../lib/util";
import { RULE_LABEL, type ModeSlot, type Profile, type SecRule, type Section } from "../lib/types";
import { DayPicker, WindowsEditor } from "../components/Windows";
import { Icon } from "../components/Icon";
import { SectionTable } from "../components/SectionTable";
import { mins, sectionWarnings } from "../lib/sections";

const SECTION_COLORS = ["#4F7CFF", "#2BB673", "#F2B134", "#FF7A59", "#E85D9B", "#3FA7D6", "#6B5CE7"];

/** Yeni gün tipine başlangıç bölümleri (eski düzenden geçişte de kullanılır). */
export async function createDefaultSections(p: Profile) {
  const start = p.timed_windows[0]?.start ?? "07:00";
  const end = p.timed_windows[0]?.end ?? "21:00";
  return supabase.from("profile_sections").insert([
    { profile_id: p.id, name: "Gündüz", start_time: start, end_time: end, budget_minutes: p.daily_minutes, default_rule: "timed", color: "#4F7CFF", sort_order: 0 },
    { profile_id: p.id, name: "Uyku", start_time: end, end_time: start, budget_minutes: null, default_rule: "blocked", color: "#6B5CE7", sort_order: 1 },
  ]);
}

function SectionsEditor({ profile, sections }: { profile: Profile; sections: Section[] }) {
  const fam = useFamily();
  const [err, setErr] = useState("");

  async function patch(s: Section, v: Partial<Section>) {
    setErr("");
    const { error } = await supabase.from("profile_sections").update(v).eq("id", s.id);
    if (error) setErr(errorText(error));
    fam.reload();
  }

  async function add() {
    const last = [...sections].sort((a, b) => mins(a.start_time) - mins(b.start_time)).filter((s) => mins(s.start_time) < mins(s.end_time)).pop();
    const start = last ? hhmm(last.end_time) : "16:00";
    const endM = (mins(start) + 60) % 1440;
    const end = `${String(Math.floor(endM / 60)).padStart(2, "0")}:${String(endM % 60).padStart(2, "0")}`;
    const { error } = await supabase.from("profile_sections").insert({
      profile_id: profile.id,
      name: "Yeni bölüm",
      start_time: start,
      end_time: end,
      budget_minutes: 30,
      default_rule: "timed",
      color: SECTION_COLORS[sections.length % SECTION_COLORS.length],
      sort_order: sections.length,
    });
    if (error) setErr(errorText(error));
    fam.reload();
  }

  async function remove(s: Section) {
    if (!confirm(`"${s.name}" bölümü silinsin mi? Bu bölümdeki kurallar da silinir.`)) return;
    await supabase.from("profile_sections").delete().eq("id", s.id);
    fam.reload();
  }

  const warnings = sectionWarnings(sections);
  return (
    <div className="stack-s">
      {err && <p className="error">{err}</p>}
      {sections.map((s) => (
        <div className="sub-card section-edit" key={s.id} style={{ borderLeft: `4px solid ${s.color}` }}>
          <div className="row gap-s wrap">
            <input
              className="mini"
              style={{ width: 52, textAlign: "center", fontSize: 20 }}
              defaultValue={s.icon ?? ""}
              key={`i-${s.id}-${s.icon}`}
              placeholder="🙂"
              maxLength={4}
              onBlur={(e) => e.target.value !== (s.icon ?? "") && patch(s, { icon: e.target.value.trim() || null })}
              aria-label="Simge (emoji)"
            />
            <input
              className="grow"
              defaultValue={s.name}
              key={`n-${s.id}-${s.name}`}
              onBlur={(e) => e.target.value.trim() && e.target.value !== s.name && patch(s, { name: e.target.value.trim() })}
              aria-label="Bölüm adı"
            />
            <button className="icon-btn" aria-label="Bölümü sil" onClick={() => remove(s)}>
              <Icon name="trash" size={18} />
            </button>
          </div>
          <div className="row gap-s wrap">
            <input type="time" value={hhmm(s.start_time)} onChange={(e) => e.target.value && patch(s, { start_time: e.target.value })} aria-label="Başlangıç" />
            <span className="muted">–</span>
            <input type="time" value={hhmm(s.end_time)} onChange={(e) => e.target.value && patch(s, { end_time: e.target.value })} aria-label="Bitiş" />
            <label className="row gap-xs">
              <input
                className="mini"
                type="number"
                min={0}
                placeholder="yok"
                defaultValue={s.budget_minutes ?? ""}
                key={`b-${s.id}-${s.budget_minutes}`}
                onBlur={(e) => {
                  const v = e.target.value === "" ? null : Number(e.target.value);
                  if (v !== s.budget_minutes) patch(s, { budget_minutes: v });
                }}
                aria-label="Bölüm süresi (dk)"
              />
              <span className="muted small">dk süre</span>
            </label>
          </div>
          <input
            defaultValue={s.message ?? ""}
            key={`m-${s.id}-${s.message}`}
            placeholder="Çocuğa mesaj (ör. İyi geceler, sabah 10'da açılır)"
            maxLength={140}
            onBlur={(e) => e.target.value !== (s.message ?? "") && patch(s, { message: e.target.value.trim() || null })}
            aria-label="Çocuğa mesaj"
          />
          <div className="row gap-s wrap">
            <label className="check">
              <input type="checkbox" checked={s.carry_over} onChange={(e) => patch(s, { carry_over: e.target.checked })} /> Kalan süre sonraki bölüme
              devretsin
            </label>
            <label className="row gap-xs">
              <span className="muted small">Diğer uygulamalar:</span>
              <select value={s.default_rule} onChange={(e) => patch(s, { default_rule: e.target.value as SecRule })}>
                {(["open", "timed", "blocked"] as SecRule[]).map((r) => (
                  <option key={r} value={r}>
                    {RULE_LABEL[r]}
                  </option>
                ))}
              </select>
            </label>
          </div>
        </div>
      ))}
      {warnings.map((w) => (
        <p className="warn-text small" key={w}>
          ⚠️ {w}
        </p>
      ))}
      <button className="btn" onClick={add}>
        <Icon name="plus" size={16} /> Bölüm ekle
      </button>
    </div>
  );
}

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

  if (!p) return <div className="page"><p className="muted">Gün tipi bulunamadı.</p></div>;
  const slots = fam.slots.filter((s) => s.profile_id === p.id);
  const sections = fam.sections.filter((s) => s.profile_id === p.id).sort((a, b) => mins(a.start_time) - mins(b.start_time));
  const hasSections = sections.length > 0;

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
    // Bölümler, kuralları ve grup sınırları da kopyalanır
    for (const sec of sections) {
      const { id: _old, profile_id: _p, ...rest } = sec;
      const { data: ns } = await supabase.from("profile_sections").insert({ ...rest, profile_id: data.id }).select("id").single();
      const rs = fam.sectionRules.filter((r) => r.section_id === sec.id);
      if (ns && rs.length)
        await supabase.from("section_rules").insert(rs.map(({ id: _i, section_id: _s, ...r }) => ({ ...r, section_id: ns.id })));
    }
    const lims = fam.groupLimits.filter((l) => l.profile_id === p!.id);
    if (lims.length) await supabase.from("profile_group_limits").insert(lims.map((l) => ({ ...l, profile_id: data.id })));
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
        <h1>Gün tipi</h1>
        <span />
      </header>
      {err && <p className="error">{err}</p>}
      <div className="card">
        <label className="field">
          <span>Ad</span>
          <input value={p.name} onChange={(e) => setP({ ...p, name: e.target.value })} />
        </label>
        <div className="grid2">
          {!hasSections && (
            <label className="field">
              <span>Günlük süre (dk)</span>
              <input type="number" min={0} value={p.daily_minutes} onChange={(e) => setP({ ...p, daily_minutes: Number(e.target.value) })} />
              <small className="muted">{minutesText(p.daily_minutes)}</small>
            </label>
          )}
          <label className="field">
            <span>{hasSections ? "Günlük üst sınır (dk, isteğe bağlı)" : "Ekstralarla en fazla (dk)"}</span>
            <input
              type="number"
              min={0}
              value={p.max_total_minutes ?? ""}
              placeholder="sınır yok"
              onChange={(e) => setP({ ...p, max_total_minutes: e.target.value === "" ? null : Number(e.target.value) })}
            />
            {hasSections && <small className="muted">Bölüm süreleri toplamı bunu geçse de gün içinde en fazla bu kadar. Ekstra süreler eklenir.</small>}
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
        <button className="btn primary" onClick={save}>
          {saved ? "Kaydedildi" : "Kaydet"}
        </button>
      </div>
      {hasSections ? (
        <>
          <div className="card">
            <h2>Bölümler</h2>
            <p className="muted small">
              Günü istediğin kadar bölüme ayır. Her bölümün kendi süresi olabilir; süreli uygulamalar o bölümün süresinden düşer.
            </p>
            <SectionsEditor profile={p} sections={sections} />
          </div>
          <div className="card">
            <h2>Kurallar</h2>
            <p className="muted small">Her grubun ve uygulamanın her bölümde açık, süreli ya da kapalı olacağını seç. Hücreye dokun.</p>
            <SectionTable profile={p} sections={sections} />
          </div>
        </>
      ) : (
        <>
          <div className="card attention">
            <h2>Bölümlere geç</h2>
            <p className="muted small">
              Bu gün tipi eski düzende (tek günlük süre + izinli saatler). Bölümlere geçince günü istediğin kadar parçaya ayırıp her grup için ayrı kural koyabilirsin.
            </p>
            <button
              className="btn primary"
              onClick={async () => {
                const { error } = await createDefaultSections(p);
                if (error) setErr(errorText(error));
                fam.reload();
              }}
            >
              Bölümlere geç
            </button>
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
        </>
      )}

      <div className="card">
        <h2>Bu gün tipindeki durumlar</h2>
        <p className="muted small">
          Durumlar bölüm kurallarının üstüne geçer (ör. Oyun zamanı 16:00–18:00). {hasSections ? "Uyku gibi saatleri artık bölüm olarak yapabilirsin; buradaki eski programı silebilirsin." : ""}
        </p>
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
          Gün tipini sil
        </button>
      </div>
    </div>
  );
}
