export type AppGroup = "always_open" | "unlimited" | "timed" | "blocked";

export type Window = { start: string; end: string };

export type ExtraTarget = "now" | "current" | "pool" | "wallet";
export type Child = { id: string; family_id: string; name: string; color: string; sort_order: number; grade_level?: number | null; extra_default: ExtraTarget; wallet_daily_max?: number | null;
  closed_grant_mode?: "clock" | "usage" | "within"; closed_grant_within_minutes?: number | null; closed_grant_within_factor?: number | null;
  profile_nickname?: string | null; profile_avatar?: string | null;
  kiosk_settings?: KioskSettings; parent_pin_enabled?: boolean;
  wifi_settings?: { child_add: boolean; notify: boolean; show_passwords: boolean; system_wifi?: boolean }; parent_pin_hash?: string | null;
  music_mode?: "always" | "rules" | "never"; music_folder?: string | null; music_folders?: string[]; timer_defaults?: { allow_stop: "no" | "yes" | "notify"; pause_mode: "none" | "limit" | "child"; pause_max_minutes: number | null; focus_change: "no" | "stricter" | "free" } };

export type AgendaKind = "homework" | "exam" | "payment" | "event";
export type AgendaItem = {
  id: string;
  family_id: string;
  child_id: string;
  kind: AgendaKind;
  title: string;
  note: string | null;
  entered_at: string;
  due_date: string;
  due_time: string | null;
  amount: number | null;
  currency: string;
  status: "open" | "done";
  completed_at: string | null;
  created_at: string;
  task_id?: string | null;
};

export type ChildApp = {
  child_id: string;
  package: string;
  label: string;
  app_group: AppGroup;
  approved: boolean;
  daily_limit_minutes: number | null;
  is_system: boolean;
  installed: boolean;
  first_seen_at: string;
  category: string | null;
  usage_rule_id?: string | null;
  kiosk?: boolean;
  kiosk_windows?: KioskWindow[];
};

export type KioskWindow = { start: string; end: string };

export type AppUsageRule = {
  id: string;
  family_id: string;
  name: string;
  mode: "open" | "timed" | "blocked";
  max_minutes: number | null;
  counts_toward_daily: boolean;
  start_time: string | null;
  end_time: string | null;
};

// --- Gün bölümleri ve uygulama grupları ---

export type SecRule = "open" | "timed" | "blocked";

export type AppGroupDef = { id: string; family_id: string; name: string; color: string; sort_order: number };
export type GroupMember = { family_id: string; package: string; group_id: string };

export type Section = {
  id: string;
  profile_id: string;
  name: string;
  start_time: string;
  end_time: string;
  budget_minutes: number | null;
  carry_over: boolean;
  default_rule: SecRule;
  color: string;
  sort_order: number;
  icon: string | null;
  message: string | null;
  kiosk?: boolean;
  /** Bölümün kullanım profili */
  mode_id?: string | null;
  music?: boolean;
};

export type KioskScreen = "tasks" | "plan" | "agenda" | "grades" | "vocab" | "messages" | "music" | "timer" | "alarms" | "day" | "wallet" | "ask" | "vault" | "wifi" | "profile" | "about";
export const KIOSK_SCREENS: [KioskScreen, string][] = [
  ["tasks", "✅ Görevler"],
  ["plan", "📋 Planım"],
  ["agenda", "🗓 Ajanda"],
  ["grades", "📝 Notlarım"],
  ["vocab", "📚 Kelime kartları"],
  ["messages", "💬 Mesajlar"],
  ["music", "🎵 Müzik"],
  ["timer", "⏱ Sayaç"],
  ["alarms", "⏰ Alarmlar"],
  ["wallet", "⏳ Süre cüzdanı"],
  ["ask", "🙋 Ebeveynden iste"],
  ["vault", "🔑 Şifreler"],
  ["wifi", "📶 Wi-Fi"],
  ["profile", "👤 Profil"],
  ["about", "ℹ️ Hakkında"],
];
export type KioskSettings = { message: string | null; screens: KioskScreen[]; calls: "emergency" | "all" };

export type FamilySettings = {
  id: string;
  lock_button: "kiosk" | "limit" | "ask";
  lock_button_minutes: number | null;
  pin_unlock_minutes: number;
  parent_pin_hash: string | null;
  task_before_photo_min: number;
  task_record_camera?: "back" | "front" | "choose";
  /** Orbit günü bitişi ("05:00:00"): o güne ait süreler bu saate kadar bekler, kalan kasaya */
  day_end?: string;
  task_before_photo_max: number;
  task_after_photo_min: number;
  task_after_photo_max: number;
  proof_retention_days: number;
  task_defaults?: TaskDefaults | null;
  open_start?: string;
  open_end?: string;
};

/** Yeni görevde hazır gelen ayarlar (ad, tarih, saat hariç). */
export type TaskDefaults = Partial<{
  child_ids: string[];
  assign_mode: "each" | "first";
  proof: ProofType;
  before_after: boolean;
  proof_before_min: number;
  proof_before_max: number;
  proof_after_min: number;
  proof_after_max: number;
  reward_minutes: number | null;
  fail_minutes?: number | null;
  vocab_cards?: number | null;
  fail_target?: "today" | "wallet" | "vault";
  reward_text: string | null;
  reward_validity: RewardValidity;
  reward_expires_days: number | null;
  record_minutes: number | null;
  record_min_minutes: number | null;
  screenshot_min: number | null;
  screenshot_max: number | null;
  screen_record_minutes: number | null;
  screen_record_min_minutes: number | null;
  allowed_packages: string[];
  allowed_mode: "keep" | "focus";
  restriction_mode_id: string | null;
  restricted_allowed: RestrictedApp[];
  use_mode: UseMode;
  use_within_minutes: number | null;
  record_camera: "back" | "front" | "choose";
  record_pause: "none" | "limit" | "child";
  record_pause_max: number | null;
  phone_restriction: TaskPhoneRestriction;
  orbit_focus_profile_id: string | null;
}>;

export type TaskGroup = {
  id: string;
  family_id: string;
  name: string;
  child_ids: string[];
  active: boolean;
  recurrence: "once" | "days" | "biweekly" | "monthly";
  days: number[];
  start_date: string;
  end_date: string | null;
  start_time: string | null;
  due_time: string | null;
  sequential: boolean;
  min_count: number | null;
  reward_mode: "done" | "all";
  reward_validity: "today" | "wallet" | "vault";
  fail_mode: "vault" | "burn" | "penalty";
  penalty_minutes: number | null;
  mandatory_release: "each" | "all";
  /** Bağlı görevler: sıralı; her bağın görevleri birlikte açılır */
  bundles: Array<{ tasks: string[] }>;
  bundles_sequential: boolean;
  use_mode: UseMode;
  use_within_minutes: number | null;
  /** Grup kısıtlaması: seçilen kullanım profili, ne zamana kadar */
  restriction?: "none" | "limit" | "kiosk" | "mode";
  restriction_mode_id?: string | null;
  restriction_until?: "mandatory" | "condition" | "all";
  defaults: TaskDefaults | null;
  sort: number;
  created_at: string;
  /** Ayarlar görev başına (grup ayarları tablosu) */
  per_task?: boolean;
};

export type TaskGroupRun = { group_id: string; child_id: string; day: string; status: "open" | "met" | "failed"; grant_id: string | null; settled_at: string | null };

export type RuleKind = "kiosk" | "limit" | "free" | "music_off" | "music_on";
export const RULE_KIND: Record<RuleKind, { label: string; color: string; hint: string }> = {
  kiosk: { label: "🔒 Kilitle", color: "#ff5d6c", hint: "Ekranda sadece Orbit kalır; ayarlar, bildirimler ve diğer uygulamalar kapalı." },
  limit: { label: "🌙 Sınırla", color: "#f2b134", hint: "Sadece her zaman açık uygulamalar çalışır (telefon, mesaj vb.)." },
  free: { label: "🟢 Serbest", color: "#2bb673", hint: "Süre ve kurallar işlemez; onaylı her şey açık." },
  music_off: { label: "🔇 Müzik kapalı", color: "#7a7fa8", hint: "Orbit müzik çalar bu saatlerde çalmaz." },
  music_on: { label: "🎵 Müzik açık", color: "#4f7cff", hint: "Bu saatlerde müzik her durumda çalabilir." },
};

export type TimeRule = {
  id: string;
  family_id: string;
  name: string;
  kind: RuleKind;
  start_date: string | null;
  end_date: string | null;
  child_ids: string[];
  days: number[];
  start_time: string;
  end_time: string;
  message: string | null;
  screens: KioskScreen[] | null;
  active: boolean;
};

export type SectionRule = {
  id: string;
  section_id: string;
  group_id: string | null;
  package: string | null;
  rule: SecRule;
  limit_minutes: number | null;
};

export type GroupLimit = { profile_id: string; group_id: string; daily_minutes: number };

export const RULE_LABEL: Record<SecRule, string> = { open: "Serbest", timed: "Süreli", blocked: "Kilitli" };

export type Profile = {
  id: string;
  family_id: string;
  name: string;
  daily_minutes: number;
  max_total_minutes: number | null;
  timed_windows: Window[];
  unlimited_windows: Window[];
  warn_minutes: number[];
};

export type Mode = {
  id: string;
  family_id: string;
  name: string;
  icon: string;
  color: string;
  allowed_packages: string[];
  allowed_groups: AppGroup[];
  budget_minutes: number | null;
  counts_toward_daily: boolean;
  others_blocked: boolean;
  extra_time_allowed: boolean;
  warn_minutes: number[];
  priority: number;
  kiosk_enabled?: boolean;
  kiosk_screens?: KioskScreen[];
  kiosk_calls?: "emergency" | "all";
  /** Hazır profil (gün profili bölüm türü): open | timed | blocked | kiosk */
  builtin?: "open" | "timed" | "blocked" | "kiosk" | null;
  kiosk_message?: string | null;
  /** Bu profildeyken süre verilince: null = çocuğun varsayılanı, none = kasaya */
  grant_mode?: "none" | "clock" | "usage" | "within" | "open" | null;
  grant_within_minutes?: number | null;
};

export type ModeSlot = {
  id: string;
  profile_id: string;
  mode_id: string;
  days: number[];
  start_time: string;
  end_time: string;
};

export type Assignment = { child_id: string; weekday: number; profile_id: string };

export type DayOverride = {
  id: string;
  child_id: string;
  day: string;
  profile_id: string | null;
  daily_minutes: number | null;
  note: string | null;
};

export type DeviceStatus = {
  child_id: string;
  day: string | null;
  used_minutes: number;
  allowance_minutes: number;
  remaining_minutes: number;
  /** Gün bitişine kadar kalan hak (kilitliyken de) */
  day_left_minutes?: number | null;
  grant_used?: Record<string, number> | null;
  /** Telefon canlı bağlantıda mı (değişiklikleri anında alır) */
  live?: boolean | null;
  /** Telefonda pil optimizasyonu muafiyeti var mı */
  power_exempt?: boolean | null;
  current_mode_name: string | null;
  locked: boolean;
  lock_reason: string | null;
  foreground_package: string | null;
  battery: number | null;
  updated_at: string;
};

export type Device = {
  id: string;
  child_id: string | null;
  kind: "child_phone" | "viewer";
  label: string;
  model: string | null;
  os_version: string | null;
  app_version: string | null;
  is_device_owner: boolean | null;
  status: "active" | "revoked";
  last_seen_at: string | null;
  update_status?: string | null;
  update_target?: number | null;
  update_checked_at?: string | null;
  last_update_at?: string | null;
  update_error?: string | null;
  created_at: string;
};

export type ParentDevice = {
  id: string;
  user_id: string;
  label: string;
  status: "pending" | "approved" | "revoked";
  last_seen_at: string | null;
  created_at: string;
};

export type Command = {
  id: string;
  child_id: string;
  type: "lock" | "unlock" | "start_mode" | "end_mode" | "adjust_minutes" | "resync";
  payload: Record<string, unknown>;
  until_at: string | null;
  created_at: string;
  acked_at: string | null;
  cancelled_at: string | null;
};

export type TimeGrant = {
  id: string;
  child_id: string;
  minutes: number;
  valid_on: string | null;
  expires_on: string | null;
  activated_on: string | null;
  source: string;
  note: string | null;
  created_at: string;
  section_id: string | null;
  vault: boolean;
  window_start: string | null;
  window_end: string | null;
  /** Gece yarısını geçen süre: kalan kısmın devam edeceği ertesi gün kaydı */
  carry_to?: string | null;
  settled_at?: string | null;
};

export type OrbitEvent = {
  id: string;
  child_id: string | null;
  type: string;
  payload: Record<string, unknown>;
  created_at: string;
  read_at: string | null;
};

export const GROUP_LABEL: Record<AppGroup, string> = {
  always_open: "Her zaman açık",
  unlimited: "Sınırsız",
  timed: "Süreli",
  blocked: "Kapalı",
};

export const GROUP_HINT: Record<AppGroup, string> = {
  always_open: "Süreden düşmez, hiç kapanmaz",
  unlimited: "Süreden düşmez, izinli saatlerde açık",
  timed: "Günlük süreden düşer",
  blocked: "Hiç açılmaz",
};

export const WEEKDAYS = ["Pzt", "Sal", "Çar", "Per", "Cum", "Cmt", "Paz"];
export const WEEKDAYS_LONG = ["Pazartesi", "Salı", "Çarşamba", "Perşembe", "Cuma", "Cumartesi", "Pazar"];

// --- Aşama 2: görevler ---

export type ProofType = "none" | "photo" | "video" | "photo_or_video";
export type RewardValidity = "today" | "tomorrow" | "date" | "wallet" | "vault";
export type TaskPhoneRestriction = "none" | "limit" | "kiosk" | "mode";
export type UseMode = "clock" | "usage" | "within";
export type RestrictedApp = { package: string; minutes: number | null };

export type TaskTemplate = {
  id: string;
  family_id: string;
  title: string;
  description: string | null;
  proof: ProofType;
  before_after: boolean;
  proof_before_min: number;
  proof_before_max: number;
  proof_after_min: number;
  proof_after_max: number;
  reward_minutes: number | null;
  fail_minutes?: number | null;
  vocab_cards?: number | null;
  fail_target?: "today" | "wallet" | "vault";
  reward_text: string | null;
  reward_validity: RewardValidity;
  reward_expires_days: number | null;
  mandatory: boolean;
  record_minutes?: number | null;
  record_min_minutes?: number | null;
  screenshot_min?: number | null;
  screenshot_max?: number | null;
  screen_record_minutes?: number | null;
  screen_record_min_minutes?: number | null;
  allowed_packages?: string[] | null;
  allowed_mode?: "keep" | "focus" | null;
  restriction_mode_id?: string | null;
  restricted_allowed?: RestrictedApp[] | null;
  use_mode?: UseMode | null;
  use_within_minutes?: number | null;
  record_camera?: "back" | "front" | "choose";
  record_pause?: "none" | "limit" | "child";
  record_pause_max?: number | null;
  phone_restriction?: TaskPhoneRestriction;
  orbit_focus_profile_id?: string | null;
};

export type Task = TaskTemplate & {
  template_id: string | null;
  child_ids: string[];
  assign_mode: "each" | "first";
  recurrence: "once" | "days";
  days: number[];
  start_date: string;
  end_date: string | null;
  due_date: string | null;
  due_time: string | null;
  reward_date: string | null;
  active: boolean;
  created_at: string;
  phone_restriction: TaskPhoneRestriction;
  orbit_focus_profile_id: string | null;
  group_id: string | null;
  group_order: number;
  /** Süre ne zaman kazanılır: boş = görev onaylanınca; dolu = bu görevler bitince (hepsi / herhangi biri / en az N) */
  earn_links?: string[];
  earn_mode?: "all" | "any" | "min";
  unlock_mode?: "k0" | "k1" | "k2" | "k3";
  unlock_until?: string | null;
  earn_min?: number;
  /** Göreve başlama: bu görevler onaylanınca başlayabilir */
  start_after?: string[];
  /** Yapılma saati başlangıcı (bitiş due_time) */
  start_time?: string | null;
};

export type RunStatus = "open" | "started" | "submitted" | "approved" | "rejected" | "claimed" | "expired";

export type TaskRun = {
  id: string;
  task_id: string;
  child_id: string;
  day: string;
  status: RunStatus;
  submitted_at: string | null;
  decided_at: string | null;
  reject_note: string | null;
  attempts: number;
  granted_minutes: number | null;
  grant_id?: string | null;
  reward_text: string | null;
  reward_delivered_at: string | null;
};

export type TaskProof = {
  id: string;
  run_id: string;
  stage: "before" | "after" | "single" | "record" | "screenshot";
  media: "photo" | "video" | "timelapse";
  path: string;
  attempt: number;
  removed_at: string | null;
  recording_id?: string | null;
  seq?: number | null;
  frames?: number | null;
  started_at?: string | null;
  ended_at?: string | null;
};

export type TaskRecording = {
  id: string;
  run_id: string;
  child_id: string;
  attempt: number;
  status: "recording" | "paused" | "done" | "cancelled";
  camera: string;
  planned_seconds: number | null;
  recorded_seconds: number;
  paused_seconds: number;
  pause_count: number;
  capture_fps: number;
  video_fps: number;
  events: { at: string; type: string; note?: string }[];
  started_at: string;
  ended_at: string | null;
};

export const PROOF_LABEL: Record<ProofType, string> = {
  none: "Kanıt yok",
  photo: "Foto",
  video: "Video",
  photo_or_video: "Foto veya video",
};

export const VALIDITY_LABEL: Record<RewardValidity, string> = {
  today: "Bugün",
  tomorrow: "Yarın",
  date: "Belirli gün",
  wallet: "Çocuk istediği gün kullanır",
  vault: "Süre kasasına (sonra ben planlarım)",
};

export const STATUS_LABEL: Record<RunStatus, string> = {
  open: "Bekliyor",
  started: "Başladı",
  submitted: "Onay bekliyor",
  approved: "Onaylandı",
  rejected: "Tekrar yapmalı",
  claimed: "Kardeşi yaptı",
  expired: "Süresi doldu",
};

// --- Sayaç, odak profilleri, etkinlikler, alarmlar ---

export type FocusProfile = {
  id: string;
  family_id: string;
  name: string;
  icon: string | null;
  allowed_groups: string[];
  allowed_packages: string[];
  messages_allowed: boolean;
  calls_allowed: boolean;
  allowed_screens: string[];
  sort_order: number;
};

export type ActivityDef = {
  id: string;
  family_id: string;
  name: string;
  icon: string | null;
  default_focus_id: string | null;
  reward_every: number | null;
  reward_minutes: number | null;
  fail_minutes?: number | null;
  vocab_cards?: number | null;
  fail_target?: "today" | "wallet" | "vault";
  reward_to: "today" | "vault";
  sort_order: number;
};

export type AllowStop = "no" | "yes" | "notify";
export type PauseMode = "none" | "limit" | "child";
export type FocusChange = "no" | "stricter" | "free";

export type TimerSession = {
  id: string;
  family_id: string;
  child_id: string;
  activity_id: string | null;
  title: string;
  icon: string | null;
  kind: "countdown" | "stopwatch";
  planned_seconds: number | null;
  focus_id: string | null;
  started_by: "child" | "parent";
  allow_stop: AllowStop;
  pause_mode: PauseMode;
  pause_max_minutes: number | null;
  focus_change: FocusChange;
  status: "running" | "paused" | "done" | "stopped" | "cancelled";
  started_at: string;
  paused_at: string | null;
  paused_seconds: number;
  ended_at: string | null;
  ended_by: string | null;
  focused_seconds: number;
  away_seconds: number;
};

export type TimerDefaults = { allow_stop: AllowStop; pause_mode: PauseMode; pause_max_minutes: number | null; focus_change: FocusChange };

export type AlarmDef = {
  id: string;
  family_id: string;
  child_id: string;
  by_parent: boolean;
  title: string;
  kind: "alarm" | "reminder";
  at_time: string;
  days: number[];
  on_date: string | null;
  active: boolean;
  child_can_edit: boolean;
  child_can_delete: boolean;
  snooze_max: number;
  snooze_minutes: number;
  /** Alarm sesi (telefonun bildirdiği listeden); boşsa varsayılan */
  sound_uri?: string | null;
  sound_title?: string | null;
  /** Alarm ses seviyesi %; boşsa telefonun ayarı */
  volume?: number | null;
  ramp?: boolean;
};

export type AlarmLog = { id: string; alarm_id: string | null; child_id: string; title: string | null; fired_at: string; dismissed_at: string | null; snoozes: number };

/** Geçen çalışma süresi (molalar hariç), saniye */
export function timerElapsed(s: TimerSession, now = Date.now()) {
  const paused = s.status === "paused" && s.paused_at ? (now - new Date(s.paused_at).getTime()) / 1000 : 0;
  return Math.max(0, (now - new Date(s.started_at).getTime()) / 1000 - s.paused_seconds - paused);
}
export function timerRemaining(s: TimerSession, now = Date.now()) {
  return s.planned_seconds == null ? null : Math.max(0, s.planned_seconds - timerElapsed(s, now));
}
export function clockText(sec: number) {
  const t = Math.round(sec);
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = t % 60;
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

/** Görevin telefon kilidi ayarları (K0–K3) */
export const UNLOCK_TEXT: Record<string, string> = {
  k1: "Onaylanınca telefon açılır; kazandığı süreyi açık saatler içinde istediği zaman kullanır. Süre bitince telefon tekrar kilitlenir.",
  k0: "Süre hesaba yazılır; telefonu açmaz. Kilit başka yoldan kalkınca kullanılır.",
  k2: "Onaylanınca görev kilitleri bugün açık saatler bitene kadar kalkar; süre bitse de geri gelmez.",
  k3: "Görev kilitleri seçtiğin saate kadar kalkar; saat gelince yapılmamış görev varsa geri gelir.",
};

