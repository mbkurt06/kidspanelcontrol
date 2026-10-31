import { supabase } from "./supabase";
import { currentSectionFor } from "./sections";
import type { Child, Section } from "./types";
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

export async function grantMinutes(
  childId: string,
  minutes: number,
  opts: {
    validOn?: string | null;
    expiresOn?: string | null;
    note?: string;
    sectionId?: string | null;
    vault?: boolean;
    window?: { start: string; end: string } | null;
  } = {}
) {
  const { data: u } = await supabase.auth.getUser();
  const { error } = await supabase.from("time_grants").insert({
    child_id: childId,
    minutes,
    valid_on: opts.validOn === undefined ? todayISO() : opts.validOn,
    expires_on: opts.expiresOn ?? null,
    note: opts.note ?? null,
    section_id: opts.sectionId ?? null,
    vault: opts.vault ?? false,
    window_start: opts.window?.start ?? null,
    window_end: opts.window?.end ?? null,
    source: "manual",
    created_by: u.user?.id,
  });
  if (error) throw error;
}

/** Hızlı ekstra süre: çocuğun varsayılan yerine (şu anki bölüm / gün boyu / cüzdan). Nereye gittiğini döner. */
export async function quickGrant(child: Child, minutes: number, sections: Section[]): Promise<string> {
  if (child.extra_default === "wallet") {
    await grantMinutes(child.id, minutes, { validOn: null });
    return "cüzdana";
  }
  const sec = child.extra_default === "current" ? await currentSectionFor(child.id, sections) : null;
  await grantMinutes(child.id, minutes, { sectionId: sec?.id ?? null });
  return sec ? `${sec.name} bölümüne` : "bugüne (gün boyu)";
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

  void sleep;
  // Gün bölümleri: Gündüz (günlük süre) + Uyku (kapalı)
  const { error: se } = await supabase.from("profile_sections").insert([
    { profile_id: weekday, name: "Gündüz", start_time: "07:00", end_time: "21:00", budget_minutes: 90, default_rule: "timed", color: "#4F7CFF", sort_order: 0 },
    { profile_id: weekday, name: "Uyku", start_time: "21:00", end_time: "07:00", budget_minutes: null, default_rule: "blocked", color: "#6B5CE7", sort_order: 1 },
    { profile_id: weekend, name: "Gündüz", start_time: "08:00", end_time: "21:30", budget_minutes: 120, default_rule: "timed", color: "#4F7CFF", sort_order: 0 },
    { profile_id: weekend, name: "Uyku", start_time: "21:30", end_time: "08:00", budget_minutes: null, default_rule: "blocked", color: "#6B5CE7", sort_order: 1 },
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
