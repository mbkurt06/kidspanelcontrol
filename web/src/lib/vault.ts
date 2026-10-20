// Şifre kasası — uçtan uca şifreleme (tarayıcıda WebCrypto).
//
// - Kasa anahtarı: AES-256-GCM, çocuk başına bir tane. Sunucu asla düz halini görmez.
// - Bu cihazın "sahip" anahtar çifti: RSA-OAEP 2048 / SHA-256. Özel anahtar dışa aktarılamaz şekilde
//   IndexedDB'de durur; açık anahtar sunucuya kaydedilir. Kasa anahtarı bu açık anahtarla şifrelenip saklanır.
// - Kurtarma kodu: PBKDF2-SHA256 (310 000 tur) ile türetilen anahtarla AES-GCM şifreli kopya.
// - Kayıtlar: JSON → AES-GCM (12 bayt IV). Android tarafı aynı biçimi kullanır.

import { localDevice, supabase } from "./supabase";

const DB_NAME = "orbit-vault";
const STORE = "keys";
const PBKDF2_ITER = 310_000;

export type VaultEntry = {
  app: string;
  username: string;
  password: string;
  recovery: string;
  note: string;
  history: { password: string; changed_at: string }[];
};

export type StoredEntry = { id: string; iv: string; ciphertext: string; updated_by: string; updated_at: string };

// --- yardımcılar ---

const enc = new TextEncoder();
const dec = new TextDecoder();

export function b64(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

export function unb64(s: string): Uint8Array<ArrayBuffer> {
  const raw = atob(s);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

function idb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(DB_NAME, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

async function idbGet<T>(key: string): Promise<T | undefined> {
  const db = await idb();
  return new Promise((resolve, reject) => {
    const r = db.transaction(STORE, "readonly").objectStore(STORE).get(key);
    r.onsuccess = () => resolve(r.result as T | undefined);
    r.onerror = () => reject(r.error);
  });
}

async function idbSet(key: string, value: unknown): Promise<void> {
  const db = await idb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// --- bu cihazın sahip anahtarı ---

type HolderRecord = { holderId: string; publicKey: string; privateKey: CryptoKey };

const RSA = { name: "RSA-OAEP", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" } as const;

let holderCache: HolderRecord | null = null;

/** Bu tarayıcı + ebeveyn cihazı için sahip kaydını hazırlar (yoksa oluşturur). */
export async function ensureHolder(familyId: string): Promise<HolderRecord> {
  const deviceId = localDevice().id;
  if (holderCache) return holderCache;
  const key = `holder:${deviceId}`;
  let rec = await idbGet<HolderRecord>(key);

  const { data: existing } = await supabase.from("vault_holders").select("id, public_key").eq("parent_device_id", deviceId).maybeSingle();

  if (rec && existing && existing.public_key === rec.publicKey) {
    holderCache = { ...rec, holderId: existing.id };
    return holderCache;
  }

  // Yeni anahtar çifti (özel anahtar dışa aktarılamaz)
  const pair = await crypto.subtle.generateKey(RSA, false, ["encrypt", "decrypt", "wrapKey", "unwrapKey"]);
  const spki = b64(await crypto.subtle.exportKey("spki", pair.publicKey));

  let holderId: string;
  if (existing) {
    // Bu cihazın eski anahtarı kaybolmuş (tarayıcı verisi silinmiş): açık anahtarı yenile, eski kopyaları bırak.
    const { error } = await supabase.from("vault_holders").update({ public_key: spki }).eq("id", existing.id);
    if (error) throw error;
    await supabase.from("vault_keys").delete().eq("holder_id", existing.id);
    holderId = existing.id;
  } else {
    const { data, error } = await supabase
      .from("vault_holders")
      .insert({ family_id: familyId, kind: "parent", parent_device_id: deviceId, public_key: spki, label: navigator.userAgent.slice(0, 80) })
      .select("id")
      .single();
    if (error) throw error;
    holderId = data.id;
  }
  rec = { holderId, publicKey: spki, privateKey: pair.privateKey };
  await idbSet(key, rec);
  holderCache = rec;
  return rec;
}

async function importPublic(spkiB64: string) {
  return crypto.subtle.importKey("spki", unb64(spkiB64), RSA, false, ["encrypt"]);
}

async function wrapFor(publicKeyB64: string, rawKey: Uint8Array<ArrayBuffer>): Promise<string> {
  const pub = await importPublic(publicKeyB64);
  return b64(await crypto.subtle.encrypt({ name: "RSA-OAEP" }, pub, rawKey));
}

// --- kasa anahtarı ---

export type VaultState =
  | { kind: "none" } // kasa hiç oluşturulmamış
  | { kind: "locked"; hasRecovery: boolean } // kasa var, bu cihazın anahtarı yok
  | { kind: "open"; key: CryptoKey; raw: Uint8Array<ArrayBuffer>; hasRecovery: boolean };

const keyCache = new Map<string, { key: CryptoKey; raw: Uint8Array<ArrayBuffer> }>();

async function importAes(raw: Uint8Array<ArrayBuffer>) {
  return crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

export async function openVault(familyId: string, childId: string): Promise<VaultState> {
  const me = await ensureHolder(familyId);
  const [{ data: keys }, { data: rec }] = await Promise.all([
    supabase.from("vault_keys").select("holder_id, wrapped_key").eq("child_id", childId),
    supabase.from("vault_recovery").select("child_id").eq("child_id", childId).maybeSingle(),
  ]);
  const hasRecovery = !!rec;
  const mine = (keys ?? []).find((k) => k.holder_id === me.holderId);
  if (!mine) return (keys ?? []).length || hasRecovery ? { kind: "locked", hasRecovery } : { kind: "none" };
  const cached = keyCache.get(childId);
  if (cached) return { kind: "open", ...cached, hasRecovery };
  const raw = new Uint8Array(await crypto.subtle.decrypt({ name: "RSA-OAEP" }, me.privateKey, unb64(mine.wrapped_key)));
  const key = await importAes(raw);
  keyCache.set(childId, { key, raw });
  await shareMissing(familyId, childId, raw);
  return { kind: "open", key, raw, hasRecovery };
}

/** Kasa anahtarını, anahtarı olmayan sahiplere (yeni onaylı ebeveyn cihazları, çocuğun telefonu) paylaştırır. */
export async function shareMissing(familyId: string, childId: string, raw: Uint8Array<ArrayBuffer>) {
  const [{ data: holders }, { data: keys }] = await Promise.all([
    supabase.from("vault_holders").select("id, kind, child_id, public_key").eq("family_id", familyId),
    supabase.from("vault_keys").select("holder_id").eq("child_id", childId),
  ]);
  const have = new Set((keys ?? []).map((k) => k.holder_id));
  const rows = [];
  for (const h of holders ?? []) {
    if (have.has(h.id)) continue;
    if (h.kind === "phone" && h.child_id !== childId) continue;
    try {
      rows.push({ child_id: childId, holder_id: h.id, wrapped_key: await wrapFor(h.public_key, raw) });
    } catch {
      /* bozuk açık anahtar: atla */
    }
  }
  if (rows.length) await supabase.from("vault_keys").upsert(rows, { onConflict: "child_id,holder_id" });
}

/** Kurtarma kodu: 20 karakter, karıştırılması kolay harfler yok, 4'lü gruplar. */
export function newRecoveryCode(): string {
  const alphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(20));
  const chars = Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("");
  return chars.match(/.{4}/g)!.join("-");
}

function normalizeCode(code: string) {
  return code.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

async function codeKey(code: string, salt: Uint8Array<ArrayBuffer>, iterations: number) {
  const base = await crypto.subtle.importKey("raw", enc.encode(normalizeCode(code)), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, base, { name: "AES-GCM", length: 256 }, false, [
    "encrypt",
    "decrypt",
  ]);
}

/** Kurtarma kopyasını (yeniden) oluşturur ve kodu döndürür. */
export async function setRecovery(childId: string, raw: Uint8Array<ArrayBuffer>): Promise<string> {
  const code = newRecoveryCode();
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const k = await codeKey(code, salt, PBKDF2_ITER);
  const wrapped = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, k, raw);
  const { error } = await supabase.from("vault_recovery").upsert(
    { child_id: childId, salt: b64(salt), iterations: PBKDF2_ITER, iv: b64(iv), wrapped_key: b64(wrapped) },
    { onConflict: "child_id" }
  );
  if (error) throw error;
  return code;
}

/** İlk kurulum: yeni kasa anahtarı, tüm sahiplere paylaşım ve kurtarma kodu. */
export async function createVault(familyId: string, childId: string): Promise<string> {
  const me = await ensureHolder(familyId);
  const raw = crypto.getRandomValues(new Uint8Array(32));
  const { error } = await supabase
    .from("vault_keys")
    .insert({ child_id: childId, holder_id: me.holderId, wrapped_key: await wrapFor(me.publicKey, raw) });
  if (error) throw error;
  keyCache.set(childId, { key: await importAes(raw), raw });
  await shareMissing(familyId, childId, raw);
  return setRecovery(childId, raw);
}

/** Kurtarma koduyla bu cihaza anahtar açar. Yanlış kodda hata verir. */
export async function recoverVault(familyId: string, childId: string, code: string): Promise<void> {
  const me = await ensureHolder(familyId);
  const { data: rec, error } = await supabase.from("vault_recovery").select("*").eq("child_id", childId).maybeSingle();
  if (error || !rec) throw new Error("Bu kasa için kurtarma kodu yok.");
  const k = await codeKey(code, unb64(rec.salt), rec.iterations);
  let raw: Uint8Array<ArrayBuffer>;
  try {
    raw = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(rec.iv) }, k, unb64(rec.wrapped_key)));
  } catch {
    throw new Error("Kurtarma kodu yanlış.");
  }
  await supabase
    .from("vault_keys")
    .upsert({ child_id: childId, holder_id: me.holderId, wrapped_key: await wrapFor(me.publicKey, raw) }, { onConflict: "child_id,holder_id" });
  keyCache.set(childId, { key: await importAes(raw), raw });
  await shareMissing(familyId, childId, raw);
}

// --- kayıtlar ---

export async function decryptEntry(key: CryptoKey, e: StoredEntry): Promise<VaultEntry> {
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(e.iv) }, key, unb64(e.ciphertext));
  const j = JSON.parse(dec.decode(plain));
  return {
    app: j.app ?? "",
    username: j.username ?? "",
    password: j.password ?? "",
    recovery: j.recovery ?? "",
    note: j.note ?? "",
    history: Array.isArray(j.history) ? j.history : [],
  };
}

export async function encryptEntry(key: CryptoKey, v: VaultEntry): Promise<{ iv: string; ciphertext: string }> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, enc.encode(JSON.stringify(v)));
  return { iv: b64(iv), ciphertext: b64(ct) };
}

/** Rastgele güçlü şifre (karıştırılan karakterler yok). */
export function generatePassword(len = 14): string {
  const sets = ["ABCDEFGHJKLMNPQRSTUVWXYZ", "abcdefghijkmnpqrstuvwxyz", "23456789", "!@#$%*?-_"];
  const all = sets.join("");
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  const chars = Array.from(bytes, (b) => all[b % all.length]);
  sets.forEach((s, i) => (chars[i] = s[bytes[i] % s.length]));
  return chars.sort(() => (crypto.getRandomValues(new Uint8Array(1))[0] > 127 ? 1 : -1)).join("");
}
