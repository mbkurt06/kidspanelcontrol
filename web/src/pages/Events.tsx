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
        {events?.map((e) => {
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
