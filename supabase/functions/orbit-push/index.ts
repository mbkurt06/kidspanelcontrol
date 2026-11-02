// Orbit — ebeveyn telefonlarına bildirim (Web Push, iPhone'da ana ekrana eklenmiş PWA).
// Veritabanındaki tetikleyici her önemli olayda bu fonksiyonu kanca sırrıyla çağırır.
import { createClient } from "npm:@supabase/supabase-js@2";
import webpush from "npm:web-push@3.6.7";

const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false },
  db: { schema: "orbit" },
});

let config: Record<string, string> | null = null;
async function cfg() {
  if (!config) {
    const { data, error } = await admin.rpc("server_config");
    if (error) throw error;
    config = data as Record<string, string>;
    webpush.setVapidDetails("mailto:orbit@orbit-panel-nu.vercel.app", config.orbit_vapid_public, config.orbit_vapid_private);
  }
  return config;
}

function text(type: string, child: string, p: Record<string, unknown>): { title: string; body: string; url: string } {
  const s = (k: string) => (p[k] == null ? "" : String(p[k]));
  switch (type) {
    case "task_submitted":
      return { title: `${child} görevi tamamladı`, body: `${s("title")} — onayını bekliyor`, url: "/#/tasks" };
    case "time_request":
      return { title: `${child} süre istiyor`, body: s("label") ? `${s("label")}: ${s("note")}` : s("note") || "Ek süre isteği", url: "/#/" };
    case "app_request":
      return { title: `${child} uygulama istiyor`, body: `${s("label") || s("package")} açılsın mı?${s("note") ? ` — ${s("note")}` : ""}`, url: "/#/" };
    case "message":
      return { title: `💬 ${child}`, body: s("body"), url: `/#/messages/${s("_child")}` };
    case "timer_alert":
      return { title: `⏱ ${child} sayacı erken bitirdi`, body: `${s("title")} — ${Math.round(Number(s("focused") || 0) / 60)} dk çalıştı`, url: "/#/" };
    case "recording_alert": {
      const a = s("action");
      const rec = Math.round(Number(s("recorded") || 0) / 60);
      const plan = Math.round(Number(s("planned") || 0) / 60);
      const what =
        a === "gap" ? "kayıt kesildi (kamera / uygulama kapandı)" :
        a === "leave" ? "kayıt ekranından çıktı" :
        a === "cancel" ? "kaydı iptal etti" :
        `kaydı erken bitirdi (${rec}/${plan} dk)`;
      return { title: `📹 ${child}: ${what}`, body: s("title"), url: "/#/tasks" };
    }
    case "pin_unlock":
      return { title: `🔓 ${child}: ebeveyn PIN'i girildi`, body: `${s("minutes") || 15} dk kısıtlama yok`, url: "/#/events" };
    case "pin_fail":
      return { title: `⚠️ ${child}: yanlış ebeveyn PIN'i`, body: "Telefonda yanlış PIN denendi", url: "/#/events" };
    case "app_installed":
      return { title: `${child} yeni uygulama yükledi`, body: `${s("label") || s("package")} onay bekliyor`, url: "/#/" };
    case "parent_device_pending":
      return { title: "Yeni cihaz onay bekliyor", body: `${s("label")} (${s("email")})`, url: "/#/settings" };
    case "device_owner_lost":
      return { title: "Dikkat: Orbit yetkisi kalktı", body: `${child} telefonunda Orbit yönetici yetkisini kaybetti`, url: "/#/" };
    case "offline_long":
      return { title: `${child} telefonu çevrimdışı`, body: "1 saattir bağlantı yok (kapalı veya internetsiz olabilir)", url: "/#/" };
    case "device_paired":
      return { title: "Cihaz eşleşti", body: `${child ? child + " — " : ""}${s("label") || s("model")}`, url: "/#/" };
    case "push_test":
      return { title: "Orbit", body: "Bildirimler bu cihazda çalışıyor.", url: "/#/settings" };
    default:
      return { title: "Orbit", body: type, url: "/#/events" };
  }
}

Deno.serve(async (req) => {
  try {
    const c = await cfg();
    if (req.headers.get("x-orbit-hook") !== c.orbit_hook_secret) return new Response("forbidden", { status: 403 });
    const { event_id } = await req.json();
    const { data: ev } = await admin.from("events").select("*").eq("id", event_id).maybeSingle();
    if (!ev) return new Response("no event", { status: 404 });
    let child = "";
    if (ev.child_id) {
      const { data: k } = await admin.from("children").select("name").eq("id", ev.child_id).maybeSingle();
      child = k?.name ?? "";
    }
    const msg = text(ev.type, child, { ...(ev.payload ?? {}), _child: ev.child_id ?? "" });
    const { data: subs } = await admin
      .from("push_subscriptions")
      .select("*")
      .eq("family_id", ev.family_id)
      .is("disabled_at", null);
    let sent = 0;
    for (const s of subs ?? []) {
      if (s.types?.length && !s.types.includes(ev.type)) continue;
      try {
        await webpush.sendNotification(
          { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
          JSON.stringify({ ...msg, tag: ev.type === "message" ? `message:${ev.id}` : ev.type + ":" + (ev.child_id ?? "") }),
          { TTL: 3600, urgency: "high" },
        );
        sent++;
      } catch (e) {
        const code = (e as { statusCode?: number }).statusCode;
        if (code === 404 || code === 410) {
          await admin.from("push_subscriptions").update({ disabled_at: new Date().toISOString() }).eq("id", s.id);
        } else {
          console.error("push hatası", code, (e as Error).message);
        }
      }
    }
    console.log("push sonucu", { sent, total: (subs ?? []).length, type: ev.type });
    return Response.json({ sent });
  } catch (e) {
    console.error(e);
    return new Response("error", { status: 500 });
  }
});
