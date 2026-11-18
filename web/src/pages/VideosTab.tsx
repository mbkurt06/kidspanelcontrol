import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Info } from "../components/Info";
import { KioskWindows, MODE3_LABEL, MODES, fromMode3, mode3, type Mode3 } from "../components/AppModes";
import { useFamily } from "../lib/family";
import { errorText, supabase } from "../lib/supabase";
import type { ChildApp } from "../lib/types";

type VList = { id: string; family_id: string; child_id: string | null; name: string; emoji: string; sort: number; created_at: string };
type Video = {
  id: string; list_id: string; title: string; file_name: string | null; size_bytes: number | null; duration_sec: number | null;
  item_id: string | null; thumb: string | null; sort: number; status: "uploading" | "ready"; created_at: string;
};
type Settings = { can_delete: boolean; can_redownload: boolean; auto_delete_days: number | null; max_gb: number; wifi_only: boolean };
type Progress = { video_id: string; position_sec: number; duration_sec: number | null; watched: boolean; removed: boolean; downloaded: boolean };

const DEF: Settings = { can_delete: true, can_redownload: false, auto_delete_days: null, max_gb: 4, wifi_only: true };
/** OneDrive parça boyutu: 320 KiB'nin katı */
const CHUNK = 320 * 1024 * 32;

/** Dosya adından video adı: uzantı ve alt çizgiler gider */
const cleanName = (n: string) => n.replace(/\.[^.]+$/, "").replace(/[_]+/g, " ").replace(/\s+/g, " ").trim();

const mb = (b: number | null | undefined) => (b ? (b / 1048576 >= 1024 ? `${(b / 1073741824).toFixed(1)} GB` : `${Math.round(b / 1048576)} MB`) : "");
const dur = (s: number | null | undefined) => (s ? `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}` : "");

/** Videonun süresi, boyutu ve kapak karesi (tarayıcıda) */
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

/** Çocuk → Videolar: ailenin ortak video listeleri; bu çocukta durumu ve izinleri */
export default function VideosTab({ childId }: { childId: string }) {
  const fam = useFamily();
  const [lists, setLists] = useState<VList[] | null>(null);
  const [videos, setVideos] = useState<Video[]>([]);
  const [rows, setRows] = useState<Record<string, ChildApp>>({});
  const [settings, setSettings] = useState<Settings>(DEF);
  const [progress, setProgress] = useState<Record<string, Progress>>({});
  const [open, setOpen] = useState<string | null>(null);
  const [uploads, setUploads] = useState<Record<string, { name: string; pct: number; error?: string }>>({});
  const [err, setErr] = useState("");
  const [newName, setNewName] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [staged, setStaged] = useState<{ list: VList; files: File[] } | null>(null);

  const load = useCallback(async () => {
    const [l, v, r, s, p] = await Promise.all([
      supabase.from("video_lists").select("*").eq("family_id", fam.familyId).order("sort").order("created_at"),
      supabase.from("videos").select("*").eq("family_id", fam.familyId).order("sort").order("created_at"),
      supabase.from("child_apps").select("*").eq("child_id", childId).like("package", "video:%"),
      supabase.from("child_video_settings").select("*").eq("child_id", childId).maybeSingle(),
      supabase.from("video_progress").select("*").eq("child_id", childId),
    ]);
    const e = l.error ?? v.error ?? r.error ?? s.error ?? p.error;
    if (e) setErr(errorText(e));
    setLists((l.data ?? []) as VList[]);
    setVideos((v.data ?? []) as Video[]);
    setRows(Object.fromEntries(((r.data ?? []) as ChildApp[]).map((x) => [x.package, x])));
    setSettings({ ...DEF, ...((s.data as Settings | null) ?? {}) });
    setProgress(Object.fromEntries(((p.data ?? []) as Progress[]).map((x) => [x.video_id, x])));
  }, [childId, fam.familyId]);
  useEffect(() => { load(); }, [load]);

  async function updateRow(listId: string, patch: Partial<ChildApp>) {
    const pkg = `video:${listId}`;
    setRows((m) => ({ ...m, [pkg]: { ...m[pkg], ...patch } as ChildApp }));
    const { error } = await supabase.from("child_apps").update({ ...patch, updated_at: new Date().toISOString() }).eq("child_id", childId).eq("package", pkg);
    if (error) { setErr(errorText(error)); load(); }
  }

  async function saveSettings(p: Partial<Settings>) {
    const next = { ...settings, ...p };
    setSettings(next);
    const { error } = await supabase.from("child_video_settings").upsert({ child_id: childId, family_id: fam.familyId, ...next, updated_at: new Date().toISOString() });
    if (error) setErr(errorText(error));
  }

  async function addList() {
    const name = newName.trim();
    if (!name) return;
    const { error } = await supabase.from("video_lists").insert({ family_id: fam.familyId, child_id: childId, name, sort: lists?.length ?? 0 });
    if (error) { setErr(errorText(error)); return; }
    setNewName("");
    load();
  }

  async function renameList(l: VList) {
    const name = prompt("Listenin adı", l.name)?.trim();
    if (!name || name === l.name) return;
    const emoji = prompt("Simge (emoji)", l.emoji)?.trim() || l.emoji;
    const { error } = await supabase.from("video_lists").update({ name, emoji }).eq("id", l.id);
    if (error) setErr(errorText(error)); else load();
  }

  async function removeList(l: VList) {
    const vids = videos.filter((v) => v.list_id === l.id);
    if (!confirm(`“${l.name}” listesi silinsin mi? ${vids.length} video bütün çocukların telefonundan kalkar.`)) return;
    const od = vids.length > 0 && confirm("Videolar OneDrive'dan da silinsin mi? (Tamam: sil · İptal: OneDrive'da kalsın)");
    if (od) for (const v of vids) if (v.item_id) await supabase.functions.invoke("orbit-onedrive", { body: { action: "video_delete", item_id: v.item_id } });
    const { error } = await supabase.from("video_lists").delete().eq("id", l.id);
    if (error) setErr(errorText(error)); else load();
  }

  async function removeVideo(v: Video) {
    if (!confirm(`“${v.title}” silinsin mi? Bütün çocukların telefonundan kalkar.`)) return;
    if (v.item_id && confirm("OneDrive'dan da silinsin mi? (Tamam: sil · İptal: OneDrive'da kalsın)")) {
      await supabase.functions.invoke("orbit-onedrive", { body: { action: "video_delete", item_id: v.item_id } });
    }
    const { error } = await supabase.from("videos").delete().eq("id", v.id);
    if (error) setErr(errorText(error)); else load();
  }

  async function move(listId: string, v: Video, d: number) {
    const a = videos.filter((x) => x.list_id === listId);
    const i = a.findIndex((x) => x.id === v.id);
    const j = i + d;
    if (j < 0 || j >= a.length) return;
    [a[i], a[j]] = [a[j], a[i]];
    setVideos((all) => [...all.filter((x) => x.list_id !== listId), ...a.map((x, k) => ({ ...x, sort: k }))]);
    await Promise.all(a.map((x, k) => supabase.from("videos").update({ sort: k }).eq("id", x.id)));
  }

  async function renameVideo(v: Video, title: string) {
    const t = title.trim();
    setEditing(null);
    if (!t || t === v.title) return;
    setVideos((all) => all.map((x) => (x.id === v.id ? { ...x, title: t } : x)));
    const { error } = await supabase.from("videos").update({ title: t }).eq("id", v.id);
    if (error) { setErr(errorText(error)); load(); }
  }

  /** Listeyi videoların adına göre sırala (1, 2, 10 doğal sırayla) */
  async function sortByName(listId: string) {
    const a = videos.filter((x) => x.list_id === listId).sort((x, y) => x.title.localeCompare(y.title, "tr", { numeric: true, sensitivity: "base" }));
    setVideos((all) => [...all.filter((x) => x.list_id !== listId), ...a.map((x, k) => ({ ...x, sort: k }))]);
    await Promise.all(a.map((x, k) => supabase.from("videos").update({ sort: k }).eq("id", x.id)));
  }

  /** Dosya adlarını yeniden video adı yap */
  async function namesFromFiles(listId: string) {
    const a = videos.filter((x) => x.list_id === listId && x.file_name);
    if (!a.length || !confirm("Bu listedeki videoların adları dosya adlarından yeniden alınsın mı?")) return;
    setVideos((all) => all.map((x) => (x.list_id === listId && x.file_name ? { ...x, title: cleanName(x.file_name) } : x)));
    await Promise.all(a.map((x) => supabase.from("videos").update({ title: cleanName(x.file_name!) }).eq("id", x.id)));
  }

  async function upload(l: VList, items: { file: File; title: string }[]) {
    const base = videos.filter((x) => x.list_id === l.id).length;
    for (const [idx, { file, title }] of items.entries()) {
      const key = `${l.id}:${file.name}:${file.size}`;
      setUploads((u) => ({ ...u, [key]: { name: file.name, pct: 0 } }));
      try {
        const meta = await probe(file);
        const { data: row, error } = await supabase.from("videos").insert({
          family_id: fam.familyId, list_id: l.id, title: title.trim() || cleanName(file.name), file_name: file.name, size_bytes: file.size,
          duration_sec: meta.duration || null, width: meta.width || null, height: meta.height || null, mime: file.type || "video/mp4",
          thumb: meta.thumb, sort: base + idx, status: "uploading",
        }).select().single();
        if (error) throw error;
        const s = await supabase.functions.invoke("orbit-onedrive", { body: { action: "video_session", list_id: l.id, name: file.name } });
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
              await new Promise((ok2) => setTimeout(ok2, 2000 * tries));
            }
          }
          off = end;
          setUploads((u) => ({ ...u, [key]: { name: file.name, pct: Math.round((off * 100) / file.size) } }));
        }
        if (!item) throw new Error("OneDrive yüklemeyi tamamlamadı");
        const { error: e2 } = await supabase.from("videos").update({ item_id: item, status: "ready" }).eq("id", (row as Video).id);
        if (e2) throw e2;
        setUploads((u) => { const n = { ...u }; delete n[key]; return n; });
        load();
      } catch (e) {
        setUploads((u) => ({ ...u, [key]: { name: file.name, pct: u[key]?.pct ?? 0, error: e instanceof Error ? e.message : String(e) } }));
      }
    }
  }

  if (!lists) return <p className="muted">Yükleniyor…</p>;
  return (
    <div className="stack">
      {err && <p className="error">{err}</p>}
      <div className="card">
        <h2>🎬 Video listeleri <Info>Bütün çocuklar için ortak listeler. Videolar ailenin OneDrive'ına (Orbit/Videolar) yüklenir; telefon bir kez indirip internetsiz oynatır. Her çocukta durum ayrı seçilir: "Hep kapalı" olan çocuğun telefonunda liste hiç görünmez, saati dışındaki liste kilitli görünür. En iyi biçim: MP4 (H.264 + AAC), 720p.</Info></h2>
        {lists.length === 0 && <p className="muted">Henüz liste yok.</p>}
        {lists.map((l) => {
          const row = rows[`video:${l.id}`];
          const vids = videos.filter((v) => v.list_id === l.id);
          const size = vids.reduce((n, v) => n + (v.size_bytes ?? 0), 0);
          return (
            <div key={l.id} className="video-list">
              <div className="row between" onClick={() => setOpen(open === l.id ? null : l.id)} role="button" tabIndex={0}>
                <b>{l.emoji} {l.name}</b>
                <span className="muted small">{vids.length} video · {mb(size)} {open === l.id ? "▴" : "▾"}</span>
              </div>
              {row ? (
                <div className="app-setting-controls">
                  <select value={mode3(row)} onChange={(e) => updateRow(l.id, fromMode3(e.target.value as Mode3))} aria-label="Durum">
                    {MODES.map((m) => <option key={m} value={m}>{MODE3_LABEL[m]}</option>)}
                  </select>
                  <select value={row.usage_rule_id ?? ""} onChange={(e) => updateRow(l.id, { usage_rule_id: e.target.value || null })} aria-label="Özel kural">
                    <option value="">Özel kural yok</option>
                    {fam.appUsageRules.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
                  </select>
                </div>
              ) : <p className="muted tiny">Bu çocuk için satır bulunamadı</p>}
              {row?.kiosk && <KioskWindows app={row} onSave={(w) => updateRow(l.id, { kiosk_windows: w })} />}
              {open === l.id && (
                <div className="video-items">
                  {vids.map((v, i) => {
                    const p = progress[v.id];
                    const st = v.status === "uploading" ? "⏳ yükleniyor" : p?.watched ? "✔ izledi" : p && p.position_sec > 5 && v.duration_sec ? `%${Math.min(99, Math.round((p.position_sec * 100) / v.duration_sec))} izledi` : p?.removed ? "telefondan sildi" : p?.downloaded ? "telefonda" : "";
                    return (
                      <div key={v.id} className="web-video">
                        {v.thumb ? <img src={v.thumb} alt="" /> : <span className="web-ico videos">🎬</span>}
                        {editing === v.id ? (
                          <input className="grow" autoFocus defaultValue={v.title}
                            onBlur={(e) => renameVideo(v, e.currentTarget.value)}
                            onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); if (e.key === "Escape") setEditing(null); }} />
                        ) : (
                          <span className="grow small" onClick={() => setEditing(v.id)} title="Adını değiştirmek için dokun">
                            {i + 1}. {v.title}
                            <span className="muted tiny"> · {dur(v.duration_sec)} · {mb(v.size_bytes)}{st ? ` · ${st}` : ""}</span>
                          </span>
                        )}
                        <button className="link-btn" onClick={() => setEditing(v.id)} aria-label="Adını değiştir">✎</button>
                        <button className="link-btn" onClick={() => move(l.id, v, -1)} aria-label="Yukarı">▲</button>
                        <button className="link-btn" onClick={() => move(l.id, v, 1)} aria-label="Aşağı">▼</button>
                        <button className="link-btn danger" onClick={() => removeVideo(v)} aria-label="Sil">✕</button>
                      </div>
                    );
                  })}
                  {Object.entries(uploads).filter(([k]) => k.startsWith(`${l.id}:`)).map(([k, u]) => (
                    <div key={k} className="upload-row">
                      <span className="small">{u.name}</span>
                      {u.error ? <span className="error tiny">{u.error}</span> : <progress max={100} value={u.pct} />}
                      <span className="muted tiny">{u.error ? "" : `%${u.pct}`}</span>
                    </div>
                  ))}
                  <UploadButton onFiles={(f) => setStaged({ list: l, files: Array.from(f) })} />
                  <div className="row gap-s" style={{ flexWrap: "wrap" }}>
                    <button className="link-btn" onClick={() => sortByName(l.id)}>⇅ Ada göre sırala</button>
                    <button className="link-btn" onClick={() => namesFromFiles(l.id)}>🏷 Adları dosya adından al</button>
                    <button className="link-btn" onClick={() => renameList(l)}>✎ Adı / simge</button>
                    <button className="link-btn danger" onClick={() => removeList(l)}>Listeyi sil</button>
                  </div>
                </div>
              )}
            </div>
          );
        })}
        <div className="row gap-s" style={{ marginTop: 10 }}>
          <input className="grow" value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="Yeni liste adı (ör. Mathe)" onKeyDown={(e) => e.key === "Enter" && addList()} />
          <button className="btn small" onClick={addList}>＋ Liste</button>
        </div>
      </div>

      {staged && (
        <StageDialog
          list={staged.list}
          files={staged.files}
          onClose={() => setStaged(null)}
          onUpload={(items) => { const l = staged.list; setStaged(null); setOpen(l.id); upload(l, items); }}
        />
      )}

      <div className="card">
        <h2>Bu çocuğun video izinleri <Info>Telefondaki indirme ve silme kuralları. Çocuk videoyu ancak burada izin verirsen telefondan silebilir ya da sildiğini tekrar indirebilir.</Info></h2>
        <label className="web-toggle"><input type="checkbox" checked={settings.can_delete} onChange={(e) => saveSettings({ can_delete: e.target.checked })} /><span><b>Videoyu telefondan silebilir</b></span></label>
        <label className="web-toggle"><input type="checkbox" checked={settings.can_redownload} onChange={(e) => saveSettings({ can_redownload: e.target.checked })} /><span><b>Sildiğini tekrar indirebilir</b></span></label>
        <label className="web-toggle"><input type="checkbox" checked={settings.wifi_only} onChange={(e) => saveSettings({ wifi_only: e.target.checked })} /><span><b>Sadece Wi-Fi'de indir</b></span></label>
        <div className="row gap-s" style={{ marginTop: 6, flexWrap: "wrap" }}>
          <label className="row gap-s small">İzlenince
            <input className="mini" type="number" min={0} placeholder="—" value={settings.auto_delete_days ?? ""}
              onChange={(e) => saveSettings({ auto_delete_days: e.target.value === "" ? null : Math.max(0, Number(e.target.value)) })} />
            gün sonra otomatik sil</label>
          <label className="row gap-s small">En fazla
            <input className="mini" type="number" min={0.5} step={0.5} value={settings.max_gb}
              onChange={(e) => saveSettings({ max_gb: Math.max(0.5, Number(e.target.value) || 4) })} />
            GB</label>
        </div>
      </div>
    </div>
  );
}

function UploadButton({ onFiles }: { onFiles: (f: FileList) => void }) {
  const ref = useRef<HTMLInputElement>(null);
  return (
    <>
      <input ref={ref} type="file" accept="video/*" multiple hidden onChange={(e) => { if (e.target.files?.length) onFiles(e.target.files); e.target.value = ""; }} />
      <button className="btn small" onClick={() => ref.current?.click()}>＋ Video seç</button>
    </>
  );
}

/** Toplu eklemeden önce: sırala, adları dosya adından al ya da elle yaz */
function StageDialog({ list, files, onClose, onUpload }: { list: VList; files: File[]; onClose: () => void; onUpload: (items: { file: File; title: string }[]) => void }) {
  const [auto, setAuto] = useState(true);
  const [items, setItems] = useState(() => files.map((file) => ({ file, title: cleanName(file.name) })));
  const setAll = (on: boolean) => {
    setAuto(on);
    setItems((a) => a.map((x) => ({ ...x, title: on ? cleanName(x.file.name) : "" })));
  };
  const move = (i: number, d: number) => setItems((a) => {
    const b = [...a]; const j = i + d;
    if (j < 0 || j >= b.length) return a;
    [b[i], b[j]] = [b[j], b[i]];
    return b;
  });
  const sortName = () => setItems((a) => [...a].sort((x, y) => (x.title || x.file.name).localeCompare(y.title || y.file.name, "tr", { numeric: true, sensitivity: "base" })));
  const notMp4 = items.filter((x) => !(/\.mp4$/i.test(x.file.name) || x.file.type === "video/mp4"));
  const missing = items.some((x) => !x.title.trim());
  return createPortal(
    <>
      <div className="pop-backdrop sheet-like" onClick={onClose} />
      <div className="lock-pop sheet-pop web-dialog" role="dialog" aria-label="Video ekle">
        <b className="sheet-pop-title">{list.emoji} {list.name} · {items.length} video ekle</b>
        <div className="stack" style={{ gap: 8 }}>
          <label className="web-toggle"><input type="checkbox" checked={auto} onChange={(e) => setAll(e.target.checked)} /><span><b>Video adlarını dosya adlarından al</b></span></label>
          <div className="row gap-s"><button className="link-btn" onClick={sortName}>⇅ Ada göre sırala</button></div>
          {items.map((x, i) => (
            <div key={x.file.name + i} className="web-video">
              <span className="muted small" style={{ width: 22 }}>{i + 1}.</span>
              <span className="grow" style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                <input value={x.title} placeholder="Video adı" onChange={(e) => setItems((a) => a.map((y, k) => (k === i ? { ...y, title: e.target.value } : y)))} />
                <span className="muted tiny">{x.file.name} · {mb(x.file.size)}</span>
              </span>
              <button className="link-btn" onClick={() => move(i, -1)} aria-label="Yukarı">▲</button>
              <button className="link-btn" onClick={() => move(i, 1)} aria-label="Aşağı">▼</button>
              <button className="link-btn danger" onClick={() => setItems((a) => a.filter((_, k) => k !== i))} aria-label="Çıkar">✕</button>
            </div>
          ))}
          {notMp4.length > 0 && <p className="error tiny">⚠ {notMp4.length} dosya MP4 değil; bazı telefonlarda oynamayabilir.</p>}
          <div className="row between">
            <button className="btn ghost small" onClick={onClose}>Vazgeç</button>
            <button className="btn small" disabled={!items.length || missing} onClick={() => onUpload(items)}>{missing ? "Adları yaz" : `Yükle (${items.length})`}</button>
          </div>
        </div>
      </div>
    </>,
    document.body,
  );
}
