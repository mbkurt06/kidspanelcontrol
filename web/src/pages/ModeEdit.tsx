import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useFamily } from "../lib/family";
import { errorText, supabase } from "../lib/supabase";
import { GROUP_LABEL, type AppGroup, type Mode } from "../lib/types";
import { Icon } from "../components/Icon";
import { Info } from "../components/Info";
import { ScreenPicker } from "../components/RuleEditor";
import { TimeField } from "../components/DateTime";
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
        budget_use: m!.budget_use ?? "any",
        budget_within_minutes: m!.budget_use === "within" ? m!.budget_within_minutes ?? 60 : null,
        budget_range_start: m!.budget_use === "range" ? m!.budget_range_start ?? null : null,
        budget_range_end: m!.budget_use === "range" ? m!.budget_range_end ?? null : null,
        app_caps: m!.budget_minutes != null ? m!.app_caps ?? {} : {},
        counts_toward_daily: m!.counts_toward_daily,
        others_blocked: m!.others_blocked,
        extra_time_allowed: m!.grant_mode !== "none",
        grant_mode: m!.grant_mode ?? null,
        grant_within_minutes: m!.grant_mode === "within" ? m!.grant_within_minutes ?? 120 : null,
        warn_minutes: m!.warn_minutes,
        priority: m!.priority,
        kiosk_enabled: !!m!.kiosk_enabled,
        // Hepsi seçiliyse kısıtlama yok ([]); tam kilitte boş = varsayılan ekranlar
        kiosk_screens: !m!.kiosk_screens?.length || KIOSK_SCREENS.every(([id]) => m!.kiosk_screens!.includes(id)) ? [] : m!.kiosk_screens,
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
    open: "Hazır profil (silinemez). Başlangıçta her şey açık, süre sayılmaz; aşağıdan istediğin gibi değiştirebilirsin.",
    timed: "Hazır profil (silinemez). Başlangıçta uygulamalar bölümün süre kutusundaki süreden düşer, bitince kapanır. Süre miktarı her bölümün kendi süre kutusunda.",
    blocked: "Hazır profil (silinemez). Başlangıçta sadece seçili uygulamalar açık; diğerleri kapalı.",
    kiosk: "Hazır profil (silinemez). Başlangıçta telefonda sadece Orbit kalır.",
  };
  // Bu profili kullanan gün profili bölümleri ve zaman dilimleri
  const usedIn = [
    ...fam.sections.filter((x) => x.mode_id === m.id).map((x) => ({
      key: x.id, table: "profile_sections" as const, prof: fam.profiles.find((p) => p.id === x.profile_id)?.name ?? "Gün profili", name: x.name,
      start: x.start_time.slice(0, 5), end: x.end_time.slice(0, 5), text: `${x.name} · ${x.start_time.slice(0, 5)}–${x.end_time.slice(0, 5)}`, profId: x.profile_id,
    })),
    ...fam.slots.filter((x) => x.mode_id === m.id).map((x) => ({
      key: x.id, table: "mode_slots" as const, prof: fam.profiles.find((p) => p.id === x.profile_id)?.name ?? "Gün profili", name: "",
      start: x.start_time.slice(0, 5), end: x.end_time.slice(0, 5), text: `${x.start_time.slice(0, 5)}–${x.end_time.slice(0, 5)}`, profId: x.profile_id,
    })),
  ];
  const showKiosk = true;
  const showApps = true;
  const showTime = true;

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
          <h2>Orbit ekranları <Info>Bu profil sürerken açık kalacak ekranlar; kaldırdıkların bu saatte kapanır (ör. gece Müzik). Çocuğun temel ayarında (çocuk sayfası → Orbit) kapalı olan ekranlar burada seçili olsa da açılmaz: kapalı her zaman kazanır. "Günüm" her zaman açıktır.</Info></h2>
          <ScreenPicker
            value={m.kiosk_screens?.length ? m.kiosk_screens : KIOSK_SCREENS.map(([id]) => id)}
            onChange={(v) => setM({ ...m, kiosk_screens: v })}
          />
          <p className="muted tiny">
            {!m.kiosk_screens?.length || KIOSK_SCREENS.every(([id]) => m.kiosk_screens!.includes(id)) ? "Kısıtlama yok: bütün ekranlar açık." : `${m.kiosk_screens.length} ekran açık, diğerleri bu profil sürerken gizli.`}
          </p>
        </div>
      )}

      {showKiosk && (
        <div className="card">
          <h2>Tam kilit</h2>
          <label className="check">
            <input type="checkbox" checked={!!m.kiosk_enabled} onChange={(e) => setM({ ...m, kiosk_enabled: e.target.checked })} />
            Telefonda sadece Orbit kalsın (diğer uygulamalar, ayarlar ve bildirimler kapalı)
          </label>
          {m.kiosk_enabled && <>
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
          <h2>🕘 Kullanıldığı yerler <Info>Bu profilin hangi gün profillerinde ve saatlerde geçerli olduğu. Saati değiştirmek için satıra dokun: gün profiline gider.</Info></h2>
          {usedIn.length === 0 && <p className="muted small">Henüz hiçbir saatte kullanılmıyor. Kurallar → gün profilinde bir bölümün türünü “{m.name || "bu profil"}” yap.</p>}
          {usedIn.map((u) => (
            <Link key={u.key} to={`/rules/profile/${u.profId}`} className="row between used-in-row">
              <span><b>{u.prof}</b> · {u.text}</span>
              <Icon name="chevron" size={16} />
            </Link>
          ))}
        </div>
      )}

      {showTime && (
        <div className="card">
          <h2>⏱ Profilin kendi süresi <Info>Profil başlayınca çocuğa bu profile özel süre gelir (ör. 10 dk). Görevden kazandığı ya da senin verdiğin normal süreyi de aynı saatte kullanabilir: önce profilin süresi düşer, bitince normal süreye geçer. “Yok” seçilirse sadece normal süre kullanılır. Kalan süre ana ekranda sol halkada görünür.</Info></h2>
          {(() => {
            const kind = m.budget_minutes != null ? "own" : m.counts_toward_daily ? "none" : "unl";
            return (
              <div className="stack-s">
                <label className="check"><input type="radio" checked={kind === "none"} onChange={() => setM({ ...m, budget_minutes: null, counts_toward_daily: true })} /> Yok: çocuk normal süresini kullanır (görev / elle verilen)</label>
                <label className="check"><input type="radio" checked={kind === "own"} onChange={() => setM({ ...m, budget_minutes: m.budget_minutes ?? 10, counts_toward_daily: false })} /> Var: bu profile özel süre</label>
                <label className="check"><input type="radio" checked={kind === "unl"} onChange={() => setM({ ...m, budget_minutes: null, counts_toward_daily: false })} /> Sınırsız: profil boyunca istediği kadar</label>
              </div>
            );
          })()}
          {m.budget_minutes != null && (<>
            <label className="field">
              <span>Süre (dk)</span>
              <input type="number" min={1} value={m.budget_minutes} onChange={(e) => setM({ ...m, budget_minutes: Math.max(1, Number(e.target.value) || 1) })} />
            </label>
            <span className="pop-label">NE ZAMAN KULLANILABİLİR</span>
            <label className="check"><input type="radio" checked={(m.budget_use ?? "any") === "any"} onChange={() => setM({ ...m, budget_use: "any" })} /> Profil boyunca, istediği zaman (kullandıkça düşer)</label>
            <label className="check"><input type="radio" checked={m.budget_use === "within"} onChange={() => setM({ ...m, budget_use: "within", budget_within_minutes: m.budget_within_minutes ?? 60 })} /> İlk açtıktan sonra … içinde</label>
            {m.budget_use === "within" && (
              <div className="row gap-xs wrap" style={{ alignItems: "center", paddingLeft: 28 }}>
                {[60, 120, 180].map((x) => <button key={x} type="button" className={`chip-btn ${m.budget_within_minutes === x ? "on" : ""}`} onClick={() => setM({ ...m, budget_within_minutes: x })}>{x / 60} sa</button>)}
                <input className="mini" type="number" min={1} value={m.budget_within_minutes ?? 60} onChange={(e) => setM({ ...m, budget_within_minutes: Math.max(1, Number(e.target.value) || 1) })} aria-label="dk" />
                <span className="muted tiny">dk</span>
              </div>
            )}
            <label className="check"><input type="radio" checked={m.budget_use === "range"} onChange={() => setM({ ...m, budget_use: "range", budget_range_start: m.budget_range_start ?? "07:00", budget_range_end: m.budget_range_end ?? "08:00" })} /> Sadece şu saatler arasında</label>
            {m.budget_use === "range" && (
              <div className="row gap-s wrap" style={{ alignItems: "center", paddingLeft: 28 }}>
                <TimeField value={(m.budget_range_start ?? "07:00").slice(0, 5)} onChange={(v) => setM({ ...m, budget_range_start: v })} label="Başlangıç" />
                <span className="small muted">–</span>
                <TimeField value={(m.budget_range_end ?? "08:00").slice(0, 5)} onChange={(v) => setM({ ...m, budget_range_end: v })} label="Bitiş" />
              </div>
            )}
            <label className="check"><input type="radio" checked={m.budget_use === "clock"} onChange={() => setM({ ...m, budget_use: "clock" })} /> Saat gibi: ilk açınca durmadan akar</label>
            <label className="check">
              <input type="checkbox" checked={m.counts_toward_daily} onChange={(e) => setM({ ...m, counts_toward_daily: e.target.checked })} />
              Kullanılan süre günlük süreden de düşsün
            </label>
          </>)}
          {b === "timed" && <p className="muted small">Ne kadar süre olacağı, bu profili kullanan her bölümün kendi süre kutusunda yazılır (0 = süre yok, boş = sınırsız).</p>}
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
          <h2>Açık olanlar <Info>Bir gruba basınca o gruptaki bütün uygulamalar bu profilde açılır (ör. “Kurallara göre”: uygulama ayarında Durum'u “Kurallara göre” olanların hepsi). İstersen aşağıdan tek tek de ekleyebilirsin. “Her zaman açık” uygulamalar zaten hep açık ve süreden düşmez.</Info></h2>
          <div className="row gap-xs wrap">
            {(["always_open", "unlimited", "timed"] as AppGroup[]).map((g) => (
              <button key={g} className={`chip ${m.allowed_groups.includes(g) ? "on" : ""}`} onClick={() => toggleGroup(g)}>
                {g === "timed" ? "Kurallara göre" : GROUP_LABEL[g]}
              </button>
            ))}
          </div>
          {(
            <label className="check">
              <input type="checkbox" checked={m.others_blocked} onChange={(e) => setM({ ...m, others_blocked: e.target.checked })} />
              Profil boyunca diğer uygulamalar kapalı
            </label>
          )}
          {m.budget_minutes != null && (m.allowed_groups.length > 0 || m.allowed_packages.length > 0) && (() => {
            const caps = m.app_caps ?? {};
            const share = Object.keys(caps).length > 0;
            const keys = [...m.allowed_groups.filter((g) => g !== "always_open").map((g) => `group:${g}`), ...m.allowed_packages];
            const label = (k: string) => (k.startsWith("group:") ? (k === "group:timed" ? "Kurallara göre (grup)" : `${GROUP_LABEL[k.slice(6) as AppGroup]} (grup)`) : apps.find((a) => a.package === k)?.label ?? k);
            return (
              <div className="stack-s">
                <span className="pop-label">{m.budget_minutes} DK NASIL KULLANILSIN</span>
                <label className="check"><input type="radio" checked={!share} onChange={() => setM({ ...m, app_caps: {} })} /> Hepsi ortak: seçili uygulamalar {m.budget_minutes} dakikayı birlikte kullanır</label>
                <label className="check"><input type="radio" checked={share} onChange={() => setM({ ...m, app_caps: Object.fromEntries(keys.slice(0, 1).map((k) => [k, Math.min(m.budget_minutes!, 5)])) })} /> Paylaştır: her birine en fazla</label>
                {share && keys.map((k) => (
                  <div key={k} className="row between" style={{ alignItems: "center", gap: 8, paddingLeft: 28 }}>
                    <span className="small">{label(k)}</span>
                    <span className="row gap-xs" style={{ alignItems: "center" }}>
                      <span className="muted tiny">en fazla</span>
                      <input className="mini" type="number" min={0} max={m.budget_minutes!} value={caps[k] ?? ""} placeholder="—"
                        onChange={(e) => { const v = Number(e.target.value); const n = { ...caps }; if (v > 0) n[k] = Math.min(v, m.budget_minutes!); else delete n[k]; setM({ ...m, app_caps: n }); }} />
                      <span className="muted tiny">dk</span>
                    </span>
                  </div>
                ))}
                {share && <p className="muted tiny" style={{ margin: 0, paddingLeft: 28 }}>Boş = sınır yok. Toplam yine {m.budget_minutes} dakikayı geçmez.</p>}
              </div>
            );
          })()}
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

      {(
        <div className="card">
          <h2>Diğer</h2>
          <label className="field">
            <span>Öncelik (çakışmada büyük kazanır)</span>
            <input type="number" value={m.priority} onChange={(e) => setM({ ...m, priority: Number(e.target.value) })} />
          </label>
        </div>
      )}

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
