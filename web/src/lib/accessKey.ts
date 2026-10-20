// Giriş ekranı sadece erişim anahtarını bilen cihazlarda görünür.
// Anahtarı bilmeyen biri siteyi açarsa boş bir ekran görür.
// Not: Asıl güvenlik giriş + cihaz onayı + veritabanı kurallarıdır; bu katman sadece giriş ekranını gizler.
const KEY_HASH = "685c95f2ff0e7e26dfd0b5a7dc4dec5bba96069a31c0f219e4ee587927afc5d1";
const STORE = "orbit.access.v1";

async function sha256(s: string) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
}

export function hasAccess(): boolean {
  try {
    return localStorage.getItem(STORE) === KEY_HASH;
  } catch {
    return false;
  }
}

export function rememberAccess() {
  try {
    localStorage.setItem(STORE, KEY_HASH);
  } catch {
    /* boş */
  }
}

export async function tryKey(k: string): Promise<boolean> {
  if ((await sha256(k.trim())) !== KEY_HASH) return false;
  rememberAccess();
  return true;
}

/** Adres #/k/<anahtar> ise anahtarı dener ve adresten siler. */
export async function consumeKeyFromUrl(): Promise<boolean> {
  const m = window.location.hash.match(/^#\/k\/([^/?]+)/);
  if (!m) return false;
  const ok = await tryKey(decodeURIComponent(m[1]));
  history.replaceState(null, "", window.location.pathname + "#/");
  return ok;
}
