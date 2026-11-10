import { useEffect, useState } from "react";
import { TimeField } from "../components/DateTime";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useFamily } from "../lib/family";
import { errorText, supabase } from "../lib/supabase";
import { daysText, hhmm, minutesText } from "../lib/util";
import { type ModeSlot, type Profile, type SecRule, type Section } from "../lib/types";
import { DayPicker, WindowsEditor } from "../components/Windows";
import { Icon } from "../components/Icon";
import { Info } from "../components/Info";
import { SectionTable } from "../components/SectionTable";
import { mins, sectionWarnings } from "../lib/sections";

const SECTION_COLORS = ["#4F7CFF", "#2BB673", "#F2B134", "#FF7A59", "#E85D9B", "#3FA7D6", "#6B5CE7"];

function timeOverlap(aStart: string, aEnd: string, bStart: string, bEnd: string) {
  const spans = (start: string, end: string) => {
    const s = mins(start); const e = mins(end);
    return s < e ? [[s, e]] : [[s, 1440], [0, e]];
  };
  return spans(aStart, aEnd).some(([a, b]) => spans(bStart, bEnd).some(([c, d]) => a < d && c < b));
}

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
  const BUILT_ORDER = ["open", "timed", "blocked", "kiosk"];
  const modeOptions = [...fam.modes].sort((a, b) => {
    const ia = a.builtin ? BUILT_ORDER.indexOf(a.builtin) : 99, ib = b.builtin ? BUILT_ORDER.indexOf(b.builtin) : 99;
    return ia - ib || a.name.localeCompare(b.name, "tr");
  });
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
    const { error } = await supabase.from("profile_sections").delete().eq("id", s.id);
    if (error) return setErr(errorText(error));
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
            <TimeField value={hhmm(s.start_time)} onCommit={(v) => v && patch(s, { start_time: v })} label="Başlangıç" />
            <span className="muted">–</span>
            <TimeField value={hhmm(s.end_time)} onCommit={(v) => v && patch(s, { end_time: v })} label="Bitiş" />
            <label className="row gap-xs">
              <input
                className="mini"
                type="number"
                min={0}
                placeholder="sınırsız"
                defaultValue={s.budget_minutes ?? ""}
                key={`b-${s.id}-${s.budget_minutes}`}
                onBlur={(e) => {
                  const v = e.target.value === "" ? null : Number(e.target.value);
                  if (v !== s.budget_minutes) patch(s, { budget_minutes: v });
                }}
                aria-label="Bölüm süresi (dk)"
              />
              <span className="muted small">dk süre (0 = süre yok, boş = sınırsız)</span>
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
              <span className="muted small">Bu saatlerde:</span>
              <select value={s.mode_id ?? ""} onChange={(e) => e.target.value && patch(s, { mode_id: e.target.value })}>
                {!s.mode_id && <option value="">—</option>}
                {modeOptions.map((m) => (
                  <option key={m.id} value={m.id}>{m.builtin ? `${m.name} — ${BUILTIN_HINT[m.builtin]}` : `${m.name} (kullanım profili)`}</option>
                ))}
              </select>
              {s.mode_id && <Link className="link small" to={`/rules/mode/${s.mode_id}`}>Profil ayarları ›</Link>}
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

const BUILTIN_HINT: Record<string, string> = {
  open: "her şey açık, süre sayılmaz",
  timed: "süreden düşer, bitince kapanır",
  blocked: "sadece seçili uygulamalar açık",
  kiosk: "sadece Orbit ekranı",
};

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
    if (slots.some((s) => s.days.some((d) => slot.days.includes(d)) && timeOverlap(s.start_time, s.end_time, slot.start, slot.end))) {
      return setErr("Bu gün ve saat aralığı başka bir kullanım profiliyle çakışıyor.");
    }
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
        <h1>Günlük program</h1>
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
            <h2>Bölümler <Info>Günü bölümlere ayır; her bölümün kendi süresi ve uygulama kuralları olur.</Info></h2>
            <SectionsEditor profile={p} sections={sections} />
          </div>
          <div className="card">
            <h2>Kurallar <Info>Her grubun ve uygulamanın bölümde açık, süreli veya kapalı olacağını seç.</Info></h2>
            <SectionTable profile={p} sections={sections} />
          </div>
        </>
      ) : (
        <>
          <div className="card attention">
            <h2>Bölümlere geç <Info>Eski tek süre düzeninden bölümlü programa geçer.</Info></h2>
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
        <h2>Bu programdaki kullanım profilleri <Info>Aynı gün ve saatte iki profil çalıştırılamaz; çakışmalar kaydedilmez.</Info></h2>
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
            <option value="">Profil seç</option>
            {fam.modes.filter((x) => !x.builtin).map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
          <div className="row gap-s">
            <TimeField value={slot.start} onChange={(v) => setSlot({ ...slot, start: v })} />
            <span className="muted">–</span>
            <TimeField value={slot.end} onChange={(v) => setSlot({ ...slot, end: v })} />
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
