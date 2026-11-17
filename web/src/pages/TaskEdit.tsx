import { RestrictionSelect } from "../components/RestrictionSelect";
import { useEffect, useRef, useState } from "react";
import { DateField, TimeField } from "../components/DateTime";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useFamily } from "../lib/family";
import { errorText, supabase } from "../lib/supabase";
import { todayISO } from "../lib/util";
import { PROOF_LABEL, VALIDITY_LABEL, type AgendaItem, type ProofType, type RestrictedApp, type RewardValidity, type Task, type TaskDefaults, type TaskGroup, type TaskPhoneRestriction, type UseMode } from "../lib/types";
import { repeatText } from "../lib/groups";
import { DayPicker } from "../components/Windows";
import { Icon } from "../components/Icon";
import { Info } from "../components/Info";
import { UNLOCK_TEXT } from "../lib/types";
import { MinuteStepper } from "../components/MinuteStepper";
import { UseModePicker } from "../components/UseModePicker";

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
  reward_on: boolean;
  fail_on: boolean;
  fail_minutes: string;
  fail_target: "today" | "wallet" | "vault";
  vocab_on: boolean;
  vocab_cards: string;
  reward_text: string;
  reward_validity: RewardValidity;
  reward_date: string;
  reward_expires_days: string;
  reward_section_id: string;
  active: boolean;
  record_on: boolean;
  record_minutes: string;
  record_min_minutes: string;
  shot_on: boolean;
  shot_min: string;
  shot_max: string;
  srec_on: boolean;
  srec_minutes: string;
  srec_min_minutes: string;
  allowed_packages: string[];
  allowed_mode: "keep" | "focus";
  restriction_mode_id: string;
  restricted_allowed: RestrictedApp[];
  use_mode: UseMode;
  use_within_minutes: string;
  record_camera: "back" | "front" | "choose";
  record_pause: "none" | "limit" | "child";
  record_pause_max: string;
  phone_restriction: TaskPhoneRestriction;
  orbit_focus_profile_id: string;
  group_id: string;
  mandatory: boolean;
  /** Grup görevi: süre ne zaman kazanılır / göreve başlama / yapılma saati */
  earn_links: string[];
  earn_mode: "all" | "any" | "min";
  earn_min: number;
  start_after: string[];
  unlock_mode: "k0" | "k1" | "k2" | "k3";
  unlock_until: string;
  start_time: string;
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
    reward_minutes: f.reward_on && f.reward_minutes.trim() !== "" ? Number(f.reward_minutes) : null,
    fail_minutes: f.fail_on && Number(f.fail_minutes) > 0 ? Number(f.fail_minutes) : null,
    fail_target: f.fail_target,
    vocab_cards: f.vocab_on && Number(f.vocab_cards) > 0 ? Number(f.vocab_cards) : null,
    reward_text: f.reward_text.trim() || null,
    reward_validity: f.reward_validity,
    reward_expires_days: f.reward_expires_days ? Number(f.reward_expires_days) : null,
    record_minutes: f.record_on ? Number(f.record_minutes) || 60 : null,
    record_min_minutes: f.record_on && f.record_min_minutes ? Number(f.record_min_minutes) : null,
    screenshot_min: f.shot_on ? Number(f.shot_min) || 1 : null,
    screenshot_max: f.shot_on ? Number(f.shot_max) || 1 : null,
    screen_record_minutes: f.srec_on ? Number(f.srec_minutes) || 30 : null,
    screen_record_min_minutes: f.srec_on && f.srec_min_minutes ? Number(f.srec_min_minutes) : null,
    allowed_packages: f.allowed_packages,
    allowed_mode: f.allowed_mode,
    restriction_mode_id: f.restriction_mode_id || null,
    restricted_allowed: f.restricted_allowed,
    use_mode: f.use_mode,
    use_within_minutes: f.use_mode === "within" ? Number(f.use_within_minutes) || 120 : null,
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
    reward_on: d.reward_minutes === undefined ? f.reward_on : d.reward_minutes != null,
    fail_on: d.fail_minutes != null,
    fail_minutes: d.fail_minutes == null ? "15" : String(d.fail_minutes),
    fail_target: (d.fail_target as Form["fail_target"]) ?? "today",
    vocab_on: d.vocab_cards != null,
    vocab_cards: d.vocab_cards == null ? "20" : String(d.vocab_cards),
    reward_text: d.reward_text ?? f.reward_text,
    reward_validity: d.reward_validity ?? f.reward_validity,
    reward_expires_days: d.reward_expires_days == null ? "" : String(d.reward_expires_days),
    record_on: d.record_minutes != null,
    record_minutes: String(d.record_minutes ?? f.record_minutes),
    record_min_minutes: d.record_min_minutes == null ? "" : String(d.record_min_minutes),
    shot_on: d.screenshot_min != null,
    shot_min: String(d.screenshot_min ?? 1),
    shot_max: String(d.screenshot_max ?? 3),
    srec_on: d.screen_record_minutes != null,
    srec_minutes: String(d.screen_record_minutes ?? f.srec_minutes),
    srec_min_minutes: d.screen_record_min_minutes == null ? "" : String(d.screen_record_min_minutes),
    allowed_packages: d.allowed_packages ?? f.allowed_packages,
    allowed_mode: d.allowed_mode ?? f.allowed_mode,
    restriction_mode_id: d.restriction_mode_id ?? f.restriction_mode_id,
    restricted_allowed: d.restricted_allowed ?? f.restricted_allowed,
    use_mode: d.use_mode ?? f.use_mode,
    use_within_minutes: d.use_within_minutes == null ? f.use_within_minutes : String(d.use_within_minutes),
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
  due_time: "20:00",
  proof: "none",
  before_after: false,
  proof_before_min: String(defaults?.task_before_photo_min ?? 1),
  proof_before_max: String(defaults?.task_before_photo_max ?? 4),
  proof_after_min: String(defaults?.task_after_photo_min ?? 1),
  proof_after_max: String(defaults?.task_after_photo_max ?? 4),
  reward_minutes: "30",
  reward_on: true,
  fail_on: false,
  fail_minutes: "15",
  fail_target: "today",
  vocab_on: false,
  vocab_cards: "20",
  reward_text: "",
  reward_validity: "today",
  reward_date: todayISO("Europe/Berlin", 1),
  reward_expires_days: "",
  reward_section_id: "",
  active: true,
  record_on: true,
  record_minutes: "30",
  record_min_minutes: "",
  shot_on: false,
  shot_min: "1",
  shot_max: "3",
  srec_on: false,
  srec_minutes: "30",
  srec_min_minutes: "",
  allowed_packages: [],
  allowed_mode: "focus",
  restriction_mode_id: "",
  restricted_allowed: [],
  use_mode: "usage",
  use_within_minutes: "120",
  record_camera: "choose",
  record_pause: "child",
  record_pause_max: "10",
  phone_restriction: "none",
  orbit_focus_profile_id: "",
  group_id: "",
  mandatory: false,
  earn_links: [],
  earn_mode: "all",
  earn_min: 1,
  start_after: [],
  unlock_mode: "k1",
  unlock_until: "",
  start_time: "08:00",
});

type RecFields = { screen_record_minutes?: number | null; screen_record_min_minutes?: number | null; allowed_packages?: string[] | null; allowed_mode?: "keep" | "focus" | null; restriction_mode_id?: string | null; restricted_allowed?: RestrictedApp[] | null; use_mode?: UseMode | null; use_within_minutes?: number | null; screenshot_min?: number | null; screenshot_max?: number | null; record_minutes?: number | null; record_min_minutes?: number | null; record_camera?: Form["record_camera"]; record_pause?: Form["record_pause"]; record_pause_max?: number | null };
const recForm = (t: RecFields) => ({
  record_on: t.record_minutes != null,
  record_minutes: t.record_minutes?.toString() ?? "60",
  record_min_minutes: t.record_min_minutes?.toString() ?? "",
  shot_on: t.screenshot_min != null,
  shot_min: String(t.screenshot_min ?? 1),
  shot_max: String(t.screenshot_max ?? t.screenshot_min ?? 3),
  srec_on: t.screen_record_minutes != null,
  srec_minutes: t.screen_record_minutes?.toString() ?? "30",
  srec_min_minutes: t.screen_record_min_minutes?.toString() ?? "",
  allowed_packages: t.allowed_packages ?? [],
  allowed_mode: t.allowed_mode ?? "focus",
  restriction_mode_id: t.restriction_mode_id ?? "",
  restricted_allowed: t.restricted_allowed ?? [],
  use_mode: t.use_mode ?? "usage",
  use_within_minutes: String(t.use_within_minutes ?? 120),
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
  // Gruptaki diğer görevler: "Süre ne zaman kazanılır" ve "Göreve başlama" seçimleri için
  const [groupTaskList, setGroupTaskList] = useState<Array<{ id: string; title: string; mandatory: boolean }>>([]);
  useEffect(() => {
    if (!f.group_id) return setGroupTaskList([]);
    supabase.from("tasks").select("id,title,mandatory,group_order,created_at").eq("group_id", f.group_id).eq("active", true).order("group_order").order("created_at")
      .then(({ data }) => setGroupTaskList(((data ?? []) as Array<{ id: string; title: string; mandatory: boolean }>).filter((t) => t.id !== id)));
  }, [f.group_id, id]);
  // Grup dışı görev: gruptaki görevlere bağlanabilir (süresi onlar bitince kullanılır)
  const [linkable, setLinkable] = useState<Array<{ id: string; title: string; mandatory: boolean; group: string }>>([]);
  useEffect(() => {
    if (f.group_id) return setLinkable([]);
    supabase.from("tasks").select("id,title,mandatory,group_id,group_order,created_at,task_groups(name)").eq("active", true).not("group_id", "is", null).order("group_order").order("created_at")
      .then(({ data }) => setLinkable(((data ?? []) as unknown as Array<{ id: string; title: string; mandatory: boolean; task_groups: { name: string } | null }>)
        .filter((t) => t.id !== id).map((t) => ({ id: t.id, title: t.title, mandatory: t.mandatory, group: t.task_groups?.name ?? "Grup" }))));
  }, [f.group_id, id]);
  const toggleIn = (k: "earn_links" | "start_after", v: string) => setF((x) => ({ ...x, [k]: x[k].includes(v) ? x[k].filter((y) => y !== v) : [...x[k], v] }));
  const activeDefaults = (group?.defaults ?? fam.family?.task_defaults) || null;

  useEffect(() => {
    supabase.from("task_groups").select("*").order("sort").then(({ data }) => setGroups((data ?? []) as TaskGroup[]));
  }, []);

  // İzinli uygulama seçimi için çocukların telefonlarındaki uygulamalar
  const [apps, setApps] = useState<Array<{ package: string; label: string; child_id: string }>>([]);
  const [appQuery, setAppQuery] = useState("");
  useEffect(() => {
    supabase.from("child_apps").select("package, label, child_id, is_system").eq("installed", true).order("label").then(({ data }) =>
      setApps(((data ?? []) as Array<{ package: string; label: string; child_id: string; is_system?: boolean }>).filter((a) => !a.is_system || a.label)),
    );
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
      record_camera: fam.family!.task_record_camera ?? "choose",
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
            reward_minutes: t.reward_minutes != null ? String(Math.abs(t.reward_minutes)) : "15",
            reward_on: (t.reward_minutes ?? 0) > 0,
            fail_on: (t.fail_minutes ?? 0) > 0 || (t.reward_minutes ?? 0) < 0,
            fail_minutes: String(t.fail_minutes ?? ((t.reward_minutes ?? 0) < 0 ? -(t.reward_minutes as number) : 15)),
            fail_target: t.fail_target ?? "today",
            vocab_on: t.vocab_cards != null,
            vocab_cards: String(t.vocab_cards ?? 20),
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
            earn_links: t.earn_links ?? [],
            earn_mode: t.earn_mode ?? "all",
            earn_min: t.earn_min ?? 1,
            start_after: t.start_after ?? [],
            unlock_mode: (t as { unlock_mode?: Form["unlock_mode"] }).unlock_mode ?? "k1",
            unlock_until: ((t as { unlock_until?: string | null }).unlock_until ?? "").slice(0, 5),
            start_time: t.start_time?.slice(0, 5) ?? "",
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
              reward_minutes: data.reward_minutes != null ? String(Math.abs(data.reward_minutes)) : "15",
              reward_on: (data.reward_minutes ?? 0) > 0,
              fail_on: (data.fail_minutes ?? 0) > 0,
              fail_minutes: String(data.fail_minutes ?? 15),
              fail_target: data.fail_target ?? "today",
              vocab_on: data.vocab_cards != null,
              vocab_cards: String(data.vocab_cards ?? 20),
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
    const rewardMinutes = f.reward_on && f.reward_minutes.trim() !== "" ? Number(f.reward_minutes) : null;
    if (rewardMinutes != null && (!Number.isInteger(rewardMinutes) || rewardMinutes < 1 || rewardMinutes > 1440)) return setErr("Kazanılacak süre 1–1440 dakika arasında olmalı.");
    const failMinutes = f.fail_on ? Number(f.fail_minutes) : null;
    if (failMinutes != null && (!Number.isInteger(failMinutes) || failMinutes < 1 || failMinutes > 1440)) return setErr("Düşülecek süre 1–1440 dakika arasında olmalı.");
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
      fail_minutes: failMinutes,
      fail_target: f.fail_target,
      vocab_cards: f.vocab_on && Number(f.vocab_cards) > 0 ? Math.min(500, Number(f.vocab_cards)) : null,
      reward_text: f.reward_text.trim() || null,
      reward_validity: f.reward_validity,
      reward_date: f.reward_validity === "date" ? f.reward_date : null,
      reward_expires_days: f.reward_validity === "wallet" && f.reward_expires_days ? Number(f.reward_expires_days) : null,
      reward_section_id: f.reward_validity !== "wallet" && f.reward_validity !== "vault" && f.reward_section_id ? f.reward_section_id : null,
      mandatory: f.group_id ? f.mandatory : false,
      group_id: f.group_id || null,
      active: f.active,
      record_minutes: f.record_on ? Math.min(240, Math.max(1, Number(f.record_minutes) || 60)) : null,
      screenshot_min: f.shot_on ? Math.max(1, Math.min(10, Number(f.shot_min) || 1)) : null,
      screenshot_max: f.shot_on ? Math.max(Number(f.shot_min) || 1, Math.min(10, Number(f.shot_max) || 1)) : null,
      record_min_minutes: f.record_on && f.record_min_minutes ? Math.min(Math.max(1, Number(f.record_minutes) || 60), Math.max(1, Number(f.record_min_minutes))) : null,
      screen_record_minutes: f.srec_on ? Math.min(240, Math.max(1, Number(f.srec_minutes) || 30)) : null,
      screen_record_min_minutes: f.srec_on && f.srec_min_minutes ? Math.min(Math.max(1, Number(f.srec_minutes) || 30), Math.max(1, Number(f.srec_min_minutes))) : null,
      allowed_packages: f.allowed_packages,
      allowed_mode: "focus",
      restriction_mode_id: f.phone_restriction === "mode" ? f.restriction_mode_id || null : null,
      restricted_allowed: f.phone_restriction === "none" ? [] : f.restricted_allowed,
      use_mode: f.use_mode,
      use_within_minutes: f.use_mode === "within" ? Math.max(1, Number(f.use_within_minutes) || 120) : null,
      record_camera: f.record_camera,
      record_pause: f.record_pause,
      record_pause_max: f.record_pause === "limit" ? Math.max(1, Number(f.record_pause_max) || 10) : null,
      phone_restriction: f.phone_restriction,
      orbit_focus_profile_id: f.orbit_focus_profile_id || null,
      earn_links: f.group_id ? f.earn_links.filter((x) => groupTaskList.some((t) => t.id === x) || x === id) : f.earn_links.filter((x) => linkable.some((t) => t.id === x)),
      unlock_mode: f.unlock_mode,
      unlock_until: f.unlock_mode === "k3" && f.unlock_until ? f.unlock_until : null,
      earn_mode: f.earn_mode,
      earn_min: Math.max(1, f.earn_min),
      start_after: f.group_id ? f.start_after.filter((x) => groupTaskList.some((t) => t.id === x)) : [],
      start_time: f.start_time || null,
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
        fail_minutes: row.fail_minutes,
        fail_target: row.fail_target,
        vocab_cards: row.vocab_cards,
        reward_text: row.reward_text,
        reward_validity: row.reward_validity === "date" ? "today" : row.reward_validity,
        reward_expires_days: row.reward_expires_days,
        reward_section_id: row.reward_section_id,
        mandatory: false,
        record_minutes: row.record_minutes,
        record_min_minutes: row.record_min_minutes,
        screenshot_min: row.screenshot_min,
        screenshot_max: row.screenshot_max,
        screen_record_minutes: row.screen_record_minutes,
        screen_record_min_minutes: row.screen_record_min_minutes,
        allowed_packages: row.allowed_packages,
        allowed_mode: row.allowed_mode,
        phone_restriction: row.phone_restriction,
        restriction_mode_id: row.restriction_mode_id,
        restricted_allowed: row.restricted_allowed,
        use_mode: row.use_mode,
        use_within_minutes: row.use_within_minutes,
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

  const unlockField = (
    <div className="field">
      <span>Telefon kilidi <Info>Görev onaylanıp süresi kullanılabilir olunca diğer görevlerin “Önce görev” kilidine ne olur. Kapalı saatler ve elle 🔒 kilit açılmaz.</Info></span>
      <select value={f.unlock_mode} onChange={(e) => set("unlock_mode", e.target.value as Form["unlock_mode"])}>
        <option value="k1">K1 · Süresi bitene kadar açar</option>
        <option value="k0">K0 · Dokunmaz</option>
        <option value="k2">K2 · Gün boyu açar</option>
        <option value="k3">K3 · Seçtiğim saate kadar açar</option>
      </select>
      <small className="muted">{UNLOCK_TEXT[f.unlock_mode]}</small>
      {f.unlock_mode === "k3" && <TimeField value={f.unlock_until} onChange={(v) => set("unlock_until", v)} label="Saate kadar" />}
    </div>
  );

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
        <h2>📚 Kelime kartları <Info>Çocuk Orbit'teki kelime kartlarında bugün bu kadar kart çalışınca görev kendiliğinden tamamlanır ve ödül verilir; onay gerekmez. Aşağıdan kanıt da istersen (ör. ekran kaydı) görev kendiliğinden tamamlanmaz: çocuk kanıtla gönderir, sen onaylarsın.</Info></h2>
        <label className="check">
          <input type="checkbox" checked={f.vocab_on} onChange={(e) => setF((x) => ({ ...x, vocab_on: e.target.checked }))} />
          Kelime kartı hedefi
        </label>
        {f.vocab_on && <div className="field">
          <span>Bugün kaç kart çalışsın</span>
          <MinuteStepper value={Number(f.vocab_cards) || 1} onChange={(v) => set("vocab_cards", String(v))} min={1} max={500} unit="kart" label="Kart sayısı" />
        </div>}
      </div>

      {<div className="card">
        <h2>Kanıt <Info>Çocuk yalnızca Orbit kamerasıyla kanıt gönderir (fotoğraf ve/veya kamera kaydı); onay veya redden sonra dosya silinir. Kayıt galeriden seçilemez.</Info></h2>
        <div className="row gap-xs wrap">
          <button className={`chip small ${f.proof === "none" && !f.record_on && !f.shot_on && !f.srec_on ? "on" : ""}`} onClick={() => setF((x) => ({ ...x, proof: "none", before_after: false, record_on: false, shot_on: false, srec_on: false }))}>
            Kanıt yok
          </button>
          <button className={`chip small ${f.proof !== "none" ? "on" : ""}`} aria-pressed={f.proof !== "none"} onClick={() => setF((x) => (x.proof !== "none" ? { ...x, proof: "none", before_after: false } : { ...x, proof: "photo", before_after: true }))}>
            {f.proof !== "none" ? "✓ " : ""}📷 Fotoğraf
          </button>
          <button className={`chip small ${f.record_on ? "on" : ""}`} aria-pressed={f.record_on} onClick={() => set("record_on", !f.record_on)}>
            {f.record_on ? "✓ " : ""}📹 Kamera kaydı
          </button>
          <button className={`chip small ${f.shot_on ? "on" : ""}`} aria-pressed={f.shot_on} onClick={() => set("shot_on", !f.shot_on)}>
            {f.shot_on ? "✓ " : ""}📱 Ekran görüntüsü
          </button>
          <button className={`chip small ${f.srec_on ? "on" : ""}`} aria-pressed={f.srec_on} onClick={() => set("srec_on", !f.srec_on)}>
            {f.srec_on ? "✓ " : ""}🎬 Ekran kaydı
          </button>
          {f.proof !== "none" && f.proof !== "photo" && <span className="pill quiet">{PROOF_LABEL[f.proof]}</span>}
        </div>
        {f.shot_on && (
          <div className="extra-group">
            <span className="pop-label">EKRAN GÖRÜNTÜSÜ <Info>Çocuk telefonda ekran görüntüsü alıp (ör. Duolingo sonucu) Orbit'ten ekler. En az kadar eklemeden görevi gönderemez, en fazladan çok ekleyemez.</Info></span>
            <div className="extra-row">
              <span className="muted small">En az</span>
              <MinuteStepper value={Number(f.shot_min) || 1} onChange={(v) => setF((x) => ({ ...x, shot_min: String(v), shot_max: Number(x.shot_max) < v ? String(v) : x.shot_max }))} min={1} max={10} unit="adet" label="En az ekran görüntüsü" />
              <span className="muted small">En fazla</span>
              <MinuteStepper value={Number(f.shot_max) || 1} onChange={(v) => setF((x) => ({ ...x, shot_max: String(v), shot_min: Number(x.shot_min) > v ? String(v) : x.shot_min }))} min={1} max={10} unit="adet" label="En fazla ekran görüntüsü" />
            </div>
          </div>
        )}
        {f.srec_on && (
          <div className="extra-group">
            <span className="pop-label">EKRAN KAYDI <Info>Çocuk görevde yuvarlak kayıt düğmesini açar; ekranda yaptığı her şey (ör. Duolingo dersi) hızlandırılmış video olarak kaydedilir. En az süre dolmadan bitiremez, en fazla süre dolunca kayıt kendiliğinden biter ve göreve eklenir.</Info></span>
            <div className="extra-row">
              <div className="chips">
                <button type="button" className={`chip-btn ${!f.srec_min_minutes ? "on" : ""}`} onClick={() => set("srec_min_minutes", "")}>Sabit süre</button>
                <button type="button" className={`chip-btn ${f.srec_min_minutes ? "on" : ""}`} onClick={() => set("srec_min_minutes", String(Math.max(1, Math.min(10, (Number(f.srec_minutes) || 30) - 1))))}>Aralık</button>
              </div>
            </div>
            <div className="extra-row">
              {f.srec_min_minutes && (
                <>
                  <span className="muted small">En az</span>
                  <MinuteStepper value={Number(f.srec_min_minutes) || 1} onChange={(v) => set("srec_min_minutes", String(v))} min={1} max={Math.max(1, Number(f.srec_minutes) || 30)} label="En az ekran kaydı" />
                </>
              )}
              <span className="muted small">{f.srec_min_minutes ? "En fazla" : "Süre"}</span>
              <MinuteStepper value={Number(f.srec_minutes) || 30} onChange={(v) => setF((x) => ({ ...x, srec_minutes: String(v), srec_min_minutes: x.srec_min_minutes && Number(x.srec_min_minutes) > v ? String(v) : x.srec_min_minutes }))} min={1} max={240} label="En fazla ekran kaydı" />
            </div>
          </div>
        )}
        {f.record_on && <span className="muted tiny">Görev boyunca Orbit kamerası kayıt alır; kayıt sana gelir, izleyip onaylarsın. Fotoğrafla birlikte de seçilebilir.</span>}
        {f.record_on && (
          <>
            <div className="extra-group">
              <span className="pop-label">KAYIT SÜRESİ <Info>En az: çocuk bu süre dolmadan kaydı bitirip görevi gönderemez. En fazla: bu süre dolunca kayıt kendiliğinden biter. Ne kadar süreceğini bilmiyorsan aralık ver.</Info></span>
              <div className="extra-row">
                <div className="chips">
                  <button type="button" className={`chip-btn ${!f.record_min_minutes ? "on" : ""}`} onClick={() => set("record_min_minutes", "")}>Sabit süre</button>
                  <button type="button" className={`chip-btn ${f.record_min_minutes ? "on" : ""}`} onClick={() => set("record_min_minutes", String(Math.max(1, Math.min(20, (Number(f.record_minutes) || 60) - 1))))}>Aralık</button>
                </div>
              </div>
              <div className="extra-row">
                {f.record_min_minutes && (
                  <>
                    <span className="muted small">En az</span>
                    <MinuteStepper value={Number(f.record_min_minutes) || 1} onChange={(v) => set("record_min_minutes", String(v))} min={1} max={Math.max(1, Number(f.record_minutes) || 60)} label="En az kayıt" />
                  </>
                )}
                <span className="muted small">{f.record_min_minutes ? "En fazla" : "Süre"}</span>
                <MinuteStepper value={Number(f.record_minutes) || 60} onChange={(v) => setF((x) => ({ ...x, record_minutes: String(v), record_min_minutes: x.record_min_minutes && Number(x.record_min_minutes) > v ? String(v) : x.record_min_minutes }))} min={1} max={240} label="En fazla kayıt" />
              </div>
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
                <MinuteStepper value={Number(f.record_pause_max) || 1} onChange={(v) => set("record_pause_max", String(v))} min={1} max={120} label="Mola dakika" />
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
      </div>}

      <div className="card">
        <h2>Kısıtlamalar <Info>Görevin saat aralığında (varsayılan: programdaki açık saatler) ve görev onaylanana kadar geçerlidir. Aralık dışında görevin kısıtlaması uygulanmaz; telefon o saatin kuralıyla çalışır. Ebeveynin verdiği ekstra süre sürerken kısıtlama kalkar.</Info></h2>
        {f.group_id && !f.mandatory ? (
          <p className="muted small">Seçmeli görev telefonu kısıtlamaz. Kısıtlama sadece zorunlu görevlerde seçilir.</p>
        ) : (
          <label className="field">
            <span>Yapılmazsa hangi kullanım profili <Info>Kullanım profilleri Kurallar → Kullanım profilleri'nden düzenlenir; orada oluşturduğun profiller burada çıkar.</Info></span>
            <RestrictionSelect
              value={{ restriction: f.phone_restriction, modeId: f.restriction_mode_id || null }}
              onChange={(v) => setF((x) => ({ ...x, phone_restriction: v.restriction as TaskPhoneRestriction, restriction_mode_id: v.modeId ?? "" }))}
            />
            <span className="muted tiny">
              {f.phone_restriction === "none"
                ? f.group_id ? "Telefon normal kurallarıyla çalışır; bu görev yapılmadan gruptan kazanılan ekstra süreler kullanılamaz." : "Telefon normal kurallarıyla çalışır, sadece ödül verilir."
                : "Görev yapılıp onaylanana kadar telefon bu durumda kalır. Onay beklerken de sürer. Birden fazla zorunlu görev varsa en sıkı olanı geçerli olur (Tam kilit > Kilitli > diğer)."}
            </span>
          </label>
        )}
        {f.phone_restriction !== "none" && !(f.group_id && !f.mandatory) && (
          <RestrictedApps
            apps={apps.filter((a) => f.child_ids.includes(a.child_id))}
            value={f.restricted_allowed}
            onChange={(v) => set("restricted_allowed", v)}
          />
        )}
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
        <h2>Görev uygulaması <Info>Görevin yapıldığı uygulama (ör. Anton, Duolingo). Sadece çocuk telefonda “Göreve başla”ya bastığında ya da ekran kaydı sürerken açılır; duraklatınca ya da bitirince kapanır. Bu sırada başka uygulamaya geçemez ve süresinden düşmez. Görev dışında da kullanılsın istersen Kurallar'dan ya da “Kısıtlıyken izinli uygulamalar”dan izin ver.</Info></h2>
        <AllowedApps
          apps={apps.filter((a) => f.child_ids.includes(a.child_id))}
          value={f.allowed_packages}
          query={appQuery}
          onQuery={setAppQuery}
          onChange={(v) => set("allowed_packages", v)}
        />
      </div>

      {!group && (
        <div className="card">
          <h2>Süre ve telefon</h2>
          <div className="grid2">
            <label className="field">
              <span>Süre ne zaman kullanılır</span>
              <select value={f.earn_links.length ? "linked" : "self"} onChange={(e) => set("earn_links", e.target.value === "linked" ? linkable.filter((t) => t.mandatory).slice(0, 1).map((t) => t.id) : [])}>
                <option value="self">Bu görev onaylanınca</option>
                <option value="linked" disabled={!linkable.length}>Gruptaki seçtiğim görevler bitince</option>
              </select>
            </label>
            {unlockField}
          </div>
          {f.earn_links.length > 0 && (
            <div className="gt-box">
              {linkable.map((t) => (
                <label key={t.id} className="check"><input type="checkbox" checked={f.earn_links.includes(t.id)} onChange={() => toggleIn("earn_links", t.id)} /> {t.group} · {t.title}{t.mandatory ? " · zorunlu" : ""}</label>
              ))}
              <div className="row gap-s wrap" style={{ alignItems: "center" }}>
                <select value={f.earn_mode} onChange={(e) => set("earn_mode", e.target.value as Form["earn_mode"])} aria-label="Kaç tanesi" style={{ width: "auto" }}>
                  <option value="all">Hepsi bitince</option>
                  <option value="any">Herhangi biri bitince</option>
                  <option value="min">En az … tanesi</option>
                </select>
                {f.earn_mode === "min" && <MinuteStepper value={f.earn_min} onChange={(v) => set("earn_min", v)} min={1} max={Math.max(1, f.earn_links.length)} unit="görev" label="En az kaç görev" />}
              </div>
              <small className="muted">Görev önce yapılırsa süresi bekler; işaretlenenler bitince kullanılır. Gün sonuna kadar bitmezse kasaya gider.</small>
            </div>
          )}
        </div>
      )}

      {group && (
        <div className="card">
          <h2>Çalışma şekli <Info>Grup ayarları tablosundaki satırın aynısı. Bitene kadar telefon için yukarıdaki “Kısıtlamalar”a bak.</Info></h2>
          <div className="grid2">
            <label className="field">
              <span>Süre ne zaman kazanılır</span>
              <select value={f.earn_links.length ? "linked" : "self"} onChange={(e) => set("earn_links", e.target.value === "linked" ? (id && !isNew ? [id] : groupTaskList.slice(0, 1).map((t) => t.id)) : [])}>
                <option value="self">Bu görev onaylanınca</option>
                <option value="linked" disabled={!groupTaskList.length && isNew}>Seçtiğim görevler bitince</option>
              </select>
            </label>
            <label className="field">
              <span>Göreve başlama</span>
              <select value={f.start_after.length ? "after" : "now"} onChange={(e) => set("start_after", e.target.value === "after" ? groupTaskList.slice(0, 1).map((t) => t.id) : [])}>
                <option value="now">Hemen başlayabilir</option>
                <option value="after" disabled={!groupTaskList.length}>Şu görevler bitince başlayabilir</option>
              </select>
            </label>
          </div>
          {unlockField}
          {f.earn_links.length > 0 && (
            <div className="gt-box">
              {!isNew && id && (
                <label className="check"><input type="checkbox" checked={f.earn_links.includes(id)} onChange={() => toggleIn("earn_links", id)} /> {f.title || "Bu görev"} (kendisi)</label>
              )}
              {groupTaskList.map((t) => (
                <label key={t.id} className="check"><input type="checkbox" checked={f.earn_links.includes(t.id)} onChange={() => toggleIn("earn_links", t.id)} /> {t.title}{t.mandatory ? " · zorunlu" : ""}</label>
              ))}
              <div className="row gap-s wrap" style={{ alignItems: "center" }}>
                <select value={f.earn_mode} onChange={(e) => set("earn_mode", e.target.value as Form["earn_mode"])} aria-label="Kaç tanesi" style={{ width: "auto" }}>
                  <option value="all">Hepsi bitince</option>
                  <option value="any">Herhangi biri bitince</option>
                  <option value="min">En az … tanesi</option>
                </select>
                {f.earn_mode === "min" && <MinuteStepper value={f.earn_min} onChange={(v) => set("earn_min", v)} min={1} max={Math.max(1, f.earn_links.length)} unit="görev" label="En az kaç görev" />}
              </div>
            </div>
          )}
          {f.start_after.length > 0 && (
            <div className="gt-box">
              {groupTaskList.map((t) => (
                <label key={t.id} className="check"><input type="checkbox" checked={f.start_after.includes(t.id)} onChange={() => toggleIn("start_after", t.id)} /> {t.title}</label>
              ))}
            </div>
          )}
          <div className="field">
            <span>Yapılma saati</span>
            <div className="row gap-xs" style={{ alignItems: "center" }}>
              <TimeField value={f.start_time} onChange={(v) => set("start_time", v)} label="Başlangıç" />
              <span className="muted">–</span>
              <TimeField value={f.due_time} onChange={(v) => set("due_time", v)} label="Bitiş" />
            </div>
          </div>
        </div>
      )}

      <div className="card">
        <h2>Ödül ve ceza <Info>İkisi birbirinden bağımsız: yalnız ödül, yalnız ceza ya da ikisi birden seçilebilir. Ceza, görev son saatine (ya da son gününe) kadar onaylanmazsa uygulanır.</Info></h2>
        <label className="check">
          <input type="checkbox" checked={f.reward_on} onChange={(e) => set("reward_on", e.target.checked)} />
          ✅ Yaparsa süre kazansın
        </label>
        {f.reward_on && <div className="grid2">
          <div className="field">
            <span>Kazanacağı süre</span>
            <MinuteStepper value={Number(f.reward_minutes) || 0} onChange={(v) => set("reward_minutes", String(v))} min={1} max={1440} label="Kazanacağı süre" />
          </div>
          <label className="field">
            <span>Nereye</span>
            <select value={f.reward_validity} onChange={(e) => set("reward_validity", e.target.value as RewardValidity)}>
              {REWARD_CORE.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              {legacyReward && <option value={f.reward_validity}>{VALIDITY_LABEL[f.reward_validity]}</option>}
            </select>
          </label>
        </div>}
        <label className="check">
          <input type="checkbox" checked={f.fail_on} onChange={(e) => set("fail_on", e.target.checked)} />
          ❌ Yapmazsa süre düşülsün
        </label>
        {f.fail_on && <div className="grid2">
          <div className="field">
            <span>Düşülecek süre</span>
            <MinuteStepper value={Number(f.fail_minutes) || 0} onChange={(v) => set("fail_minutes", String(v))} min={1} max={1440} label="Düşülecek süre" />
          </div>
          <label className="field">
            <span>Nereden</span>
            <select value={f.fail_target} onChange={(e) => set("fail_target", e.target.value as Form["fail_target"])}>
              <option value="today">O günün süresinden</option>
              <option value="wallet">Cüzdana borç yaz</option>
              <option value="vault">Kasadan düş</option>
            </select>
          </label>
        </div>}
        {!f.reward_on && !f.fail_on && <p className="muted tiny">Süre ödülü ya da cezası yok.</p>}
        {f.reward_on && f.reward_validity === "date" && (
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
        {f.reward_on && f.reward_validity === "today" && Number(f.reward_minutes) > 0 && !f.group_id && (
          <small className="muted">Kullandıkça düşer · açık saatler bitince kalanı kasaya gider</small>
        )}
        {f.reward_on && f.reward_validity === "wallet" && (
          <div className="field">
            <span>Kaç gün içinde kullanılmalı (0 = süresiz)</span>
            <MinuteStepper value={Number(f.reward_expires_days) || 0} onChange={(v) => set("reward_expires_days", v ? String(v) : "")} min={0} max={365} unit="gün" label="Kullanma günü" />
          </div>
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
        <div className="field"><span>En az</span><MinuteStepper value={Number(min) || 1} onChange={(v) => onMin(String(v))} min={1} max={4} unit="foto" label="En az" /></div>
        <div className="field"><span>En fazla</span><MinuteStepper value={Number(max) || 1} onChange={(v) => onMax(String(v))} min={1} max={4} unit="foto" label="En fazla" /></div>
      </div>
    </div>
  );
}

/** Görev açıkken (Sınırla / Kilitle modunda bile) kullanılabilecek uygulamalar */
function AllowedApps({ apps, value, query, onQuery, onChange }: {
  apps: Array<{ package: string; label: string }>;
  value: string[];
  query: string;
  onQuery: (q: string) => void;
  onChange: (v: string[]) => void;
}) {
  const byPkg = new Map<string, string>();
  apps.forEach((a) => byPkg.set(a.package, a.label || a.package));
  const q = query.trim().toLocaleLowerCase("tr");
  const list = [...byPkg.entries()]
    .filter(([pkg]) => !value.includes(pkg))
    .filter(([pkg, label]) => !q || label.toLocaleLowerCase("tr").includes(q) || pkg.includes(q))
    .slice(0, q ? 30 : 12);
  const toggle = (pkg: string) => onChange(value.includes(pkg) ? value.filter((x) => x !== pkg) : [...value, pkg]);
  return (
    <div className="field">
      <span>
        İzinli uygulamalar{" "}
        <Info>Görev bitene kadar bu uygulamalar her zaman açık kalır; telefon Sınırla veya Kilitle modunda olsa bile. Ör. ders için Anton, dil için Duolingo. Çocuk görev ekranından tek dokunuşla açar.</Info>
      </span>
      {value.length > 0 && (
        <div className="chips">
          {value.map((pkg) => (
            <button key={pkg} type="button" className="chip-btn on" onClick={() => toggle(pkg)} title="Kaldır">
              ✓ {byPkg.get(pkg) ?? pkg} ×
            </button>
          ))}
        </div>
      )}
      <input placeholder="Uygulama ara (ör. Duolingo)" value={query} onChange={(e) => onQuery(e.target.value)} />
      {list.length > 0 ? (
        <div className="chips">
          {list.map(([pkg, label]) => (
            <button key={pkg} type="button" className="chip-btn" onClick={() => toggle(pkg)}>
              + {label}
            </button>
          ))}
        </div>
      ) : (
        apps.length === 0 && <span className="muted tiny">Seçili çocukların telefonundan uygulama listesi henüz gelmedi.</span>
      )}
    </div>
  );
}

/** Kısıtlıyken izinli uygulamalar: isteğe bağlı günlük dakika sınırı */
function RestrictedApps({ apps, value, onChange }: { apps: Array<{ package: string; label: string }>; value: RestrictedApp[]; onChange: (v: RestrictedApp[]) => void }) {
  const [q, setQ] = useState("");
  const byPkg = new Map<string, string>();
  apps.forEach((a) => byPkg.set(a.package, a.label || a.package));
  const ql = q.trim().toLocaleLowerCase("tr");
  const chosen = new Set(value.map((v) => v.package));
  const list = [...byPkg.entries()].filter(([p]) => !chosen.has(p)).filter(([p, l]) => !ql || l.toLocaleLowerCase("tr").includes(ql) || p.includes(ql)).slice(0, ql ? 30 : 10);
  return (
    <div className="field">
      <span>
        Kısıtlıyken izinli uygulamalar{" "}
        <Info>Görev yapılmadığı sürece de açık kalır (ör. sözlük, WhatsApp). İstersen günlük dakika sınırı koy; bu süre ayrıdır, kasaya gitmez ve ertesi güne devretmez.</Info>
      </span>
      {value.map((v) => {
        const setMin = (m: number | null) => onChange(value.map((x) => (x.package === v.package ? { ...x, minutes: m } : x)));
        return (
          <div className="ra-row" key={v.package}>
            <button type="button" className="chip-btn on ra-chip" title="Kaldırmak için tıkla" onClick={() => onChange(value.filter((x) => x.package !== v.package))}>
              {byPkg.get(v.package) ?? v.package}
              <span className="ra-x" aria-hidden="true">×</span>
            </button>
            <label className="check ra-unl">
              <input type="checkbox" checked={v.minutes == null} onChange={(e) => setMin(e.target.checked ? null : 30)} />
              Sınırsız
            </label>
            {v.minutes != null && (
              <span className="row gap-s ra-time">
                <span className="muted small">Günde</span>
                <MinuteStepper value={v.minutes} onChange={(m) => setMin(Math.max(1, m))} min={1} max={600} label={`${byPkg.get(v.package) ?? v.package} günlük süre`} />
              </span>
            )}
          </div>
        );
      })}
      <input placeholder="Uygulama ara" value={q} onChange={(e) => setQ(e.target.value)} />
      {list.length > 0 && (
        <div className="chips">
          {list.map(([p, l]) => (
            <button key={p} type="button" className="chip-btn" onClick={() => onChange([...value, { package: p, minutes: null }])}>+ {l}</button>
          ))}
        </div>
      )}
    </div>
  );
}

