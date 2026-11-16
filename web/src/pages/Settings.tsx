import { getTheme, setTheme, type ThemeChoice } from "../lib/theme";
import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useFamily } from "../lib/family";
import { errorText, localDevice, supabase } from "../lib/supabase";
import { relTime } from "../lib/util";
import type { Device, ParentDevice } from "../lib/types";
import { Info } from "../components/Info";
import { MinuteStepper } from "../components/MinuteStepper";
import { TimeField } from "../components/DateTime";
import type { CloudStatus } from "../lib/media";
import { currentPushTypes, currentSubscription, disablePush, enablePush, isIOS, isStandalone, PUSH_EVENT_TYPES, pushSupported, updatePushTypes } from "../lib/push";
import { biometricEnabled, biometricGrace, biometricSupported, disableBiometric, registerBiometric, setBiometricGrace } from "../lib/biometric";

type Parent = { user_id: string; email: string; display_name: string };
type Invite = { email: string; display_name: string | null };
type ParentDraft = { email: string; name: string; password: string };

export default function Settings() {
  const fam = useFamily();
  const me = localDevice().id;
  const [devices, setDevices] = useState<ParentDevice[]>([]);
  const [parents, setParents] = useState<Parent[]>([]);
  const [invites, setInvites] = useState<Invite[]>([]);
  const [parentDrafts, setParentDrafts] = useState<Record<string, ParentDraft>>({});
  const [viewers, setViewers] = useState<Device[]>([]);
  const [inv, setInv] = useState({ email: "", name: "" });
  const [code, setCode] = useState("");
  const [err, setErr] = useState("");
  const [msg, setMsg] = useState("");

  const [pushOn, setPushOn] = useState(false);
  const [pushBusy, setPushBusy] = useState(false);
  const [pushTypes, setPushTypes] = useState<string[]>(PUSH_EVENT_TYPES.map(([id]) => id));
  const [pushPrefsOpen, setPushPrefsOpen] = useState(false);
  useEffect(() => {
    (async () => {
      try {
        const s = await currentSubscription();
        setPushOn(!!s);
        if (s) setPushTypes((await currentPushTypes()) ?? PUSH_EVENT_TYPES.map(([id]) => id));
      } catch (e) {
        setErr(errorText(e));
      }
    })();
  }, []);

  const load = useCallback(async () => {
    const [d, p, i, v] = await Promise.all([
      supabase.from("parent_devices").select("*").is("removed_at", null).order("created_at", { ascending: false }),
      supabase.from("parents").select("user_id, email, display_name"),
      supabase.from("allowed_parents").select("email, display_name"),
      supabase.from("devices").select("*").eq("kind", "viewer").order("created_at", { ascending: false }),
    ]);
    setDevices((d.data ?? []) as ParentDevice[]);
    setParents((p.data ?? []) as Parent[]);
    setParentDrafts(
      Object.fromEntries(
        ((p.data ?? []) as Parent[]).map((x) => [x.user_id, { email: x.email, name: x.display_name, password: "" }]),
      ),
    );
    setInvites((i.data ?? []) as Invite[]);
    setViewers((v.data ?? []) as Device[]);
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  async function setStatus(id: string, status: "approved" | "revoked") {
    if (status === "revoked" && !confirm("Bu cihazın erişimi kaldırılsın mı?")) return;
    const { error } = await supabase.rpc("set_parent_device_status", { p_device_id: id, p_status: status });
    if (error) setErr(errorText(error));
    load();
  }

  async function removeDevice(id: string) {
    if (!confirm("Bu cihaz listeden tamamen silinsin mi?")) return;
    const { error } = await supabase.rpc("delete_parent_device", { p_device_id: id });
    if (error) setErr(errorText(error));
    load();
  }

  async function invite() {
    setErr("");
    setMsg("");
    const { error } = await supabase.rpc("invite_parent", { p_email: inv.email, p_name: inv.name || null });
    if (error) return setErr(errorText(error));
    setMsg(`${inv.email} davet edildi. Orbit'i açıp bu e-postayla hesap oluşturabilir; ilk cihazını buradan onaylarsın.`);
    setInv({ email: "", name: "" });
    load();
  }

  async function saveParent(userId: string) {
    const draft = parentDrafts[userId];
    if (!draft?.email || !draft.name.trim()) return setErr("E-posta ve ad zorunlu.");
    if (draft.password && draft.password.length < 6) return setErr("Parola en az 6 karakter olmalı.");
    setErr("");
    setMsg("");
    const { data, error } = await supabase.functions.invoke("orbit-admin-account", {
      body: { user_id: userId, email: draft.email, name: draft.name, password: draft.password || undefined },
    });
    if (error) return setErr(error.message);
    if (!data?.ok) return setErr(data?.error ?? "Ebeveyn hesabı güncellenemedi.");
    setMsg("Ebeveyn hesabı güncellendi.");
    load();
  }

  const parentName = (uid: string) => parents.find((p) => p.user_id === uid)?.display_name ?? "";
  const joined = new Set(parents.map((p) => p.email));

  return (
    <div className="page">
      <header className="page-head">
        <h1>Panel Ayarları</h1>
      </header>
      {err && <p className="error">{err}</p>}
      {msg && <p className="ok">{msg}</p>}

      <DayEndCard />
      <OneDriveCard />
      <UpdateTokenCard familyId={fam.familyId} />
      <ThemeCard />
      <BiometricCard />

      <div className="card">
        <h2>Bildirimler <Info>Görev, süre, uygulama ve telefon durumlarıyla ilgili bildirimleri bu cihazda yönetirsin.</Info></h2>
        {!pushSupported() || (isIOS() && !isStandalone()) ? (
          <p className="muted tiny">Bildirimleri açmak için paneli iPhone ana ekranından açman gerekir.</p>
        ) : (
          <>
            <div className="row gap-s wrap">
              {pushOn ? (
                <>
                  <span className="pill">Bu cihazda açık</span>
                  <button
                    className="btn small"
                    disabled={pushBusy}
                    onClick={async () => {
                      setPushBusy(true);
                      setErr("");
                      const { data: u } = await supabase.auth.getUser();
                      const { error } = await supabase.from("events").insert({ family_id: fam.familyId, type: "push_test", payload: { by: u.user?.email } });
                      if (error) setErr(errorText(error));
                      else setMsg("Deneme bildirimi gönderildi. iPhone'da birkaç saniye içinde görünmeli.");
                      setPushBusy(false);
                    }}
                  >
                    Deneme gönder
                  </button>
                  <button
                    className="btn small ghost"
                    disabled={pushBusy}
                    onClick={async () => {
                      setPushBusy(true);
                      await disablePush();
                      setPushOn(false);
                      setPushBusy(false);
                    }}
                  >
                    Kapat
                  </button>
                </>
              ) : (
                <button
                  className="btn primary"
                  disabled={pushBusy}
                  onClick={async () => {
                    setPushBusy(true);
                    setErr("");
                    try {
                      await enablePush(fam.familyId!);
                      setPushOn(true);
                      setPushTypes((await currentPushTypes()) ?? PUSH_EVENT_TYPES.map(([id]) => id));
                      setMsg("Bildirimler açıldı");
                    } catch (e) {
                      setErr(errorText(e));
                    }
                    setPushBusy(false);
                  }}
                >
                  Bildirimleri aç
                </button>
              )}
            </div>
            {pushOn && (
              <div className="stack gap-s">
                <button className="section-toggle" aria-expanded={pushPrefsOpen} onClick={() => setPushPrefsOpen((v) => !v)}>
                  Bildirim türleri <span className={`collapse-arrow${pushPrefsOpen ? " open" : ""}`} aria-hidden="true" />
                </button>
                {pushPrefsOpen && (
                  <div className="card soft">
                    <div className="grid2">
                      {PUSH_EVENT_TYPES.map(([id, label]) => (
                        <label className="check" key={id}>
                          <input
                            type="checkbox"
                            checked={pushTypes.includes(id)}
                            onChange={(e) => setPushTypes((old) => e.target.checked ? [...new Set([...old, id])] : old.filter((x) => x !== id))}
                          />
                          {label}
                        </label>
                      ))}
                    </div>
                    <button
                      className="btn small"
                      disabled={pushBusy}
                      onClick={async () => {
                        setPushBusy(true);
                        setErr("");
                        try {
                          await updatePushTypes(pushTypes);
                          setMsg("Bildirim tercihleri kaydedildi.");
                        } catch (e) {
                          setErr(errorText(e));
                        }
                        setPushBusy(false);
                      }}
                    >
                      Kaydet
                    </button>
                  </div>
                )}
              </div>
            )}
          </>
        )}
      </div>

      <div className="card">
        <h2>Ebeveyn cihazları <Info>Paneli yalnızca onaylı cihazlar açabilir. Kaybolan bir cihazın erişimini buradan kaldırabilirsin.</Info></h2>
        {devices.map((d) => (
          <div className="app-row" key={d.id}>
            <div className="grow">
              <b>
                {d.label}
                {d.id === me ? " · bu cihaz" : ""}
              </b>
              <div className="muted tiny">
                {parentName(d.user_id)} · {d.status === "approved" ? `son görülme ${relTime(d.last_seen_at)}` : d.status === "pending" ? "onay bekliyor" : "erişimi kaldırıldı"}
              </div>
            </div>
            {d.status === "pending" && (
              <button className="btn small primary" onClick={() => setStatus(d.id, "approved")}>
                Onayla
              </button>
            )}
            {d.status !== "revoked" && d.id !== me && (
              <button className="btn small danger-text" onClick={() => setStatus(d.id, "revoked")}>
                Kaldır
              </button>
            )}
            {d.status === "revoked" && (
              <>
                <button className="btn small" onClick={() => setStatus(d.id, "approved")}>
                  Geri ver
                </button>
                <button className="btn small danger-text" onClick={() => removeDevice(d.id)}>
                  Sil
                </button>
              </>
            )}
          </div>
        ))}
      </div>

      <div className="card">
        <h2>Ebeveyn hesapları <Info>İki ebeveyn hesabının görünen adını, e-posta adresini ve parolasını buradan güncelleyebilirsin.</Info></h2>
        {parents.map((p) => {
          const draft = parentDrafts[p.user_id] ?? { email: p.email, name: p.display_name, password: "" };
          return (
            <div className="parent-account" key={p.user_id}>
              <div className="muted small">{p.display_name} · {p.email}</div>
              <div className="grid2">
                <label className="field">
                  <span>E-posta</span>
                  <input
                    type="email"
                    value={draft.email}
                    onChange={(e) => setParentDrafts({ ...parentDrafts, [p.user_id]: { ...draft, email: e.target.value } })}
                  />
                </label>
                <label className="field">
                  <span>Ad</span>
                  <input
                    value={draft.name}
                    onChange={(e) => setParentDrafts({ ...parentDrafts, [p.user_id]: { ...draft, name: e.target.value } })}
                  />
                </label>
              </div>
              <div className="row gap-s">
                <label className="field grow">
                  <span>Yeni parola</span>
                  <input
                    type="password"
                    autoComplete="new-password"
                    placeholder="Değiştirmek için yaz"
                    value={draft.password}
                    onChange={(e) => setParentDrafts({ ...parentDrafts, [p.user_id]: { ...draft, password: e.target.value } })}
                  />
                </label>
                <button className="btn small" onClick={() => saveParent(p.user_id)}>
                  Kaydet
                </button>
              </div>
            </div>
          );
        })}
        <h3>Ebeveyn daveti</h3>
        {invites.map((i) => (
          <div className="app-row" key={i.email}>
            <div className="grow">
              <b>{i.display_name ?? i.email}</b>
              <div className="muted tiny">
                {i.email} · {joined.has(i.email) ? "katıldı" : "davet edildi"}
              </div>
            </div>
          </div>
        ))}
        <div className="grid2">
          <label className="field">
            <span>E-posta</span>
            <input type="email" value={inv.email} onChange={(e) => setInv({ ...inv, email: e.target.value })} />
          </label>
          <label className="field">
            <span>Ad</span>
            <input value={inv.name} onChange={(e) => setInv({ ...inv, name: e.target.value })} placeholder="Anne" />
          </label>
        </div>
        <button className="btn" onClick={invite} disabled={!inv.email}>
          Davet et
        </button>
      </div>

      <div className="card">
        <h2>Noor tableti <Info>Tabletteki Orbit sayfası çocukların durumunu gösterir. Eşleştirmek için kod alıp tablete girersin.</Info></h2>
        {viewers
          .filter((v) => v.status === "active")
          .map((v) => (
            <div className="app-row" key={v.id}>
              <div className="grow">
                <b>{v.label}</b>
                <div className="muted tiny">son görülme {relTime(v.last_seen_at)}</div>
              </div>
              <button
                className="btn small danger-text"
                onClick={async () => {
                  if (!confirm("Tabletin bağlantısı kesilsin mi?")) return;
                  await supabase.from("devices").update({ status: "revoked" }).eq("id", v.id);
                  load();
                }}
              >
                Kes
              </button>
            </div>
          ))}
        {code ? (
          <div className="code">
            {code.slice(0, 4)} {code.slice(4)}
          </div>
        ) : (
          <button
            className="btn"
            onClick={async () => {
              const { data, error } = await supabase.rpc("create_pairing_code", { p_kind: "viewer", p_child_id: null });
              if (error) setErr(errorText(error));
              else setCode(String(data));
            }}
          >
            Tablet için kod al
          </button>
        )}
      </div>

      <div className="card">
        <h2>Hesap <Info>Paneli iPhone ana ekranına eklemek için Safari → Paylaş → Ana Ekrana Ekle yolunu kullan.</Info></h2>
        <button className="btn ghost" onClick={() => supabase.auth.signOut()}>
          Çıkış yap
        </button>
      </div>
      <p className="muted tiny center" title={__PANEL_BUILD__}>Orbit panel {__PANEL_VERSION__} · {fam.children.length} çocuk</p>
    </div>
  );
}

async function sha256(text: string) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Güvenlik: bütün telefonlarda geçen ebeveyn PIN'i. */
export function SecurityCard({ embedded = false }: { embedded?: boolean } = {}) {
  const fam = useFamily();
  const f = fam.family;
  const [pin, setPin] = useState("");
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");
  if (!f) return null;
  async function savePin() {
    setErr("");
    setMsg("");
    if (!/^\d{4,8}$/.test(pin)) return setErr("PIN 4–8 rakam olmalı.");
    const { error } = await supabase.from("families").update({ parent_pin_hash: await sha256(`orbit:${f!.id}:${pin}`) }).eq("id", f!.id);
    if (error) return setErr(error.message);
    setPin("");
    setMsg("PIN kaydedildi");
    fam.reload();
  }
  async function patchChild(id: string, on: boolean) {
    await supabase.from("children").update({ parent_pin_enabled: on }).eq("id", id);
    fam.reload();
  }
  return (
    <div className={embedded ? "stack" : "card"}>
      <h2 hidden={embedded}>🔐 Güvenlik · Ebeveyn PIN'i <Info>Bu PIN ile çocuk telefonunda geçici ebeveyn modu açılır. Üç yanlış denemede 5 dakika beklenir ve giriş sana bildirilir.</Info></h2>
      <div className="row gap-s">
        <input type="password" inputMode="numeric" className="grow" value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, "").slice(0, 8))} placeholder={f.parent_pin_hash ? "Yeni PIN (değiştir)" : "PIN belirle (4–8 rakam)"} />
        <button className="btn small" onClick={savePin}>
          Kaydet
        </button>
      </div>
      {err && <p className="error">{err}</p>}
      {msg && <p className="ok">{msg}</p>}
      <label className="field">
        <span>PIN ile ne kadar açık kalsın</span>
        <select
          value={f.pin_unlock_minutes}
          onChange={async (e) => {
            await supabase.from("families").update({ pin_unlock_minutes: Number(e.target.value) }).eq("id", f.id);
            fam.reload();
          }}
        >
          {[5, 15, 30, 60].map((m) => (
            <option key={m} value={m}>
              {m} dk
            </option>
          ))}
        </select>
      </label>
      <span className="small">Hangi telefonlarda geçerli</span>
      {fam.children.map((c) => (
        <label className="check" key={c.id}>
          <input type="checkbox" checked={!!c.parent_pin_enabled} disabled={!f.parent_pin_hash} onChange={(e) => patchChild(c.id, e.target.checked)} /> {c.name}
        </label>
      ))}
      {!f.parent_pin_hash && <p className="muted tiny">Önce PIN belirle.</p>}
    </div>
  );
}

function ThemeCard() {
  const [t, setT] = useState<ThemeChoice>(getTheme());
  const opts: [ThemeChoice, string][] = [
    ["auto", "Otomatik"],
    ["light", "Açık"],
    ["dark", "Gece modu"],
  ];
  return (
    <div className="card">
        <h2>Görünüm <Info>Otomatik seçenek cihazın açık/koyu ayarını izler; seçim bu cihazda saklanır.</Info></h2>
      <div className="segmented">
        {opts.map(([k, l]) => (
          <button
            key={k}
            className={t === k ? "on" : ""}
            onClick={() => {
              setT(k);
              setTheme(k);
            }}
          >
            {l}
          </button>
        ))}
      </div>
    </div>
  );
}

function ProofCard() {
  const fam = useFamily();
  const [v, setV] = useState<number | null>(null);
  useEffect(() => {
    if (!fam.familyId) return;
    supabase
      .from("families")
      .select("proof_retention_days")
      .eq("id", fam.familyId)
      .maybeSingle()
      .then(({ data }) => setV((data as { proof_retention_days: number } | null)?.proof_retention_days ?? 0));
  }, [fam.familyId]);
  async function save(n: number) {
    setV(n);
    await supabase.from("families").update({ proof_retention_days: n }).eq("id", fam.familyId);
  }
  return (
    <div className="card">
      <h2>Görev kanıtları <Info>Reddedilen denemeler seçtiğin süre boyunca saklanır; onay ekranında önceki ve sonraki denemeleri görebilirsin.</Info></h2>
      <select value={v ?? 0} onChange={(e) => save(Number(e.target.value))} disabled={v == null}>
        <option value={0}>Fotoğraflar hemen silinsin</option>
        <option value={7}>7 gün saklansın</option>
        <option value={30}>30 gün saklansın</option>
      </select>
    </div>
  );
}

const OD_REDIRECT = "https://pwxbrkbljcknstjbccwu.supabase.co/functions/v1/orbit-onedrive";

/** Kanıt dosyaları (fotoğraf, ekran görüntüsü, kamera ve ekran kaydı) ebeveynin OneDrive'ına */
function OneDriveCard() {
  const fam = useFamily();
  const [st, setSt] = useState<CloudStatus | null>(null);
  const [cid, setCid] = useState("");
  const [secret, setSecret] = useState("");
  const [edit, setEdit] = useState(false);
  const [guide, setGuide] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");
  const load = useCallback(async () => {
    const { data } = await supabase.rpc("parent_cloud_status");
    setSt(data as CloudStatus);
  }, []);
  useEffect(() => {
    load();
    const q = new URLSearchParams(window.location.search);
    const r = q.get("onedrive");
    if (r === "ok") setMsg("OneDrive bağlandı. Yeni kanıtlar artık OneDrive > Uygulamalar > Orbit klasörüne kaydedilir.");
    else if (r === "error") setErr(`OneDrive bağlanamadı: ${q.get("reason") ?? "bilinmeyen hata"}`);
    if (r) window.history.replaceState(null, "", window.location.pathname);
  }, [load]);
  async function call(body: Record<string, unknown>) {
    const { data, error } = await supabase.functions.invoke("orbit-onedrive", { body });
    if (error) {
      let m = error.message;
      try { m = (await (error as { context?: Response }).context?.json())?.error ?? m; } catch { /* */ }
      throw new Error(m);
    }
    return data as Record<string, unknown>;
  }
  async function saveKeys() {
    setErr(""); setMsg(""); setBusy(true);
    try {
      await call({ action: "setup", client_id: cid, client_secret: secret });
      setSecret(""); setEdit(false);
      await load();
      setMsg("Anahtarlar kaydedildi. Şimdi “OneDrive'ı bağla”ya bas.");
    } catch (e) { setErr(e instanceof Error && e.message === "bad_credentials" ? "Uygulama kimliği ya da gizli anahtar hatalı görünüyor." : errorText(e)); }
    setBusy(false);
  }
  async function connect() {
    setErr(""); setBusy(true);
    try {
      const d = await call({ action: "start", return_to: `${window.location.origin}/settings` });
      window.location.href = String(d.url);
    } catch (e) { setErr(errorText(e)); setBusy(false); }
  }
  async function disconnect() {
    if (!confirm("OneDrive bağlantısı kesilsin mi? Yeni kanıtlar yine Orbit'in kendi deposuna kaydedilir.")) return;
    setBusy(true);
    try { await call({ action: "disconnect" }); await load(); } catch (e) { setErr(errorText(e)); }
    setBusy(false);
  }
  async function setDays(d: number) {
    await supabase.from("families").update({ cloud_retention_days: d }).eq("id", fam.familyId);
    await load();
  }
  if (!st) return null;
  return (
    <div className="card">
      <h2>
        OneDrive <Info>Fotoğraflar, ekran görüntüleri, kamera ve ekran kayıtları OneDrive'ında “Uygulamalar &gt; Orbit &gt; çocuk adı &gt; tarih” klasörüne kaydedilir. Orbit sadece bu klasörü görür; diğer dosyalarına erişemez. Bağlı değilken kanıtlar Orbit'in kendi deposuna kaydedilir.</Info>
      </h2>
      {st.connected ? (
        <div className="stack-s">
          <div className="row gap-s"><span className="pill good">Bağlı</span><b>{st.account ?? "OneDrive"}</b></div>
          <span className="muted small">Klasör: OneDrive › Uygulamalar › Orbit</span>
          <div className="extra-row">
            <span className="muted small">Kayıtlar kaç gün saklansın</span>
            <MinuteStepper value={st.retention_days} onChange={setDays} min={1} max={45} unit="gün" label="Saklama günü" />
          </div>
          <div className="row gap-s">
            <button className="pill-btn" onClick={connect} disabled={busy}>Yeniden bağlan</button>
            <button className="pill-btn ghost" onClick={disconnect} disabled={busy}>Bağlantıyı kes</button>
          </div>
        </div>
      ) : (
        <div className="stack-s">
          {st.configured && !edit ? (
            <>
              <span className="muted small">Anahtarlar kayıtlı. Microsoft hesabınla giriş yapıp izin ver.</span>
              <div className="row gap-s">
                <button className="pill-btn primary" onClick={connect} disabled={busy}>OneDrive'ı bağla</button>
                <button className="pill-btn ghost" onClick={() => setEdit(true)}>Anahtarları değiştir</button>
              </div>
            </>
          ) : (
            <>
              <label className="field"><span>Uygulama (istemci) kimliği</span><input value={cid} onChange={(e) => setCid(e.target.value)} placeholder="00000000-0000-0000-0000-000000000000" /></label>
              <label className="field"><span>Gizli anahtar (değer)</span><input type="password" value={secret} onChange={(e) => setSecret(e.target.value)} placeholder="Azure'da oluşturduğun gizli anahtarın değeri" /></label>
              <div className="row gap-s">
                <button className="pill-btn primary" onClick={saveKeys} disabled={busy || !cid || !secret}>Kaydet</button>
                {st.configured && <button className="pill-btn ghost" onClick={() => setEdit(false)}>Vazgeç</button>}
              </div>
            </>
          )}
          <button className="section-toggle" aria-expanded={guide} onClick={() => setGuide((x) => !x)}>
            Nasıl kurulur (5 dk) <span className={`collapse-arrow${guide ? " open" : ""}`} aria-hidden="true" />
          </button>
          {guide && (
            <ol className="small guide-list">
              <li><a href="https://portal.azure.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade" target="_blank" rel="noreferrer">Azure portalında “Uygulama kayıtları”</a> sayfasını aç, OneDrive'daki Microsoft hesabınla giriş yap.</li>
              <li><b>Yeni kayıt</b>: Ad <b>Orbit</b>. Hesap türü: <b>Yalnızca kişisel Microsoft hesapları</b>.</li>
              <li>Yeniden yönlendirme URI'si: platform <b>Web</b>, adres:<br /><code className="copy" onClick={() => navigator.clipboard?.writeText(OD_REDIRECT)}>{OD_REDIRECT}</code> <span className="muted tiny">(dokununca kopyalanır)</span></li>
              <li><b>Kaydet</b>'e bas. Açılan sayfadaki <b>Uygulama (istemci) kimliği</b>'ni yukarıdaki ilk kutuya yapıştır.</li>
              <li>Soldan <b>Sertifikalar ve gizli diziler</b> → <b>Yeni istemci gizli dizisi</b> → süre 24 ay → Ekle. Çıkan <b>Değer</b>'i (Kimlik değil) ikinci kutuya yapıştır.</li>
              <li><b>Kaydet</b>, sonra <b>OneDrive'ı bağla</b>. Microsoft'un sorduğu izni onayla.</li>
            </ol>
          )}
        </div>
      )}
      {err && <p className="error">{err}</p>}
      {msg && <p className="ok">{msg}</p>}
    </div>
  );
}


function TaskPhotoDefaultsCard() {
  const fam = useFamily();
  const f = fam.family;
  const [v, setV] = useState({ beforeMin: 1, beforeMax: 4, afterMin: 1, afterMax: 4 });
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!f) return;
    setV({
      beforeMin: f.task_before_photo_min ?? 1,
      beforeMax: f.task_before_photo_max ?? 4,
      afterMin: f.task_after_photo_min ?? 1,
      afterMax: f.task_after_photo_max ?? 4,
    });
  }, [f]);

  async function save() {
    setErr("");
    setMsg("");
    const n = {
      task_before_photo_min: Math.max(1, Math.min(4, v.beforeMin)),
      task_before_photo_max: Math.max(1, Math.min(4, v.beforeMax)),
      task_after_photo_min: Math.max(1, Math.min(4, v.afterMin)),
      task_after_photo_max: Math.max(1, Math.min(4, v.afterMax)),
    };
    if (n.task_before_photo_min > n.task_before_photo_max || n.task_after_photo_min > n.task_after_photo_max) return setErr("En az değeri en fazla değerinden büyük olamaz.");
    const { error } = await supabase.from("families").update(n).eq("id", fam.familyId);
    if (error) return setErr(errorText(error));
    setMsg("Yeni görev varsayılanları kaydedildi.");
    await fam.reload();
  }

  if (!f) return null;
  return (
    <div className="card">
      <div className="section-toggle-row">
        <button className="section-toggle" aria-expanded={open} onClick={() => setOpen((x) => !x)}>
          Görev fotoğraf varsayılanları <span className={`collapse-arrow${open ? " open" : ""}`} aria-hidden="true" />
        </button>
        <Info>Yeni fotoğraflı görevlerde başlangıç ve tamamlanma aşamaları için uygulanır.</Info>
      </div>
      {open && (
        <>
          <div className="grid2">
            <label className="field"><span>Başlangıç · en az</span><input type="number" min={1} max={4} value={v.beforeMin} onChange={(e) => setV({ ...v, beforeMin: Number(e.target.value) })} /></label>
            <label className="field"><span>Başlangıç · en fazla</span><input type="number" min={1} max={4} value={v.beforeMax} onChange={(e) => setV({ ...v, beforeMax: Number(e.target.value) })} /></label>
            <label className="field"><span>Tamamlanma · en az</span><input type="number" min={1} max={4} value={v.afterMin} onChange={(e) => setV({ ...v, afterMin: Number(e.target.value) })} /></label>
            <label className="field"><span>Tamamlanma · en fazla</span><input type="number" min={1} max={4} value={v.afterMax} onChange={(e) => setV({ ...v, afterMax: Number(e.target.value) })} /></label>
          </div>
          {err && <p className="error">{err}</p>}
          {msg && <p className="ok">{msg}</p>}
          <button className="btn small" onClick={save}>Varsayılanı kaydet</button>
        </>
      )}
    </div>
  );
}

function BiometricCard() {
  const [supported, setSupported] = useState(false);
  const [enabled, setEnabled] = useState(() => biometricEnabled());
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  useEffect(() => { biometricSupported().then(setSupported); }, []);

  async function enable() {
    setBusy(true);
    setErr("");
    try {
      const { data } = await supabase.auth.getUser();
      if (!data.user) throw new Error("Oturum bulunamadı.");
      await registerBiometric({ id: data.user.id, email: data.user.email ?? "Orbit" });
      setEnabled(true);
      setMsgAndReload();
    } catch (e) {
      setErr(errorText(e));
      setBusy(false);
    }
  }

  function setMsgAndReload() {
    window.location.reload();
  }

  function disable() {
    disableBiometric();
    setEnabled(false);
  }

  return (
    <div className="card">
      <h2>Face ID ile aç <Info>Orbit ana ekrandan açıldığında cihazın Face ID/Touch ID doğrulamasını ister.</Info></h2>
      {!supported ? <p className="muted tiny">Bu cihaz veya tarayıcı platform doğrulamasını desteklemiyor.</p> : enabled ? (
        <>
          <div className="row gap-s wrap"><span className="pill">Face ID kilidi açık</span><button className="btn small ghost" onClick={disable}>Kapat</button></div>
          <GraceSelect />
        </>
      ) : <button className="btn" onClick={enable} disabled={busy}>{busy ? "Hazırlanıyor…" : "Face ID ile korumayı aç"}</button>}
      {err && <p className="error">{err}</p>}
    </div>
  );
}

/** Face ID ne zaman tekrar sorulsun (bu cihazda) */
const GRACE_PRESETS = [0, 1, 5, 15, 30, 60, 240, 1440];
function graceText(m: number) {
  if (m < 0) return "Süresiz";
  if (m === 0) return "Her açılışta";
  const d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60), mm = m % 60;
  return [d && `${d} gün`, h && `${h} sa`, mm && `${mm} dk`].filter(Boolean).join(" ") + " sonra";
}
function GraceSelect() {
  const [v, setV] = useState(biometricGrace());
  const [custom, setCustom] = useState(false);
  const [d, setD] = useState(0);
  const [h, setH] = useState(0);
  const [m, setM] = useState(0);
  const set = (n: number) => { setV(n); setBiometricGrace(n); };
  function openCustom() {
    const cur = v > 0 ? v : 120;
    setD(Math.floor(cur / 1440)); setH(Math.floor((cur % 1440) / 60)); setM(cur % 60);
    setCustom(true);
  }
  const isPreset = v < 0 || GRACE_PRESETS.includes(v);
  return (
    <>
      <label className="field">
        <span>Tekrar sorulsun <Info>Panelden çıkıp bu süre içinde geri dönersen Face ID sorulmaz. "Süresiz" seçilirse bir kez açtıktan sonra bu cihazda tekrar sorulmaz. Ayar sadece bu cihaz için.</Info></span>
        <select
          value={isPreset ? String(v) : "custom-cur"}
          onChange={(e) => (e.target.value === "custom" ? openCustom() : e.target.value !== "custom-cur" && set(Number(e.target.value)))}
        >
          {GRACE_PRESETS.map((p) => <option key={p} value={p}>{graceText(p)}</option>)}
          <option value={-1}>Süresiz (tekrar sorma)</option>
          {!isPreset && <option value="custom-cur">Özel: {graceText(v)}</option>}
          <option value="custom">Özel…</option>
        </select>
      </label>
      {custom && createPortal(
        <div className="sheet-backdrop" onClick={() => setCustom(false)}>
          <div className="sheet" onClick={(e) => e.stopPropagation()}>
            <h2>Face ID ne zaman tekrar sorulsun</h2>
            <div className="row gap-s wrap">
              <MinuteStepper value={d} onChange={setD} min={0} max={30} unit="gün" label="Gün" />
              <MinuteStepper value={h} onChange={setH} min={0} max={23} unit="sa" label="Saat" />
              <MinuteStepper value={m} onChange={setM} min={0} max={59} unit="dk" label="Dakika" />
            </div>
            <p className="muted small">Panelden çıktıktan {graceText(d * 1440 + h * 60 + m).replace(" sonra", "")} sonra tekrar sorar.</p>
            <div className="row gap-s">
              <button className="btn primary" disabled={d * 1440 + h * 60 + m <= 0} onClick={() => { set(d * 1440 + h * 60 + m); setCustom(false); }}>Kaydet</button>
              <button className="btn ghost" onClick={() => setCustom(false)}>Vazgeç</button>
            </div>
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}

/**
 * Telefon güncellemeleri gizli GitHub deposunun sürümlerinden iner. Salt okunur anahtar burada saklanır;
 * telefonlar kendi ailelerinin anahtarını alır. Anahtar yoksa yedek kurulum dosyası kullanılır.
 */
function UpdateTokenCard({ familyId }: { familyId: string | null }) {
  const [saved, setSaved] = useState<string | null>(null);
  const [val, setVal] = useState("");
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!familyId) return;
    supabase.from("family_secrets").select("update_token").eq("family_id", familyId).maybeSingle()
      .then(({ data }) => setSaved((data as { update_token: string | null } | null)?.update_token ?? null));
  }, [familyId]);
  const save = async (token: string | null) => {
    if (!familyId) return;
    setBusy(true);
    setMsg("");
    const { error } = await supabase.from("family_secrets")
      .upsert({ family_id: familyId, update_token: token, updated_at: new Date().toISOString() }, { onConflict: "family_id" });
    setBusy(false);
    if (error) setMsg(errorText(error));
    else { setSaved(token); setVal(""); setMsg(token ? "Kaydedildi · telefonlar bir sonraki kontrolde kullanır" : "Silindi"); }
  };
  return (
    <div className="card">
      <h2>Telefon güncellemeleri <Info>Telefonlar yeni Orbit sürümünü gizli GitHub deposundan indirir. GitHub'da “Fine-grained token” oluştur: sadece kidspanelcontrol deposu, izin: Contents → Read-only. Anahtarı buraya yapıştır. Anahtar yoksa ya da geçersizse telefonlar yedek kurulum dosyasını kullanır.</Info></h2>
      <p className="small">{saved ? <>GitHub anahtarı kayıtlı ✓ <span className="muted tiny">(…{saved.slice(-4)})</span></> : <span className="muted">GitHub anahtarı yok · yedek kurulum dosyası kullanılıyor</span>}</p>
      <div className="row gap-s" style={{ alignItems: "center" }}>
        <input className="grow" type="password" autoComplete="off" placeholder="github_pat_…" value={val} onChange={(e) => setVal(e.target.value)} />
        <button className="btn small" disabled={busy || val.trim().length < 20} onClick={() => save(val.trim())}>Kaydet</button>
        {saved && <button className="btn small ghost" disabled={busy} onClick={() => confirm("Güncelleme anahtarı silinsin mi?") && save(null)}>Sil</button>}
      </div>
      {msg && <p className="tiny muted">{msg}</p>}
    </div>
  );
}

/** Orbit günü bitişi: süreler bu saate kadar bekler (telefon açıkken kullanılır), kalan kasaya geçer; sayaçlar sıfırlanır */
function DayEndCard() {
  const fam = useFamily();
  const cur = (fam.family?.day_end ?? "05:00").slice(0, 5);
  const [v, setV] = useState(cur);
  const [msg, setMsg] = useState("");
  useEffect(() => setV(cur), [cur]);
  return (
    <div className="card">
      <h2>Gün bitişi <Info>O güne ait bütün süreler (günlük süre, verilen süre, görev ödülü) bu saate kadar bekler; telefon kilitli olsa da kaybolmaz, sadece telefon açıkken kullanılır. Bu saatte kalan ne varsa kasaya geçer, “bugün kullandı” sayacı ve günün görevleri yenilenir. Gece yarısından bu saate kadarki süre önceki güne sayılır.</Info></h2>
      <div className="row gap-s" style={{ alignItems: "center" }}>
        <span className="small">Gün</span>
        <TimeField value={v} onChange={setV} label="Gün bitişi" />
        <span className="small">'de biter</span>
        <button className="btn small" disabled={v === cur} onClick={async () => {
          const { error } = await supabase.from("families").update({ day_end: v }).eq("id", fam.familyId);
          if (error) { setMsg(errorText(error)); return; }
          await fam.reload();
          for (const c of fam.children) await supabase.from("commands").insert({ child_id: c.id, type: "resync", payload: {} });
          setMsg("Kaydedildi");
        }}>Kaydet</button>
        {msg && <span className="small good-text">{msg}</span>}
      </div>
    </div>
  );
}
