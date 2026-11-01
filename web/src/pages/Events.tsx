import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useFamily } from "../lib/family";
import { supabase } from "../lib/supabase";
import { relTime } from "../lib/util";
import type { OrbitEvent } from "../lib/types";

function describe(e: OrbitEvent, childName: string) {
  const p = e.payload as Record<string, string>;
  switch (e.type) {
    case "app_installed":
      return `${childName} yeni uygulama yükledi: ${p.label ?? p.package}. Onay bekliyor.`;
    case "device_paired":
      return `${childName ? childName + " için " : ""}${p.label ?? "cihaz"} eşleşti.`;
    case "parent_device_pending":
      return `Yeni ebeveyn cihazı onay bekliyor: ${p.label} (${p.email}).`;
    case "task_submitted":
      return `${childName} "${p.title}" görevini tamamladı, onay bekliyor.`;
    case "time_request":
      return `${childName} ek süre istiyor${p.label ? ` (${p.label})` : ""}${p.note ? `: "${p.note}"` : "."}`;
    case "timer":
    case "timer_alert": {
      const st = String(p.status ?? "");
      const by = p.by === "parent" ? "senin başlattığın" : "kendi başlattığı";
      const mins = Math.round(Number(p.focused ?? 0) / 60 + Number(p.away ?? 0) / 60);
      if (st === "started") return `⏱ ${childName} ${p.by === "parent" ? "(senin başlattığın)" : ""} "${p.title}" sayacını başlattı.`;
      if (st === "done") return `✅ ${childName} "${p.title}" sayacını tamamladı (${mins} dk)${p.reward ? ` · +${p.reward} dk ödül` : ""}.`;
      if (st === "stopped") return `⏹ ${childName} ${by} "${p.title}" sayacını erken bitirdi (${mins} dk).`;
      if (st === "cancelled") return `✖ ${childName} ${by} "${p.title}" sayacını iptal etti.`;
      return `⏱ ${childName} · ${p.title}`;
    }
    case "recording":
    case "recording_alert": {
      const rec = Math.round(Number(p.recorded ?? 0) / 60);
      const plan = Math.round(Number(p.planned ?? 0) / 60);
      switch (p.action) {
        case "start":
          return `📹 ${childName} "${p.title}" kaydını başlattı (${p.minutes} dk).`;
        case "pause":
          return `📹 ${childName} "${p.title}" kaydında mola verdi (${rec} dk kaydedildi).`;
        case "resume":
          return `📹 ${childName} "${p.title}" kaydına devam etti${p.note ? ` (${p.note})` : ""}.`;
        case "gap":
          return `⚠️ ${childName} "${p.title}" kaydı kesildi${p.note ? `: ${p.note}` : ""}.`;
        case "leave":
          return `⚠️ ${childName} "${p.title}" kayıt ekranından çıktı.`;
        case "cancel":
          return `✖ ${childName} "${p.title}" kaydını iptal etti.`;
        case "done":
          return rec < plan ? `⚠️ ${childName} "${p.title}" kaydını erken bitirdi (${rec}/${plan} dk).` : `✅ ${childName} "${p.title}" kaydını tamamladı (${rec} dk).`;
        default:
          return `📹 ${childName} · ${p.title}`;
      }
    }
    case "pin_unlock":
      return `🔓 ${childName} telefonunda ebeveyn PIN'i girildi (${p.minutes ?? 15} dk kısıtlama yok).`;
    case "pin_fail":
      return `⚠️ ${childName} telefonunda yanlış ebeveyn PIN'i denendi.`;
    case "message":
      return `💬 ${childName}: ${p.body ?? ""}`;
    case "app_request":
      return `${childName} "${p.label ?? p.package}" uygulamasının açılmasını istiyor${p.note ? `: "${p.note}"` : "."}`;
    case "device_boot":
      return `${childName} telefonu yeniden başlatıldı.`;
    case "device_owner_lost":
      return `${childName} telefonunda Orbit yönetici yetkisini kaybetti!`;
    case "offline_long":
      return `${childName} telefonu uzun süredir çevrimdışı.`;
    default:
      return `${childName} · ${e.type}`;
  }
}

export default function Events() {
  const fam = useFamily();
  const [events, setEvents] = useState<OrbitEvent[] | null>(null);

  useEffect(() => {
    (async () => {
      const { data } = await supabase.from("events").select("*").order("created_at", { ascending: false }).limit(100);
      setEvents((data ?? []) as OrbitEvent[]);
      const unread = ((data ?? []) as OrbitEvent[]).filter((x) => !x.read_at).map((x) => x.id);
      if (unread.length) {
        await supabase.from("events").update({ read_at: new Date().toISOString() }).in("id", unread);
        fam.reload();
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="page">
      <header className="page-head">
        <h1>Olaylar</h1>
      </header>
      {!events && <p className="muted">Yükleniyor…</p>}
      {events && !events.length && <p className="muted">Henüz olay yok.</p>}
      <div className="stack-s">
        {events?.filter((e) => e.child_id == null || fam.visibleChildren.some((c) => c.id === e.child_id)).map((e) => {
          const child = fam.children.find((c) => c.id === e.child_id);
          const text = describe(e, child?.name ?? "");
          const to = e.type === "message" && child ? `/messages/${child.id}` : e.type === "parent_device_pending" ? "/settings" : e.type === "task_submitted" ? "/tasks" : child ? `/child/${child.id}` : "/";
          return (
            <Link to={to} className={`card event ${e.read_at ? "" : "unread"}`} key={e.id}>
              {child && <span className="dot" style={{ background: child.color }} />}
              <div className="grow">
                <div>{text}</div>
                <div className="muted tiny">{relTime(e.created_at)}</div>
              </div>
            </Link>
          );
        })}
      </div>
    </div>
  );
}
