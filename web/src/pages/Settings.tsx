import { getTheme, setTheme, type ThemeChoice } from "../lib/theme";
import { useCallback, useEffect, useState } from "react";
import { useFamily } from "../lib/family";
import { errorText, localDevice, supabase } from "../lib/supabase";
import { relTime } from "../lib/util";
import type { Device, ParentDevice } from "../lib/types";
import { Info } from "../components/Info";
import { currentSubscription, disablePush, enablePush, isStandalone, pushSupported } from "../lib/push";

type Parent = { user_id: string; email: string; display_name: string };
type Invite = { email: string; display_name: string | null };

export default function Settings() {
  const fam = useFamily();
  const me = localDevice().id;
  const [devices, setDevices] = useState<ParentDevice[]>([]);
  const [parents, setParents] = useState<Parent[]>([]);
  const [invites, setInvites] = useState<Invite[]>([]);
  const [viewers, setViewers] = useState<Device[]>([]);
  const [inv, setInv] = useState({ email: "", name: "" });
  const [code, setCode] = useState("");
  const [err, setErr] = useState("");
  const [msg, setMsg] = useState("");

  const [pushOn, setPushOn] = useState(false);
  const [pushBusy, setPushBusy] = useState(false);
  useEffect(() => {
    currentSubscription().then((s) => setPushOn(!!s));
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

  const parentName = (uid: string) => parents.find((p) => p.user_id === uid)?.display_name ?? "";
  const joined = new Set(parents.map((p) => p.email));

  return (
    <div className="page">
      <header className="page-head">
        <h1>Ayarlar</h1>
      </header>
      {err && <p className="error">{err}</p>}
      {msg && <p className="ok">{msg}</p>}

      <ThemeCard />
      <ProofCard />

      <div className="card">
        <h2>Bildirimler <Info>Görev, süre, uygulama ve telefon durumlarıyla ilgili bildirimleri bu cihazda yönetirsin.</Info></h2>
        {!pushSupported() || (/iPhone|iPad/.test(navigator.userAgent) && !isStandalone()) ? (
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
                      const { data: u } = await supabase.auth.getUser();
                      await supabase.from("events").insert({ family_id: fam.familyId, type: "push_test", payload: { by: u.user?.email } });
                      setMsg("Deneme bildirimi gönderildi");
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
        <h2>Ebeveynler</h2>
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

      <SecurityCard />

      <div className="card">
        <h2>Hesap <Info>Paneli iPhone ana ekranına eklemek için Safari → Paylaş → Ana Ekrana Ekle yolunu kullan.</Info></h2>
        <button className="btn ghost" onClick={() => supabase.auth.signOut()}>
          Çıkış yap
        </button>
      </div>
      <p className="muted tiny center">Orbit panel 0.1 · {fam.children.length} çocuk</p>
    </div>
  );
}

async function sha256(text: string) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Güvenlik: bütün telefonlarda geçen ebeveyn PIN'i. */
function SecurityCard() {
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
    <div className="card">
      <h2>🔐 Güvenlik · Ebeveyn PIN'i <Info>Bu PIN ile çocuk telefonunda geçici ebeveyn modu açılır. Üç yanlış denemede 5 dakika beklenir ve giriş sana bildirilir.</Info></h2>
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
