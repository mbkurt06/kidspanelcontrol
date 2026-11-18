// Orbit — OneDrive bağlantısı ve kanıt dosyaları.
// Dosyalar ebeveynin OneDrive'ında: Uygulamalar > Orbit > <çocuk> > <tarih>
//
// GET  ?code=…&state=…         Microsoft giriş dönüşü (bağlantıyı kaydeder, panele geri yönlendirir)
// POST {action:"setup"}        ebeveyn: uygulama kimliği + gizli anahtar
// POST {action:"start"}        ebeveyn: Microsoft giriş adresi
// POST {action:"disconnect"}   ebeveyn
// POST {action:"urls"}         ebeveyn: kanıt yolları → oynatılabilir/görüntülenebilir geçici adresler
// POST {action:"session"}      telefon: büyük dosya yükleme oturumu (parça parça, kaldığı yerden); folder verilirse o klasöre
// POST {action:"delete"}       sunucu (x-orbit-hook): silinecek öğeler
// POST {action:"video_session"} ebeveyn: video yükleme oturumu (Videolar/<liste>/<dosya>); tarayıcı parça parça yükler
// POST {action:"video_url"}    telefon: videonun geçici indirme adresi (ailesinin videosu)
// POST {action:"video_delete"} ebeveyn: videoyu OneDrive'dan sil
import { createClient } from "npm:@supabase/supabase-js@2";

const SB = Deno.env.get("SUPABASE_URL")!;
const ANON = Deno.env.get("SUPABASE_ANON_KEY")!;
const admin = createClient(SB, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false }, db: { schema: "orbit" } });
const SELF = `${SB}/functions/v1/orbit-onedrive`;
const AUTH = "https://login.microsoftonline.com/consumers/oauth2/v2.0";
const SCOPE = "offline_access Files.ReadWrite.AppFolder User.Read";
const GRAPH = "https://graph.microsoft.com/v1.0";
const PANEL = "https://orbit-panel-nu.vercel.app";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-orbit-hook, x-orbit-device",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};
class HttpErr extends Error { constructor(public status: number, msg: string) { super(msg); } }
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { ...cors, "Content-Type": "application/json" } });

function asUser(req: Request) {
  const h = req.headers.get("Authorization");
  if (!h) throw new HttpErr(401, "no_auth");
  // Ebeveyn cihaz doğrulaması (onaylı cihaz) bu başlıkla yapılır
  const headers: Record<string, string> = { Authorization: h };
  const dev = req.headers.get("x-orbit-device");
  if (dev) headers["x-orbit-device"] = dev;
  return createClient(SB, ANON, { global: { headers }, auth: { persistSession: false }, db: { schema: "orbit" } });
}
async function parentFamily(req: Request): Promise<string> {
  const { data, error } = await asUser(req).rpc("parent_family");
  if (error || !data) throw new HttpErr(403, "not_parent");
  return data as string;
}
async function device(req: Request): Promise<{ child_id: string; family_id: string; child_name: string }> {
  const { data, error } = await asUser(req).rpc("device_whoami");
  if (error || !data) throw new HttpErr(403, "not_device");
  return data as { child_id: string; family_id: string; child_name: string };
}

export async function accessToken(fam: string): Promise<string> {
  const { data: c } = await admin.from("cloud_storage").select("*").eq("family_id", fam).maybeSingle();
  if (!c?.refresh_token) throw new HttpErr(409, "not_connected");
  if (c.access_token && c.access_expires && new Date(c.access_expires).getTime() > Date.now() + 60_000) return c.access_token;
  const r = await fetch(`${AUTH}/token`, {
    method: "POST",
    body: new URLSearchParams({ client_id: c.client_id, client_secret: c.client_secret, grant_type: "refresh_token", refresh_token: c.refresh_token, scope: SCOPE, redirect_uri: SELF }),
  });
  const j = await r.json();
  if (!r.ok) throw new HttpErr(502, `token_failed: ${j.error_description ?? j.error ?? r.status}`);
  await admin.from("cloud_storage").update({
    access_token: j.access_token,
    access_expires: new Date(Date.now() + (Number(j.expires_in ?? 3600) - 60) * 1000).toISOString(),
    refresh_token: j.refresh_token ?? c.refresh_token,
    updated_at: new Date().toISOString(),
  }).eq("family_id", fam);
  return j.access_token;
}

const itemId = (path: string) => path.split("/od:")[1] ?? null;
const safe = (s: string) => s.replace(/[\\/:*?"<>|#%]+/g, "-").trim() || "dosya";

async function callback(u: URL): Promise<Response> {
  const state = u.searchParams.get("state") ?? "";
  const { data: c } = await admin.from("cloud_storage").select("*").eq("state", state).maybeSingle();
  const back = (q: string) => Response.redirect(`${c?.return_to || `${PANEL}/settings`}${q}`, 302);
  if (!c || !state) return Response.redirect(`${PANEL}/settings?onedrive=error&reason=state`, 302);
  if (c.state_expires && new Date(c.state_expires).getTime() < Date.now()) return back("?onedrive=error&reason=expired");
  const err = u.searchParams.get("error");
  if (err) return back(`?onedrive=error&reason=${encodeURIComponent(err)}`);
  const r = await fetch(`${AUTH}/token`, {
    method: "POST",
    body: new URLSearchParams({ client_id: c.client_id, client_secret: c.client_secret, grant_type: "authorization_code", code: u.searchParams.get("code") ?? "", redirect_uri: SELF, scope: SCOPE }),
  });
  const j = await r.json();
  if (!r.ok) return back(`?onedrive=error&reason=${encodeURIComponent(j.error_description ?? j.error ?? "token")}`);
  let account: string | null = null;
  const me = await fetch(`${GRAPH}/me`, { headers: { Authorization: `Bearer ${j.access_token}` } });
  if (me.ok) { const m = await me.json(); account = m.userPrincipalName ?? m.mail ?? m.displayName ?? null; }
  // Uygulama klasörünü oluştur (ilk erişimde Microsoft açar)
  await fetch(`${GRAPH}/me/drive/special/approot`, { headers: { Authorization: `Bearer ${j.access_token}` } });
  await admin.from("cloud_storage").update({
    refresh_token: j.refresh_token, access_token: j.access_token,
    access_expires: new Date(Date.now() + (Number(j.expires_in ?? 3600) - 60) * 1000).toISOString(),
    account, state: null, state_expires: null, connected_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  }).eq("family_id", c.family_id);
  return back("?onedrive=ok");
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const u = new URL(req.url);
    if (req.method === "GET") return await callback(u);
    const body = await req.json().catch(() => ({}));
    const action = body.action as string;

    if (action === "setup") {
      const fam = await parentFamily(req);
      const id = String(body.client_id ?? "").trim();
      const secret = String(body.client_secret ?? "").trim();
      if (!/^[0-9a-f-]{36}$/i.test(id) || secret.length < 10) throw new HttpErr(400, "bad_credentials");
      await admin.from("cloud_storage").upsert({ family_id: fam, client_id: id, client_secret: secret, updated_at: new Date().toISOString() });
      return json({ ok: true });
    }
    if (action === "start") {
      const fam = await parentFamily(req);
      const { data: c } = await admin.from("cloud_storage").select("client_id").eq("family_id", fam).maybeSingle();
      if (!c?.client_id) throw new HttpErr(409, "not_configured");
      const state = crypto.randomUUID();
      const ret = typeof body.return_to === "string" && body.return_to.startsWith("https://") ? body.return_to : `${PANEL}/settings`;
      await admin.from("cloud_storage").update({ state, state_expires: new Date(Date.now() + 15 * 60_000).toISOString(), return_to: ret }).eq("family_id", fam);
      const q = new URLSearchParams({ client_id: c.client_id, response_type: "code", redirect_uri: SELF, response_mode: "query", scope: SCOPE, state, prompt: "select_account" });
      return json({ url: `${AUTH}/authorize?${q}` });
    }
    if (action === "disconnect") {
      const fam = await parentFamily(req);
      await admin.from("cloud_storage").update({ refresh_token: null, access_token: null, access_expires: null, account: null, connected_at: null }).eq("family_id", fam);
      return json({ ok: true });
    }
    if (action === "urls") {
      const fam = await parentFamily(req);
      const paths: string[] = Array.isArray(body.paths) ? body.paths.slice(0, 200) : [];
      const token = await accessToken(fam);
      const out: Record<string, string | null> = {};
      const thumbs: Record<string, string | null> = {};
      await Promise.all(paths.map(async (p) => {
        const id = itemId(p);
        if (!id || !p.startsWith(`${fam}/`)) { out[p] = null; return; }
        // Küçük resim de istenir: panelde ızgara hızlı açılsın, tam boy sadece büyütünce
        const r = await fetch(`${GRAPH}/me/drive/items/${encodeURIComponent(id)}?$expand=thumbnails($select=c300x300_crop,medium)`, { headers: { Authorization: `Bearer ${token}` } });
        if (!r.ok) { out[p] = null; return; }
        const j = await r.json();
        out[p] = j["@microsoft.graph.downloadUrl"] ?? null;
        const t = j.thumbnails?.[0];
        thumbs[p] = t?.c300x300_crop?.url ?? t?.medium?.url ?? null;
      }));
      return json({ urls: out, thumbs });
    }
    if (action === "session") {
      const d = await device(req);
      const token = await accessToken(d.family_id);
      const day = new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Berlin" });
      const name = safe(String(body.name ?? `kanit-${Date.now()}`));
      // İsteğe bağlı klasör (ör. notlar: "Notlar/7. sınıf/Matematik/2026-11-17 Sınav"); yoksa tarih klasörü
      const folder = typeof body.folder === "string" && body.folder.trim()
        ? String(body.folder).split("/").filter((x) => x.trim()).map((x) => safe(x)).slice(0, 6)
        : [day];
      const rel = [safe(d.child_name ?? "Çocuk"), ...folder, name].map(encodeURIComponent).join("/");
      const r = await fetch(`${GRAPH}/me/drive/special/approot:/${rel}:/createUploadSession`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ item: { "@microsoft.graph.conflictBehavior": "rename" } }),
      });
      const j = await r.json();
      if (!r.ok) throw new HttpErr(502, `session_failed: ${j.error?.message ?? r.status}`);
      return json({ upload_url: j.uploadUrl, family_id: d.family_id });
    }
    if (action === "video_session") {
      const fam = await parentFamily(req);
      const token = await accessToken(fam);
      const { data: list } = await admin.from("video_lists").select("name,family_id").eq("id", String(body.list_id ?? "")).maybeSingle();
      if (!list || list.family_id !== fam) throw new HttpErr(404, "list_not_found");
      const name = safe(String(body.name ?? `video-${Date.now()}.mp4`));
      const rel = ["Videolar", safe(list.name), name].map(encodeURIComponent).join("/");
      const r = await fetch(`${GRAPH}/me/drive/special/approot:/${rel}:/createUploadSession`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ item: { "@microsoft.graph.conflictBehavior": "rename" } }),
      });
      const j = await r.json();
      if (!r.ok) throw new HttpErr(502, `session_failed: ${j.error?.message ?? r.status}`);
      return json({ upload_url: j.uploadUrl });
    }
    if (action === "video_url") {
      const d = await device(req);
      const { data: v } = await admin.from("videos").select("item_id,family_id").eq("id", String(body.video_id ?? "")).maybeSingle();
      if (!v || v.family_id !== d.family_id || !v.item_id) throw new HttpErr(404, "video_not_found");
      const token = await accessToken(d.family_id);
      const r = await fetch(`${GRAPH}/me/drive/items/${encodeURIComponent(v.item_id)}`, { headers: { Authorization: `Bearer ${token}` } });
      const j = await r.json();
      if (!r.ok) throw new HttpErr(502, `item_failed: ${j.error?.message ?? r.status}`);
      let url: string | null = j["@microsoft.graph.downloadUrl"] ?? null;
      if (!url) {
        // Yedek: /content yönlendirmesinin adresi (ön imzalı, kısa ömürlü)
        const c = await fetch(`${GRAPH}/me/drive/items/${encodeURIComponent(v.item_id)}/content`, { headers: { Authorization: `Bearer ${token}` }, redirect: "manual" });
        url = c.headers.get("location");
      }
      if (!url) throw new HttpErr(502, "no_download_url");
      return json({ url, size: j.size });
    }
    if (action === "video_delete") {
      const fam = await parentFamily(req);
      const id = String(body.item_id ?? "");
      if (!id) throw new HttpErr(400, "no_item");
      const { data: v } = await admin.from("videos").select("family_id").eq("item_id", id).maybeSingle();
      if (v && v.family_id !== fam) throw new HttpErr(403, "forbidden");
      const token = await accessToken(fam);
      const r = await fetch(`${GRAPH}/me/drive/items/${encodeURIComponent(id)}`, { method: "DELETE", headers: { Authorization: `Bearer ${token}` } });
      return json({ ok: r.ok || r.status === 404 });
    }
    if (action === "delete") {
      const { data: cfg } = await admin.rpc("server_config");
      if (req.headers.get("x-orbit-hook") !== (cfg as Record<string, string>)?.orbit_hook_secret) throw new HttpErr(403, "forbidden");
      const paths: string[] = Array.isArray(body.paths) ? body.paths : [];
      const done: string[] = [];
      const byFam = new Map<string, string[]>();
      for (const p of paths) { const f = p.split("/")[0]; byFam.set(f, [...(byFam.get(f) ?? []), p]); }
      for (const [fam, list] of byFam) {
        let token: string;
        try { token = await accessToken(fam); } catch { continue; }
        for (const p of list) {
          const id = itemId(p);
          if (!id) { done.push(p); continue; }
          const r = await fetch(`${GRAPH}/me/drive/items/${encodeURIComponent(id)}`, { method: "DELETE", headers: { Authorization: `Bearer ${token}` } });
          if (r.ok || r.status === 404) done.push(p);
        }
      }
      return json({ deleted: done });
    }
    throw new HttpErr(400, "bad_action");
  } catch (e) {
    const status = e instanceof HttpErr ? e.status : 500;
    return json({ error: e instanceof Error ? e.message : String(e) }, status);
  }
});
