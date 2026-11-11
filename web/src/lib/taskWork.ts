import type { FamilySettings as Family, Mode, Task, TaskGroup, TaskRun } from "./types";

/** Görevin "çalışma şekli" ayarları: grup ayarları tablosu ve görev ekranı aynı alanları kullanır. */

export type ProofKey = "camera" | "photo" | "screenshot" | "screenrec";
export const PROOFS: Array<[ProofKey, string]> = [
  ["camera", "🎥 Kamera kaydı"],
  ["photo", "📷 Fotoğraf"],
  ["screenshot", "🖼️ Ekran görüntüsü"],
  ["screenrec", "🎬 Ekran kaydı"],
];

export function proofKeys(t: Partial<Task>): ProofKey[] {
  const k: ProofKey[] = [];
  if (t.record_minutes != null) k.push("camera");
  if (t.proof && t.proof !== "none") k.push("photo");
  if (t.screenshot_min != null) k.push("screenshot");
  if (t.screen_record_minutes != null) k.push("screenrec");
  return k;
}

export const taskDuration = (t: Partial<Task>) => t.record_minutes ?? t.screen_record_minutes ?? 30;

/** Kanıt seçimi değişince görev alanları (fotoğraf = öncesi + sonrası, adet ailenin varsayılanından) */
export function proofPatch(t: Partial<Task>, keys: ProofKey[], fam: Family | null, dur = taskDuration(t)): Partial<Task> {
  const has = (k: ProofKey) => keys.includes(k);
  const photo = has("photo");
  return {
    record_minutes: has("camera") ? dur : null,
    record_min_minutes: has("camera") && t.record_min_minutes != null ? Math.min(t.record_min_minutes, dur) : null,
    screen_record_minutes: has("screenrec") ? dur : null,
    screen_record_min_minutes: has("screenrec") && t.screen_record_min_minutes != null ? Math.min(t.screen_record_min_minutes, dur) : null,
    screenshot_min: has("screenshot") ? t.screenshot_min ?? 1 : null,
    screenshot_max: has("screenshot") ? t.screenshot_max ?? 4 : null,
    proof: photo ? "photo" : "none",
    before_after: photo,
    proof_before_min: photo ? fam?.task_before_photo_min ?? 1 : 0,
    proof_before_max: photo ? fam?.task_before_photo_max ?? 4 : 4,
    proof_after_min: photo ? fam?.task_after_photo_min ?? 1 : 1,
    proof_after_max: photo ? fam?.task_after_photo_max ?? 4 : 4,
  };
}

export function durationPatch(t: Partial<Task>, dur: number): Partial<Task> {
  return {
    record_minutes: t.record_minutes != null ? dur : null,
    record_min_minutes: t.record_min_minutes != null ? Math.min(t.record_min_minutes, dur) : t.record_min_minutes ?? null,
    screen_record_minutes: t.screen_record_minutes != null ? dur : null,
    screen_record_min_minutes: t.screen_record_min_minutes != null ? Math.min(t.screen_record_min_minutes, dur) : t.screen_record_min_minutes ?? null,
  };
}

export function proofText(t: Partial<Task>): string {
  const k = proofKeys(t);
  if (!k.length) return "Kanıt yok";
  return PROOFS.filter(([key]) => k.includes(key)).map(([, l]) => l.split(" ").slice(1).join(" ")).join(" + ");
}

/** Yeni grup görevinin varsayılanları: 08:00–20:00, onaylanınca hemen (kullandıkça), hemen başlar, kamera kaydı */
export function newGroupTask(g: TaskGroup, fam: Family | null, familyId: string, title: string, mandatory: boolean, order: number): Partial<Task> & Record<string, unknown> {
  return {
    family_id: familyId,
    title,
    child_ids: g.child_ids,
    assign_mode: "each",
    recurrence: "days",
    days: [1, 2, 3, 4, 5, 6, 7],
    group_id: g.id,
    group_order: order,
    mandatory,
    phone_restriction: mandatory ? "kiosk" : "none",
    restriction_mode_id: null,
    reward_minutes: 30,
    reward_validity: "today",
    use_mode: "usage",
    fail_minutes: null,
    fail_target: "vault",
    earn_links: [],
    earn_mode: "all",
    earn_min: 1,
    start_after: [],
    start_time: "08:00",
    due_time: "20:00",
    record_minutes: 30,
    record_camera: fam?.task_record_camera ?? "choose",
    proof: "none",
    before_after: false,
    active: true,
  };
}

export function lockLabel(t: Partial<Task>, modes: Mode[]): string {
  const r = t.phone_restriction ?? "none";
  if (r === "kiosk") return "Tam kilit";
  if (r === "none") return "Kısıtlama yok";
  if (r === "limit") return modes.find((m) => m.builtin === "blocked")?.name ?? "Kilitli";
  return modes.find((m) => m.id === t.restriction_mode_id)?.name ?? "Kullanım profili";
}

const hm = (v?: string | null) => (v ? v.slice(0, 5) : null);
const USE: Record<string, string> = { usage: "kullandıkça", clock: "saat gibi", within: "süre içinde" };

export function earnText(t: Partial<Task>, all: Task[]): string {
  const links = (t.earn_links ?? []).map((id) => all.find((x) => x.id === id)?.title).filter(Boolean) as string[];
  if (!links.length) return "Onaylanınca";
  const n = links.length;
  const how = t.earn_mode === "any" ? "herhangi biri" : t.earn_mode === "min" ? `en az ${Math.min(t.earn_min ?? 1, n)}` : "hepsi";
  return `${links.join(", ")} bitince (${how})`;
}

export function startText(t: Partial<Task>, all: Task[]): string {
  const after = (t.start_after ?? []).map((id) => all.find((x) => x.id === id)?.title).filter(Boolean) as string[];
  return after.length ? `${after.join(", ")} bitince başlar` : "Hemen başlar";
}

export function destText(t: Partial<Task>): string {
  if (t.reward_validity === "wallet") return "Cüzdana";
  if (t.reward_validity === "vault") return "Kasaya";
  return `Hemen/${USE[t.use_mode ?? "usage"] ?? "kullandıkça"}`;
}

/** Özet satırı: +45/−30 · Zorunlu · Tam kilit · Onaylanınca · Hemen/kullandıkça · Hemen başlar · Kamera kaydı 30 dk · 08:00–20:00 */
export function specText(t: Task, all: Task[], modes: Mode[]): string {
  const rec = proofKeys(t).some((k) => k === "camera" || k === "screenrec");
  return [
    `+${Math.max(0, t.reward_minutes ?? 0)}${t.fail_minutes ? `/−${t.fail_minutes}` : ""}`,
    t.mandatory ? "Zorunlu" : "Seçmeli",
    lockLabel(t, modes),
    earnText(t, all),
    destText(t),
    startText(t, all),
    proofText(t) + (rec ? ` ${taskDuration(t)} dk` : ""),
    hm(t.start_time) || hm(t.due_time) ? `${hm(t.start_time) ?? "—"}–${hm(t.due_time) ?? "—"}` : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

const FAIL_TO: Record<string, string> = { vault: "kasadan düşülür", wallet: "cüzdana borç yazılır", today: "o günün süresinden düşülür" };

/** Telefonda ne olur: düz cümle */
export function phoneSentence(t: Task, all: Task[], modes: Mode[]): string {
  const parts: string[] = [];
  const after = startText(t, all);
  if (after !== "Hemen başlar") parts.push(`${after.replace(" başlar", "")} başlayabilir.`);
  if ((t.phone_restriction ?? "none") !== "none") parts.push(`Bitene kadar ${lockLabel(t, modes) === "Tam kilit" ? "telefon Tam kilitli" : `“${lockLabel(t, modes)}” profili geçerli`}.`);
  const when = earnText(t, all);
  const m = Math.max(0, t.reward_minutes ?? 0);
  const w = when === "Onaylanınca" ? "Onaylanınca" : `${when.replace(/ \(.*\)$/, "")} bitince`.replace(" bitince bitince", " bitince");
  if (t.reward_validity === "wallet") parts.push(`${w} +${m} dk cüzdana gider.`);
  else if (t.reward_validity === "vault") parts.push(`${w} +${m} dk kasaya gider.`);
  else parts.push(`${w} +${m} dk hemen açılır, ${USE[t.use_mode ?? "usage"] ?? "kullandıkça"} düşer${(t.phone_restriction ?? "none") !== "none" ? "; süre bitene kadar kilit kalkar" : ""}.`);
  if (when !== "Onaylanınca") parts.push("Gün içinde koşul sağlanmazsa kazanılan süre kasaya gider.");
  if (t.fail_minutes) parts.push(`Yapılmazsa −${t.fail_minutes} dk ${FAIL_TO[t.fail_target ?? "today"]}.`);
  parts.push(proofKeys(t).length ? `Kanıt: ${proofText(t).toLowerCase()}.` : "Kanıt istenmez.");
  return parts.join(" ");
}

/** Grup görevinin bugünkü durumu (panel "Bugün") */
export type RunDest = { vault: boolean; wallet: boolean };
export function runBadge(t: Task, r: TaskRun | undefined, all: Task[], runs: TaskRun[], dest: Record<string, RunDest>): { text: string; tone: "good" | "wait" | "wallet" | "vault" | "bad" | "muted" } {
  if (!r) return { text: "—", tone: "muted" };
  const m = Math.max(0, r.granted_minutes ?? t.reward_minutes ?? 0);
  if (r.status === "approved") {
    if (!r.grant_id) return { text: `⏳ ${m} dk bekliyor`, tone: "wait" };
    const d = dest[r.grant_id];
    if (d?.vault) return { text: `🏦 +${m} kasaya`, tone: "vault" };
    if (d?.wallet) return { text: `👛 +${m} cüzdana`, tone: "wallet" };
    return { text: `✅ +${m} açıldı`, tone: "good" };
  }
  if (r.status === "submitted") return { text: "Onay bekliyor", tone: "wait" };
  if (r.status === "expired") return { text: t.fail_minutes ? `Yapılmadı · −${t.fail_minutes}` : "Yapılmadı", tone: "bad" };
  if (r.status === "claimed") return { text: "Kardeşi yaptı", tone: "muted" };
  const blocking = (t.start_after ?? []).filter((id) => {
    const x = runs.find((y) => y.task_id === id && y.child_id === r.child_id && y.day === r.day);
    return x && x.status !== "approved" && x.status !== "claimed";
  });
  if (blocking.length) return { text: `🔒 ${blocking.map((id) => all.find((x) => x.id === id)?.title).join(", ")} bitince`, tone: "muted" };
  if (r.status === "rejected") return { text: "Reddedildi", tone: "bad" };
  return { text: r.status === "started" ? "Yapıyor" : "Yapılmadı", tone: "muted" };
}
