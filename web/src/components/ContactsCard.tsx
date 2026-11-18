import { useCallback, useEffect, useState } from "react";
import { Info } from "./Info";
import { useFamily } from "../lib/family";
import { errorText, supabase } from "../lib/supabase";

type Contact = { id: string; family_id: string; name: string; emoji: string; value: string; child_ids: string[]; sort: number };
type Draft = { id?: string; name: string; emoji: string; value: string; child_ids: string[] };

/** Ayarlar → 📇 Kişiler: çocukların Orbit ana ekranında görünen numaralar ve önemli bilgiler */
export default function ContactsCard() {
  const fam = useFamily();
  const [list, setList] = useState<Contact[]>([]);
  const [edit, setEdit] = useState<Draft | null>(null);
  const [err, setErr] = useState("");

  const load = useCallback(async () => {
    const { data, error } = await supabase.from("contacts").select("*").eq("family_id", fam.familyId).order("sort").order("created_at");
    if (error) setErr(errorText(error));
    setList((data ?? []) as Contact[]);
  }, [fam.familyId]);
  useEffect(() => { load(); }, [load]);

  async function save() {
    if (!edit || !edit.name.trim() || !edit.value.trim()) { setErr("Ad ve numara/bilgi gerekli"); return; }
    const row = { name: edit.name.trim(), emoji: edit.emoji.trim() || "👤", value: edit.value.trim(), child_ids: edit.child_ids };
    const { error } = edit.id
      ? await supabase.from("contacts").update(row).eq("id", edit.id)
      : await supabase.from("contacts").insert({ ...row, family_id: fam.familyId, sort: list.length });
    if (error) { setErr(errorText(error)); return; }
    setErr(""); setEdit(null); load();
  }

  async function remove(c: Contact) {
    if (!confirm(`“${c.name}” silinsin mi?`)) return;
    const { error } = await supabase.from("contacts").delete().eq("id", c.id);
    if (error) setErr(errorText(error)); else load();
  }

  async function move(i: number, d: number) {
    const a = [...list]; const j = i + d;
    if (j < 0 || j >= a.length) return;
    [a[i], a[j]] = [a[j], a[i]];
    setList(a);
    await Promise.all(a.map((x, k) => supabase.from("contacts").update({ sort: k }).eq("id", x.id)));
  }

  const kids = fam.children;
  const toggle = (id: string) => edit && setEdit({ ...edit, child_ids: edit.child_ids.includes(id) ? edit.child_ids.filter((x) => x !== id) : [...edit.child_ids, id] });

  return (
    <div className="card">
      <h2>📇 Kişiler <Info>Anne, baba numarası ya da unutmamaları gereken bir bilgi (adres, okul numarası…). Seçtiğin çocukların telefonunda Orbit ana ekranında, kilitliyken de görünür. Arama yok, sadece bilgi.</Info></h2>
      {err && <p className="error">{err}</p>}
      {list.length === 0 && !edit && <p className="muted">Henüz kişi yok.</p>}
      {list.map((c, i) => (
        <div key={c.id} className="web-video">
          <span style={{ fontSize: 20, width: 28 }}>{c.emoji}</span>
          <span className="grow small">
            <b>{c.name}</b> · {c.value}
            <span className="muted tiny"> · {kids.filter((k) => c.child_ids.includes(k.id)).map((k) => k.name).join(", ") || "kimse seçilmedi"}</span>
          </span>
          <button className="link-btn" onClick={() => move(i, -1)} aria-label="Yukarı">▲</button>
          <button className="link-btn" onClick={() => move(i, 1)} aria-label="Aşağı">▼</button>
          <button className="link-btn" onClick={() => setEdit({ id: c.id, name: c.name, emoji: c.emoji, value: c.value, child_ids: c.child_ids })} aria-label="Düzenle">✎</button>
          <button className="link-btn danger" onClick={() => remove(c)} aria-label="Sil">✕</button>
        </div>
      ))}
      {edit ? (
        <div className="stack" style={{ gap: 8, marginTop: 10 }}>
          <div className="row gap-s">
            <input className="mini" style={{ width: 56, textAlign: "center", fontSize: 20 }} value={edit.emoji} maxLength={4} onChange={(e) => setEdit({ ...edit, emoji: e.target.value })} aria-label="Simge" />
            <input className="grow" value={edit.name} placeholder="Ad (ör. Anne)" onChange={(e) => setEdit({ ...edit, name: e.target.value })} />
          </div>
          <input value={edit.value} placeholder="Numara ya da bilgi (ör. +49 151 2345678)" onChange={(e) => setEdit({ ...edit, value: e.target.value })} />
          <div className="row gap-s" style={{ flexWrap: "wrap" }}>
            {kids.map((k) => (
              <label key={k.id} className="web-toggle"><input type="checkbox" checked={edit.child_ids.includes(k.id)} onChange={() => toggle(k.id)} /><span>{k.name}</span></label>
            ))}
          </div>
          <div className="row between">
            <button className="btn ghost small" onClick={() => { setEdit(null); setErr(""); }}>Vazgeç</button>
            <button className="btn small" onClick={save}>Kaydet</button>
          </div>
        </div>
      ) : (
        <button className="btn small" style={{ marginTop: 10 }} onClick={() => setEdit({ name: "", emoji: "👤", value: "", child_ids: kids.map((k) => k.id) })}>＋ Kişi ekle</button>
      )}
    </div>
  );
}
