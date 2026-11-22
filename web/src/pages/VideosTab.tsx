import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Info } from "../components/Info";
import { KioskControl, MODE3_LABEL, MODES, fromMode3, mode3, type Mode3 } from "../components/AppModes";
import { useFamily } from "../lib/family";
import { errorText, supabase } from "../lib/supabase";
import type { ChildApp } from "../lib/types";
import { dismiss, enqueue, onUploaded, retry, useUploads } from "../lib/uploads";

type VList = { id: string; family_id: string; child_id: string | null; name: string; emoji: string; sort: number; created_at: string };
type Video = {
  id: string; list_id: string; title: string; file_name: string | null; size_bytes: number | null; duration_sec: number | null;
  item_id: string | null; thumb: string | null; sort: number; status: "uploading" | "ready"; created_at: string;
};
type Settings = { can_delete: boolean; can_redownload: boolean; auto_delete_days: number | null; max_gb: number; wifi_only: boolean };
type Progress = { video_id: string; position_sec: number; duration_sec: number | null; watched: boolean; removed: boolean; downloaded: boolean };

const DEF: Settings = { can_delete: true, can_redownload: false, auto_delete_days: null, max_gb: 4, wifi_only: true };

/** Dosya adından video adı: uzantı ve alt çizgiler gider */
const cleanName = (n: string) => n.replace(/\.[^.]+$/, "").replace(/[_]+/g, " ").replace(/\s+/g, " ").trim();

/** Doğal sıra: baştaki numaraya göre (001, 002, 10), sonra ada göre */
const natural = (a: string, b: string) => a.localeCompare(b, "tr", { numeric: true, sensitivity: "base" });
const numbered = (t: string) => /^\s*\d+/.test(t);

const mb = (b: number | null | undefined) => (b ? (b / 1048576 >= 1024 ? `${(b / 1073741824).toFixed(1)} GB` : `${Math.round(b / 1048576)} MB`) : "");
const dur = (s: number | null | undefined) => (s ? `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}` : "");

/** Videonun süresi, boyutu ve kapak karesi (tarayıcıda) */
/** Çocuk → Videolar: ailenin ortak video listeleri; bu çocukta durumu ve izinleri */
export default function VideosTab({ childId }: { childId: string }) {
  const fam = useFamily();
  const [lists, setLists] = useState<VList[] | null>(null);
  const [videos, setVideos] = useState<Video[]>([]);
  const [rows, setRows] = useState<Record<string, ChildApp>>({});
  const [settings, setSettings] = useState<Settings>(DEF);
  const [progress, setProgress] = useState<Record<string, Progress>>({});
  const [open, setOpen] = useState<string | null>(null);
  const queue = useUploads();
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
  // Her video yüklendikçe liste kendiliğinden yenilenir
  useEffect(() => onUploaded(() => { void load(); }), [load]);

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
    const a = videos.filter((x) => x.list_id === listId).sort((x, y) => natural(x.title, y.title));
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

  function upload(l: VList, items: { file: File; title: string }[]) {
    const base = videos.filter((x) => x.list_id === l.id).length;
    if (fam.familyId) enqueue(l.id, fam.familyId, base, items);
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
          const active = new Set(queue.filter((q) => q.videoId && q.status !== "done").map((q) => q.videoId));
          const vids = videos.filter((v) => v.list_id === l.id && !active.has(v.id));
          const lq = queue.filter((q) => q.listId === l.id && (q.status !== "done" || !videos.some((v) => v.id === q.videoId && v.status === "ready")));
          const left = lq.filter((q) => q.status === "waiting" || q.status === "uploading").length;
          const size = vids.reduce((n, v) => n + (v.size_bytes ?? 0), 0);
          return (
            <div key={l.id} className="video-list">
              <div className="row between" onClick={() => setOpen(open === l.id ? null : l.id)} role="button" tabIndex={0}>
                <b>{l.emoji} {l.name}</b>
                <span className="muted small">{vids.length} video · {mb(size)}{left ? ` · ⬆ ${left} yükleniyor` : ""} {open === l.id ? "▴" : "▾"}</span>
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
              {row && <KioskControl app={row} onSave={(p) => updateRow(l.id, p)} />}
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
                  {lq.length > 0 && (
                    <div className="upload-queue">
                      <p className="small"><b>Yükleme</b> <span className="muted">· {lq.filter((q) => q.status === "done").length} / {lq.length} yüklendi{left ? " · sayfadan ayrılabilirsin, panel açık kaldıkça sürer" : ""}</span></p>
                      {lq.map((q) => (
                        <div key={q.key} className="upload-row">
                          <span className="small grow">{q.title}</span>
                          {q.status === "uploading" && <><progress max={100} value={q.pct} /><span className="muted tiny">%{q.pct} yükleniyor</span></>}
                          {q.status === "waiting" && <span className="muted tiny">⏳ bekliyor</span>}
                          {q.status === "done" && <span className="ok tiny">✔ yüklendi</span>}
                          {q.status === "error" && <>
                            <span className="error tiny">⚠ {q.error}</span>
                            <button className="link-btn" onClick={() => retry(q.key)}>Tekrar dene</button>
                            <button className="link-btn" onClick={() => dismiss(q.key)}>✕</button>
                          </>}
                        </div>
                      ))}
                    </div>
                  )}
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
  // Seçim sırası telefona göre değişir: dosya adına göre (001, 002…) sıralı başla
  const [items, setItems] = useState(() => files.map((file) => ({ file, title: cleanName(file.name) })).sort((x, y) => natural(x.file.name, y.file.name)));
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
  const sortName = () => setItems((a) => [...a].sort((x, y) => natural(x.title || x.file.name, y.title || y.file.name)));
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
