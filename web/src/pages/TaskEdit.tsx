import { useEffect, useState } from "react";
import { DateField, TimeField } from "../components/DateTime";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useFamily } from "../lib/family";
import { errorText, supabase } from "../lib/supabase";
import { todayISO } from "../lib/util";
import { PROOF_LABEL, VALIDITY_LABEL, type ProofType, type RewardValidity, type Task } from "../lib/types";
import { DayPicker } from "../components/Windows";
import { Icon } from "../components/Icon";
import { Info } from "../components/Info";

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
  before_after: false,
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
const REWARD_CORE: Array<[RewardValidity, string]> = [
  ["today", "Hemen kullan"],
  ["wallet", "Cüzdana ekle"],
  ["vault", "Kasaya ekle"],
];

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
      reward_minutes: f.reward_minutes ? Number(f.reward_minutes) : null,
      reward_text: f.reward_text.trim() || null,
      reward_validity: f.reward_validity,
      reward_date: f.reward_validity === "date" ? f.reward_date : null,
      reward_expires_days: f.reward_validity === "wallet" && f.reward_expires_days ? Number(f.reward_expires_days) : null,
      reward_section_id: f.reward_validity !== "wallet" && f.reward_validity !== "vault" && f.reward_section_id ? f.reward_section_id : null,
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
  const legacyReward = f.reward_validity === "tomorrow" || f.reward_validity === "date";

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
          <span>Açıklama <Info>Çocuğun görevin ayrıntılarını görür.</Info></span>
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
            <div className="grid2 task-date-grid">
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
          <div className="grid2 task-date-grid">
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
          <span>Saat <Info>İstersen son teslim saatini de belirle.</Info></span>
          <TimeField clearable value={f.due_time} onChange={(v) => set("due_time", v)} label="Saat" />
        </div>
        <label className="check">
          <input type="checkbox" checked={f.mandatory} onChange={(e) => set("mandatory", e.target.checked)} />
          Zorunlu: bu görev yapılmadan süreli uygulamalar açılmasın
        </label>
      </div>

      <div className="card">
        <h2>Kanıt <Info>Çocuk yalnızca Orbit kamerasıyla kanıt gönderir; onay veya redden sonra dosya silinir.</Info></h2>
        <div className="row gap-xs wrap">
          <button className={`chip small ${f.proof === "none" ? "on" : ""}`} onClick={() => { set("proof", "none"); set("before_after", false); }}>
            Kanıt yok
          </button>
          <button className={`chip small ${f.proof === "photo" && !f.before_after ? "on" : ""}`} onClick={() => { set("proof", "photo"); set("before_after", false); }}>
            Tamamlanınca fotoğraf
          </button>
          <button className={`chip small ${f.proof === "photo" && f.before_after ? "on" : ""}`} onClick={() => { set("proof", "photo"); set("before_after", true); }}>
            Başlangıç + tamamlanınca fotoğraf
          </button>
          {f.proof !== "none" && f.proof !== "photo" && <span className="pill quiet">{PROOF_LABEL[f.proof]}</span>}
        </div>
        {f.proof !== "none" && f.proof !== "photo" && <p className="muted tiny">Bu eski görev video kanıtı kullanıyor; değiştirmek için yukarıdaki fotoğraf seçeneğini seçebilirsin.</p>}
        {f.proof === "photo" && <p className="muted tiny"><Info>Başlangıç seçilirse çocuk önce fotoğraf çeker; tamamlayınca ikinci fotoğrafı gönderir.</Info></p>}
      </div>

      <div className="card">
        <h2>📹 Kamera kaydı <Info>Kayıt görev boyunca telefondaki Orbit kamerasından alınır; galeri kullanılmaz.</Info></h2>
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
          </>
        )}
      </div>

      <div className="card">
        <h2>Ödül <Info>Süre ödülü çocuğun Süre kasasına kaydedilir; sonradan bir güne, bölüme veya saat aralığına aktarabilirsin.</Info></h2>
        <div className="grid2">
          <label className="field">
            <span>Ekstra süre (dk)</span>
            <input type="number" min={0} value={f.reward_minutes} onChange={(e) => set("reward_minutes", e.target.value)} placeholder="yok" />
          </label>
          <label className="field">
            <span>Ödül</span>
            <select value={f.reward_validity} onChange={(e) => set("reward_validity", e.target.value as RewardValidity)}>
              {REWARD_CORE.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              {legacyReward && <option value={f.reward_validity}>{VALIDITY_LABEL[f.reward_validity]}</option>}
            </select>
          </label>
        </div>
        {f.reward_validity === "date" && (
          <div className="field">
            <span>Gün</span>
            <DateField value={f.reward_date} onChange={(v) => set("reward_date", v)} />
          </div>
        )}
        {legacyReward && (
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
