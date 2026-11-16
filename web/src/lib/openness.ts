import { supabase } from "./supabase";
import { sendCommand } from "./actions";
import { hm, mins, nowBerlin } from "./sections";
import { todayISO } from "./util";
import { untilFrom } from "../pages/Lock";

/*
 * Açıklık zamanı (telefon ne zaman açık olabilir). Bunlar çocuğa süre VERMEZ; sadece zamanı değiştirir.
 * "Geçici açma · …" notlu aralıklar telefonda kilitleri / kapalı saati kaldırır, çocuk kendi hakkını harcar.
 */

/** Açık saatleri bugünlük uzat: bugünün süre aralıklarının bitişini ileri alır (kasaya geçiş de o saate kayar) */
export async function extendOpenToday(childId: string, endHm: string, openEnd: string | null) {
  // Verilen süreler artık açıklığa bağlı değil: gün bitişine kadar geçerli, açıklık değişince kaymaz / kısalmaz
  void childId; void endHm; void openEnd;
  return 0;
}
export async function undoExtendOpen(childId: string) {
  const { data, error } = await supabase.from("time_grants").select("id, orig_window_end").eq("child_id", childId).eq("valid_on", todayISO()).not("orig_window_end", "is", null);
  if (error) throw error;
  for (const g of (data ?? []) as { id: string; orig_window_end: string }[]) {
    await supabase.from("time_grants").update({ window_end: g.orig_window_end, orig_window_end: null }).eq("id", g.id);
  }
  await sendCommand(childId, "resync", {});
}

/** Bugünün açık saat bitişini değiştirir (sadece açıklık zamanı; kullanım hakkı değişmez).
 *  Uzatma: açık saat bitişinden yeni bitişe "açıklık" aralığı + bitişe bağlı sürelerin bitişi kayar.
 *  Kısaltma: yeni bitişten itibaren geçerli ileri tarihli kilit + bitişe bağlı süreler yeni bitişte kapanır. */
/** Açık saat uzatma aralığının notu (telefonda "Geçici açma" = açıklık; süre vermez) */
export const EXT_NOTE = "Geçici açma · Açık saatler uzatıldı";

/** Şu anki dakikadan itibaren `abs` (bugünün 00:00'ından dakika; 1440+ = yarın) anına ISO zaman */
export function isoAtAbs(abs: number) {
  return new Date(Date.now() + (abs - nowBerlin().minute) * 60000).toISOString();
}

/** Bugünün açık saat bitişini değiştirir (sadece açıklık zamanı; kullanım hakkı değişmez).
 *  endAbs: bugünün 00:00'ından dakika (1440 ve üstü = gece yarısından sonra, yarın).
 *  Uzatma: açık saat bitişinden yeni bitişe "açıklık" aralığı (gerekirse yarına taşar) + bitişe bağlı süreler kayar.
 *  Kısaltma: yeni bitişten itibaren geçerli ileri tarihli kilit + bitişe bağlı süreler yeni bitişte kapanır. */
export async function setOpenEnd(childId: string, endAbs: number, openEnd: string) {
  const today = todayISO(), tomorrow = todayISO("Europe/Berlin", 1);
  const nowIso = new Date().toISOString();
  // Önceki uzatma / kısaltmayı temizle
  await supabase.from("time_grants").update({ minutes: 0, settled_at: nowIso })
    .eq("child_id", childId).in("valid_on", [today, tomorrow]).eq("note", EXT_NOTE).is("settled_at", null);
  const { data: cmds } = await supabase.from("commands").select("id, payload").eq("child_id", childId).eq("type", "kiosk_start").is("cancelled_at", null).gte("created_at", new Date(Date.now() - 36 * 3600e3).toISOString());
  for (const c of (cmds ?? []) as { id: string; payload: { reason?: string } | null }[]) {
    if (c.payload?.reason === "shorten") await supabase.from("commands").update({ cancelled_at: nowIso }).eq("id", c.id);
  }
  await undoExtendOpen(childId);
  const o = mins(openEnd), now = nowBerlin().minute;
  if (endAbs > o) {
    const s0 = Math.max(o, now);
    const e1 = Math.min(endAbs, 1439);
    const rows: Record<string, unknown>[] = [];
    if (e1 > s0) rows.push({ child_id: childId, minutes: e1 - s0, valid_on: today, source: "manual", note: EXT_NOTE, window_start: hm(s0), window_end: hm(e1), use_mode: "clock", to_vault: false, vault: false });
    if (endAbs > 1440) rows.push({ child_id: childId, minutes: endAbs - 1440, valid_on: tomorrow, source: "manual", note: EXT_NOTE, window_start: "00:00", window_end: hm(Math.min(endAbs - 1440, 1439)), use_mode: "clock", to_vault: false, vault: false });
    if (rows.length) { const { error } = await supabase.from("time_grants").insert(rows); if (error) throw error; }
    await extendOpenToday(childId, hm(e1), openEnd);
  } else if (endAbs < o) {
    await extendOpenToday(childId, hm(endAbs), openEnd);
    await sendCommand(childId, "kiosk_start", { message: null, reason: "shorten", from_at: isoAtAbs(endAbs) }, untilFrom("until", openEnd));
  }
  await sendCommand(childId, "resync", {});
}

/** Süren "Kilidi aç" açıklığının bitişini değiştirir (gece yarısını geçebilir) */
export async function setTempEnd(childId: string, note: string, endAbs: number, openEnd: string | null) {
  const today = todayISO(), tomorrow = todayISO("Europe/Berlin", 1);
  await supabase.from("time_grants").update({ minutes: 0, settled_at: new Date().toISOString() })
    .eq("child_id", childId).in("valid_on", [today, tomorrow]).eq("note", note).is("settled_at", null);
  await openUntil(childId, isoAtAbs(endAbs), note.replace(/^Geçici açma · /, ""), openEnd);
}

/** Belirli bir zamana kadar aç (gün gün aralıklar) + bugünkü açık saat bitişine bağlı süreler de o zamana kadar geçerli olsun */
export async function openUntil(childId: string, endIso: string, reason: string, openEnd: string | null) {
  const end = new Date(endIso);
  const endDay = end.toLocaleDateString("sv-SE", { timeZone: "Europe/Berlin" });
  const [eh, em] = end.toLocaleTimeString("en-GB", { timeZone: "Europe/Berlin", hour: "2-digit", minute: "2-digit", hour12: false }).split(":").map(Number);
  const endMin = (eh % 24) * 60 + em;
  const rows: Record<string, unknown>[] = [];
  for (let i = 0; i < 31; i++) {
    const d = todayISO("Europe/Berlin", i);
    const last = d === endDay;
    const s0 = i === 0 ? nowBerlin().minute : 0;
    const e = last ? Math.min(endMin, 1439) : 1439;
    if (e > s0) rows.push({ child_id: childId, minutes: e - s0, valid_on: d, source: "manual", note: `Geçici açma · ${reason}`, window_start: hm(s0), window_end: hm(e), use_mode: "clock", to_vault: false, vault: false });
    if (last || d > endDay) break;
  }
  if (!rows.length) throw new Error("Bitiş zamanı geçmiş");
  const { error } = await supabase.from("time_grants").insert(rows);
  if (error) throw error;
  const todayEnd = endDay === todayISO() ? Math.min(endMin, 1439) : 1439;
  if (openEnd && todayEnd > mins(openEnd)) await extendOpenToday(childId, hm(todayEnd), openEnd);
  await sendCommand(childId, "resync", {});
}

/** Çocuğun bugünkü programdaki açık saat bitişi (sunucu hesabı) */
export async function openEndOf(childId: string): Promise<string | null> {
  const { data } = await supabase.rpc("open_hours", { p_child: childId, p_day: todayISO() });
  const h = (Array.isArray(data) ? data[0] : data) as { os: number; oe: number } | null;
  return h?.oe != null ? hm(h.oe) : null;
}
