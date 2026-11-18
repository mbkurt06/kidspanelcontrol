import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useFamily } from "../lib/family";
import { errorText, supabase } from "../lib/supabase";

export type WebVideo = { type: "video" | "playlist"; id: string; title: string };
export type WebApp = {
  id: string; family_id: string; child_id: string; kind: "site" | "videos"; title: string; url: string | null; allowed_domains: string[];
  videos: WebVideo[]; autoplay: boolean; loop: boolean; strict: boolean; history: boolean; downloads: boolean; media: boolean;
  fullscreen: boolean; safe_search: boolean; remember_login: boolean; login_mode: "off" | "fill" | "auto";
};
type Visit = { id: number; url: string; title: string | null; blocked: boolean; at: string };

const blank = (kind: WebApp["kind"]): Omit<WebApp, "id" | "family_id" | "child_id"> => ({
  kind, title: "", url: "", allowed_domains: [], videos: [], autoplay: true, loop: false, strict: true, history: true, downloads: false,
  media: false, fullscreen: true, safe_search: true, remember_login: true, login_mode: "auto",
});

/** YouTube linkinden video ya da oynatma listesi kimliği */
export function parseYouTube(s: string): WebVideo | null {
  const t = s.trim();
  if (/^[\w-]{11}$/.test(t)) return { type: "video", id: t, title: "" };
  try {
    const u = new URL(t.includes("://") ? t : `https://${t}`);
    const h = u.hostname.replace(/^www\.|^m\./, "");
    if (h === "youtu.be") { const id = u.pathname.slice(1).split("/")[0]; return id ? { type: "video", id, title: "" } : null; }
    if (!h.endsWith("youtube.com") && !h.endsWith("youtube-nocookie.com")) return null;
    const v = u.searchParams.get("v") ?? u.pathname.match(/^\/(shorts|embed|live)\/([\w-]{6,})/)?.[2];
    const list = u.searchParams.get("list");
    if (v) return { type: "video", id: v, title: "" };
    if (list) return { type: "playlist", id: list, title: "" };
  } catch { /* geçersiz */ }
  return null;
}

async function videoTitle(v: WebVideo): Promise<string> {
  const url = v.type === "video" ? `https://www.youtube.com/watch?v=${v.id}` : `https://www.youtube.com/playlist?list=${v.id}`;
  for (const api of [`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(url)}`, `https://noembed.com/embed?url=${encodeURIComponent(url)}`]) {
    try {
      const r = await fetch(api);
      if (r.ok) { const j = await r.json(); if (j?.title) return String(j.title); }
    } catch { /* sıradaki */ }
  }
  return v.type === "playlist" ? "Oynatma listesi" : `Video ${v.id}`;
}

const hostOf = (s: string | null) => { try { return new URL((s ?? "").includes("://") ? s! : `https://${s}`).hostname.replace(/^www\./, ""); } catch { return s ?? ""; } };

/** Çocuk → Uygulamalar: web sayfaları ve YouTube video listeleri (telefonda uygulama gibi) */
export default function WebAppsCard({ childId, onChanged, editId, onEditDone }: { childId: string; onChanged: () => void; editId?: string | null; onEditDone?: () => void }) {
  const [list, setList] = useState<WebApp[]>([]);
  const [edit, setEdit] = useState<Partial<WebApp> | null>(null);
  const [err, setErr] = useState("");

  const load = useCallback(async () => {
    const { data, error } = await supabase.from("web_apps").select("*").eq("child_id", childId).order("created_at");
    if (error) setErr(errorText(error));
    setList((data ?? []) as WebApp[]);
  }, [childId]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    if (!editId) return;
    const w = list.find((x) => `web:${x.id}` === editId);
    if (w) { setEdit(w); onEditDone?.(); }
  }, [editId, list, onEditDone]);

  return (
    <div className="card">
      <div className="row between">
        <h2 style={{ margin: 0 }}>Web sayfaları ve videolar</h2>
      </div>
      <p className="muted small" style={{ margin: "4px 0 10px" }}>
        Telefonda Orbit içinde uygulama gibi açılır; adres çubuğu yoktur, başka siteye geçilemez. Grubu, durumu ve özel kuralı aşağıdaki listede diğer uygulamalar gibi seçilir.
      </p>
      {err && <p className="error">{err}</p>}
      {list.map((w) => (
        <button key={w.id} className="web-app-row" onClick={() => setEdit(w)}>
          <span className={`web-ico ${w.kind}`}>{w.kind === "videos" ? "▶" : "🌐"}</span>
          <span className="grow">
            <b>{w.title}</b>
            <span className="muted tiny">{w.kind === "videos" ? `${w.videos.length} video / liste` : hostOf(w.url)}</span>
          </span>
          <span className="muted">⚙</span>
        </button>
      ))}
      <div className="row gap-s" style={{ marginTop: 10, flexWrap: "wrap" }}>
        <button className="btn small" onClick={() => setEdit(blank("site"))}>＋ Web sayfası</button>
        <button className="btn small" onClick={() => setEdit(blank("videos"))}>＋ YouTube video listesi</button>
      </div>
      {edit && (
        <WebAppDialog
          childId={childId}
          value={edit}
          onClose={() => setEdit(null)}
          onSaved={() => { setEdit(null); load(); onChanged(); }}
        />
      )}
    </div>
  );
}

function Toggle({ label, hint, value, onChange }: { label: string; hint?: string; value: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="web-toggle">
      <input type="checkbox" checked={value} onChange={(e) => onChange(e.target.checked)} />
      <span><b>{label}</b>{hint && <span className="muted tiny"> · {hint}</span>}</span>
    </label>
  );
}

function WebAppDialog({ childId, value, onClose, onSaved }: { childId: string; value: Partial<WebApp>; onClose: () => void; onSaved: () => void }) {
  const fam = useFamily();
  const [w, setW] = useState<Partial<WebApp>>(value);
  const [domains, setDomains] = useState((value.allowed_domains ?? []).join("\n"));
  const [link, setLink] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [visits, setVisits] = useState<Visit[] | null>(null);
  const isVideos = w.kind === "videos";
  const set = (p: Partial<WebApp>) => setW((x) => ({ ...x, ...p }));

  useEffect(() => {
    if (!value.id) return;
    supabase.from("web_visits").select("id,url,title,blocked,at").eq("web_app_id", value.id).order("at", { ascending: false }).limit(50)
      .then(({ data }) => setVisits((data ?? []) as Visit[]));
  }, [value.id]);

  async function addVideo() {
    const v = parseYouTube(link);
    if (!v) { setErr("YouTube video ya da oynatma listesi linki değil"); return; }
    if ((w.videos ?? []).some((x) => x.id === v.id)) { setErr("Bu video zaten listede"); return; }
    setErr("");
    setLink("");
    const tmp = { ...v, title: "…" };
    set({ videos: [...(w.videos ?? []), tmp] });
    const title = await videoTitle(v);
    setW((x) => ({ ...x, videos: (x.videos ?? []).map((y) => (y.id === v.id ? { ...v, title } : y)) }));
  }

  function move(i: number, d: number) {
    const a = [...(w.videos ?? [])];
    const j = i + d;
    if (j < 0 || j >= a.length) return;
    [a[i], a[j]] = [a[j], a[i]];
    set({ videos: a });
  }

  async function save() {
    const title = (w.title ?? "").trim() || (isVideos ? "Videolar" : hostOf(w.url ?? ""));
    if (!isVideos && !hostOf(w.url ?? "").includes(".")) { setErr("Geçerli bir adres yaz (ör. antolin.de)"); return; }
    if (isVideos && !(w.videos ?? []).length) { setErr("En az bir video ekle"); return; }
    setBusy(true);
    const url = isVideos ? null : (w.url ?? "").trim().includes("://") ? (w.url ?? "").trim() : `https://${(w.url ?? "").trim()}`;
    const row = {
      kind: w.kind, title, url,
      allowed_domains: domains.split(/[\s,]+/).map((d) => hostOf(d)).filter((d) => d.includes(".")),
      videos: w.videos ?? [], autoplay: !!w.autoplay, loop: !!w.loop, strict: !!w.strict, history: !!w.history, downloads: !!w.downloads,
      media: !!w.media, fullscreen: !!w.fullscreen, safe_search: !!w.safe_search, remember_login: !!w.remember_login, login_mode: w.login_mode ?? "auto",
      updated_at: new Date().toISOString(),
    };
    const { error } = value.id
      ? await supabase.from("web_apps").update(row).eq("id", value.id)
      : await supabase.from("web_apps").insert({ ...row, family_id: fam.familyId, child_id: childId });
    setBusy(false);
    if (error) { setErr(errorText(error)); return; }
    onSaved();
  }

  async function remove() {
    if (!value.id || !confirm(`“${value.title}” silinsin mi? Telefondan da kalkar.`)) return;
    const { error } = await supabase.from("web_apps").delete().eq("id", value.id);
    if (error) { setErr(errorText(error)); return; }
    onSaved();
  }

  async function allowHost(h: string) {
    const list = domains.split(/[\s,]+/).filter(Boolean);
    if (!list.includes(h)) setDomains([...list, h].join("\n"));
  }

  return createPortal(
    <>
      <div className="pop-backdrop sheet-like" onClick={onClose} />
      <div className="lock-pop sheet-pop web-dialog" role="dialog" aria-label="Web sayfası">
        <b className="sheet-pop-title">{value.id ? "Düzenle" : isVideos ? "YouTube video listesi" : "Web sayfası"}</b>
        <div className="stack" style={{ gap: 10 }}>
          <label className="field"><span>Ad</span>
            <input value={w.title ?? ""} onChange={(e) => set({ title: e.target.value })} placeholder={isVideos ? "Bilim videoları" : "Antolin"} />
          </label>

          {!isVideos && (
            <>
              <label className="field"><span>Adres</span>
                <input value={w.url ?? ""} onChange={(e) => set({ url: e.target.value })} placeholder="https://antolin.de" inputMode="url" autoCapitalize="off" />
              </label>
              <label className="field"><span>İzinli ek siteler <span className="muted tiny">(her satıra bir; ör. giriş sayfası accounts.google.com)</span></span>
                <textarea rows={2} value={domains} onChange={(e) => setDomains(e.target.value)} placeholder="westermann.de" autoCapitalize="off" />
              </label>
            </>
          )}

          {isVideos && (
            <div className="stack" style={{ gap: 6 }}>
              <div className="row gap-s">
                <input className="grow" value={link} onChange={(e) => setLink(e.target.value)} placeholder="YouTube linkini yapıştır" onKeyDown={(e) => e.key === "Enter" && addVideo()} autoCapitalize="off" />
                <button className="btn small" onClick={addVideo}>Ekle</button>
              </div>
              <span className="muted tiny">Video ya da oynatma listesi linki olur. Liste eklenirse içindeki videolar sırayla oynar.</span>
              {(w.videos ?? []).map((v, i) => (
                <div className="web-video" key={v.id}>
                  {v.type === "video" ? <img src={`https://i.ytimg.com/vi/${v.id}/default.jpg`} alt="" /> : <span className="web-ico videos">📃</span>}
                  <span className="grow small">{i + 1}. {v.title || v.id}</span>
                  <button className="link-btn" onClick={() => move(i, -1)} aria-label="Yukarı">▲</button>
                  <button className="link-btn" onClick={() => move(i, 1)} aria-label="Aşağı">▼</button>
                  <button className="link-btn danger" onClick={() => set({ videos: (w.videos ?? []).filter((x) => x.id !== v.id) })} aria-label="Sil">✕</button>
                </div>
              ))}
              <Toggle label="Sırayla otomatik oynat" value={!!w.autoplay} onChange={(v) => set({ autoplay: v })} />
              <Toggle label="Bitince başa dön" value={!!w.loop} onChange={(v) => set({ loop: v })} />
            </div>
          )}

          <details className="web-more" open={!value.id}>
            <summary><b>Site ayarları</b></summary>
            <div className="stack" style={{ gap: 6, marginTop: 8 }}>
              {!isVideos && <Toggle label="🛡 Sıkı mod" hint="sadece izinli sitelerden içerik; reklamlar kaybolur" value={!!w.strict} onChange={(v) => set({ strict: v })} />}
              <Toggle label="📜 Ziyaret geçmişi" hint="açılan sayfalar aşağıda görünür" value={!!w.history} onChange={(v) => set({ history: v })} />
              {!isVideos && <Toggle label="⬇ Dosya indirme" value={!!w.downloads} onChange={(v) => set({ downloads: v })} />}
              {!isVideos && <Toggle label="🎤 Kamera / mikrofon" hint="online ders için" value={!!w.media} onChange={(v) => set({ media: v })} />}
              <Toggle label="🎬 Tam ekran video" value={!!w.fullscreen} onChange={(v) => set({ fullscreen: v })} />
              {!isVideos && <Toggle label="🔍 Güvenli arama" hint="Google, Bing, DuckDuckGo" value={!!w.safe_search} onChange={(v) => set({ safe_search: v })} />}
              <Toggle label="🍪 Girişi hatırla" hint="kapalıysa her açılışta çıkış yapılmış olur" value={!!w.remember_login} onChange={(v) => set({ remember_login: v })} />
              {!isVideos && (
                <label className="field"><span>🔑 Kasadan giriş <span className="muted tiny">(Kasa'daki kaydın web sitesi alanı bu siteyle aynı olmalı)</span></span>
                  <select value={w.login_mode ?? "auto"} onChange={(e) => set({ login_mode: e.target.value as WebApp["login_mode"] })}>
                    <option value="auto">Otomatik giriş (doldur ve gönder)</option>
                    <option value="fill">Doldur, çocuk "Giriş"e bassın</option>
                    <option value="off">Kapalı</option>
                  </select>
                </label>
              )}
              <p className="muted tiny" style={{ margin: 0 }}>
                Doğrulama ya da ilk giriş için panelden ebeveyn modunu aç: o sürede kısıtlar kalkar, girişi yap; sonra site girişi hatırlar.
              </p>
            </div>
          </details>

          {visits && visits.length > 0 && (
            <details className="web-more">
              <summary><b>Son ziyaretler ({visits.length})</b></summary>
              <div className="web-visits">
                {visits.map((v) => (
                  <div key={v.id} className={`web-visit${v.blocked ? " blocked" : ""}`}>
                    <span className="muted tiny">{new Date(v.at).toLocaleString("tr-TR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}</span>
                    <span className="small">{v.blocked ? "🚫 " : ""}{v.title || v.url}</span>
                    {v.blocked && !isVideos && <button className="link-btn" onClick={() => allowHost(hostOf(v.url))}>＋ {hostOf(v.url)} izin ver</button>}
                  </div>
                ))}
              </div>
            </details>
          )}

          {err && <p className="error">{err}</p>}
          <div className="row between">
            {value.id ? <button className="btn ghost small danger" onClick={remove}>Sil</button> : <span />}
            <div className="row gap-s">
              <button className="btn ghost small" onClick={onClose}>Vazgeç</button>
              <button className="btn small" disabled={busy} onClick={save}>{busy ? "Kaydediliyor…" : "Kaydet"}</button>
            </div>
          </div>
        </div>
      </div>
    </>,
    document.body,
  );
}
