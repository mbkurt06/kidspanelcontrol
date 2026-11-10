import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useFamily } from "../lib/family";
import { errorText, supabase } from "../lib/supabase";
import { GROUP_LABEL, type AppGroup, type Mode } from "../lib/types";
import { Icon } from "../components/Icon";
import { Info } from "../components/Info";
import { ScreenPicker } from "../components/RuleEditor";
import { KIOSK_SCREENS } from "../lib/types";

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
        kiosk_enabled: !!m!.kiosk_enabled,
        kiosk_screens: m!.kiosk_screens ?? KIOSK_SCREENS.map(([id]) => id),
        kiosk_calls: m!.kiosk_calls ?? "emergency",
        kiosk_message: m!.kiosk_message?.trim() || null,
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
    const { id: _id, builtin: _b, ...rest } = m!;
    const { data, error } = await supabase
      .from("modes")
      .insert({ ...rest, name: `${m!.name} (kopya)`, priority: Math.max(50, rest.priority) })
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

  const b = m.builtin ?? null;
  const BUILTIN_NOTE: Record<string, string> = {
    open: "Hazır profil. Bu profili kullanan bölümlerde her şey açıktır ve süre sayılmaz.",
    timed: "Hazır profil. Bu profili kullanan bölümlerde uygulamalar bölümün süre kutusundaki süreden düşer; süre bitince kapanır.",
    blocked: "Hazır profil. Bu profili kullanan bölümlerde sadece aşağıda seçtiğin uygulamalar açık kalır.",
    kiosk: "Hazır profil. Bu profili kullanan bölümlerde telefonda sadece Orbit kalır; açık Orbit ekranlarını ve mesajı aşağıdan seçersin.",
  };
  // Bu profili kullanan gün profili bölümleri ve zaman dilimleri
  const usedIn = [
    ...fam.sections.filter((x) => x.mode_id === m.id).map((x) => ({
      key: x.id, prof: fam.profiles.find((p) => p.id === x.profile_id)?.name ?? "Gün profili", text: `${x.name} · ${x.start_time.slice(0, 5)}–${x.end_time.slice(0, 5)}`, profId: x.profile_id,
    })),
    ...fam.slots.filter((x) => x.mode_id === m.id).map((x) => ({
      key: x.id, prof: fam.profiles.find((p) => p.id === x.profile_id)?.name ?? "Gün profili", text: `${x.start_time.slice(0, 5)}–${x.end_time.slice(0, 5)}`, profId: x.profile_id,
    })),
  ];
  const showKiosk = b === "kiosk" || b == null;
  const showApps = b === "blocked" || b == null;
  const showTime = b === "timed" || b == null;

  return (
    <div className="page">
      <header className="page-head">
        <Link to="/rules" className="icon-btn" aria-label="Geri">
          <Icon name="back" />
        </Link>
        <h1>Kullanım profili</h1>
        <span />
      </header>
      {err && <p className="error">{err}</p>}

      <div className="card">
        <h2>Genel</h2>
        {b && <p className="muted small">{BUILTIN_NOTE[b]}</p>}
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

      {showKiosk && (
        <div className="card">
          <h2>Kilit ekranı</h2>
          {b == null && (
            <label className="check">
              <input type="checkbox" checked={!!m.kiosk_enabled} onChange={(e) => setM({ ...m, kiosk_enabled: e.target.checked })} />
              Tam kilit: telefonda sadece Orbit kalsın
            </label>
          )}
          {(b === "kiosk" || m.kiosk_enabled) && <>
            <span className="muted small">Kilitliyken açık Orbit ekranları</span>
            <ScreenPicker value={m.kiosk_screens ?? KIOSK_SCREENS.map(([id]) => id)} onChange={(v) => setM({ ...m, kiosk_screens: v })} />
            <label className="field">
              <span>Aramalar</span>
              <select value={m.kiosk_calls ?? "emergency"} onChange={(e) => setM({ ...m, kiosk_calls: e.target.value as "emergency" | "all" })}>
                <option value="emergency">Sadece acil arama</option>
                <option value="all">Aramalar açık</option>
              </select>
            </label>
            <label className="field">
              <span>Çocuğa gösterilecek mesaj</span>
              <input value={m.kiosk_message ?? ""} placeholder="Boş = varsayılan mesaj" onChange={(e) => setM({ ...m, kiosk_message: e.target.value })} />
            </label>
          </>}
        </div>
      )}

      {showTime && (
        <div className="card">
          <h2>Süre</h2>
          {b == null && <>
            <label className="check">
              <input type="checkbox" checked={m.budget_minutes == null} onChange={(e) => setM({ ...m, budget_minutes: e.target.checked ? null : 30 })} />
              Saat aralığı boyunca sınırsız
            </label>
            {m.budget_minutes != null && (
              <label className="field">
                <span>Bu profilin kendi süresi (dk)</span>
                <input type="number" min={0} value={m.budget_minutes} onChange={(e) => setM({ ...m, budget_minutes: Number(e.target.value) })} />
              </label>
            )}
            <label className="check">
              <input type="checkbox" checked={m.counts_toward_daily} onChange={(e) => setM({ ...m, counts_toward_daily: e.target.checked })} />
              Kullanılan süre günlük süreden de düşsün
            </label>
          </>}
          {b === "timed" && <p className="muted small">Ne kadar süre olacağı, bu profili kullanan her bölümün kendi süre kutusunda yazılır (0 = süre yok, boş = sınırsız).</p>}
          <label className="check">
            <input type="checkbox" checked={m.extra_time_allowed} onChange={(e) => setM({ ...m, extra_time_allowed: e.target.checked })} />
            Bu profilde ekstra süre kullanılabilsin
          </label>
          <label className="field">
            <span>Bitmeden önce uyarı (dk, virgülle)</span>
            <input
              value={m.warn_minutes.join(", ")}
              onChange={(e) => setM({ ...m, warn_minutes: e.target.value.split(",").map((x) => Number(x.trim())).filter((x) => x > 0) })}
            />
          </label>
        </div>
      )}

      {showApps && (
        <div className="card">
          <h2>Açık olanlar <Info>Grupları veya tek tek uygulamaları bu profile dahil edebilirsin.</Info></h2>
          <div className="row gap-xs wrap">
            {(["always_open", "unlimited", "timed"] as AppGroup[]).map((g) => (
              <button key={g} className={`chip ${m.allowed_groups.includes(g) ? "on" : ""}`} onClick={() => toggleGroup(g)}>
                {GROUP_LABEL[g]}
              </button>
            ))}
          </div>
          {b == null && (
            <label className="check">
              <input type="checkbox" checked={m.others_blocked} onChange={(e) => setM({ ...m, others_blocked: e.target.checked })} />
              Profil boyunca diğer uygulamalar kapalı
            </label>
          )}
          {lists.length > 0 && (
            <div className="row gap-xs wrap">
              <span className="muted small">Kayıtlı listeler:</span>
              {lists.map((l) => (
                <button key={l.id} className="chip small" onClick={() => setM({ ...m, allowed_packages: [...new Set([...m.allowed_packages, ...l.packages])] })}>
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
      )}

      {b == null && (
        <div className="card">
          <h2>Diğer</h2>
          <label className="field">
            <span>Öncelik (çakışmada büyük kazanır)</span>
            <input type="number" value={m.priority} onChange={(e) => setM({ ...m, priority: Number(e.target.value) })} />
          </label>
        </div>
      )}

      <div className="card">
        <h2>Kullanıldığı yerler</h2>
        {usedIn.length === 0 && <p className="muted small">Henüz hiçbir gün profilinde kullanılmıyor. Gün profilinde bir bölümün türünü bu profil yaparak kullanabilirsin.</p>}
        {usedIn.map((u) => (
          <Link key={u.key} to={`/rules/profile/${u.profId}`} className="row between used-in-row">
            <span><b>{u.prof}</b> · {u.text}</span>
            <Icon name="chevron" size={16} />
          </Link>
        ))}
      </div>

      <button className="btn primary wide" onClick={save}>
        {saved ? "Kaydedildi" : "Kaydet"}
      </button>
      <div className="row gap-s">
        <button className="btn ghost" onClick={duplicate}>
          Kopyasını oluştur
        </button>
        {b == null && (
          <button className="btn ghost danger-text" onClick={remove}>
            Profili sil
          </button>
        )}
      </div>
    </div>
  );
}
