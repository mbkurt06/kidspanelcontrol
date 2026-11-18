import { useSyncExternalStore } from "react";
import { supabase } from "./supabase";

/**
 * Video yükleme kuyruğu: sayfadan ayrılınca da sürer (uygulama açık kaldıkça).
 * Her dosya: bekliyor → yükleniyor (%) → yüklendi / hata. Her video bitince dinleyenler listeyi yeniler.
 */
export type UpItem = {
  key: string; listId: string; familyId: string; file: File; title: string; sort: number;
  status: "waiting" | "uploading" | "done" | "error"; pct: number; error?: string; videoId?: string;
};

/** OneDrive parça boyutu: 320 KiB'nin katı */
const CHUNK = 320 * 1024 * 32;
const cleanName = (n: string) => n.replace(/\.[^.]+$/, "").replace(/[_]+/g, " ").replace(/\s+/g, " ").trim();
const natural = (a: string, b: string) => a.localeCompare(b, "tr", { numeric: true, sensitivity: "base" });
const numbered = (t: string) => /^\s*\d+/.test(t);

let items: UpItem[] = [];
let running = false;
const subs = new Set<() => void>();
const doneSubs = new Set<() => void>();

function emit() { items = [...items]; subs.forEach((f) => f()); }
function patch(key: string, p: Partial<UpItem>) {
  items = items.map((x) => (x.key === key ? { ...x, ...p } : x));
  subs.forEach((f) => f());
}

export function useUploads(): UpItem[] {
  return useSyncExternalStore((f) => { subs.add(f); return () => subs.delete(f); }, () => items);
}
/** Bir video yüklenince (ya da bir kuyruk bitince) çağrılır */
export function onUploaded(f: () => void): () => void { doneSubs.add(f); return () => { doneSubs.delete(f); }; }

export function enqueue(listId: string, familyId: string, base: number, files: { file: File; title: string }[]) {
  const now = Date.now();
  items = [
    ...items.filter((x) => x.status !== "done"),
    ...files.map((f, i) => ({
      key: `${listId}:${f.file.name}:${f.file.size}:${now}:${i}`, listId, familyId, file: f.file, title: f.title.trim() || cleanName(f.file.name),
      sort: base + i, status: "waiting" as const, pct: 0,
    })),
  ];
  emit();
  void run();
}

export function dismiss(key: string) { items = items.filter((x) => x.key !== key); emit(); }
export function retry(key: string) { patch(key, { status: "waiting", pct: 0, error: undefined }); void run(); }
export const busy = () => items.some((x) => x.status === "waiting" || x.status === "uploading");

if (typeof window !== "undefined") {
  window.addEventListener("beforeunload", (e) => { if (busy()) { e.preventDefault(); e.returnValue = ""; } });
}

async function run() {
  if (running) return;
  running = true;
  const touched = new Set<string>();
  try {
    for (;;) {
      const it = items.find((x) => x.status === "waiting");
      if (!it) break;
      touched.add(it.listId);
      await one(it);
      doneSubs.forEach((f) => f());
    }
    // Adlar numaralıysa (001, 002…) liste numaraya göre dizilir
    for (const listId of touched) {
      const { data } = await supabase.from("videos").select("id,title").eq("list_id", listId);
      const all = (data ?? []) as { id: string; title: string }[];
      if (all.length && all.every((x) => numbered(x.title))) {
        const sorted = [...all].sort((a, b) => natural(a.title, b.title));
        await Promise.all(sorted.map((x, k) => supabase.from("videos").update({ sort: k }).eq("id", x.id)));
      }
    }
    doneSubs.forEach((f) => f());
  } finally { running = false; }
}

async function one(it: UpItem) {
  const { key, file } = it;
  patch(key, { status: "uploading", pct: 0 });
  try {
    let videoId = it.videoId;
    if (!videoId) {
      const meta = await probe(file);
      const { data: row, error } = await supabase.from("videos").insert({
        family_id: it.familyId, list_id: it.listId, title: it.title, file_name: file.name, size_bytes: file.size,
        duration_sec: meta.duration || null, width: meta.width || null, height: meta.height || null, mime: file.type || "video/mp4",
        thumb: meta.thumb, sort: it.sort, status: "uploading",
      }).select("id").single();
      if (error) throw error;
      videoId = (row as { id: string }).id;
      patch(key, { videoId });
      doneSubs.forEach((f) => f());
    }
    const s = await supabase.functions.invoke("orbit-onedrive", { body: { action: "video_session", list_id: it.listId, name: file.name } });
    if (s.error || !s.data?.upload_url) throw new Error(s.data?.error ?? s.error?.message ?? "OneDrive oturumu açılamadı");
    const url = s.data.upload_url as string;
    let off = 0;
    let item: string | null = null;
    while (off < file.size) {
      const end = Math.min(off + CHUNK, file.size);
      let tries = 0;
      for (;;) {
        try {
          const r = await fetch(url, { method: "PUT", headers: { "Content-Range": `bytes ${off}-${end - 1}/${file.size}` }, body: file.slice(off, end) });
          if (r.status === 200 || r.status === 201) { item = (await r.json()).id; break; }
          if (r.status === 202) break;
          throw new Error(`OneDrive HTTP ${r.status}`);
        } catch (e) {
          if (++tries >= 4) throw e;
          await new Promise((ok) => setTimeout(ok, 2000 * tries));
        }
      }
      off = end;
      patch(key, { pct: Math.round((off * 100) / file.size) });
    }
    if (!item) throw new Error("OneDrive yüklemeyi tamamlamadı");
    const { error: e2 } = await supabase.from("videos").update({ item_id: item, status: "ready" }).eq("id", videoId);
    if (e2) throw e2;
    patch(key, { status: "done", pct: 100 });
  } catch (e) {
    patch(key, { status: "error", error: e instanceof Error ? e.message : String(e) });
  }
}

function probe(file: File): Promise<{ duration: number; width: number; height: number; thumb: string | null }> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const v = document.createElement("video");
    v.preload = "metadata";
    v.muted = true;
    v.playsInline = true;
    let done = false;
    const finish = (thumb: string | null) => {
      if (done) return;
      done = true;
      resolve({ duration: Math.round(v.duration || 0), width: v.videoWidth, height: v.videoHeight, thumb });
      URL.revokeObjectURL(url);
    };
    v.onloadedmetadata = () => { v.currentTime = Math.min(2, (v.duration || 2) / 3); };
    v.onseeked = () => {
      try {
        const c = document.createElement("canvas");
        c.width = 192; c.height = 108;
        c.getContext("2d")!.drawImage(v, 0, 0, 192, 108);
        finish(c.toDataURL("image/jpeg", 0.7));
      } catch { finish(null); }
    };
    v.onerror = () => finish(null);
    setTimeout(() => finish(null), 15000);
    v.src = url;
  });
}
