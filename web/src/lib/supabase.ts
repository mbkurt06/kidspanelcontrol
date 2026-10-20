import { createClient } from "@supabase/supabase-js";

const URL = import.meta.env.VITE_SUPABASE_URL as string;
const KEY = import.meta.env.VITE_SUPABASE_KEY as string;

// Bu tarayıcının cihaz kimliği ve sırrı — her ebeveyn hesabı için ayrı.
// (Aynı tarayıcıda iki ebeveyn sırayla giriş yapabilir; her biri kendi cihaz kaydını kullanır.)
// Sır sadece bu cihazda durur; veritabanında sadece SHA-256 özeti tutulur.
const LEGACY_KEY = "orbit.device.v1";
const MAP_KEY = "orbit.devices.v2";

export type LocalDevice = { id: string; secret: string };

function randomHex(bytes: number) {
  const b = new Uint8Array(bytes);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

function readMap(): Record<string, LocalDevice> {
  try {
    return JSON.parse(localStorage.getItem(MAP_KEY) ?? "{}");
  } catch {
    return {};
  }
}

function writeMap(m: Record<string, LocalDevice>) {
  try {
    localStorage.setItem(MAP_KEY, JSON.stringify(m));
  } catch {
    /* boş */
  }
}

function newDevice(): LocalDevice {
  return { id: crypto.randomUUID(), secret: randomHex(32) };
}

let current: LocalDevice | null = null;

/** Giriş yapan kullanıcının bu tarayıcıdaki cihazını seçer (yoksa oluşturur). */
export function selectDeviceFor(userId: string): LocalDevice {
  const m = readMap();
  let d = m[userId];
  if (!d) {
    // Eski sürümden kalan tek cihaz kaydı varsa önce onu dene; sunucu bu hesaba ait olduğunu
    // doğrularsa (confirmDevice) devralınır, başka hesaba aitse sıradaki hesap için bekler.
    try {
      const legacy = localStorage.getItem(LEGACY_KEY);
      if (legacy) d = JSON.parse(legacy) as LocalDevice;
    } catch {
      /* boş */
    }
    d = d && d.id && d.secret ? d : newDevice();
    m[userId] = d;
    writeMap(m);
  }
  current = d;
  return d;
}

/** Sunucu cihazı bu hesap için kabul etti: eski tekil kayıt artık bu hesaba ait. */
export function confirmDevice(userId: string) {
  try {
    const legacy = localStorage.getItem(LEGACY_KEY);
    if (legacy && (JSON.parse(legacy) as LocalDevice).id === readMap()[userId]?.id) localStorage.removeItem(LEGACY_KEY);
  } catch {
    /* boş */
  }
}

/** Bu cihaz kimliği başka bir hesaba aitse yenisini üretir. */
export function renewDeviceFor(userId: string): LocalDevice {
  const m = readMap();
  m[userId] = newDevice();
  writeMap(m);
  current = m[userId];
  return current;
}

export function localDevice(): LocalDevice {
  return current ?? { id: "", secret: "" };
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

// Her isteğe o anki cihaz başlığını ekler.
const fetchWithDevice: typeof fetch = (input, init) => {
  const headers = new Headers(init?.headers);
  if (current) headers.set("x-orbit-device", `${current.id}.${current.secret}`);
  return fetch(input, { ...init, headers });
};

export const supabase = createClient(URL, KEY, {
  db: { schema: "orbit" },
  auth: { persistSession: true, autoRefreshToken: true, storageKey: "orbit.auth" },
  global: { fetch: fetchWithDevice },
});

export function errorText(e: unknown): string {
  const m = (e as { message?: string })?.message ?? String(e);
  const map: Record<string, string> = {
    not_invited: "Bu e-posta Orbit'e davetli değil.",
    not_allowed: "Bu işlem için yetkin yok (cihaz onaylı mı?).",
    "Invalid login credentials": "E-posta veya şifre hatalı.",
    "Email not confirmed": "E-posta adresin henüz doğrulanmadı. Gelen kutundaki bağlantıya dokun.",
    "User already registered": "Bu e-posta zaten kayıtlı. Giriş yap.",
    "Database error saving new user": "Bu e-posta ile hesap açılamaz.",
    signup_not_allowed: "Bu e-posta ile hesap açılamaz.",
    device_conflict: "Cihaz kaydı çakıştı, sayfayı yenile.",
  };
  for (const k of Object.keys(map)) if (m.includes(k)) return map[k];
  return m;
}
