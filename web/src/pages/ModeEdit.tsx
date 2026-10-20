import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useFamily } from "../lib/family";
import { errorText, supabase } from "../lib/supabase";
import { GROUP_LABEL, type AppGroup, type Mode } from "../lib/types";
import { Icon } from "../components/Icon";

type AppOpt = { package: string; label: string };
type AppList = { id: string; name: string; packages: string[] };

const COLORS = ["#7C5CFF", "#3FA7D6", "#59C3A5", "#6B5CE7", "#FF7A59", "#F2B134", "#E0607E", "#2BB673"];

export default function ModeEdit() {
  const { id } = useParams();
  const fam = useFamily();
  const nav = useNavigate();
  const orig = fam.modes.find((m) => m.id === id);
  const [m, setM] = useState<Mode | undefined>(orig);
  const [apps, setApps] = useState<AppOpt[]>([]);
  const [lists, setLists] = useState<AppList[]>([]);
  const [q, setQ] = useState("");
  const [err, setErr] = useState("");
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (orig && !m) setM(orig);
  }, [orig, m]);

  useEffect(() => {
    (async () => {
      const [a, l] = await Promise.all([
        supabase.from("child_apps").select("package, label, is_system").eq("installed", true),
        supabase.from("app_lists").select("*").order("name"),
      ]);
      const seen = new Map<string, AppOpt>();
      for (const r of (a.data ?? []) as (AppOpt & { is_system: boolean })[]) if (!r.is_system && !seen.has(r.package)) seen.set(r.package, { package: r.package, label: r.label });
      setApps([...seen.values()].sort((x, y) => x.label.localeCompare(y.label, "tr")));
      setLists((l.data ?? []) as AppList[]);
    })();
  }, []);

  const shown = useMemo(
    () => apps.filter((a) => !q || a.label.toLowerCase().includes(q.toLowerCase())),
    [apps, q]
  );

  if (!m) return <div className="page"><p className="muted">Durum bulunamadı.</p></div>;

  const toggleGroup = (g: AppGroup) =>
    setM({ ...m, allowed_groups: m.allowed_groups.includes(g) ? m.allowed_groups.filter((x) => x !== g) : [...m.allowed_groups, g] });
  const togglePkg = (p: string) =>
    setM({ ...m, allowed_packages: m.allowed_packages.includes(p) ? m.allowed_packages.filter((x) => x !== p) : [...m.allowed_packages, p] });

  async function save() {
    setErr("");
    const { error } = await supabase
      .from("modes")
      .update({
        name: m!.name,
        color: m!.color,
        allowed_packages: m!.allowed_packages,
        allowed_groups: m!.allowed_groups,
        budget_minutes: m!.budget_minutes,
        counts_toward_daily: m!.counts_toward_daily,
        others_blocked: m!.others_blocked,
        extra_time_allowed: m!.extra_time_allowed,
        warn_minutes: m!.warn_minutes,
        priority: m!.priority,
      })
      .eq("id", m!.id);
    if (error) return setErr(errorText(error));
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
    fam.reload();
  }

  async function saveList() {
    const name = prompt("Liste adı (örneğin Oyunlarım)");
    if (!name) return;
    const { data, error } = await supabase
      .from("app_lists")
      .insert({ family_id: m!.family_id, name, packages: m!.allowed_packages })
      .select("*")
      .single();
    if (error) return setErr(errorText(error));
    setLists([...lists, data as AppList]);
  }

  async function duplicate() {
    const { id: _id, ...rest } = m!;
    const { data, error } = await supabase
      .from("modes")
      .insert({ ...rest, name: `${m!.name} (kopya)` })
      .select("id")
      .single();
    if (error) return setErr(errorText(error));
    await fam.reload();
    setM(undefined);
    nav(`/rules/mode/${data.id}`);
  }

  async function remove() {
    if (!confirm(`"${m!.name}" silinsin mi? Programlardaki zamanları da silinir.`)) return;
    await supabase.from("modes").delete().eq("id", m!.id);
    await fam.reload();
    nav("/rules");
  }

  return (
    <div className="page">
      <header className="page-head">
        <Link to="/rules" className="icon-btn" aria-label="Geri">
          <Icon name="back" />
        </Link>
        <h1>Durum</h1>
        <span />
      </header>
      {err && <p className="error">{err}</p>}
      <div className="card">
        <label className="field">
          <span>Ad</span>
          <input value={m.name} onChange={(e) => setM({ ...m, name: e.target.value })} />
        </label>
        <div className="row gap-xs wrap">
          {COLORS.map((c) => (
            <button key={c} className={`swatch ${m.color === c ? "on" : ""}`} style={{ background: c }} onClick={() => setM({ ...m, color: c })} aria-label={c} />
          ))}
        </div>
      </div>

      <div className="card">
        <h2>Süre</h2>
        <label className="check">
          <input type="checkbox" checked={m.budget_minutes == null} onChange={(e) => setM({ ...m, budget_minutes: e.target.checked ? null : 30 })} />
          Saat aralığı boyunca sınırsız
        </label>
        {m.budget_minutes != null && (
          <label className="field">
            <span>Bu durumun kendi süresi (dk)</span>
            <input type="number" min={0} value={m.budget_minutes} onChange={(e) => setM({ ...m, budget_minutes: Number(e.target.value) })} />
          </label>
        )}
        <label className="check">
          <input type="checkbox" checked={m.counts_toward_daily} onChange={(e) => setM({ ...m, counts_toward_daily: e.target.checked })} />
          Kullanılan süre günlük süreden de düşsün
        </label>
        <label className="check">
          <input type="checkbox" checked={m.extra_time_allowed} onChange={(e) => setM({ ...m, extra_time_allowed: e.target.checked })} />
          Bu durumda ekstra süre kullanılabilsin
        </label>
      </div>

      <div className="card">
        <h2>Açık olanlar</h2>
        <p className="muted small">Gruplar çocuğun kendi uygulama gruplarıdır. Ayrıca tek tek uygulama seçebilirsin.</p>
        <div className="row gap-xs wrap">
          {(["always_open", "unlimited", "timed"] as AppGroup[]).map((g) => (
            <button key={g} className={`chip ${m.allowed_groups.includes(g) ? "on" : ""}`} onClick={() => toggleGroup(g)}>
              {GROUP_LABEL[g]}
            </button>
          ))}
        </div>
        <label className="check">
          <input type="checkbox" checked={m.others_blocked} onChange={(e) => setM({ ...m, others_blocked: e.target.checked })} />
          Durum boyunca diğer uygulamalar kapalı
        </label>
        {lists.length > 0 && (
          <div className="row gap-xs wrap">
            <span className="muted small">Kayıtlı listeler:</span>
            {lists.map((l) => (
              <button
                key={l.id}
                className="chip small"
                onClick={() => setM({ ...m, allowed_packages: [...new Set([...m.allowed_packages, ...l.packages])] })}
              >
                + {l.name}
              </button>
            ))}
          </div>
        )}
        <input className="search" placeholder="Uygulama ara" value={q} onChange={(e) => setQ(e.target.value)} />
        <div className="app-pick">
          {shown.map((a) => (
            <label className="check" key={a.package}>
              <input type="checkbox" checked={m.allowed_packages.includes(a.package)} onChange={() => togglePkg(a.package)} />
              {a.label}
            </label>
          ))}
          {!apps.length && <p className="muted small">Telefon eşleşince uygulamalar burada görünür.</p>}
        </div>
        {m.allowed_packages.length > 0 && (
          <button className="link" onClick={saveList}>
            Seçili {m.allowed_packages.length} uygulamayı liste olarak kaydet
          </button>
        )}
      </div>

      <div className="card">
        <h2>Diğer</h2>
        <div className="grid2">
          <label className="field">
            <span>Uyarı (dk önce)</span>
            <input
              value={m.warn_minutes.join(", ")}
              onChange={(e) => setM({ ...m, warn_minutes: e.target.value.split(",").map((x) => Number(x.trim())).filter((x) => x > 0) })}
            />
          </label>
          <label className="field">
            <span>Öncelik (çakışmada büyük kazanır)</span>
            <input type="number" value={m.priority} onChange={(e) => setM({ ...m, priority: Number(e.target.value) })} />
          </label>
        </div>
      </div>

      <button className="btn primary wide" onClick={save}>
        {saved ? "Kaydedildi" : "Kaydet"}
      </button>
      <div className="row gap-s">
        <button className="btn ghost" onClick={duplicate}>
          Kopyasını oluştur
        </button>
        <button className="btn ghost danger-text" onClick={remove}>
          Durumu sil
        </button>
      </div>
    </div>
  );
}
