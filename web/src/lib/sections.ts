import { supabase } from "./supabase";
import { todayISO } from "./util";
import type { Section, SectionRule } from "./types";

/** "HH:MM" → dakika */
export function mins(t: string) {
  const [h, m] = t.slice(0, 5).split(":").map(Number);
  return h * 60 + m;
}

/** Berlin saatiyle şu an (dakika) ve ISO hafta günü (1 = Pzt). */
export function nowBerlin() {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Berlin", hour: "2-digit", minute: "2-digit", weekday: "short", hour12: false })
    .formatToParts(new Date());
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const wd = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].indexOf(get("weekday")) + 1;
  return { minute: Number(get("hour")) * 60 + Number(get("minute")), weekday: wd };
}

/** Bir bölüm verilen dakikayı içeriyor mu (gece yarısını geçen bölümler dahil). */
export function sectionContains(s: Section, m: number) {
  const a = mins(s.start_time);
  const b = mins(s.end_time);
  return a < b ? m >= a && m < b : m >= a || m < b;
}

/** Çocuğun bugünkü gün tipi (gün değişikliği varsa o). */
export async function todayProfileId(childId: string): Promise<string | null> {
  return profileIdOn(childId, todayISO(), nowBerlin().weekday);
}

/** Çocuğun belirli bir gündeki gün tipi. */
export async function profileIdOn(childId: string, day: string, weekdayHint?: number): Promise<string | null> {
  const today = day;
  const weekday = weekdayHint ?? (new Date(`${day}T12:00:00Z`).getUTCDay() || 7);
  const [{ data: ov }, { data: as }] = await Promise.all([
    supabase.from("day_overrides").select("profile_id").eq("child_id", childId).eq("day", today).maybeSingle(),
    supabase.from("profile_assignments").select("profile_id").eq("child_id", childId).eq("weekday", weekday).maybeSingle(),
  ]);
  return (ov as { profile_id: string | null } | null)?.profile_id ?? (as as { profile_id: string } | null)?.profile_id ?? null;
}

/** Çocuğun şu anki bölümü (bugünün gün tipinde). */
export async function currentSectionFor(childId: string, sections: Section[]): Promise<Section | null> {
  const pid = await todayProfileId(childId);
  if (!pid) return null;
  const { minute } = nowBerlin();
  const list = sections.filter((s) => s.profile_id === pid);
  return list.find((s) => mins(s.start_time) < mins(s.end_time) && sectionContains(s, minute)) ?? list.find((s) => sectionContains(s, minute)) ?? null;
}

/** Bölümde süreli uygulama kullanılabilir mi (telefon "açık" sayılır mı). */
export function timedPossible(s: Section, rules: SectionRule[]) {
  return s.default_rule === "timed" || rules.some((r) => r.section_id === s.id && r.rule === "timed");
}

/** dakika → "HH:MM" */
export function hm(m: number) {
  return fmt(Math.max(0, Math.min(1439, m)));
}

/** Bölümler arasında boşluk ve çakışma kontrolü (uyarı metinleri). */
export function sectionWarnings(list: Section[]): string[] {
  const out: string[] = [];
  const cover = new Array(1440).fill(0);
  for (const s of list) for (let m = 0; m < 1440; m++) if (sectionContains(s, m)) cover[m]++;
  const ranges = (pred: (n: number) => boolean) => {
    const r: string[] = [];
    let start = -1;
    for (let m = 0; m <= 1440; m++) {
      const on = m < 1440 && pred(cover[m]);
      if (on && start < 0) start = m;
      if (!on && start >= 0) {
        r.push(`${fmt(start)}–${fmt(m % 1440)}`);
        start = -1;
      }
    }
    return r;
  };
  if (list.length) {
    const gaps = ranges((n) => n === 0);
    if (gaps.length) out.push(`Bölüm olmayan saatler (telefon kapalı olur): ${gaps.join(", ")}`);
    const over = ranges((n) => n > 1);
    if (over.length) out.push(`Çakışan saatler: ${over.join(", ")}`);
  }
  return out;
}

function fmt(m: number) {
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

/** Uygulama adı / paket / Android kategorisinden grup önerisi (grup adına göre). */
export function suggestGroup(pkg: string, label: string, category: string | null): string | null {
  const s = `${pkg} ${label}`.toLowerCase();
  const has = (...k: string[]) => k.some((x) => s.includes(x));
  if (has("whatsapp", "telegram", "signal", "messag", "mms", "dialer", "contacts", "phone", "mail", "gmail", "duo", "meet")) return "İletişim";
  if (has("youtube", "netflix", "disney", "primevideo", "twitch", "tiktok.video", "video", "tv.", "player")) return "Video";
  if (has("instagram", "tiktok", "snapchat", "facebook", "twitter", "x.android", "pinterest", "reddit", "discord", "bereal", "musically")) return "Sosyal";
  if (has("classroom", "khan", "duolingo", "school", "edu", "quizlet", "photomath", "teams", "zoom", "docs", "sheets", "slides", "dictionary", "translate", "math", "brainly", "kahoot", "eba", "morpa", "okul")) return "Okul";
  if (category === "game" || has("game", "roblox", "minecraft", "mojang", "supercell", "king.", "brawl", "clash", "pubg", "fortnite", "subway", "candy", "garena", "freefire", "ea.", "gameloft")) return "Oyunlar";
  if (category === "video") return "Video";
  if (category === "social") return "Sosyal";
  if (has("calculator", "clock", "deskclock", "camera", "gallery", "photos", "calendar", "notes", "files", "weather", "compass", "maps", "spotify", "music", "chrome", "browser"))
    return "Araçlar";
  return null;
}
