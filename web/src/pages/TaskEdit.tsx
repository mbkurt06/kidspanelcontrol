import { useEffect, useRef, useState } from "react";
import { DateField, TimeField } from "../components/DateTime";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useFamily } from "../lib/family";
import { errorText, supabase } from "../lib/supabase";
import { todayISO } from "../lib/util";
import { PROOF_LABEL, VALIDITY_LABEL, type AgendaItem, type ProofType, type RewardValidity, type Task, type TaskDefaults, type TaskGroup, type TaskPhoneRestriction } from "../lib/types";
import { repeatText } from "../lib/groups";
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
  proof_before_min: string;
  proof_before_max: string;
  proof_after_min: string;
  proof_after_max: string;
  reward_minutes: string;
  reward_text: string;
  reward_validity: RewardValidity;
  reward_date: string;
  reward_expires_days: string;
  reward_section_id: string;
  active: boolean;
  record_on: boolean;
  record_minutes: string;
  record_camera: "back" | "front" | "choose";
  record_pause: "none" | "limit" | "child";
  record_pause_max: string;
  phone_restriction: TaskPhoneRestriction;
  orbit_focus_profile_id: string;
  group_id: string;
  mandatory: boolean;
};

/** Varsayılana giren alanlar: ad, açıklama, tarih ve saat hariç */
function defaultsOf(f: Form): TaskDefaults {
  return {
    child_ids: f.child_ids,
    assign_mode: f.assign_mode,
    proof: f.proof,
    before_after: f.before_after,
    proof_before_min: Number(f.proof_before_min) || 1,
    proof_before_max: Number(f.proof_before_max) || 4,
    proof_after_min: Number(f.proof_after_min) || 1,
    proof_after_max: Number(f.proof_after_max) || 4,
    reward_minutes: f.reward_minutes.trim() === "" ? null : Number(f.reward_minutes),
    reward_text: f.reward_text.trim() || null,
    reward_validity: f.reward_validity,
    reward_expires_days: f.reward_expires_days ? Number(f.reward_expires_days) : null,
    record_minutes: f.record_on ? Number(f.record_minutes) || 60 : null,
    record_camera: f.record_camera,
    record_pause: f.record_pause,
    record_pause_max: f.record_pause === "limit" ? Number(f.record_pause_max) || 10 : null,
    phone_restriction: f.phone_restriction,
    orbit_focus_profile_id: f.orbit_focus_profile_id || null,
  };
}
function applyDefaults(f: Form, d: TaskDefaults | null | undefined, allChildren: string[]): Form {
  if (!d) return f;
  const kids = (d.child_ids ?? f.child_ids).filter((id) => allChildren.includes(id));
  return {
    ...f,
    child_ids: kids.length ? kids : f.child_ids,
    assign_mode: d.assign_mode ?? f.assign_mode,
    proof: d.proof ?? f.proof,
    before_after: d.before_after ?? f.before_after,
    proof_before_min: String(d.proof_before_min ?? f.proof_before_min),
    proof_before_max: String(d.proof_before_max ?? f.proof_before_max),
    proof_after_min: String(d.proof_after_min ?? f.proof_after_min),
    proof_after_max: String(d.proof_after_max ?? f.proof_after_max),
    reward_minutes: d.reward_minutes === undefined ? f.reward_minutes : d.reward_minutes == null ? "" : String(d.reward_minutes),
    reward_text: d.reward_text ?? f.reward_text,
    reward_validity: d.reward_validity ?? f.reward_validity,
    reward_expires_days: d.reward_expires_days == null ? "" : String(d.reward_expires_days),
    record_on: d.record_minutes != null,
    record_minutes: String(d.record_minutes ?? f.record_minutes),
    record_camera: d.record_camera ?? f.record_camera,
    record_pause: d.record_pause ?? f.record_pause,
    record_pause_max: String(d.record_pause_max ?? f.record_pause_max),
    phone_restriction: d.phone_restriction ?? f.phone_restriction,
    orbit_focus_profile_id: d.orbit_focus_profile_id ?? "",
  };
}
const sameDefaults = (a: TaskDefaults, b: TaskDefaults | null | undefined) => !!b && JSON.stringify(a) === JSON.stringify({ ...a, ...b });

const empty = (childIds: string[], defaults?: { task_before_photo_min?: number; task_before_photo_max?: number; task_after_photo_min?: number; task_after_photo_max?: number }): Form => ({
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
  proof_before_min: String(defaults?.task_before_photo_min ?? 1),
  proof_before_max: String(defaults?.task_before_photo_max ?? 4),
  proof_after_min: String(defaults?.task_after_photo_min ?? 1),
  proof_after_max: String(defaults?.task_after_photo_max ?? 4),
  reward_minutes: "15",
  reward_text: "",
  reward_validity: "today",
  reward_date: todayISO("Europe/Berlin", 1),
  reward_expires_days: "",
  reward_section_id: "",
  active: true,
  record_on: false,
  record_minutes: "60",
  record_camera: "back",
  record_pause: "child",
  record_pause_max: "10",
  phone_restriction: "none",
  orbit_focus_profile_id: "",
  group_id: "",
  mandatory: false,
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
  const [f, setF] = useState<Form>(() => empty(fam.children.map((c) => c.id), fam.family ?? undefined));
  const [saveTemplate, setSaveTemplate] = useState(false);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [photoCountsOpen, setPhotoCountsOpen] = useState(false);
  const [photoDefaultsMsg, setPhotoDefaultsMsg] = useState("");
  const photoDefaultsInitialized = useRef(false);
  const [groups, setGroups] = useState<TaskGroup[]>([]);
  const [agenda, setAgenda] = useState<AgendaItem | null>(null);
  const [defMsg, setDefMsg] = useState("");
  const [defAsk, setDefAsk] = useState(false);
  const defaultsApplied = useRef(false);
  const group = groups.find((g) => g.id === f.group_id) ?? null;
  const activeDefaults = (group?.defaults ?? fam.family?.task_defaults) || null;

  useEffect(() => {
    supabase.from("task_groups").select("*").order("sort").then(({ data }) => setGroups((data ?? []) as TaskGroup[]));
  }, []);

  // Yeni görev: önce grubun, yoksa genel varsayılan; ajandadan geliyorsa ad/çocuk/tarih ajandadan
  useEffect(() => {
    if (!isNew || params.get("template") || defaultsApplied.current || !fam.family) return;
    const gid = params.get("group") ?? "";
    if (gid && !groups.length) return;
    defaultsApplied.current = true;
    const g = groups.find((x) => x.id === gid) ?? null;
    setF((x) => {
      let next = applyDefaults({ ...x, group_id: g?.id ?? "" }, g?.defaults ?? fam.family?.task_defaults, fam.children.map((c) => c.id));
      if (g?.child_ids.length) next = { ...next, child_ids: g.child_ids };
      return next;
    });
    const aid = params.get("agenda");
    if (aid)
      supabase.from("agenda_items").select("*").eq("id", aid).maybeSingle().then(({ data }) => {
        const a = data as AgendaItem | null;
        if (!a) return;
        setAgenda(a);
        setF((x) => ({ ...x, title: a.title, description: a.note ?? "", child_ids: [a.child_id], recurrence: "once", start_date: todayISO(), due_date: a.due_date, due_time: a.due_time?.slice(0, 5) ?? "" }));
      });
  }, [fam.family, fam.children, groups, isNew, params]);

  useEffect(() => {
    if (!isNew || params.get("template") || !fam.family || photoDefaultsInitialized.current) return;
    photoDefaultsInitialized.current = true;
    setF((x) => ({
      ...x,
      proof_before_min: String(fam.family!.task_before_photo_min ?? 1),
      proof_before_max: String(fam.family!.task_before_photo_max ?? 4),
      proof_after_min: String(fam.family!.task_after_photo_min ?? 1),
      proof_after_max: String(fam.family!.task_after_photo_max ?? 4),
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
            proof_before_min: String(t.proof_before_min ?? (t.before_after ? 1 : 0)),
            proof_before_max: String(t.proof_before_max ?? 4),
            proof_after_min: String(t.proof_after_min ?? 1),
            proof_after_max: String(t.proof_after_max ?? 4),
            reward_minutes: t.reward_minutes?.toString() ?? "",
            reward_text: t.reward_text ?? "",
            reward_validity: t.reward_validity,
            reward_date: t.reward_date ?? todayISO("Europe/Berlin", 1),
            reward_expires_days: t.reward_expires_days?.toString() ?? "",
            reward_section_id: (t as Task & { reward_section_id?: string | null }).reward_section_id ?? "",
            active: t.active,
            ...recForm(t as RecFields),
            phone_restriction: t.phone_restriction ?? "none",
            orbit_focus_profile_id: t.orbit_focus_profile_id ?? "",
            group_id: t.group_id ?? "",
            mandatory: t.mandatory ?? false,
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
              proof_before_min: String(data.proof_before_min ?? (data.before_after ? 1 : 0)),
              proof_before_max: String(data.proof_before_max ?? 4),
              proof_after_min: String(data.proof_after_min ?? 1),
              proof_after_max: String(data.proof_after_max ?? 4),
              reward_minutes: data.reward_minutes?.toString() ?? "",
              reward_text: data.reward_text ?? "",
              reward_validity: data.reward_validity,
              reward_expires_days: data.reward_expires_days?.toString() ?? "",
              reward_section_id: data.reward_section_id ?? "",
              ...recForm(data as RecFields),
            }));
        }
      }
    })();
  }, [id, isNew, params]);

  const set = <K extends keyof Form>(k: K, v: Form[K]) => setF((x) => ({ ...x, [k]: v }));

  async function savePhotoDefaults() {
    setErr("");
    setPhotoDefaultsMsg("");
    const n = {
      task_before_photo_min: Math.max(1, Math.min(4, Number(f.proof_before_min) || 1)),
      task_before_photo_max: Math.max(1, Math.min(4, Number(f.proof_before_max) || 4)),
      task_after_photo_min: Math.max(1, Math.min(4, Number(f.proof_after_min) || 1)),
      task_after_photo_max: Math.max(1, Math.min(4, Number(f.proof_after_max) || 4)),
    };
    if (n.task_before_photo_min > n.task_before_photo_max || n.task_after_photo_min > n.task_after_photo_max) {
      return setErr("En az değeri en fazla değerinden büyük olamaz.");
    }
    const { error } = await supabase.from("families").update(n).eq("id", fam.familyId);
    if (error) return setErr(errorText(error));
    setPhotoDefaultsMsg("Varsayılan fotoğraf sayıları kaydedildi.");
    await fam.reload();
  }

  async function save() {
    setErr("");
    if (!f.title.trim()) return setErr("Görev adı yaz.");
    if (!f.child_ids.length) return setErr("En az bir çocuk seç.");
    if (f.recurrence === "days" && !f.days.length) return setErr("Tekrar günlerini seç.");
    const rewardMinutes = f.reward_minutes.trim() === "" ? null : Number(f.reward_minutes);
    if (rewardMinutes != null && (!Number.isInteger(rewardMinutes) || rewardMinutes < -1440 || rewardMinutes > 1440)) return setErr("Süre -1440 ile 1440 dakika arasında tam sayı olmalı.");
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
      proof_before_min: f.proof !== "none" && f.before_after ? Math.min(4, Math.max(1, Number(f.proof_before_min) || 1)) : 0,
      proof_before_max: f.proof !== "none" && f.before_after ? Math.max(Number(f.proof_before_max) || 4, Number(f.proof_before_min) || 1) : 4,
      proof_after_min: f.proof === "none" ? 1 : Math.min(4, Math.max(1, Number(f.proof_after_min) || 1)),
      proof_after_max: f.proof === "none" ? 4 : Math.max(Number(f.proof_after_max) || 4, Number(f.proof_after_min) || 1),
      reward_minutes: rewardMinutes,
      reward_text: f.reward_text.trim() || null,
      reward_validity: f.reward_validity,
      reward_date: f.reward_validity === "date" ? f.reward_date : null,
      reward_expires_days: f.reward_validity === "wallet" && f.reward_expires_days ? Number(f.reward_expires_days) : null,
      reward_section_id: f.reward_validity !== "wallet" && f.reward_validity !== "vault" && f.reward_section_id ? f.reward_section_id : null,
      mandatory: f.group_id ? f.mandatory : false,
      group_id: f.group_id || null,
      active: f.active,
      record_minutes: f.record_on ? Math.min(240, Math.max(1, Number(f.record_minutes) || 60)) : null,
      record_camera: f.record_camera,
      record_pause: f.record_pause,
      record_pause_max: f.record_pause === "limit" ? Math.max(1, Number(f.record_pause_max) || 10) : null,
      phone_restriction: f.phone_restriction,
      orbit_focus_profile_id: f.orbit_focus_profile_id || null,
    };
    const prev = isNew ? null : (await supabase.from("tasks").select("group_id, group_order").eq("id", id).maybeSingle()).data as { group_id: string | null; group_order: number } | null;
    let groupOrder = prev?.group_order ?? 0;
    if (f.group_id && prev?.group_id !== f.group_id) {
      const { data: last } = await supabase.from("tasks").select("group_order").eq("group_id", f.group_id).order("group_order", { ascending: false }).limit(1);
      groupOrder = ((last?.[0] as { group_order?: number } | undefined)?.group_order ?? 0) + 1;
    }
    const full = { ...row, group_order: groupOrder, child_ids: group?.child_ids.length ? group.child_ids : row.child_ids };
    const res = isNew ? await supabase.from("tasks").insert(full).select("id").single() : await supabase.from("tasks").update(full).eq("id", id).select("id").single();
    const error = res.error;
    if (!error && agenda) await supabase.from("agenda_items").update({ task_id: (res.data as { id: string }).id }).eq("id", agenda.id);
    if (!error && saveTemplate) {
      await supabase.from("task_templates").insert({
        family_id: fam.familyId,
        title: row.title,
        description: row.description,
        proof: row.proof,
        before_after: row.before_after,
        proof_before_min: row.proof_before_min,
        proof_before_max: row.proof_before_max,
        proof_after_min: row.proof_after_min,
        proof_after_max: row.proof_after_max,
        reward_minutes: row.reward_minutes,
        reward_text: row.reward_text,
        reward_validity: row.reward_validity === "date" ? "today" : row.reward_validity,
        reward_expires_days: row.reward_expires_days,
        reward_section_id: row.reward_section_id,
        mandatory: false,
        record_minutes: row.record_minutes,
        record_camera: row.record_camera,
        record_pause: row.record_pause,
        record_pause_max: row.record_pause_max,
      });
    }
    setBusy(false);
    if (error) return setErr(errorText(error));
    nav(agenda ? "/agenda" : f.group_id ? `/tasks?group=${f.group_id}` : "/tasks");
  }

  async function saveDefaults(target: "family" | "group") {
    setErr("");
    setDefMsg("");
    setDefAsk(false);
    const d = defaultsOf(f);
    const { error } =
      target === "group" && group
        ? await supabase.from("task_groups").update({ defaults: d }).eq("id", group.id)
        : await supabase.from("families").update({ task_defaults: d }).eq("id", fam.familyId);
    if (error) return setErr(errorText(error));
    setDefMsg(target === "group" && group ? `“${group.name}” grubundaki yeni görevler bu ayarlarla açılacak.` : "Yeni görevler bu ayarlarla açılacak.");
    if (target === "group" && group) setGroups((gs) => gs.map((g) => (g.id === group.id ? { ...g, defaults: d } : g)));
    else await fam.reload();
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
      {agenda && (
        <div className="card soft from-agenda">
          <span className="pop-label">AJANDADAN</span>
          <span className="small">{fam.children.find((c) => c.id === agenda.child_id)?.name} yazdı: <b>{agenda.title}</b>. Görev olunca ajandada yanında görev etiketi görünür; onaylayınca orada yapıldı olur.</span>
        </div>
      )}

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

      <div className="card extra-card">
        <h2>Grup <Info>Gruptaki görevler grubun günlerine, sırasına ve tamamlama koşuluna uyar. Fotoğraf, kamera, ödül gibi ayarlar görevin kendisinde kalır.</Info></h2>
        <div className="chips">
          <button type="button" className={`chip-btn ${!f.group_id ? "on" : ""}`} onClick={() => set("group_id", "")}>Tek görev</button>
          {groups.map((g) => (
            <button key={g.id} type="button" className={`chip-btn ${f.group_id === g.id ? "on" : ""}`} onClick={() => setF((x) => ({ ...x, group_id: g.id, child_ids: g.child_ids.length ? g.child_ids : x.child_ids }))}>{g.name}</button>
          ))}
        </div>
        {group && (
          <>
            <span className="muted tiny">{repeatText(group)} · {fam.children.filter((c) => group.child_ids.includes(c.id)).map((c) => c.name).join(", ")}{group.sequential ? " · sırayla" : ""}</span>
            <div className="chips">
              <button type="button" className={`chip-btn ${f.mandatory ? "on" : ""}`} onClick={() => set("mandatory", true)}>Zorunlu</button>
              <button type="button" className={`chip-btn ${!f.mandatory ? "on" : ""}`} onClick={() => set("mandatory", false)}>Seçmeli</button>
            </div>
          </>
        )}
      </div>

      {!group && <div className="card">
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
      </div>}

      {!group && <div className="card">
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
      </div>}

      <div className="card">
        <h2>Kanıt <Info>Çocuk yalnızca Orbit kamerasıyla kanıt gönderir (fotoğraf ve/veya kamera kaydı); onay veya redden sonra dosya silinir. Kayıt galeriden seçilemez.</Info></h2>
        <div className="row gap-xs wrap">
          <button className={`chip small ${f.proof === "none" && !f.record_on ? "on" : ""}`} onClick={() => setF((x) => ({ ...x, proof: "none", before_after: false, record_on: false }))}>
            Kanıt yok
          </button>
          <button className={`chip small ${f.proof === "photo" && !f.before_after ? "on" : ""}`} onClick={() => { set("proof", "photo"); set("before_after", false); }}>
            Tamamlanınca fotoğraf
          </button>
          <button className={`chip small ${f.proof === "photo" && f.before_after ? "on" : ""}`} onClick={() => { set("proof", "photo"); set("before_after", true); }}>
            Başlangıç + tamamlanınca fotoğraf
          </button>
          <button className={`chip small ${f.record_on ? "on" : ""}`} aria-pressed={f.record_on} onClick={() => set("record_on", !f.record_on)}>
            {f.record_on ? "✓ " : ""}📹 Kamera kaydı
          </button>
          {f.proof !== "none" && f.proof !== "photo" && <span className="pill quiet">{PROOF_LABEL[f.proof]}</span>}
        </div>
        {f.record_on && <span className="muted tiny">Görev boyunca Orbit kamerası kayıt alır; kayıt sana gelir, izleyip onaylarsın. Fotoğrafla birlikte de seçilebilir.</span>}
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

        {f.proof !== "none" && f.proof !== "photo" && <p className="muted tiny"><Info>Bu eski görev video kanıtı kullanıyor; değiştirmek için yukarıdaki fotoğraf seçeneğini seçebilirsin.</Info></p>}
        {f.proof === "photo" && (
          <>
            <button className="section-toggle" aria-expanded={photoCountsOpen} onClick={() => setPhotoCountsOpen((v) => !v)}>
              Fotoğraf sayıları <span className={`collapse-arrow${photoCountsOpen ? " open" : ""}`} aria-hidden="true" />
            </button>
            {photoCountsOpen && (
              <>
                <p className="muted tiny"><Info>Her aşamada kaç fotoğraf gerektiğini belirleyebilirsin. Bu değerleri yeni görevler için varsayılan olarak kaydedebilirsin.</Info></p>
                <div className="grid2">
                  {f.before_after && <PhotoCountFields title="Başlangıç fotoğrafları" min={f.proof_before_min} max={f.proof_before_max} onMin={(v) => set("proof_before_min", v)} onMax={(v) => set("proof_before_max", v)} />}
                  <PhotoCountFields title="Tamamlanma fotoğrafları" min={f.proof_after_min} max={f.proof_after_max} onMin={(v) => set("proof_after_min", v)} onMax={(v) => set("proof_after_max", v)} />
                </div>
                {photoDefaultsMsg && <p className="ok">{photoDefaultsMsg}</p>}
              </>
            )}
          </>
        )}
      </div>

      <div className="card">
        <h2>Kısıtlamalar <Info>Bu görev onaylanana kadar geçerlidir. Telefon kısıtı ile Orbit içindeki menü kısıtı birbirinden bağımsızdır.</Info></h2>
        <label className="field">
          <span>Telefon</span>
          <select value={f.phone_restriction} onChange={(e) => set("phone_restriction", e.target.value as TaskPhoneRestriction)}>
            <option value="none">Kısıtlama yok</option>
            <option value="limit">Sınırlı kullanım</option>
            <option value="kiosk">Tam kilit</option>
          </select>
        </label>
        <label className="field">
          <span>Orbit menüsü</span>
          <select value={f.orbit_focus_profile_id} onChange={(e) => set("orbit_focus_profile_id", e.target.value)}>
            <option value="">Kısıtlama yok</option>
            {fam.focusProfiles.map((p) => <option key={p.id} value={p.id}>{p.icon ?? "🎯"} {p.name}</option>)}
          </select>
        </label>
        {!fam.focusProfiles.length && <p className="muted tiny">Orbit menü kısıtı için önce Kurallar → Odak profilleri bölümünden profil oluştur.</p>}
      </div>

      <div className="card">
        <h2>Ödül / eksi süre <Info>Pozitif değer ödül olarak eklenir. Negatif değer görev zamanında yapılmazsa seçtiğin hedefe borç/eksi süre olarak yazılır.</Info></h2>
        <div className="grid2">
          <label className="field">
            <span>{Number(f.reward_minutes) < 0 ? "Eksi süre (dk)" : "Ekstra süre (dk)"}</span>
            <input type="number" min={-1440} max={1440} step={1} value={f.reward_minutes} onChange={(e) => set("reward_minutes", e.target.value)} placeholder="yok" />
          </label>
          <label className="field">
            <span>Ödül</span>
            <select value={f.reward_validity} onChange={(e) => set("reward_validity", e.target.value as RewardValidity)}>
              {REWARD_CORE.map(([value, label]) => <option key={value} value={value}>{Number(f.reward_minutes) < 0 ? (({ today: "Bugünden düş", wallet: "Cüzdana borç yaz", vault: "Kasaya borç yaz" } as Record<string, string>)[value] ?? label) : label}</option>)}
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
        {defMsg && <p className="ok small">{defMsg}</p>}
        <div className="extra-actions">
          <div className="pop-anchor">
            <button type="button" className="pill-btn" onClick={() => (group ? setDefAsk((v) => !v) : saveDefaults("family"))}>Varsayılan yap</button>
            {defAsk && (
              <>
                <div className="pop-backdrop" onClick={() => setDefAsk(false)} />
                <div className="lock-pop menu-pop up" role="menu">
                  <span className="pop-label">NEREDE GEÇERLİ</span>
                  <button className="menu-item" role="menuitem" onClick={() => saveDefaults("group")}>Sadece “{group?.name}” grubunda</button>
                  <button className="menu-item" role="menuitem" onClick={() => saveDefaults("family")}>Bütün yeni görevlerde</button>
                </div>
              </>
            )}
          </div>
          {activeDefaults && !sameDefaults(defaultsOf(f), activeDefaults) && (
            <button type="button" className="pill-btn ghost" onClick={() => setF((x) => applyDefaults(x, activeDefaults, fam.children.map((c) => c.id)))}>Varsayılana dön</button>
          )}
          <span className="grow" />
          <button className="pill-btn primary" disabled={busy} onClick={save}>
            {isNew ? "Görevi ver" : "Kaydet"}
          </button>
        </div>
        {!isNew && (
          <button className="btn ghost danger-text" onClick={remove}>
            Görevi sil
          </button>
        )}
      </div>
    </div>
  );
}

function PhotoCountFields({ title, min, max, onMin, onMax }: { title: string; min: string; max: string; onMin: (v: string) => void; onMax: (v: string) => void }) {
  return (
    <div className="card soft">
      <b>{title}</b>
      <div className="grid2">
        <label className="field"><span>En az</span><input type="number" min={1} max={4} value={min} onChange={(e) => onMin(e.target.value)} /></label>
        <label className="field"><span>En fazla</span><input type="number" min={1} max={4} value={max} onChange={(e) => onMax(e.target.value)} /></label>
      </div>
    </div>
  );
}
