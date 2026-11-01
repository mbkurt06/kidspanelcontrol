import { useCallback, useEffect, useMemo, useState } from "react";
import { DateField, TimeField } from "../components/DateTime";
import { useFamily } from "../lib/family";
import { errorText, supabase } from "../lib/supabase";
import { dateText, todayISO } from "../lib/util";
import type { AgendaItem, AgendaKind } from "../lib/types";
import { Icon } from "../components/Icon";

const KIND: Record<AgendaKind, string> = { homework: "📚 Ödev", exam: "📝 Sınav", payment: "💶 Ödeme", event: "📅 Program" };

export default function Agenda() {
  const fam = useFamily();
  const [items, setItems] = useState<AgendaItem[]>([]);
  const [childFilter, setChildFilter] = useState("all");
  const [kind, setKind] = useState<AgendaKind>("homework");
  const [childId, setChildId] = useState("");
  const [title, setTitle] = useState("");
  const [note, setNote] = useState("");
  const [dueDate, setDueDate] = useState(todayISO());
  const [dueTime, setDueTime] = useState("");
  const [amount, setAmount] = useState("");
  const [currency, setCurrency] = useState("EUR");
  const [err, setErr] = useState("");

  const load = useCallback(async () => {
    const { data, error } = await supabase.from("agenda_items").select("*").order("due_date").order("due_time");
    if (error) return setErr(errorText(error));
    setItems((data ?? []) as AgendaItem[]);
  }, []);

  useEffect(() => { if (!childId && fam.children[0]) setChildId(fam.children[0].id); }, [childId, fam.children]);
  useEffect(() => { load(); }, [load]);

  const visible = useMemo(() => childFilter === "all" ? items : items.filter((x) => x.child_id === childFilter), [items, childFilter]);

  async function add() {
    setErr("");
    if (!childId || !title.trim() || !dueDate) return setErr("Çocuk, başlık ve son tarih gerekli.");
    const { error } = await supabase.from("agenda_items").insert({
      family_id: fam.familyId, child_id: childId, kind, title: title.trim(), note: note.trim() || null,
      due_date: dueDate, due_time: dueTime || null, amount: kind === "payment" && amount ? Number(amount) : null,
      currency: currency.trim().toUpperCase() || "EUR",
    });
    if (error) return setErr(errorText(error));
    setTitle(""); setNote(""); setAmount(""); setDueTime("");
    load();
  }

  async function toggle(item: AgendaItem) {
    const { error } = await supabase.from("agenda_items").update({ status: item.status === "done" ? "open" : "done", completed_at: item.status === "done" ? null : new Date().toISOString() }).eq("id", item.id);
    if (error) setErr(errorText(error)); else load();
  }

  async function remove(item: AgendaItem) {
    if (!confirm(`"${item.title}" ajandadan silinsin mi?`)) return;
    const { error } = await supabase.from("agenda_items").delete().eq("id", item.id);
    if (error) setErr(errorText(error)); else load();
  }

  return <div className="page">
    <header className="page-head"><h1>🗓 Ajanda</h1><span /></header>
    <p className="muted small">Ödev, sınav, ödeme ve programları giriş tarihiyle birlikte takip et.</p>
    {err && <p className="error">{err}</p>}

    <div className="card">
      <h2>Yeni kayıt</h2>
      <div className="row gap-xs wrap">{(Object.keys(KIND) as AgendaKind[]).map((k) => <button key={k} className={`chip small ${kind === k ? "on" : ""}`} onClick={() => setKind(k)}>{KIND[k]}</button>)}</div>
      <label className="field"><span>Çocuk</span><select value={childId} onChange={(e) => setChildId(e.target.value)}>{fam.children.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
      <label className="field"><span>Başlık</span><input value={title} onChange={(e) => setTitle(e.target.value)} placeholder={kind === "payment" ? "Almanca dersi ücreti" : "Matematik ödevi"} /></label>
      <label className="field"><span>Not</span><input value={note} onChange={(e) => setNote(e.target.value)} placeholder="İsteğe bağlı" /></label>
      <div className="grid2"><div className="field"><span>Son tarih</span><DateField value={dueDate} onChange={setDueDate} /></div><div className="field"><span>Saat</span><TimeField clearable value={dueTime} onChange={setDueTime} label="Saat" /></div></div>
      {kind === "payment" && <div className="row gap-s"><label className="field grow"><span>Tutar</span><input type="number" min="0" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="3" /></label><label className="field" style={{ width: 100 }}><span>Para birimi</span><input maxLength={3} value={currency} onChange={(e) => setCurrency(e.target.value)} /></label></div>}
      <button className="btn primary" onClick={add}><Icon name="plus" size={16} /> Ajandaya ekle</button>
    </div>

    <div className="row between"><h2 className="section-title">Kayıtlar</h2><select value={childFilter} onChange={(e) => setChildFilter(e.target.value)}><option value="all">Tüm çocuklar</option>{fam.children.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></div>
    <div className="stack">{visible.map((item) => <div className={`card ${item.status === "done" ? "soft" : ""}`} key={item.id}>
      <div className="row gap-s"><span className="dot" style={{ background: fam.children.find((c) => c.id === item.child_id)?.color ?? "#888" }} /><div className="grow"><b style={{ textDecoration: item.status === "done" ? "line-through" : undefined }}>{KIND[item.kind]} · {item.title}</b><div className="muted small">{fam.children.find((c) => c.id === item.child_id)?.name} · Girildi: {new Date(item.entered_at).toLocaleDateString("tr-TR")} · Son tarih: {dateText(item.due_date)}{item.due_time ? ` ${item.due_time.slice(0, 5)}` : ""}</div>{item.note && <div className="muted small">{item.note}</div>}{item.kind === "payment" && item.amount != null && <div className="small">{item.amount} {item.currency}</div>}</div><button className="btn small" onClick={() => toggle(item)}>{item.status === "done" ? "Açık yap" : "Tamamlandı"}</button><button className="icon-btn" aria-label="Sil" onClick={() => remove(item)}><Icon name="trash" size={18} /></button></div>
    </div>)}{!visible.length && <p className="muted small">Ajandada kayıt yok.</p>}</div>
  </div>;
}
