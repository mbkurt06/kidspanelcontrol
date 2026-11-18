import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Info } from "./Info";
import { useFamily } from "../lib/family";
import { errorText, supabase } from "../lib/supabase";
import { decryptEntry, encryptEntry, openVault, type StoredEntry, type VaultEntry } from "../lib/vault";

type Login = { child_id: string; mode: "auto" | "entry" | "off"; entry_id: string | null };
type Test = { id: string; child_id: string; status: "pending" | "running" | "ok" | "fail" | "error"; message: string | null; final_url: string | null; created_at: string; done_at: string | null };
type Kid = { state: "open" | "locked" | "none" | "loading"; key?: CryptoKey; entries: { id: string; label: string; host: string }[] };

const hostOf = (s: string) => { try { return new URL(s.includes("://") ? s : `https://${s}`).hostname.replace(/^www\./, ""); } catch { return ""; } };
const hm = (s: string) => new Date(s).toLocaleTimeString("tr-TR", { hour: "2-digit", minute: "2-digit" });

/** Web sayfası → her çocuk için kasadaki hangi giriş kullanılsın; "Telefonda dene" ile giriş denenir */
export default function WebLogins({ webAppId, siteUrl, title }: { webAppId: string; siteUrl: string; title: string }) {
  const fam = useFamily();
  const [kids, setKids] = useState<Record<string, Kid>>({});
  const [logins, setLogins] = useState<Record<string, Login>>({});
  const [tests, setTests] = useState<Record<string, Test>>({});
  const [adding, setAdding] = useState<string | null>(null);
  const [nu, setNu] = useState({ u: "", p: "" });
  const [err, setErr] = useState("");
  const site = hostOf(siteUrl);

  const loadVaults = useCallback(async () => {
    if (!fam.familyId) return;
    for (const c of fam.children) {
      setKids((k) => ({ ...k, [c.id]: { state: "loading", entries: [] } }));
      try {
        const s = await openVault(fam.familyId, c.id);
        if (s.kind !== "open") { setKids((k) => ({ ...k, [c.id]: { state: s.kind, entries: [] } })); continue; }
        const { data } = await supabase.from("vault_entries").select("id, iv, ciphertext, updated_by, updated_at").eq("child_id", c.id).is("removed_at", null);
        const entries: Kid["entries"] = [];
        for (const e of (data ?? []) as StoredEntry[]) {
          try {
            const v = await decryptEntry(s.key, e);
            if (v.kind === "wifi" || !v.password) continue;
            entries.push({ id: e.id, label: `${v.app || hostOf(v.url ?? "") || "Kayıt"}${v.username ? ` · ${v.username}` : ""}`, host: hostOf(v.url ?? "") });
          } catch { /* çözülemeyen kayıt atlanır */ }
        }
        // Bu siteye ait olanlar önce
        entries.sort((a, b) => Number(b.host === site) - Number(a.host === site) || a.label.localeCompare(b.label, "tr"));
        setKids((k) => ({ ...k, [c.id]: { state: "open", key: s.key, entries } }));
      } catch {
        setKids((k) => ({ ...k, [c.id]: { state: "locked", entries: [] } }));
      }
    }
  }, [fam.familyId, fam.children, site]);

  const loadRows = useCallback(async () => {
    const [l, t] = await Promise.all([
      supabase.from("web_app_logins").select("child_id,mode,entry_id").eq("web_app_id", webAppId),
      supabase.from("web_login_tests").select("*").eq("web_app_id", webAppId).order("created_at", { ascending: false }).limit(30),
    ]);
    if (l.error || t.error) { setErr(errorText((l.error ?? t.error)!)); return; }
    setLogins(Object.fromEntries(((l.data ?? []) as Login[]).map((x) => [x.child_id, x])));
    const last: Record<string, Test> = {};
    for (const x of (t.data ?? []) as Test[]) if (!last[x.child_id]) last[x.child_id] = x;
    setTests(last);
  }, [webAppId]);

  useEffect(() => { void loadVaults(); }, [loadVaults]);
  useEffect(() => { void loadRows(); }, [loadRows]);

  // Deneme sürerken sonucu bekle
  const waiting = Object.values(tests).some((t) => t.status === "pending" || t.status === "running");
  useEffect(() => {
    if (!waiting) return;
    const h = setInterval(() => { void loadRows(); }, 2500);
    return () => clearInterval(h);
  }, [waiting, loadRows]);

  async function choose(childId: string, v: string) {
    const row = { web_app_id: webAppId, child_id: childId, family_id: fam.familyId, mode: v === "auto" || v === "off" ? v : "entry", entry_id: v === "auto" || v === "off" ? null : v, updated_at: new Date().toISOString() };
    setLogins((l) => ({ ...l, [childId]: row as Login }));
    const { error } = await supabase.from("web_app_logins").upsert(row);
    if (error) setErr(errorText(error));
  }

  async function addEntry(childId: string) {
    const k = kids[childId];
    if (!k?.key || !nu.p) return;
    const v: VaultEntry = { app: title || site, username: nu.u.trim(), password: nu.p, recovery: "", note: "", history: [], url: siteUrl };
    const c = await encryptEntry(k.key, v);
    const { data, error } = await supabase.from("vault_entries").insert({ child_id: childId, ...c, updated_by: "parent" }).select("id").single();
    if (error) { setErr(errorText(error)); return; }
    setAdding(null);
    setNu({ u: "", p: "" });
    await loadVaults();
    await choose(childId, (data as { id: string }).id);
  }

  async function test(childId: string) {
    setErr("");
    const { data, error } = await supabase.from("web_login_tests").insert({ family_id: fam.familyId, child_id: childId, web_app_id: webAppId }).select().single();
    if (error) { setErr(errorText(error)); return; }
    setTests((t) => ({ ...t, [childId]: data as Test }));
  }

  function result(t?: Test) {
    if (!t) return null;
    const age = Date.now() - new Date(t.created_at).getTime();
    if (t.status === "pending") return <span className="muted tiny">{age > 60_000 ? "⏳ telefon yanıt vermiyor (kapalı ya da çevrimdışı olabilir)" : "⏳ telefona gönderildi…"}</span>;
    if (t.status === "running") return <span className="muted tiny">⏳ telefonda deneniyor…</span>;
    const when = hm(t.done_at ?? t.created_at);
    const cls = t.status === "ok" ? "ok tiny" : "error tiny";
    const icon = t.status === "ok" ? "✔" : t.status === "fail" ? "✖" : "⚠";
    return <span className={cls} title={t.final_url ?? ""}>{icon} {when} {t.message}{t.final_url ? ` · ${t.final_url.replace(/^https?:\/\//, "").slice(0, 60)}` : ""}</span>;
  }

  return (
    <div className="web-logins">
      <b>🔑 Giriş bilgisi</b> <Info>Her çocuk kendi şifre kasasındaki kayıtla girer. "Otomatik": kasada web sitesi bu siteyle aynı olan kayıt kullanılır. "▶ Telefonda dene": çocuğun telefonu siteyi görünmeden açar, şifreyi girer ve sonucu buraya yazar (telefon açık ve internete bağlı olmalı).</Info>
      {fam.children.map((c) => {
        const k = kids[c.id];
        const l = logins[c.id];
        const val = !l || l.mode === "auto" ? "auto" : l.mode === "off" ? "off" : l.entry_id ?? "auto";
        const missing = l?.mode === "entry" && k?.state === "open" && !k.entries.some((e) => e.id === l.entry_id);
        const t = tests[c.id];
        const busy = t && (t.status === "pending" || t.status === "running") && Date.now() - new Date(t.created_at).getTime() < 120_000;
        return (
          <div key={c.id} className="web-login-row">
            <span className="small web-login-name">{c.name}</span>
            {k?.state === "open" ? (
              <select value={adding === c.id ? "__new" : val} onChange={(e) => (e.target.value === "__new" ? setAdding(c.id) : (setAdding(null), choose(c.id, e.target.value)))}>
                <option value="auto">Otomatik (adrese göre)</option>
                {k.entries.map((e) => <option key={e.id} value={e.id}>{e.host === site ? "★ " : ""}{e.label}</option>)}
                <option value="off">Giriş yok</option>
                <option value="__new">＋ Yeni kayıt…</option>
              </select>
            ) : k?.state === "loading" || !k ? <span className="muted tiny">Kasa açılıyor…</span>
              : <span className="muted tiny">{k.state === "none" ? "Kasa yok · " : "🔒 Kasa bu cihazda kilitli · "}<Link to={`/child/${c.id}/vault`}>Şifreler</Link></span>}
            <button className="btn ghost small" disabled={!!busy || val === "off"} onClick={() => test(c.id)}>▶ Telefonda dene</button>
            <div className="web-login-res">{missing ? <span className="error tiny">Seçilen kayıt kasada yok</span> : result(t)}</div>
            {adding === c.id && (
              <div className="row gap-s web-login-new">
                <input placeholder="Kullanıcı adı / e-posta" value={nu.u} onChange={(e) => setNu({ ...nu, u: e.target.value })} />
                <input placeholder="Şifre" type="password" value={nu.p} onChange={(e) => setNu({ ...nu, p: e.target.value })} />
                <button className="btn small" disabled={!nu.p} onClick={() => addEntry(c.id)}>Kaydet</button>
                <button className="link-btn" onClick={() => setAdding(null)}>Vazgeç</button>
              </div>
            )}
          </div>
        );
      })}
      {err && <p className="error tiny">{err}</p>}
    </div>
  );
}
