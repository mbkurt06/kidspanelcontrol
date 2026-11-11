import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { supabase } from "./supabase";
import type { ActivityDef, FocusProfile, TimerSession, AppGroupDef, AppUsageRule, Child, DeviceStatus, GroupLimit, GroupMember, Mode, ModeSlot, OrbitEvent, Profile, Section, SectionRule, TimeRule, FamilySettings } from "./types";

type FamilyData = {
  familyId: string | null;
  family: FamilySettings | null;
  children: Child[];
  profiles: Profile[];
  modes: Mode[];
  slots: ModeSlot[];
  groups: AppGroupDef[];
  appUsageRules: AppUsageRule[];
  members: Record<string, string>;
  sections: Section[];
  sectionRules: SectionRule[];
  groupLimits: GroupLimit[];
  focusProfiles: FocusProfile[];
  activities: ActivityDef[];
  /** çocuk id → çalışan/moladaki sayaç */
  timers: Record<string, TimerSession>;
  timeRules: TimeRule[];
  statuses: Record<string, DeviceStatus>;
  unreadEvents: number;
  unreadMessages: number;
  pendingApprovals: number;
  selectedChildId: string;
  setSelectedChildId: (id: string) => void;
  visibleChildren: Child[];
  loading: boolean;
  reload: () => Promise<void>;
};

const Ctx = createContext<FamilyData | null>(null);

export function FamilyProvider({ children: kids }: { children: React.ReactNode }) {
  const [state, setState] = useState<Omit<FamilyData, "reload" | "selectedChildId" | "setSelectedChildId" | "visibleChildren">>({
    familyId: null,
    family: null,
    children: [],
    profiles: [],
    modes: [],
    slots: [],
    groups: [],
    appUsageRules: [],
    members: {},
    sections: [],
    sectionRules: [],
    groupLimits: [],
    focusProfiles: [],
    activities: [],
    timers: {},
    timeRules: [],
    statuses: {},
    unreadEvents: 0,
    unreadMessages: 0,
    pendingApprovals: 0,
    loading: true,
  });
  const [selectedChildId, setSelectedChildId] = useState(() => localStorage.getItem("orbit.selectedChild") ?? "all");

  useEffect(() => {
    if (state.children.length && selectedChildId !== "all" && !state.children.some((c) => c.id === selectedChildId)) setSelectedChildId("all");
    localStorage.setItem("orbit.selectedChild", selectedChildId);
  }, [selectedChildId, state.children]);

  const reload = useCallback(async () => {
    supabase.rpc("touch_parent_device").then(() => {});
    const [fam, ch, pr, mo, sl, st, ev, ap, gr, gm, se, sr, gl, um, fp, ac, ts, tr, ar] = await Promise.all([
      supabase.from("families").select("id,lock_button,lock_button_minutes,pin_unlock_minutes,parent_pin_hash,task_before_photo_min,task_before_photo_max,task_after_photo_min,task_after_photo_max,task_record_camera,proof_retention_days,task_defaults,open_start,open_end").limit(1).maybeSingle(),
      supabase.from("children").select("*").order("sort_order").order("created_at"),
      supabase.from("rule_profiles").select("*").order("created_at"),
      supabase.from("modes").select("*").order("priority", { ascending: false }),
      supabase.from("mode_slots").select("*").order("start_time"),
      supabase.from("device_status").select("*"),
      supabase.from("events").select("id", { count: "exact", head: true }).is("read_at", null),
      supabase.from("task_runs").select("id", { count: "exact", head: true }).eq("status", "submitted"),
      supabase.from("app_groups").select("*").order("sort_order").order("created_at"),
      supabase.from("app_group_members").select("*"),
      supabase.from("profile_sections").select("*").order("start_time"),
      supabase.from("section_rules").select("*"),
      supabase.from("profile_group_limits").select("*"),
      supabase.from("messages").select("id", { count: "exact", head: true }).eq("from_parent", false).is("read_at", null),
      supabase.from("focus_profiles").select("*").order("sort_order").order("created_at"),
      supabase.from("activities").select("*").order("sort_order").order("created_at"),
      supabase.from("timer_sessions").select("*").in("status", ["running", "paused"]),
      supabase.from("time_rules").select("*").order("start_time"),
      supabase.from("app_usage_rules").select("*").order("name"),
    ]);
    const timers: Record<string, TimerSession> = {};
    for (const t of (ts.data ?? []) as TimerSession[]) timers[t.child_id] = t;
    const members: Record<string, string> = {};
    for (const m of (gm.data ?? []) as GroupMember[]) members[m.package] = m.group_id;
    const statuses: Record<string, DeviceStatus> = {};
    for (const s of (st.data ?? []) as DeviceStatus[]) statuses[s.child_id] = s;
    setState({
      familyId: (fam.data as { id: string } | null)?.id ?? null,
      family: (fam.data as FamilySettings | null) ?? null,
      children: (ch.data ?? []) as Child[],
      profiles: (pr.data ?? []) as Profile[],
      modes: (mo.data ?? []) as Mode[],
      slots: (sl.data ?? []) as ModeSlot[],
      groups: (gr.data ?? []) as AppGroupDef[],
      appUsageRules: (ar.data ?? []) as AppUsageRule[],
      members,
      sections: (se.data ?? []) as Section[],
      sectionRules: (sr.data ?? []) as SectionRule[],
      groupLimits: (gl.data ?? []) as GroupLimit[],
      focusProfiles: (fp.data ?? []) as FocusProfile[],
      activities: (ac.data ?? []) as ActivityDef[],
      timers,
      timeRules: (tr.data ?? []) as TimeRule[],
      statuses,
      unreadEvents: ev.count ?? 0,
      unreadMessages: um.count ?? 0,
      pendingApprovals: ap.count ?? 0,
      loading: false,
    });
  }, []);

  useEffect(() => {
    reload();
    // Panel açıkken durumları düzenli yenile; uygulama ön plana gelince hemen yenile.
    const t = setInterval(reload, 20000);
    const onVis = () => document.visibilityState === "visible" && reload();
    document.addEventListener("visibilitychange", onVis);
    return () => {
      clearInterval(t);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [reload]);

  const visibleChildren = selectedChildId === "all" ? state.children : state.children.filter((c) => c.id === selectedChildId);
  return <Ctx.Provider value={{ ...state, reload, selectedChildId, setSelectedChildId, visibleChildren }}>{kids}</Ctx.Provider>;
}

export function useFamily() {
  const v = useContext(Ctx);
  if (!v) throw new Error("FamilyProvider yok");
  return v;
}

export type { OrbitEvent };
