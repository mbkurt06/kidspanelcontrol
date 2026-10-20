import { supabase } from "./supabase";
import { todayISO } from "./util";

export async function sendCommand(childId: string, type: string, payload: Record<string, unknown> = {}, untilAt: string | null = null) {
  const { data: u } = await supabase.auth.getUser();
  const { error } = await supabase.from("commands").insert({
    child_id: childId,
    type,
    payload,
    until_at: untilAt,
    created_by: u.user?.id,
  });
  if (error) throw error;
}

export async function grantMinutes(childId: string, minutes: number, opts: { validOn?: string | null; expiresOn?: string | null; note?: string } = {}) {
  const { data: u } = await supabase.auth.getUser();
  const { error } = await supabase.from("time_grants").insert({
    child_id: childId,
    minutes,
    valid_on: opts.validOn === undefined ? todayISO() : opts.validOn,
    expires_on: opts.expiresOn ?? null,
    note: opts.note ?? null,
    source: "manual",
    created_by: u.user?.id,
  });
  if (error) throw error;
}

// İlk kurulum için önerilen başlangıç kuralları. Hepsi sonradan düzenlenebilir veya silinebilir.
export async function seedDefaults(familyId: string, childIds: string[]) {
  const { data: profiles, error: pe } = await supabase
    .from("rule_profiles")
    .insert([
      {
        family_id: familyId,
        name: "Hafta içi",
        daily_minutes: 90,
        timed_windows: [{ start: "07:00", end: "21:00" }],
        unlimited_windows: [{ start: "07:00", end: "21:00" }],
      },
      {
        family_id: familyId,
        name: "Hafta sonu",
        daily_minutes: 120,
        timed_windows: [{ start: "08:00", end: "21:30" }],
        unlimited_windows: [{ start: "08:00", end: "21:30" }],
      },
    ])
    .select("id, name");
  if (pe) throw pe;
  const weekday = profiles!.find((p) => p.name === "Hafta içi")!.id;
  const weekend = profiles!.find((p) => p.name === "Hafta sonu")!.id;

  const { data: modes, error: me } = await supabase
    .from("modes")
    .insert([
      { family_id: familyId, name: "Ders zamanı", icon: "book", color: "#3FA7D6", allowed_groups: ["always_open"], others_blocked: true, priority: 70 },
      { family_id: familyId, name: "Dinlenme zamanı", icon: "pause", color: "#59C3A5", allowed_groups: ["always_open"], others_blocked: true, priority: 60 },
      { family_id: familyId, name: "Uyku zamanı", icon: "moon", color: "#6B5CE7", allowed_groups: ["always_open"], others_blocked: true, priority: 90 },
    ])
    .select("id, name");
  if (me) throw me;
  const sleep = modes!.find((m) => m.name === "Uyku zamanı")!.id;

  const { error: se } = await supabase.from("mode_slots").insert([
    { profile_id: weekday, mode_id: sleep, days: [1, 2, 3, 4, 5, 6, 7], start_time: "21:00", end_time: "07:00" },
    { profile_id: weekend, mode_id: sleep, days: [1, 2, 3, 4, 5, 6, 7], start_time: "21:30", end_time: "08:00" },
  ]);
  if (se) throw se;

  const rows = childIds.flatMap((cid) =>
    [1, 2, 3, 4, 5, 6, 7].map((d) => ({ child_id: cid, weekday: d, profile_id: d <= 5 ? weekday : weekend }))
  );
  if (rows.length) {
    const { error } = await supabase.from("profile_assignments").upsert(rows);
    if (error) throw error;
  }
}
