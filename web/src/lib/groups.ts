import { supabase } from "./supabase";
import { todayISO } from "./util";
import type { Task, TaskGroup, TaskGroupRun, TaskRun } from "./types";

export const WEEKDAYS = [1, 2, 3, 4, 5];
export const WEEKEND = [6, 7];
export const DAY_SHORT = ["Pzt", "Sal", "Çar", "Per", "Cum", "Cmt", "Paz"];

export type RepeatChoice = "once" | "daily" | "weekdays" | "weekend" | "days" | "biweekly" | "monthly";

export function repeatChoice(g: Pick<TaskGroup, "recurrence" | "days">): RepeatChoice {
  if (g.recurrence === "once") return "once";
  if (g.recurrence === "biweekly") return "biweekly";
  if (g.recurrence === "monthly") return "monthly";
  const d = [...g.days].sort().join(",");
  if (d === "1,2,3,4,5,6,7") return "daily";
  if (d === "1,2,3,4,5") return "weekdays";
  if (d === "6,7") return "weekend";
  return "days";
}

export function repeatText(g: TaskGroup): string {
  const c = repeatChoice(g);
  const days = [...g.days].sort().map((d) => DAY_SHORT[d - 1]).join(", ");
  const base =
    c === "once" ? "bir kez" : c === "daily" ? "her gün" : c === "weekdays" ? "hafta içi" : c === "weekend" ? "hafta sonu" : c === "biweekly" ? `2 haftada bir · ${days}` : c === "monthly" ? `ayda bir (${Number(g.start_date.slice(8, 10))}.)` : days;
  return g.due_time ? `${base} · ${g.due_time.slice(0, 5)}'e kadar` : base;
}

/** Grubun bugünkü dönem günü: tekrarlıda bugün, tek seferlikte başlangıç günü. */
export function groupDay(g: TaskGroup): string {
  return g.recurrence === "once" ? g.start_date : todayISO();
}

export type GroupProgress = {
  total: number;
  approved: number;
  need: number;
  mandatoryLeft: number;
  held: number;
  earned: number;
  all: number;
  status: "open" | "met" | "failed";
  submitted: number;
};

export function groupProgress(g: TaskGroup, tasks: Task[], runs: TaskRun[], groupRuns: TaskGroupRun[], childId: string, day = groupDay(g)): GroupProgress {
  const ids = new Set(tasks.filter((t) => t.group_id === g.id).map((t) => t.id));
  const list = runs.filter((r) => ids.has(r.task_id) && r.child_id === childId && r.day === day && r.status !== "claimed");
  const byId = Object.fromEntries(tasks.map((t) => [t.id, t]));
  const total = list.length;
  const approved = list.filter((r) => r.status === "approved").length;
  const mandatoryLeft = list.filter((r) => byId[r.task_id]?.mandatory && r.status !== "approved").length;
  const mins = (r: TaskRun) => Math.max(0, r.granted_minutes ?? byId[r.task_id]?.reward_minutes ?? 0);
  // Kazanılan: onaylanan görevlerin süresi; bekleyen: henüz açılmamış (verilmemiş) kısmı
  const earned = list.filter((r) => r.status === "approved").reduce((a, r) => a + mins(r), 0);
  const held = list.filter((r) => r.status === "approved" && !r.grant_id).reduce((a, r) => a + mins(r), 0);
  const all = tasks.filter((t) => t.group_id === g.id && t.active).reduce((a, t) => a + Math.max(0, t.reward_minutes ?? 0), 0);
  const need = g.min_count == null ? total : Math.min(g.min_count, total);
  const gr = groupRuns.find((x) => x.group_id === g.id && x.child_id === childId && x.day === day);
  return { total, approved, need, mandatoryLeft, held, earned, all, status: gr?.status ?? "open", submitted: list.filter((r) => r.status === "submitted").length };
}

export function groupTasks(g: TaskGroup, tasks: Task[]): Task[] {
  return tasks
    .filter((t) => t.group_id === g.id)
    .sort((a, b) => a.group_order - b.group_order || a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
}

export async function moveToGroup(task: Task, g: TaskGroup | null, tasks: Task[]) {
  if (!g) return supabase.from("tasks").update({ group_id: null, group_order: 0 }).eq("id", task.id);
  const max = Math.max(0, ...tasks.filter((t) => t.group_id === g.id).map((t) => t.group_order));
  return supabase.from("tasks").update({ group_id: g.id, group_order: max + 1, child_ids: g.child_ids.length ? g.child_ids : task.child_ids }).eq("id", task.id);
}

export async function saveOrder(list: Task[]) {
  await Promise.all(list.map((t, i) => (t.group_order === i + 1 ? null : supabase.from("tasks").update({ group_order: i + 1 }).eq("id", t.id))));
}

export const newGroup = (familyId: string, childIds: string[]): Partial<TaskGroup> => ({
  family_id: familyId,
  name: "Yeni grup",
  child_ids: childIds,
  recurrence: "days",
  days: [1, 2, 3, 4, 5, 6, 7],
  start_date: todayISO(),
  sequential: false,
  min_count: null,
  reward_mode: "done",
  reward_validity: "today",
  fail_mode: "vault",
});
