import { localDevice, supabase } from "./supabase";

function b64ToBytes(b64: string) {
  const pad = "=".repeat((4 - (b64.length % 4)) % 4);
  const raw = atob((b64 + pad).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

export function pushSupported() {
  return "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
}

export function isIOS() {
  return /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
}

export function isStandalone() {
  return window.matchMedia("(display-mode: standalone)").matches || (navigator as unknown as { standalone?: boolean }).standalone === true;
}

async function readyRegistration(): Promise<ServiceWorkerRegistration | null> {
  if (!pushSupported()) return null;
  const existing = await navigator.serviceWorker.getRegistration("/");
  if (!existing) await navigator.serviceWorker.register("/sw.js", { scope: "/" });
  return navigator.serviceWorker.ready;
}

export async function currentSubscription(): Promise<PushSubscription | null> {
  const reg = await readyRegistration();
  return (await reg?.pushManager.getSubscription()) ?? null;
}

/** Bu cihazda bildirimleri açar ve aboneliği kaydeder. Kullanıcı dokunuşuyla çağrılmalı (iPhone şartı). */
export async function enablePush(familyId: string): Promise<void> {
  if (!pushSupported()) throw new Error("Bu tarayıcı bildirimleri desteklemiyor. iPhone'da paneli ana ekrana ekleyip oradan aç.");
  if (isIOS() && !isStandalone()) throw new Error("iPhone'da önce Orbit'i ana ekrana ekleyip oradan aç.");
  const perm = await Notification.requestPermission();
  if (perm !== "granted") throw new Error("Bildirim izni verilmedi. Ayarlar → Bildirimler → Orbit'ten açabilirsin.");
  const reg = await readyRegistration();
  if (!reg) throw new Error("Bildirim servisi başlatılamadı. Orbit'i kapatıp tekrar aç.");
  const { data: key, error: kerr } = await supabase.rpc("vapid_public_key");
  if (kerr || !key) throw new Error("Sunucu anahtarı alınamadı");
  const sub =
    (await reg.pushManager.getSubscription()) ??
    (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(String(key)) }));
  const json = sub.toJSON();
  const { data: u } = await supabase.auth.getUser();
  if (!u.user) throw new Error("Oturum bulunamadı. Tekrar giriş yap.");
  const { error } = await supabase.from("push_subscriptions").upsert(
    {
      user_id: u.user.id,
      family_id: familyId,
      parent_device_id: localDevice().id || null,
      endpoint: json.endpoint,
      p256dh: json.keys?.p256dh,
      auth: json.keys?.auth,
      disabled_at: null,
    },
    { onConflict: "endpoint" }
  );
  if (error) throw error;
}

export async function disablePush(): Promise<void> {
  const sub = await currentSubscription();
  if (!sub) return;
  await supabase.from("push_subscriptions").update({ disabled_at: new Date().toISOString() }).eq("endpoint", sub.endpoint);
  await sub.unsubscribe();
}
