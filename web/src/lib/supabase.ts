import { createClient } from "@supabase/supabase-js";

const URL = import.meta.env.VITE_SUPABASE_URL as string;
const KEY = import.meta.env.VITE_SUPABASE_KEY as string;

// Bu tarayıcının (PWA kurulumunun) kalıcı cihaz kimliği ve sırrı.
// Sır sadece bu cihazda durur; veritabanında sadece SHA-256 özeti tutulur.
const DEVICE_KEY = "orbit.device.v1";

export type LocalDevice = { id: string; secret: string };

function randomHex(bytes: number) {
  const b = new Uint8Array(bytes);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

export function localDevice(): LocalDevice {
  try {
    const raw = localStorage.getItem(DEVICE_KEY);
    if (raw) {
      const d = JSON.parse(raw) as LocalDevice;
      if (d.id && d.secret) return d;
    }
  } catch {
    /* boş */
  }
  const d = { id: crypto.randomUUID(), secret: randomHex(32) };
  try {
    localStorage.setItem(DEVICE_KEY, JSON.stringify(d));
  } catch {
    /* boş */
  }
  return d;
}

export function deviceLabel() {
  const ua = navigator.userAgent;
  const standalone = window.matchMedia("(display-mode: standalone)").matches;
  let name = "Tarayıcı";
  if (/iPhone/.test(ua)) name = "iPhone";
  else if (/iPad/.test(ua)) name = "iPad";
  else if (/Android/.test(ua)) name = "Android";
  else if (/Macintosh/.test(ua)) name = "Mac";
  else if (/Windows/.test(ua)) name = "Windows";
  return `${name}${standalone ? " (uygulama)" : " (Safari/tarayıcı)"}`;
}

const dev = localDevice();

export const supabase = createClient(URL, KEY, {
  db: { schema: "orbit" },
  auth: { persistSession: true, autoRefreshToken: true, storageKey: "orbit.auth" },
  global: { headers: { "x-orbit-device": `${dev.id}.${dev.secret}` } },
});

export function errorText(e: unknown): string {
  const m = (e as { message?: string })?.message ?? String(e);
  const map: Record<string, string> = {
    not_invited: "Bu e-posta Orbit'e davetli değil.",
    not_allowed: "Bu işlem için yetkin yok (cihaz onaylı mı?).",
    "Invalid login credentials": "E-posta veya şifre hatalı.",
    "Email not confirmed": "E-posta adresin henüz doğrulanmadı. Gelen kutundaki bağlantıya dokun.",
    "User already registered": "Bu e-posta zaten kayıtlı. Giriş yap.",
  };
  for (const k of Object.keys(map)) if (m.includes(k)) return map[k];
  return m;
}
