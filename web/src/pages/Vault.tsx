import { sendCommand } from "../lib/actions";
import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useFamily } from "../lib/family";
import { errorText, supabase } from "../lib/supabase";
import { relTime } from "../lib/util";
import {
  createVault,
  decryptEntry,
  encryptEntry,
  generatePassword,
  openVault,
  recoverVault,
  setRecovery,
  type StoredEntry,
  type VaultEntry,
  type VaultState,
} from "../lib/vault";
import { Icon } from "../components/Icon";
import { Info } from "../components/Info";

type Row = { id: string; v: VaultEntry; updated_at: string; updated_by: string };

const blank: VaultEntry = { app: "", username: "", password: "", recovery: "", note: "", history: [] };
const blankWifi: VaultEntry = { ...blank, kind: "wifi", security: "wpa", hidden: false };
const SEC: Array<[string, string]> = [["wpa", "WPA2"], ["wpa3", "WPA3"], ["open", "Şifresiz"]];
const WIFI_DEFAULT = { child_add: true, notify: true, show_passwords: true, system_wifi: false };

export default function Vault() {
  const { id } = useParams();
  const fam = useFamily();
  const child = fam.children.find((c) => c.id === id);
  const [state, setState] = useState<VaultState | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [code, setCode] = useState("");
  const [shownCode, setShownCode] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [edit, setEdit] = useState<{ id: string | null; v: VaultEntry } | null>(null);
  const [revealed, setRevealed] = useState<Record<string, boolean>>({});
  const [q, setQ] = useState("");
  const [copied, setCopied] = useState("");
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [apps, setApps] = useState<{ package: string; label: string }[]>([]);
  useEffect(() => {
    if (!id) return;
    supabase.from("child_apps").select("package,label").eq("child_id", id).order("label").then(({ data }) => setApps((data ?? []) as { package: string; label: string }[]));
  }, [id]);
  const appName = (pkg?: string) => (pkg ? apps.find((a) => a.package === pkg)?.label ?? pkg : "");

  const load = useCallback(async () => {
    if (!fam.familyId || !id) return;
    setErr("");
    try {
      const s = await openVault(fam.familyId, id);
      setState(s);
      if (s.kind === "open") {
        const { data } = await supabase
          .from("vault_entries")
          .select("id, iv, ciphertext, updated_by, updated_at")
          .eq("child_id", id)
          .is("removed_at", null)
          .order("updated_at", { ascending: false });
        const out: Row[] = [];
        for (const e of (data ?? []) as StoredEntry[]) {
          try {
            out.push({ id: e.id, v: await decryptEntry(s.key, e), updated_at: e.updated_at, updated_by: e.updated_by });
          } catch {
            /* çözülemeyen kayıt atlanır */
          }
        }
        out.sort((a, b) => a.v.app.localeCompare(b.v.app, "tr"));
        setRows(out);
      }
    } catch (e) {
      setErr(errorText(e));
    }
  }, [fam.familyId, id]);

  useEffect(() => {
    load();
  }, [load]);

  // Anahtar yoksa çocuğun telefonundan hemen paylaşmasını iste (canlı bağlantıyla birkaç saniyede gelir) ve bekle
  const [asking, setAsking] = useState(false);
  const askPhone = useCallback(async () => {
    if (!id) return;
    setAsking(true);
    await sendCommand(id, "resync", { vault: true }).catch(() => {});
  }, [id]);
  const locked = state?.kind === "locked";
  useEffect(() => {
    if (!locked) {
      setAsking(false);
      return;
    }
    askPhone();
    let n = 0;
    const t = setInterval(() => {
      if (++n > 24) {
        clearInterval(t);
        setAsking(false);
        return;
      }
      load();
    }, 5000);
    return () => clearInterval(t);
  }, [locked, askPhone, load]);

  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setErr("");
    try {
      await fn();
    } catch (e) {
      setErr(errorText(e));
    }
    setBusy(false);
  }

  async function save() {
    if (!edit || state?.kind !== "open" || !id) return;
    const v = { ...edit.v, app: edit.v.app.trim() };
    const isWifi = v.kind === "wifi";
    if (!v.app) return setErr(isWifi ? "Ağ adını yaz." : "Uygulama veya site adını yaz.");
    if (isWifi && v.security !== "open" && v.password.length < 8) return setErr("Wi-Fi şifresi en az 8 karakter olmalı.");
    await run(async () => {
      const prev = rows.find((r) => r.id === edit.id);
      if (prev && prev.v.password && prev.v.password !== v.password) {
        v.history = [{ password: prev.v.password, changed_at: new Date().toISOString() }, ...prev.v.history].slice(0, 10);
      }
      const c = await encryptEntry(state.key, v);
      const now = new Date().toISOString();
      const { error } = edit.id
        ? await supabase.from("vault_entries").update({ ...c, updated_by: "parent", updated_at: now }).eq("id", edit.id)
        : await supabase.from("vault_entries").insert({ child_id: id, ...c, updated_by: "parent" });
      if (error) throw error;
      setEdit(null);
      if (isWifi) await sendCommand(id, "resync", { wifi: true }).catch(() => {});
      await load();
    });
  }

  const wifiSet = { ...WIFI_DEFAULT, ...(child?.wifi_settings ?? {}) };
  async function setWifi(k: keyof typeof WIFI_DEFAULT, val: boolean) {
    if (!child) return;
    await run(async () => {
      const { error } = await supabase.from("children").update({ wifi_settings: { ...wifiSet, [k]: val } }).eq("id", child.id);
      if (error) throw error;
      await sendCommand(child.id, "resync", {}).catch(() => {});
      await fam.reload();
    });
  }

  async function copy(text: string, what: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(what);
      setTimeout(() => setCopied(""), 1500);
    } catch {
      setErr("Kopyalanamadı");
    }
  }

  if (!child) return <div className="page"><p className="muted">Çocuk bulunamadı.</p></div>;
  const wifiRows = rows.filter((r) => r.v.kind === "wifi");
  const appRows = rows.filter((r) => r.v.kind !== "wifi");

  const header = (
    <header className="page-head">
      <Link to={`/child/${child.id}`} className="icon-btn" aria-label="Geri">
        <Icon name="back" />
      </Link>
      <h1>{child.name} · Şifreler</h1>
      <span />
    </header>
  );

  if (shownCode)
    return (
      <div className="page">
        {header}
        <div className="card attention">
          <h2>Kurtarma kodu</h2>
          <p className="small">
            Bu kodu bir kâğıda yaz veya parola yöneticine kaydet. Tüm cihazların kaybolursa kasayı sadece bu kodla açabilirsin. Kod bir
            daha gösterilmez.
          </p>
          <div className="code small-code">{shownCode}</div>
          <button className="btn" onClick={() => copy(shownCode, "code")}>
            {copied === "code" ? "Kopyalandı" : "Kopyala"}
          </button>
          <button
            className="btn primary"
            onClick={() => {
              setShownCode("");
              load();
            }}
          >
            Yazdım, devam et
          </button>
        </div>
      </div>
    );

  return (
    <div className="page">
      {header}
      {err && <p className="error">{err}</p>}
      {!state && <p className="muted">Açılıyor…</p>}

      {state?.kind === "none" && (
        <div className="card">
          <h2>Kasa henüz yok</h2>
          <p className="muted small">
            {child.name} için şifre kasası oluştur. Şifreler bu cihazda şifrelenir; sunucu dahil kimse içeriği okuyamaz. Kasa
            onaylı ebeveyn cihazlarıyla ve {child.name}'in telefonuyla otomatik paylaşılır.
          </p>
          <button className="btn primary" disabled={busy} onClick={() => run(async () => setShownCode(await createVault(fam.familyId!, child.id)))}>
            Kasayı oluştur
          </button>
        </div>
      )}

      {state?.kind === "locked" && (
        <div className="card">
          <h2>Bu cihazda kasa anahtarı yok</h2>
          <p className="muted small">
            {asking
              ? `${child.name}'in telefonundan anahtar isteniyor… Telefon açık ve internete bağlıysa birkaç saniye içinde açılır.`
              : `Anahtar ${child.name}'in telefonundan bu cihaza paylaşılır. Telefon kapalı ya da internetsizse açılınca gelir; beklemek istemezsen kurtarma kodunu gir.`}
          </p>
          {state.hasRecovery ? (
            <>
              <label className="field">
                <span>Kurtarma kodu</span>
                <input value={code} onChange={(e) => setCode(e.target.value)} placeholder="XXXX-XXXX-XXXX-XXXX-XXXX" autoCapitalize="characters" />
              </label>
              <button className="btn primary" disabled={busy || !code} onClick={() => run(async () => { await recoverVault(fam.familyId!, child.id, code); setCode(""); await load(); })}>
                Kasayı aç
              </button>
            </>
          ) : (
            <p className="muted small">Bu kasa için henüz kurtarma kodu oluşturulmamış.</p>
          )}
          <button
            className="btn ghost"
            onClick={async () => {
              await askPhone();
              load();
            }}
          >
            Tekrar dene
          </button>
        </div>
      )}

      {state?.kind === "open" && (
        <>
          {!state.hasRecovery && (
            <div className="card attention">
              <h2>Kurtarma kodu yok</h2>
              <p className="muted small"><Info>Kasa {child.name}'in telefonunda oluşturulmuş. Tüm cihazlar kaybolursa diye bir kurtarma kodu oluştur.</Info></p>
              <button className="btn primary" disabled={busy} onClick={() => run(async () => setShownCode(await setRecovery(child.id, state.raw)))}>
                Kurtarma kodu oluştur
              </button>
            </div>
          )}

          {edit && edit.v.kind === "wifi" ? (
            <div className="card">
              <h2>{edit.id ? "Wi-Fi ağını düzenle" : "Wi-Fi ağı ekle"}</h2>
              <label className="field">
                <span>Ağ adı (SSID)</span>
                <input value={edit.v.app} autoComplete="off" onChange={(e) => setEdit({ ...edit, v: { ...edit.v, app: e.target.value } })} placeholder="Anneanne-WLAN" />
              </label>
              <div className="row gap-xs wrap">
                {SEC.map(([k, l]) => (
                  <button key={k} type="button" className={`chip ${edit.v.security === k ? "on" : ""}`} onClick={() => setEdit({ ...edit, v: { ...edit.v, security: k } })}>
                    {l}
                  </button>
                ))}
              </div>
              {edit.v.security !== "open" && (
                <label className="field">
                  <span>Şifre</span>
                  <input value={edit.v.password} autoComplete="off" onChange={(e) => setEdit({ ...edit, v: { ...edit.v, password: e.target.value } })} />
                </label>
              )}
              <label className="row gap-s small">
                <input type="checkbox" checked={!!edit.v.hidden} onChange={(e) => setEdit({ ...edit, v: { ...edit.v, hidden: e.target.checked } })} />
                Gizli ağ (yakındaki ağlarda görünmüyor)
              </label>
              <div className="row gap-s">
                <button className="btn primary grow" disabled={busy} onClick={save}>
                  Kaydet
                </button>
                <button className="btn grow" onClick={() => setEdit(null)}>
                  Vazgeç
                </button>
              </div>
            </div>
          ) : edit ? (
            <div className="card">
              <h2>{edit.id ? "Kaydı düzenle" : "Yeni kayıt"}</h2>
              <label className="field">
                <span>Uygulama / site</span>
                <input value={edit.v.app} onChange={(e) => setEdit({ ...edit, v: { ...edit.v, app: e.target.value } })} placeholder="Roblox" />
              </label>
              <label className="field">
                <span>Kullanıcı adı / e-posta</span>
                <input value={edit.v.username} autoComplete="off" onChange={(e) => setEdit({ ...edit, v: { ...edit.v, username: e.target.value } })} />
              </label>
              <label className="field">
                <span>Şifre</span>
                <div className="row gap-s">
                  <input className="grow" value={edit.v.password} autoComplete="off" onChange={(e) => setEdit({ ...edit, v: { ...edit.v, password: e.target.value } })} />
                  <button className="btn small" onClick={() => setEdit({ ...edit, v: { ...edit.v, password: generatePassword() } })}>
                    Üret
                  </button>
                </div>
              </label>
              <label className="field">
                <span>Web sitesi</span>
                <input value={edit.v.url ?? ""} autoComplete="off" placeholder="roblox.com" onChange={(e) => setEdit({ ...edit, v: { ...edit.v, url: e.target.value.trim() } })} />
              </label>
              <label className="field">
                <span>Telefondaki uygulama</span>
                <select value={edit.v.pkg ?? ""} onChange={(e) => {
                  const pkg = e.target.value;
                  setEdit({ ...edit, v: { ...edit.v, pkg, app: edit.v.app || appName(pkg) } });
                }}>
                  <option value="">— Seçilmedi —</option>
                  {apps.map((a) => (
                    <option key={a.package} value={a.package}>{a.label}</option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span>Hesabın bağlı olduğu e-posta / telefon (kurtarma)</span>
                <input value={edit.v.recovery} onChange={(e) => setEdit({ ...edit, v: { ...edit.v, recovery: e.target.value } })} />
              </label>
              <label className="field">
                <span>Not</span>
                <input value={edit.v.note} onChange={(e) => setEdit({ ...edit, v: { ...edit.v, note: e.target.value } })} />
              </label>
              <div className="row gap-s">
                <button className="btn primary grow" disabled={busy} onClick={save}>
                  Kaydet
                </button>
                <button className="btn grow" onClick={() => setEdit(null)}>
                  Vazgeç
                </button>
              </div>
            </div>
          ) : (
            <div className="row gap-s">
              <input className="search grow" placeholder="Ara" value={q} onChange={(e) => setQ(e.target.value)} />
              <button className="btn primary" onClick={() => setEdit({ id: null, v: { ...blank } })}>
                <Icon name="plus" size={16} /> Ekle
              </button>
            </div>
          )}

          {!edit && (
            <div className="card">
              <div className="row between">
                <h2>📶 Wi-Fi ağları</h2>
                <button className="btn small primary" onClick={() => setEdit({ id: null, v: { ...blankWifi } })}>
                  <Icon name="plus" size={14} /> Ağ ekle
                </button>
              </div>
              <p className="muted small">
                <Info>
                  {child.name}'in telefonu bu ağları tanır ve yakınına gelince kendiliğinden bağlanır. Telefonda eklenen ağlar da buraya gelir.
                </Info>
              </p>
              {wifiRows.length === 0 && <p className="muted small">Henüz kayıtlı ağ yok.</p>}
              {wifiRows.map((r) => (
                <div className="row gap-s wifi-row" key={r.id}>
                  <div className="grow">
                    <b>{r.v.app}</b>
                    <div className="muted tiny">
                      {SEC.find(([k]) => k === r.v.security)?.[1] ?? "WPA2"}
                      {r.v.hidden ? " · gizli" : ""} · {r.updated_by === "phone" ? child.name : "ebeveyn"} · {relTime(r.updated_at)}
                    </div>
                    {r.v.password && <span className="mono small">{revealed[r.id] ? r.v.password : "••••••••"}</span>}
                    {!r.v.password && r.v.security !== "open" && (
                      <button className="chip small warn-chip" onClick={() => setEdit({ id: r.id, v: { ...r.v, note: "" } })}>
                        Şifre eksik · ekle
                      </button>
                    )}
                  </div>
                  {r.v.password && (
                    <button className="btn small" onClick={() => setRevealed({ ...revealed, [r.id]: !revealed[r.id] })}>
                      {revealed[r.id] ? "Gizle" : "Göster"}
                    </button>
                  )}
                  <button className="btn small" onClick={() => setEdit({ id: r.id, v: { ...r.v } })} aria-label="Düzenle">
                    Düzenle
                  </button>
                  <button
                    className="btn small danger-text"
                    onClick={async () => {
                      if (deleteId !== r.id) return setDeleteId(r.id);
                      await supabase.from("vault_entries").update({ removed_at: new Date().toISOString() }).eq("id", r.id);
                      setDeleteId(null);
                      await sendCommand(child.id, "resync", { wifi: true }).catch(() => {});
                      load();
                    }}
                  >
                    {deleteId === r.id ? "Tekrar bas: sil" : "Sil"}
                  </button>
                </div>
              ))}
              <div className="stack-s wifi-settings">
                <label className="row gap-s small">
                  <input type="checkbox" checked={wifiSet.child_add} disabled={busy} onChange={(e) => setWifi("child_add", e.target.checked)} />
                  {child.name} yeni ağ ekleyebilir
                </label>
                <label className="row gap-s small">
                  <input type="checkbox" checked={wifiSet.notify} disabled={busy} onChange={(e) => setWifi("notify", e.target.checked)} />
                  Yeni ağ eklenince ve onay sayfalı ağa bağlanınca bana bildir
                </label>
                <label className="row gap-s small">
                  <input type="checkbox" checked={wifiSet.show_passwords} disabled={busy} onChange={(e) => setWifi("show_passwords", e.target.checked)} />
                  {child.name} Wi-Fi şifrelerini görebilir
                </label>
                <label className="row gap-s small">
                  <input type="checkbox" checked={wifiSet.system_wifi} disabled={busy} onChange={(e) => setWifi("system_wifi", e.target.checked)} />
                  <span>
                    Telefonun kendi Wi-Fi ayarlarını kullanabilir{" "}
                    <Info>Kapalıyken {child.name} ağlara sadece Orbit'in Wi-Fi ekranından bağlanır; telefonun Ayarlar › Wi-Fi bölümünde ve üst menüde ağ seçemez, ekleyemez. Wi-Fi'yi açıp kapatmak serbest. Ebeveyn modunda bu kısıt kalkar.</Info>
                  </span>
                </label>
              </div>
            </div>
          )}

          {!appRows.length && !edit && <p className="muted small">Henüz hesap kaydı yok. {child.name} telefonundan da ekleyebilir.</p>}
          <div className="stack-s">
            {appRows
              .filter((r) => !q || r.v.app.toLowerCase().includes(q.toLowerCase()) || r.v.username.toLowerCase().includes(q.toLowerCase()))
              .map((r) => (
                <div className="card" key={r.id}>
                  <div className="row between">
                    <b>{r.v.app}</b>
                    <span className="muted tiny">
                      {r.updated_by === "phone" ? child.name : "ebeveyn"} · {relTime(r.updated_at)}
                    </span>
                  </div>
                  {r.v.username && (
                    <div className="row gap-s">
                      <span className="grow mono">{r.v.username}</span>
                      <button className="btn small" onClick={() => copy(r.v.username, r.id + "u")}>
                        {copied === r.id + "u" ? "Kopyalandı" : "Kopyala"}
                      </button>
                    </div>
                  )}
                  {r.v.password && (
                    <div className="row gap-s">
                      <span className="grow mono">{revealed[r.id] ? r.v.password : "••••••••"}</span>
                      <button className="btn small" onClick={() => setRevealed({ ...revealed, [r.id]: !revealed[r.id] })}>
                        {revealed[r.id] ? "Gizle" : "Göster"}
                      </button>
                      <button className="btn small" onClick={() => copy(r.v.password, r.id + "p")}>
                        {copied === r.id + "p" ? "Kopyalandı" : "Kopyala"}
                      </button>
                    </div>
                  )}
                  {(r.v.url || r.v.pkg) && (
                    <div className="row gap-s wrap small">
                      {r.v.url && (
                        <a href={/^https?:\/\//.test(r.v.url) ? r.v.url : `https://${r.v.url}`} target="_blank" rel="noreferrer">
                          🌐 {r.v.url.replace(/^https?:\/\//, "")}
                        </a>
                      )}
                      {r.v.pkg && <span className="chip small">📱 {appName(r.v.pkg)}</span>}
                    </div>
                  )}
                  {r.v.recovery && <div className="muted small">Kurtarma: {r.v.recovery}</div>}
                  {r.v.note && <div className="muted small">{r.v.note}</div>}
                  {revealed[r.id] && r.v.history.length > 0 && (
                    <div className="muted tiny">
                      Eski şifreler: {r.v.history.map((h) => `${h.password} (${new Date(h.changed_at).toLocaleDateString("tr-TR")})`).join(", ")}
                    </div>
                  )}
                  <div className="row gap-s">
                    <button className="btn small" onClick={() => setEdit({ id: r.id, v: { ...r.v } })}>
                      Düzenle
                    </button>
                    <button
                      className="btn small danger-text"
                      onClick={async () => {
                        if (deleteId !== r.id) return setDeleteId(r.id);
                        await supabase.from("vault_entries").update({ removed_at: new Date().toISOString() }).eq("id", r.id);
                        setDeleteId(null);
                        load();
                      }}
                    >
                      {deleteId === r.id ? "Tekrar bas: sil" : "Sil"}
                    </button>
                  </div>
                </div>
              ))}
          </div>

          {state.hasRecovery && (
            <button
              className="btn ghost"
              disabled={busy}
              onClick={() => {
                if (confirm("Yeni kurtarma kodu oluşturulsun mu? Eski kod geçersiz olur.")) run(async () => setShownCode(await setRecovery(child.id, state.raw)));
              }}
            >
              Kurtarma kodunu yenile
            </button>
          )}
        </>
      )}
    </div>
  );
}
