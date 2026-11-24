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
  // Saat aralığını buradan değiştir (gün profilindeki bölümün saati)
  async function setTimes(u: (typeof usedIn)[number], start: string, end: string) {
    const { error } = await supabase.from(u.table).update({ start_time: start, end_time: end }).eq("id", u.key);
    if (error) setErr(errorText(error));
    await fam.reload();
  }
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
          <h2>Orbit ekranları <Info>Bu profil sürerken çocuğun Orbit uygulamasında hangi ekranların açık olacağı. Hepsi seçiliyse kısıtlama yok. "Günüm" her zaman açıktır.</Info></h2>
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
          <h2>⏱ Saat aralığı ve süre <Info>Saat aralığı: bu profilin geçerli olduğu saatler (gün profilindeki bölüm de aynı anda değişir). Kullanma süresi: bu aralıkta seçili uygulamaların toplam kullanılabileceği dakika; ana ekranda sol halkada görünür.</Info></h2>
          <span className="pop-label">SAAT ARALIĞI</span>
          {usedIn.length === 0 && <p className="muted small">Henüz hiçbir saatte kullanılmıyor. Gün profilinde (Kurallar → gün profili) bir bölümün türünü “{m.name || "bu profil"}” yap.</p>}
          {usedIn.map((u) => (
            <div key={u.key} className="stack-s mode-range">
              <span className="small"><b>{u.prof}</b>{u.name ? ` · ${u.name}` : ""}</span>
              <div className="row gap-s wrap" style={{ alignItems: "center" }}>
                <TimeField value={u.start} onChange={(v) => setTimes(u, v, u.end)} label="Başlangıç" />
                <span className="small muted">–</span>
                <TimeField value={u.end} onChange={(v) => setTimes(u, u.start, v)} label="Bitiş" />
              </div>
            </div>
          ))}
          <span className="pop-label">BU ARALIKTA KULLANMA SÜRESİ</span>
          {<>
            <label className="check">
              <input type="checkbox" checked={m.budget_minutes == null} onChange={(e) => setM({ ...m, budget_minutes: e.target.checked ? null : 30 })} />
              Sınırsız (aralık boyunca istediği kadar)
            </label>
            {m.budget_minutes != null && (
              <label className="field">
                <span>Toplam kullanma süresi (dk)</span>
                <input type="number" min={0} value={m.budget_minutes} onChange={(e) => setM({ ...m, budget_minutes: Number(e.target.value) })} />
              </label>
            )}
            <label className="check">
              <input type="checkbox" checked={m.counts_toward_daily} onChange={(e) => setM({ ...m, counts_toward_daily: e.target.checked })} />
              Kullanılan süre günlük süreden de düşsün
            </label>
          </>}
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
