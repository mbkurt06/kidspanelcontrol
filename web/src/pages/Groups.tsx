import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useFamily } from "../lib/family";
import { errorText, supabase } from "../lib/supabase";
import { suggestGroup } from "../lib/sections";
import { Icon } from "../components/Icon";
import { Info } from "../components/Info";

type AppRow = { package: string; label: string; category: string | null; is_system: boolean };

const COLORS = ["#FF7A59", "#E85D9B", "#F2B134", "#2BB673", "#4F7CFF", "#9AA0C3", "#7C5CFF", "#3FA7D6"];

/** Uygulama grupları: ailede ortak. Bir uygulama en fazla bir grupta olur. */
export default function Groups() {
  const fam = useFamily();
  const [apps, setApps] = useState<AppRow[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  const [err, setErr] = useState("");
  const [msg, setMsg] = useState("");
  const [showSystem, setShowSystem] = useState(false);

  const load = useCallback(async () => {
    const { data, error } = await supabase.from("child_apps").select("package,label,category,is_system").eq("installed", true).order("label");
    if (error) setErr(errorText(error));
    const seen = new Map<string, AppRow>();
    for (const a of (data ?? []) as AppRow[]) if (!seen.has(a.package)) seen.set(a.package, a);
    setApps([...seen.values()]);
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  const visible = useMemo(() => apps.filter((a) => showSystem || !a.is_system), [apps, showSystem]);
  const ungrouped = visible.filter((a) => !fam.members[a.package]);

  async function setGroup(pkg: string, groupId: string | null) {
    setErr("");
    const { error } = groupId
      ? await supabase.from("app_group_members").upsert({ family_id: fam.familyId, package: pkg, group_id: groupId })
      : await supabase.from("app_group_members").delete().eq("package", pkg);
    if (error) setErr(errorText(error));
    fam.reload();
  }

  async function addGroup() {
    const name = prompt("Grup adı");
    if (!name?.trim()) return;
    const { error } = await supabase
      .from("app_groups")
      .insert({ family_id: fam.familyId, name: name.trim(), color: COLORS[fam.groups.length % COLORS.length], sort_order: fam.groups.length });
    if (error) setErr(errorText(error));
    fam.reload();
  }

  async function rename(id: string, old: string) {
    const name = prompt("Yeni ad", old);
    if (!name?.trim() || name === old) return;
    await supabase.from("app_groups").update({ name: name.trim() }).eq("id", id);
    fam.reload();
  }

  async function removeGroup(id: string, name: string) {
    if (!confirm(`"${name}" grubu silinsin mi? İçindeki uygulamalar gruba girmemiş olur, bu grubun kuralları silinir.`)) return;
    await supabase.from("app_groups").delete().eq("id", id);
    fam.reload();
  }

  async function autoFill() {
    setMsg("");
    const byName = new Map(fam.groups.map((g) => [g.name.toLocaleLowerCase("tr"), g.id]));
    const rows = ungrouped
      .map((a) => {
        const s = suggestGroup(a.package, a.label, a.category);
        const gid = s ? byName.get(s.toLocaleLowerCase("tr")) : undefined;
        return gid ? { family_id: fam.familyId, package: a.package, group_id: gid } : null;
      })
      .filter((r): r is { family_id: string | null; package: string; group_id: string } => r !== null);
    if (!rows.length) return setMsg("Önerilecek uygulama bulunamadı.");
    const { error } = await supabase.from("app_group_members").upsert(rows);
    if (error) return setErr(errorText(error));
    setMsg(`${rows.length} uygulama gruplara yerleştirildi. Kontrol edip gerekirse değiştir.`);
    fam.reload();
  }

  return (
    <div className="page">
      <header className="page-head">
        <Link to="/rules" className="icon-btn" aria-label="Geri">
          <Icon name="back" />
        </Link>
        <h1>Uygulama grupları</h1>
        <button className="btn small" onClick={addGroup}>
          <Icon name="plus" size={16} /> Grup
        </button>
      </header>
      {err && <p className="error">{err}</p>}
      <h2 className="section-title">Uygulama grupları <Info>Gruplar iki çocukta ortaktır. Her gün tipinde grubun açık, süreli veya kapalı olacağını seçersin.</Info></h2>

      {ungrouped.length > 0 && (
        <div className="card attention">
          <h2>Gruba girmemiş ({ungrouped.length}) <Info>Bu uygulamalar bölümlerin “Diğer uygulamalar” kuralına uyar.</Info></h2>
          <button className="btn" onClick={autoFill}>
            Önerilere göre yerleştir
          </button>
          {msg && <p className="ok small">{msg}</p>}
          {ungrouped.map((a) => (
            <AppLine key={a.package} app={a} value={null} onChange={(g) => setGroup(a.package, g)} />
          ))}
        </div>
      )}

      {fam.groups.map((g) => {
        const list = visible.filter((a) => fam.members[a.package] === g.id);
        const isOpen = open === g.id;
        return (
          <div className="card" key={g.id}>
            <div className="row gap-s" style={{ alignItems: "center" }}>
              <span className="dot" style={{ background: g.color }} />
              <button className="link grow" style={{ textAlign: "left" }} onClick={() => setOpen(isOpen ? null : g.id)}>
                <b>{g.name}</b> <span className="muted small">· {list.length} uygulama</span>
              </button>
              <button className="icon-btn" aria-label="Yeniden adlandır" onClick={() => rename(g.id, g.name)}>
                ✎
              </button>
              <button className="icon-btn" aria-label="Grubu sil" onClick={() => removeGroup(g.id, g.name)}>
                <Icon name="trash" size={18} />
              </button>
            </div>
            {isOpen && (
              <>
                {!list.length && <p className="muted small">Bu grupta uygulama yok.</p>}
                {list.map((a) => (
                  <AppLine key={a.package} app={a} value={g.id} onChange={(x) => setGroup(a.package, x)} />
                ))}
              </>
            )}
          </div>
        );
      })}
      <label className="check">
        <input type="checkbox" checked={showSystem} onChange={(e) => setShowSystem(e.target.checked)} /> Sistem uygulamalarını da göster
      </label>
    </div>
  );
}

function AppLine({ app, value, onChange }: { app: AppRow; value: string | null; onChange: (g: string | null) => void }) {
  const fam = useFamily();
  return (
    <div className="app-row">
      <div className="grow">
        <b>{app.label}</b>
        <div className="muted tiny">{app.package}</div>
      </div>
      <select value={value ?? ""} onChange={(e) => onChange(e.target.value || null)} aria-label="Grup">
        <option value="">Grupsuz</option>
        {fam.groups.map((g) => (
          <option key={g.id} value={g.id}>
            {g.name}
          </option>
        ))}
      </select>
    </div>
  );
}
