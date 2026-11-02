import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useFamily } from "../lib/family";
import { errorText, supabase } from "../lib/supabase";
import type { ActivityDef, FocusProfile } from "../lib/types";
import { Icon } from "../components/Icon";
import { Info } from "../components/Info";

type AppRow = { package: string; label: string };
const MENU_OPTIONS: [string, string][] = [
  ["tasks", "✅ Görevler"],
  ["agenda", "🗓 Ajanda"],
  ["timer", "⏱ Sayaç"],
  ["alarms", "⏰ Hatırlatıcılar"],
  ["messages", "💬 Mesajlar"],
  ["music", "🎵 Müzik"],
  ["wallet", "⏳ Süre cüzdanı"],
  ["ask", "🙋 Ebeveynden iste"],
  ["vault", "🔑 Şifreler"],
];

/** Odak profili düzenleme: sayaç çalışırken telefonda ne açık kalsın (kuralların üstüne sadece kısıtlar). */
export function FocusEdit() {
  const { id } = useParams();
  const fam = useFamily();
  const nav = useNavigate();
  const orig = fam.focusProfiles.find((p) => p.id === id);
  const [p, setP] = useState<FocusProfile | undefined>(orig);
  const [apps, setApps] = useState<AppRow[]>([]);
  const [add, setAdd] = useState("");
  const [err, setErr] = useState("");
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (orig && !p) setP(orig);
  }, [orig, p]);
  useEffect(() => {
    supabase
      .from("child_apps")
      .select("package,label")
      .eq("approved", true)
      .eq("installed", true)
      .order("label")
      .then(({ data }) => {
        const m = new Map<string, AppRow>();
        for (const a of (data ?? []) as AppRow[]) if (!m.has(a.package)) m.set(a.package, a);
        setApps([...m.values()]);
      });
  }, []);

  if (!p) return <div className="page"><p className="muted">Odak profili bulunamadı.</p></div>;

  async function save() {
    setErr("");
    const { error } = await supabase
      .from("focus_profiles")
      .update({
        name: p!.name.trim() || "Odak",
        icon: p!.icon || null,
        allowed_groups: p!.allowed_groups,
        allowed_packages: p!.allowed_packages,
        allowed_screens: p!.allowed_screens,
        messages_allowed: p!.messages_allowed,
        calls_allowed: p!.calls_allowed,
      })
      .eq("id", p!.id);
    if (error) return setErr(errorText(error));
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
    fam.reload();
  }

  async function remove() {
    if (!confirm(`"${p!.name}" silinsin mi?`)) return;
    await supabase.from("focus_profiles").delete().eq("id", p!.id);
    await fam.reload();
    nav("/rules");
  }

  const toggleGroup = (g: string) =>
    setP({ ...p, allowed_groups: p.allowed_groups.includes(g) ? p.allowed_groups.filter((x) => x !== g) : [...p.allowed_groups, g] });

  return (
    <div className="page">
      <header className="page-head">
        <Link to="/rules" className="icon-btn" aria-label="Geri">
          <Icon name="back" />
        </Link>
        <h1>Odak profili</h1>
        <span />
      </header>
      {err && <p className="error">{err}</p>}
      <div className="card">
        <div className="row gap-s">
          <input className="mini" style={{ width: 56, textAlign: "center", fontSize: 20 }} value={p.icon ?? ""} maxLength={4} placeholder="🎯" onChange={(e) => setP({ ...p, icon: e.target.value })} aria-label="Simge" />
          <input className="grow" value={p.name} onChange={(e) => setP({ ...p, name: e.target.value })} aria-label="Ad" />
        </div>
        <h2 className="section-title">Odak profili <Info>Sayaç bu profille çalışırken yalnızca aşağıda seçtiklerin açık kalır. Mevcut kuralları gevşetmez.</Info></h2>
      </div>
      <div className="card">
        <h2>Orbit menüleri</h2>
        <p className="muted small">Sayaç bu profille çalışırken yalnızca seçtiğin menüler görünür. Hiçbiri seçilmezse tüm menüler açık kalır.</p>
        {MENU_OPTIONS.map(([key, label]) => (
          <label className="check" key={key}>
            <input
              type="checkbox"
              checked={p.allowed_screens.includes(key)}
              onChange={() => setP({ ...p, allowed_screens: p.allowed_screens.includes(key) ? p.allowed_screens.filter((x) => x !== key) : [...p.allowed_screens, key] })}
            />
            {label}
          </label>
        ))}
      </div>
      <div className="card">
        <h2>Açık kalacak gruplar</h2>
        {!fam.groups.length && <p className="muted small">Henüz grup yok.</p>}
        {fam.groups.map((g) => (
          <label className="check" key={g.id}>
            <input type="checkbox" checked={p.allowed_groups.includes(g.id)} onChange={() => toggleGroup(g.id)} />
            <span className="dot" style={{ background: g.color }} /> {g.name}
          </label>
        ))}
      </div>
      <div className="card">
        <h2>Açık kalacak uygulamalar</h2>
        {p.allowed_packages.map((pk) => (
          <div className="app-row" key={pk}>
            <div className="grow">{apps.find((a) => a.package === pk)?.label ?? pk}</div>
            <button className="icon-btn" aria-label="Kaldır" onClick={() => setP({ ...p, allowed_packages: p.allowed_packages.filter((x) => x !== pk) })}>
              <Icon name="x" size={16} />
            </button>
          </div>
        ))}
        <div className="row gap-s">
          <select value={add} onChange={(e) => setAdd(e.target.value)} className="grow" aria-label="Uygulama ekle">
            <option value="">Uygulama ekle…</option>
            {apps
              .filter((a) => !p.allowed_packages.includes(a.package))
              .map((a) => (
                <option key={a.package} value={a.package}>
                  {a.label}
                </option>
              ))}
          </select>
          <button
            className="btn small"
            disabled={!add}
            onClick={() => {
              setP({ ...p, allowed_packages: [...p.allowed_packages, add] });
              setAdd("");
            }}
          >
            Ekle
          </button>
        </div>
      </div>
      <div className="card">
        <label className="check">
          <input type="checkbox" checked={p.messages_allowed} onChange={(e) => setP({ ...p, messages_allowed: e.target.checked })} /> Orbit mesajları açık (sana yazabilsin)
        </label>
        <label className="check">
          <input type="checkbox" checked={p.calls_allowed} onChange={(e) => setP({ ...p, calls_allowed: e.target.checked })} /> Telefon araması açık
        </label>
        <p className="muted tiny">Acil arama her zaman yapılabilir. Kapalı uygulamaların bildirimleri de görünmez.</p>
      </div>
      <button className="btn primary wide" onClick={save}>
        {saved ? "Kaydedildi" : "Kaydet"}
      </button>
      <button className="btn ghost danger-text" onClick={remove}>
        Profili sil
      </button>
    </div>
  );
}

/** Etkinlikler: çocuğun sayaçta seçeceği işler, varsayılan odak ve ödül. */
export function ActivitiesPage() {
  const fam = useFamily();
  const [err, setErr] = useState("");

  async function patch(a: ActivityDef, v: Partial<ActivityDef>) {
    setErr("");
    const { error } = await supabase.from("activities").update(v).eq("id", a.id);
    if (error) setErr(errorText(error));
    fam.reload();
  }
  async function add() {
    const { error } = await supabase.from("activities").insert({ family_id: fam.familyId, name: "Yeni etkinlik", icon: "⭐", sort_order: fam.activities.length });
    if (error) setErr(errorText(error));
    fam.reload();
  }
  async function remove(a: ActivityDef) {
    if (!confirm(`"${a.name}" silinsin mi?`)) return;
    await supabase.from("activities").delete().eq("id", a.id);
    fam.reload();
  }

  return (
    <div className="page">
      <header className="page-head">
        <Link to="/rules" className="icon-btn" aria-label="Geri">
          <Icon name="back" />
        </Link>
        <h1>Etkinlikler</h1>
        <button className="btn small" onClick={add}>
          <Icon name="plus" size={16} /> Ekle
        </button>
      </header>
      {err && <p className="error">{err}</p>}
      <h2 className="section-title">Etkinlikler <Info>Çocuk sayaç başlatırken bunlardan birini seçebilir. Ödül, odaklı çalışma süresine göre ekstra süredir.</Info></h2>
      {fam.activities.map((a) => (
        <div className="card" key={a.id}>
          <div className="row gap-s">
            <input className="mini" style={{ width: 56, textAlign: "center", fontSize: 20 }} defaultValue={a.icon ?? ""} key={`i${a.icon}`} maxLength={4} onBlur={(e) => e.target.value !== (a.icon ?? "") && patch(a, { icon: e.target.value || null })} aria-label="Simge" />
            <input className="grow" defaultValue={a.name} key={`n${a.name}`} onBlur={(e) => e.target.value.trim() && e.target.value !== a.name && patch(a, { name: e.target.value.trim() })} aria-label="Ad" />
            <button className="icon-btn" aria-label="Sil" onClick={() => remove(a)}>
              <Icon name="trash" size={18} />
            </button>
          </div>
          <label className="field">
            <span>Varsayılan odak profili</span>
            <select value={a.default_focus_id ?? ""} onChange={(e) => patch(a, { default_focus_id: e.target.value || null })}>
              <option value="">Serbest (kısıtlama yok)</option>
              {fam.focusProfiles.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.icon} {f.name}
                </option>
              ))}
            </select>
          </label>
          <div className="row gap-s wrap" style={{ alignItems: "center" }}>
            <span className="small">Ödül: her</span>
            <input className="mini" type="number" min={1} placeholder="—" defaultValue={a.reward_every ?? ""} key={`e${a.reward_every}`} onBlur={(e) => patch(a, { reward_every: e.target.value ? Number(e.target.value) : null })} aria-label="Her kaç dakika" />
            <span className="small">dk çalışmaya</span>
            <input className="mini" type="number" min={1} placeholder="—" defaultValue={a.reward_minutes ?? ""} key={`m${a.reward_minutes}`} onBlur={(e) => patch(a, { reward_minutes: e.target.value ? Number(e.target.value) : null })} aria-label="Kaç dakika ödül" />
            <span className="small">dk</span>
            <select value={a.reward_to} onChange={(e) => patch(a, { reward_to: e.target.value as "today" | "vault" })}>
              <option value="today">bugüne</option>
              <option value="vault">süre kasasına</option>
            </select>
          </div>
        </div>
      ))}
    </div>
  );
}
