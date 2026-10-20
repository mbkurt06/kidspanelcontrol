import { useCallback, useEffect, useState } from "react";
import { useFamily } from "../lib/family";
import { errorText, localDevice, supabase } from "../lib/supabase";
import { relTime } from "../lib/util";
import type { Device, ParentDevice } from "../lib/types";

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

  const load = useCallback(async () => {
    const [d, p, i, v] = await Promise.all([
      supabase.from("parent_devices").select("*").order("created_at", { ascending: false }),
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

      <div className="card">
        <h2>Ebeveyn cihazları</h2>
        <p className="muted small">Paneli sadece burada onaylı cihazlar açabilir. Kaybolan telefonun erişimini buradan kaldır.</p>
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
              <button className="btn small" onClick={() => setStatus(d.id, "approved")}>
                Geri ver
              </button>
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
        <h2>Noor tableti</h2>
        <p className="muted small">Noor'daki Orbit sayfası iki çocuğun durumunu gösterir. Eşleştirmek için bir kod al ve tablete gir.</p>
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
        <h2>Hesap</h2>
        <p className="muted small">Panel ekranını iPhone'da ana ekrana ekle: Safari → Paylaş → Ana Ekrana Ekle.</p>
        <button className="btn ghost" onClick={() => supabase.auth.signOut()}>
          Çıkış yap
        </button>
      </div>
      <p className="muted tiny center">Orbit panel 0.1 · {fam.children.length} çocuk</p>
    </div>
  );
}
