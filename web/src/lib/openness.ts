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
  const nowMin = nowBerlin().minute;
  const { data, error } = await supabase.from("time_grants").select("id, window_start, window_end, orig_window_end, use_mode, note")
    .eq("child_id", childId).eq("valid_on", todayISO()).eq("vault", false).gt("minutes", 0).is("settled_at", null).not("window_end", "is", null);
  if (error) throw error;
  let n = 0;
  for (const g of (data ?? []) as { id: string; window_start: string; window_end: string; orig_window_end: string | null; use_mode: string | null; note: string | null }[]) {
    if (g.use_mode === "clock" || g.note?.startsWith("Geçici açma")) continue;
    if (mins(g.window_end) < nowMin) continue; // bitmiş aralık
    // Sadece açık saatlerin bitişine bağlı süreler (ya da daha önce uzatılmış olanlar) kayar
    const bound = g.orig_window_end != null || (openEnd != null && mins(g.window_end) === mins(openEnd));
    if (!bound) continue;
    if (mins(endHm) <= mins(g.window_start) || mins(endHm) === mins(g.window_end)) continue;
    const orig = g.orig_window_end ?? g.window_end;
    const back = mins(endHm) === mins(orig);
    const { error: e2 } = await supabase.from("time_grants").update({ window_end: endHm, orig_window_end: back ? null : orig }).eq("id", g.id);
    if (e2) throw e2;
    n++;
  }
  if (n) await sendCommand(childId, "resync", {});
  return n;
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
export async function setOpenEnd(childId: string, endHm: string, openEnd: string) {
  const today = todayISO();
  const nowIso = new Date().toISOString();
  // Önceki uzatma / kısaltmayı temizle
  await supabase.from("time_grants").update({ minutes: 0, settled_at: nowIso })
    .eq("child_id", childId).eq("valid_on", today).eq("note", "${EXT}").is("settled_at", null);
  const { data: cmds } = await supabase.from("commands").select("id, payload").eq("child_id", childId).eq("type", "kiosk_start").is("cancelled_at", null).gte("created_at", new Date(Date.now() - 36 * 3600e3).toISOString());
  for (const c of (cmds ?? []) as { id: string; payload: { reason?: string } | null }[]) {
    if (c.payload?.reason === "shorten") await supabase.from("commands").update({ cancelled_at: nowIso }).eq("id", c.id);
  }
  await undoExtendOpen(childId);
  const e = mins(endHm), o = mins(openEnd), now = nowBerlin().minute;
  if (e > o) {
    const s0 = Math.max(o, now);
    const { error } = await supabase.from("time_grants").insert({ child_id: childId, minutes: Math.max(1, Math.min(e, 1439) - s0), valid_on: today, source: "manual", note: "${EXT}", window_start: hm(s0), window_end: hm(Math.min(e, 1439)), use_mode: "clock", to_vault: false, vault: false });
    if (error) throw error;
    await extendOpenToday(childId, hm(Math.min(e, 1439)), openEnd);
  } else if (e < o) {
    await extendOpenToday(childId, endHm, openEnd);
    await sendCommand(childId, "kiosk_start", { message: null, reason: "shorten", from_at: untilFrom("until", endHm) }, untilFrom("until", openEnd));
  }
  await sendCommand(childId, "resync", {});
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
