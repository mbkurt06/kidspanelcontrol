export type AppGroup = "always_open" | "unlimited" | "timed" | "blocked";

export type Window = { start: string; end: string };

export type Child = { id: string; family_id: string; name: string; color: string; sort_order: number };

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
};

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
export type RewardValidity = "today" | "tomorrow" | "date" | "wallet";

export type TaskTemplate = {
  id: string;
  family_id: string;
  title: string;
  description: string | null;
  proof: ProofType;
  before_after: boolean;
  reward_minutes: number | null;
  reward_text: string | null;
  reward_validity: RewardValidity;
  reward_expires_days: number | null;
  mandatory: boolean;
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
  reward_text: string | null;
  reward_delivered_at: string | null;
};

export type TaskProof = {
  id: string;
  run_id: string;
  stage: "before" | "after" | "single";
  media: "photo" | "video";
  path: string;
  attempt: number;
  removed_at: string | null;
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
