import { useEffect, useRef, useState } from "react";
import { DateField, TimeField } from "../components/DateTime";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useFamily } from "../lib/family";
import { errorText, supabase } from "../lib/supabase";
import { todayISO } from "../lib/util";
import { PENALTY_VALIDITY_LABEL, PROOF_LABEL, VALIDITY_LABEL, type ProofType, type RewardValidity, type Task } from "../lib/types";
import { DayPicker } from "../components/Windows";
import { Icon } from "../components/Icon";

type Form = {
  title: string;
  description: string;
  child_ids: string[];
  assign_mode: "each" | "first";
  recurrence: "once" | "days";
  days: number[];
  start_date: string;
  end_date: string;
  due_date: string;
  due_time: string;
  proof: ProofType;
  before_after: boolean;
  before_photo_min: string;
  before_photo_max: string;
  after_photo_min: string;
  after_photo_max: string;
  reward_minutes: string;
  reward_text: string;
  reward_validity: RewardValidity;
  reward_date: string;
  reward_expires_days: string;
  reward_section_id: string;
  mandatory: boolean;
  active: boolean;
  record_on: boolean;
  record_minutes: string;
  record_camera: "back" | "front" | "choose";
  record_pause: "none" | "limit" | "child";
  record_pause_max: string;
};

const empty = (childIds: string[]): Form => ({
  title: "",
  description: "",
  child_ids: childIds,
  assign_mode: "each",
  recurrence: "once",
  days: [1, 2, 3, 4, 5, 6, 7],
  start_date: todayISO(),
  end_date: "",
  due_date: todayISO(),
  due_time: "",
  proof: "photo",
  before_after: true,
  before_photo_min: "1",
  before_photo_max: "4",
  after_photo_min: "1",
  after_photo_max: "4",
  reward_minutes: "15",
  reward_text: "",
  reward_validity: "today",
  reward_date: todayISO("Europe/Berlin", 1),
  reward_expires_days: "",
  reward_section_id: "",
  mandatory: false,
  active: true,
  record_on: false,
  record_minutes: "60",
  record_camera: "back",
  record_pause: "child",
  record_pause_max: "10",
});

type RecFields = { record_minutes?: number | null; record_camera?: Form["record_camera"]; record_pause?: Form["record_pause"]; record_pause_max?: number | null };
const recForm = (t: RecFields) => ({
  record_on: t.record_minutes != null,
  record_minutes: t.record_minutes?.toString() ?? "60",
  record_camera: t.record_camera ?? "back",
  record_pause: t.record_pause ?? "child",
  record_pause_max: t.record_pause_max?.toString() ?? "10",
});

export default function TaskEdit() {
  const { id } = useParams();
  const [params] = useSearchParams();
  const fam = useFamily();
  const nav = useNavigate();
  const isNew = !id || id === "new";
  const [f, setF] = useState<Form>(empty(fam.children.map((c) => c.id)));
  const [saveTemplate, setSaveTemplate] = useState(false);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const appliedNewDefaults = useRef(false);

  useEffect(() => {
    if (!isNew || params.get("template") || !fam.family || appliedNewDefaults.current) return;
    appliedNewDefaults.current = true;
    setF((x) => ({
      ...x,
      before_photo_min: String(fam.family?.task_before_photo_min ?? 1),
      before_photo_max: String(fam.family?.task_before_photo_max ?? 4),
      after_photo_min: String(fam.family?.task_after_photo_min ?? 1),
      after_photo_max: String(fam.family?.task_after_photo_max ?? 4),
    }));
  }, [fam.family, isNew, params]);

  useEffect(() => {
    (async () => {
      if (!isNew) {
        const { data } = await supabase.from("tasks").select("*").eq("id", id).maybeSingle();
        const t = data as Task | null;
        if (t)
          setF({
            title: t.title,
            description: t.description ?? "",
            child_ids: t.child_ids,
            assign_mode: t.assign_mode,
            recurrence: t.recurrence,
            days: t.days,
            start_date: t.start_date,
            end_date: t.end_date ?? "",
            due_date: t.due_date ?? "",
            due_time: t.due_time?.slice(0, 5) ?? "",
            proof: t.proof,
            before_after: t.before_after,
            before_photo_min: String(t.before_photo_min ?? fam.family?.task_before_photo_min ?? 1),
            before_photo_max: String(t.before_photo_max ?? fam.family?.task_before_photo_max ?? 4),
            after_photo_min: String(t.after_photo_min ?? fam.family?.task_after_photo_min ?? 1),
            after_photo_max: String(t.after_photo_max ?? fam.family?.task_after_photo_max ?? 4),
            reward_minutes: t.reward_minutes?.toString() ?? "",
            reward_text: t.reward_text ?? "",
            reward_validity: t.reward_validity,
            reward_date: t.reward_date ?? todayISO("Europe/Berlin", 1),
            reward_expires_days: t.reward_expires_days?.toString() ?? "",
            reward_section_id: (t as Task & { reward_section_id?: string | null }).reward_section_id ?? "",
            mandatory: t.mandatory,
            active: t.active,
            ...recForm(t as RecFields),
          });
      } else {
        const tid = params.get("template");
        if (tid) {
          const { data } = await supabase.from("task_templates").select("*").eq("id", tid).maybeSingle();
          if (data)
            setF((x) => ({
              ...x,
              title: data.title,
              description: data.description ?? "",
              proof: data.proof,
              before_after: data.before_after,
              before_photo_min: String(data.before_photo_min ?? fam.family?.task_before_photo_min ?? 1),
              before_photo_max: String(data.before_photo_max ?? fam.family?.task_before_photo_max ?? 4),
              after_photo_min: String(data.after_photo_min ?? fam.family?.task_after_photo_min ?? 1),
              after_photo_max: String(data.after_photo_max ?? fam.family?.task_after_photo_max ?? 4),
              reward_minutes: data.reward_minutes?.toString() ?? "",
              reward_text: data.reward_text ?? "",
              reward_validity: data.reward_validity,
              reward_expires_days: data.reward_expires_days?.toString() ?? "",
              reward_section_id: data.reward_section_id ?? "",
              mandatory: data.mandatory,
              ...recForm(data as RecFields),
            }));
        }
      }
    })();
  }, [id, isNew, params]);

  const set = <K extends keyof Form>(k: K, v: Form[K]) => setF((x) => ({ ...x, [k]: v }));

  async function save() {
    setErr("");
    if (!f.title.trim()) return setErr("Görev adı yaz.");
    if (!f.child_ids.length) return setErr("En az bir çocuk seç.");
    if (f.recurrence === "days" && !f.days.length) return setErr("Tekrar günlerini seç.");
    setBusy(true);
    const row = {
      family_id: fam.familyId,
      title: f.title.trim(),
      description: f.description.trim() || null,
      child_ids: f.child_ids,
      assign_mode: f.child_ids.length > 1 ? f.assign_mode : "each",
      recurrence: f.recurrence,
      days: f.days,
      start_date: f.start_date || todayISO(),
      end_date: f.recurrence === "days" ? f.end_date || null : null,
      due_date: f.recurrence === "once" ? f.due_date || null : null,
      due_time: f.due_time || null,
      proof: f.proof,
      before_after: f.proof !== "none" && f.before_after,
      before_photo_min: Math.min(4, Math.max(1, Number(f.before_photo_min) || 1)),
      before_photo_max: Math.min(4, Math.max(Number(f.before_photo_min) || 1, Number(f.before_photo_max) || 4)),
      after_photo_min: Math.min(4, Math.max(1, Number(f.after_photo_min) || 1)),
      after_photo_max: Math.min(4, Math.max(Number(f.after_photo_min) || 1, Number(f.after_photo_max) || 4)),
      reward_minutes: f.reward_minutes.trim() === "" ? null : Number(f.reward_minutes),
      reward_text: f.reward_text.trim() || null,
      reward_validity: f.reward_validity,
      reward_date: f.reward_validity === "date" ? f.reward_date : null,
      reward_expires_days: f.reward_validity === "wallet" && f.reward_expires_days ? Number(f.reward_expires_days) : null,
      reward_section_id: Number(f.reward_minutes) >= 0 && f.reward_validity !== "wallet" && f.reward_validity !== "vault" && f.reward_section_id ? f.reward_section_id : null,
      mandatory: f.mandatory,
      active: f.active,
      record_minutes: f.record_on ? Math.min(240, Math.max(1, Number(f.record_minutes) || 60)) : null,
      record_camera: f.record_camera,
      record_pause: f.record_pause,
      record_pause_max: f.record_pause === "limit" ? Math.max(1, Number(f.record_pause_max) || 10) : null,
    };
    const { error } = isNew ? await supabase.from("tasks").insert(row) : await supabase.from("tasks").update(row).eq("id", id);
    if (!error && saveTemplate) {
      await supabase.from("task_templates").insert({
        family_id: fam.familyId,
        title: row.title,
        description: row.description,
        proof: row.proof,
        before_after: row.before_after,
        before_photo_min: row.before_photo_min,
        before_photo_max: row.before_photo_max,
        after_photo_min: row.after_photo_min,
        after_photo_max: row.after_photo_max,
        reward_minutes: row.reward_minutes,
        reward_text: row.reward_text,
        reward_validity: row.reward_validity === "date" ? "today" : row.reward_validity,
        reward_expires_days: row.reward_expires_days,
        reward_section_id: row.reward_section_id,
        mandatory: row.mandatory,
        record_minutes: row.record_minutes,
        record_camera: row.record_camera,
        record_pause: row.record_pause,
        record_pause_max: row.record_pause_max,
      });
    }
    setBusy(false);
    if (error) return setErr(errorText(error));
    nav("/tasks");
  }

  async function remove() {
    if (!confirm("Görev ve geçmişi silinsin mi? (Sadece durdurmak için 'Etkin' kutusunu kaldırabilirsin.)")) return;
    await supabase.from("tasks").delete().eq("id", id);
    nav("/tasks");
  }

  const toggleChild = (cid: string) =>
    set("child_ids", f.child_ids.includes(cid) ? f.child_ids.filter((x) => x !== cid) : [...f.child_ids, cid]);

  return (
    <div className="page">
      <header className="page-head">
        <Link to="/tasks" className="icon-btn" aria-label="Geri">
          <Icon name="back" />
        </Link>
        <h1>{isNew ? "Yeni görev" : "Görev"}</h1>
        <span />
      </header>
      {err && <p className="error">{err}</p>}

      <div className="card">
        <label className="field">
          <span>Görev</span>
          <input value={f.title} onChange={(e) => set("title", e.target.value)} placeholder="Odanı topla" />
        </label>
        <label className="field">
          <span>Açıklama (isteğe bağlı)</span>
          <input value={f.description} onChange={(e) => set("description", e.target.value)} placeholder="Yatağını yap, yerleri topla" />
        </label>
      </div>

      <div className="card">
        <h2>Kime</h2>
        <div className="row gap-xs wrap">
          {fam.children.map((c) => (
            <button key={c.id} className={`chip ${f.child_ids.includes(c.id) ? "on" : ""}`} onClick={() => toggleChild(c.id)}>
              {c.name}
            </button>
          ))}
        </div>
        {f.child_ids.length > 1 && (
          <div className="row gap-xs wrap">
            <button className={`chip small ${f.assign_mode === "each" ? "on" : ""}`} onClick={() => set("assign_mode", "each")}>
              Her biri ayrı yapsın
            </button>
            <button className={`chip small ${f.assign_mode === "first" ? "on" : ""}`} onClick={() => set("assign_mode", "first")}>
              İlk yapan alsın
            </button>
          </div>
        )}
      </div>

      <div className="card">
        <h2>Ne zaman</h2>
        <div className="row gap-xs wrap">
          <button className={`chip ${f.recurrence === "once" ? "on" : ""}`} onClick={() => set("recurrence", "once")}>
            Tek seferlik
          </button>
          <button className={`chip ${f.recurrence === "days" ? "on" : ""}`} onClick={() => set("recurrence", "days")}>
            Tekrarlı
          </button>
        </div>
        {f.recurrence === "days" ? (
          <>
            <DayPicker value={f.days} onChange={(d) => set("days", d)} />
            <div className="grid2">
              <div className="field">
                <span>Başlangıç</span>
                <DateField value={f.start_date} onChange={(v) => set("start_date", v)} />
              </div>
              <div className="field">
                <span>Bitiş (isteğe bağlı)</span>
                <DateField clearable value={f.end_date} onChange={(v) => set("end_date", v)} placeholder="Bitiş yok" />
              </div>
            </div>
          </>
        ) : (
          <div className="grid2">
            <div className="field">
              <span>Başlangıç</span>
              <DateField value={f.start_date} onChange={(v) => set("start_date", v)} />
            </div>
            <div className="field">
              <span>Son gün</span>
              <DateField value={f.due_date} onChange={(v) => set("due_date", v)} />
            </div>
          </div>
        )}
        <div className="field">
          <span>Saat (isteğe bağlı, ör. 18:00'e kadar)</span>
          <TimeField clearable value={f.due_time} onChange={(v) => set("due_time", v)} label="Saat" />
        </div>
      </div>

      <div className="card">
        <h2>Kanıt</h2>
        <div className="row gap-xs wrap">
          {(Object.keys(PROOF_LABEL) as ProofType[]).map((p) => (
            <button key={p} className={`chip small ${f.proof === p ? "on" : ""}`} onClick={() => set("proof", p)}>
              {PROOF_LABEL[p]}
            </button>
          ))}
        </div>
        {f.proof !== "none" && (
          <>
            <label className="check"><input type="checkbox" checked={f.before_after} onChange={(e) => set("before_after", e.target.checked)} />Öncesi ve sonrası istensin</label>
            {f.before_after && <div className="grid2"><label className="field"><span>Başlangıç fotoğrafı: en az / en fazla</span><div className="row gap-xs"><input type="number" min={1} max={4} value={f.before_photo_min} onChange={(e) => set("before_photo_min", e.target.value)} /><input type="number" min={1} max={4} value={f.before_photo_max} onChange={(e) => set("before_photo_max", e.target.value)} /></div></label><label className="field"><span>Tamamlanma fotoğrafı: en az / en fazla</span><div className="row gap-xs"><input type="number" min={1} max={4} value={f.after_photo_min} onChange={(e) => set("after_photo_min", e.target.value)} /><input type="number" min={1} max={4} value={f.after_photo_max} onChange={(e) => set("after_photo_max", e.target.value)} /></div></label></div>}
          </>
        )}
        <p className="muted tiny">Çocuk kanıtı Orbit'in kamerasıyla çeker; galeriden eski foto seçemez. Onay veya retten sonra dosya silinir.</p>
      </div>

      <div className="card">
        <h2>📹 Kamera kaydı</h2>
        <label className="check">
          <input type="checkbox" checked={f.record_on} onChange={(e) => set("record_on", e.target.checked)} />
          Görev süresince kamerayla kayıt yapsın
        </label>
        {f.record_on && (
          <>
            <div className="row gap-s wrap" style={{ alignItems: "center" }}>
              {["30", "45", "60", "90", "120"].map((m) => (
                <button key={m} className={`chip small ${f.record_minutes === m ? "on" : ""}`} onClick={() => set("record_minutes", m)}>
                  {m} dk
                </button>
              ))}
              <input className="mini" type="number" min={1} max={240} value={f.record_minutes} onChange={(e) => set("record_minutes", e.target.value)} aria-label="Kayıt süresi" />
            </div>
            <label className="field">
              <span>Kamera</span>
              <select value={f.record_camera} onChange={(e) => set("record_camera", e.target.value as Form["record_camera"])}>
                <option value="back">Arka kamera (oda / masa)</option>
                <option value="front">Ön kamera (çocuğu görür)</option>
                <option value="choose">Çocuk seçsin</option>
              </select>
            </label>
            <label className="field">
              <span>Mola</span>
              <select value={f.record_pause} onChange={(e) => set("record_pause", e.target.value as Form["record_pause"])}>
                <option value="none">Mola yok</option>
                <option value="limit">Sınırlı mola</option>
                <option value="child">Serbest: istediği zaman mola verip devam etsin</option>
              </select>
            </label>
            {f.record_pause === "limit" && (
              <div className="row gap-s" style={{ alignItems: "center" }}>
                <span className="small">Toplam en fazla</span>
                <input className="mini" type="number" min={1} value={f.record_pause_max} onChange={(e) => set("record_pause_max", e.target.value)} aria-label="Mola dakika" />
                <span className="small">dk (dolunca kayıt kendiliğinden devam eder)</span>
              </div>
            )}
            <p className="muted tiny">
              Telefon saniyede 2 kare çeker; 1 saatlik kayıt yaklaşık 3 dakikalık, ~45 MB'lık bir video olur ve panelde 5x–40x hızda izlenir. Molalar kayda sayılmaz.
              Kayıt sürerken telefonda diğer uygulamalar kapalıdır. Kayıt kesilirse ya da erken bitirilirse sana bildirim gelir.
            </p>
          </>
        )}
      </div>

      <div className="card">
        <h2>Süre ödülü / ceza</h2>
        <div className="grid2">
          <label className="field">
            <span>Ekstra süre (dk)</span>
            <input type="number" min={-1440} max={1440} value={f.reward_minutes} onChange={(e) => { const value = e.target.value; setF((x) => ({ ...x, reward_minutes: value, reward_validity: Number(value) < 0 && !["today", "wallet", "vault"].includes(x.reward_validity) ? "today" : x.reward_validity })); }} placeholder="0" />
          </label>
          <label className="field">
            <span>Geçerli</span>
            <select value={f.reward_validity} onChange={(e) => set("reward_validity", e.target.value as RewardValidity)}>
              {(Object.keys(VALIDITY_LABEL) as RewardValidity[]).filter((v) => Number(f.reward_minutes) < 0 ? ["today", "wallet", "vault"].includes(v) : true).map((v) => (
                <option key={v} value={v}>
                  {Number(f.reward_minutes) < 0 ? PENALTY_VALIDITY_LABEL[v] : VALIDITY_LABEL[v]}
                </option>
              ))}
            </select>
          </label>
        </div>
        {f.reward_validity === "date" && (
          <div className="field">
            <span>Gün</span>
            <DateField value={f.reward_date} onChange={(v) => set("reward_date", v)} />
          </div>
        )}
        {f.reward_validity === "vault" && (
          <p className="muted small">Pozitifse süre çocuğun kasasına eklenir; negatifse borç olarak tutulur. Çocuk kasayı kullanamaz, ebeveyn Süre sekmesinden yönetir.</p>
        )}
        {Number(f.reward_minutes) >= 0 && f.reward_validity !== "wallet" && f.reward_validity !== "vault" && (
          <label className="field">
            <span>Kazandığı süre nereye eklensin</span>
            <select value={f.reward_section_id} onChange={(e) => set("reward_section_id", e.target.value)}>
              <option value="">Gün boyu: süreli her bölümde kullanılır</option>
              {fam.sections.map((s) => (
                <option key={s.id} value={s.id}>
                  {fam.profiles.find((p) => p.id === s.profile_id)?.name} · {s.name} {s.start_time.slice(0, 5)}–{s.end_time.slice(0, 5)}
                </option>
              ))}
            </select>
            <small className="muted">Onaylarken ya da sonra çocuğun Süre sekmesinden değiştirebilirsin.</small>
          </label>
        )}
        {f.reward_validity === "wallet" && (
          <label className="field">
            <span>Kaç gün içinde kullanılmalı (boş = süresiz)</span>
            <input type="number" min={1} value={f.reward_expires_days} onChange={(e) => set("reward_expires_days", e.target.value)} />
          </label>
        )}
        <label className="field">
          <span>Başka ödül (isteğe bağlı)</span>
          <input value={f.reward_text} onChange={(e) => set("reward_text", e.target.value)} placeholder="Cumartesi sinema" />
        </label>
      </div>

      <div className="card">
        {!isNew && (
          <label className="check">
            <input type="checkbox" checked={f.active} onChange={(e) => set("active", e.target.checked)} />
            Etkin
          </label>
        )}
        <label className="check">
          <input type="checkbox" checked={saveTemplate} onChange={(e) => setSaveTemplate(e.target.checked)} />
          Şablon olarak da kaydet
        </label>
        <button className="btn primary wide" disabled={busy} onClick={save}>
          {isNew ? "Görevi ver" : "Kaydet"}
        </button>
        {!isNew && (
          <button className="btn ghost danger-text" onClick={remove}>
            Görevi sil
          </button>
        )}
      </div>
    </div>
  );
}
