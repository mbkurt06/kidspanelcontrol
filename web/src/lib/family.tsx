import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { supabase } from "./supabase";
import type { Child, DeviceStatus, Mode, ModeSlot, OrbitEvent, Profile } from "./types";

type FamilyData = {
  familyId: string | null;
  children: Child[];
  profiles: Profile[];
  modes: Mode[];
  slots: ModeSlot[];
  statuses: Record<string, DeviceStatus>;
  unreadEvents: number;
  pendingApprovals: number;
  loading: boolean;
  reload: () => Promise<void>;
};

const Ctx = createContext<FamilyData | null>(null);

export function FamilyProvider({ children: kids }: { children: React.ReactNode }) {
  const [state, setState] = useState<Omit<FamilyData, "reload">>({
    familyId: null,
    children: [],
    profiles: [],
    modes: [],
    slots: [],
    statuses: {},
    unreadEvents: 0,
    pendingApprovals: 0,
    loading: true,
  });

  const reload = useCallback(async () => {
    supabase.rpc("touch_parent_device").then(() => {});
    const [fam, ch, pr, mo, sl, st, ev, ap] = await Promise.all([
      supabase.from("families").select("id").limit(1).maybeSingle(),
      supabase.from("children").select("*").order("sort_order").order("created_at"),
      supabase.from("rule_profiles").select("*").order("created_at"),
      supabase.from("modes").select("*").order("priority", { ascending: false }),
      supabase.from("mode_slots").select("*").order("start_time"),
      supabase.from("device_status").select("*"),
      supabase.from("events").select("id", { count: "exact", head: true }).is("read_at", null),
      supabase.from("task_runs").select("id", { count: "exact", head: true }).eq("status", "submitted"),
    ]);
    const statuses: Record<string, DeviceStatus> = {};
    for (const s of (st.data ?? []) as DeviceStatus[]) statuses[s.child_id] = s;
    setState({
      familyId: (fam.data as { id: string } | null)?.id ?? null,
      children: (ch.data ?? []) as Child[],
      profiles: (pr.data ?? []) as Profile[],
      modes: (mo.data ?? []) as Mode[],
      slots: (sl.data ?? []) as ModeSlot[],
      statuses,
      unreadEvents: ev.count ?? 0,
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

  return <Ctx.Provider value={{ ...state, reload }}>{kids}</Ctx.Provider>;
}

export function useFamily() {
  const v = useContext(Ctx);
  if (!v) throw new Error("FamilyProvider yok");
  return v;
}

export type { OrbitEvent };
