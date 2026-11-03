import { supabase } from "./supabase";
import { currentSectionFor, hm, mins, nowBerlin, profileIdOn, sectionContains, timedPossible } from "./sections";
import type { Child, Section, SectionRule } from "./types";
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

type FamLike = { sections: Section[]; sectionRules: SectionRule[]; children?: Child[] };
export type GrantPatch = { valid_on: string | null; section_id: string | null; vault: boolean; window_start: string | null; window_end: string | null };

/**
 * "Hemen kullanılsın": telefon şu an açık saatlerdeyse süre o anki bölüme eklenir (kalan süre hemen artar);
 * kapalı saatlerdeyse şu andan itibaren `minutes` dakikalık bir aralık açılır, bitince telefon yine kapanır.
 */
export async function nowPatch(
  childId: string,
  minutes: number,
  fam: FamLike,
  opts: { closed?: boolean } = {}
): Promise<{ patch: GrantPatch; text: string }> {
  const sec = await currentSectionFor(childId, fam.sections);
  if (!opts.closed && sec && timedPossible(sec, fam.sectionRules)) {
    return { patch: { valid_on: todayISO(), section_id: sec.id, vault: false, window_start: null, window_end: null }, text: `${sec.name} süresine eklendi` };
  }
  // Kapalı / sınırlı saatte: çocuğun ayarına göre aralık (Kurallar → Kapalıyken verilen süre)
  const child = fam.children?.find((c) => c.id === childId);
  const mode = child?.closed_grant_mode ?? "usage";
  const { minute } = nowBerlin();
  let end: number;
  if (mode === "clock") end = minute + minutes;
  else if (mode === "within") end = minute + (child?.closed_grant_within_factor ? minutes * child.closed_grant_within_factor : child?.closed_grant_within_minutes ?? 120);
  else {
    // Kullandıkça düşer: bir sonraki açık saatler başlayınca ya da gece yarısı biter
    const pid = await profileIdOn(childId, todayISO());
    const next = fam.sections
      .filter((x) => x.profile_id === pid && timedPossible(x, fam.sectionRules) && mins(x.start_time) > minute)
      .map((x) => mins(x.start_time))
      .sort((a, b) => a - b)[0];
    end = next ?? 1439;
  }
  end = Math.min(end, 1439);
  if (end <= minute) end = Math.min(minute + 1, 1439);
  const text =
    mode === "clock" ? `şu andan ${hm(end)}'e kadar açık` : mode === "within" ? `kullandıkça düşer · ${hm(end)}'e kadar kullanmalı` : `kullandıkça düşer · ${hm(end)}'e kadar geçerli`;
  return { patch: { valid_on: todayISO(), section_id: null, vault: false, window_start: hm(minute), window_end: hm(end) }, text };
}

/**
 * Belirli saatten itibaren: o saatten sonra `minutes` dk; bitiş "open" (açık saatler bitene kadar),
 * "until" (verilen saate kadar) ya da "eod" (gün sonuna kadar).
 */
export async function fromPatch(
  childId: string,
  fam: FamLike,
  day: string,
  start: string,
  endMode: "open" | "until" | "eod",
  until?: string
): Promise<{ patch: GrantPatch; text: string }> {
  let end = "23:59";
  if (endMode === "until") {
    if (!until || mins(until) <= mins(start)) throw new Error("Bitiş saati başlangıçtan sonra olmalı.");
    end = until;
  } else if (endMode === "open") {
    const pid = await profileIdOn(childId, day);
    const sec = fam.sections.find((x) => x.profile_id === pid && sectionContains(x, mins(start)) && timedPossible(x, fam.sectionRules));
    if (!sec) throw new Error("Bu saatte telefon açık değil. Bitiş için bir saat seç.");
    end = mins(sec.end_time) > mins(start) ? sec.end_time.slice(0, 5) : "23:59";
  }
  return {
    patch: { valid_on: day, section_id: null, vault: false, window_start: start, window_end: end },
    text: `${start}–${end} arası`,
  };
}

/** Yeni süre ekle (hazır hedefle). */
export async function insertGrant(childId: string, minutes: number, patch: GrantPatch, note?: string, expiresOn?: string | null) {
  const { data: u } = await supabase.auth.getUser();
  const { error } = await supabase.from("time_grants").insert({
    child_id: childId,
    minutes,
    note: note || null,
    expires_on: expiresOn ?? null,
    source: "manual",
    created_by: u.user?.id,
    ...patch,
  });
  if (error) throw error;
}

/** Hızlı ekstra süre: çocuğun varsayılan yerine (hemen / şu anki bölüm / gün boyu / cüzdan). Nereye gittiğini döner. */
export async function quickGrant(child: Child, minutes: number, fam: FamLike): Promise<string> {
  if (child.extra_default === "wallet") {
    await grantMinutes(child.id, minutes, { validOn: null });
    return "cüzdana";
  }
  if (child.extra_default === "now") {
    const { patch, text } = await nowPatch(child.id, minutes, fam);
    await insertGrant(child.id, minutes, patch);
    return text;
  }
  const sec = child.extra_default === "current" ? await currentSectionFor(child.id, fam.sections) : null;
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
