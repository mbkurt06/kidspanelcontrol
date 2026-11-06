import { useCallback, useEffect, useState } from "react";
import { DateField, TimeField } from "../components/DateTime";
import { useFamily } from "../lib/family";
import { errorText, supabase } from "../lib/supabase";
import { agendaDateText, todayISO } from "../lib/util";
import type { AgendaItem, Task } from "../lib/types";
import { useNavigate } from "react-router-dom";
import { Icon } from "../components/Icon";
import { ChildChips } from "../components/ChildChips";

export default function Agenda() {
  const fam = useFamily();
  const nav = useNavigate();
  const [items, setItems] = useState<AgendaItem[]>([]);
  const [tasks, setTasks] = useState<Record<string, Task>>({});
  const [open, setOpen] = useState<AgendaItem | null>(null);
  const [form, setForm] = useState(false);
  const [err, setErr] = useState("");
  const load = useCallback(async () => {
    const { data, error } = await supabase.from("agenda_items").select("*").order("due_date").order("due_time");
    if (error) return setErr(errorText(error));
    const list = (data ?? []) as AgendaItem[];
    setItems(list);
    const ids = [...new Set(list.map((x) => x.task_id).filter(Boolean))] as string[];
    if (ids.length) {
      const { data: t } = await supabase.from("tasks").select("*").in("id", ids);
      setTasks(Object.fromEntries(((t ?? []) as Task[]).map((x) => [x.id, x])));
    }
  }, []);
  useEffect(() => { load(); }, [load]);
  const grouped = fam.visibleChildren.map((child) => ({ child, items: items.filter((x) => x.child_id === child.id) }));

  async function toggle(item: AgendaItem) {
    const { error } = await supabase.from("agenda_items").update({ status: item.status === "done" ? "open" : "done", completed_at: item.status === "done" ? null : new Date().toISOString() }).eq("id", item.id);
    if (error) setErr(errorText(error)); else { setOpen(null); load(); }
  }
  async function remove(item: AgendaItem) {
    if (!confirm(`"${item.title}" ajandadan silinsin mi?`)) return;
    const { error } = await supabase.from("agenda_items").delete().eq("id", item.id);
    if (error) setErr(errorText(error)); else { setOpen(null); load(); }
  }

  return <div className="page">
    <header className="page-head"><h1>Ajanda</h1></header>
    <ChildChips />
    {err && <p className="error">{err}</p>}
    {!grouped.some((g) => g.items.length) && <p className="muted small">Ajandada kayıt yok.</p>}
    {grouped.map(({ child, items: list }) => <section className="agenda-group" key={child.id}>
      <h2>{child.name}</h2>
      {!list.length && <p className="muted tiny">Kayıt yok</p>}
      {list.map((item) => <button className={`agenda-row ${item.status === "done" ? "done" : ""}`} key={item.id} onClick={() => setOpen(item)}>
        <span className={`check-box ${item.status === "done" ? "checked" : ""}`} aria-hidden="true">{item.status === "done" ? "✓" : ""}</span>
        <span className="agenda-copy"><span className="muted tiny">{new Date(item.entered_at).toLocaleDateString("tr-TR")} · {new Date(item.entered_at).toLocaleTimeString("tr-TR", { hour: "2-digit", minute: "2-digit" })}</span><b>{item.title}</b><span className="muted tiny">{agendaDateText(item.due_date)}{item.due_time ? ` · ${item.due_time.slice(0, 5)}` : ""}</span></span>
        {item.task_id && tasks[item.task_id] ? (
          <span className="task-tag" title="Bu girdi bir görev">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden="true"><rect x="5" y="4" width="14" height="17" rx="2" /><path d="M9 10h6M9 14h6" /></svg>
            Görev{tasks[item.task_id].reward_minutes ? ` · +${tasks[item.task_id].reward_minutes} dk` : " · ödülsüz"}
          </span>
        ) : item.status !== "done" ? (
          <span className="task-tag ghost">Göreve dönüştür</span>
        ) : null}
        <Icon name="chevron" size={18} />
      </button>)}
    </section>)}
    {form && <AgendaForm defaultChildren={fam.visibleChildren.map((c) => c.id)} allChildren={fam.children} onClose={() => setForm(false)} onSaved={() => { setForm(false); load(); }} />}
    {open && <AgendaDetail item={open} task={open.task_id ? tasks[open.task_id] : undefined} childName={fam.children.find((c) => c.id === open.child_id)?.name ?? ""} onClose={() => setOpen(null)} onToggle={() => toggle(open)} onRemove={() => remove(open)} onConvert={() => nav(`/tasks/new?agenda=${open.id}`)} onOpenTask={() => open.task_id && nav(`/tasks/${open.task_id}`)} />}
    <button className="agenda-fab" aria-label="Ajandaya kayıt ekle" onClick={() => setForm(true)}>+</button>
  </div>;
}

function AgendaForm({ defaultChildren, allChildren, onClose, onSaved }: { defaultChildren: string[]; allChildren: { id: string; name: string }[]; onClose: () => void; onSaved: () => void }) {
  const fam = useFamily();
  const [children, setChildren] = useState(defaultChildren.length ? defaultChildren : allChildren.map((c) => c.id));
  const [title, setTitle] = useState("");
  const [date, setDate] = useState(todayISO());
  const [time, setTime] = useState("");
  const [note, setNote] = useState("");
  const [extra, setExtra] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function save() {
    if (!children.length || !title.trim() || !date) return setError("Çocuk, başlık ve tarih gerekli.");
    setBusy(true); setError("");
    const { error: e } = await supabase.from("agenda_items").insert(children.map((child_id) => ({ family_id: fam.familyId, child_id, kind: "event", title: title.trim(), due_date: date, due_time: time || null, note: note.trim() || null })));
    setBusy(false);
    if (e) setError(errorText(e)); else onSaved();
  }
  return <div className="sheet-backdrop" onClick={onClose}><div className="sheet compact-sheet" onClick={(e) => e.stopPropagation()}>
    <div className="row between"><h2>Ajandaya ekle</h2><button className="icon-btn" onClick={onClose} aria-label="Kapat">×</button></div>
    <div className="row gap-xs wrap">{allChildren.map((c) => <button key={c.id} className={`chip small ${children.includes(c.id) ? "on" : ""}`} onClick={() => setChildren((v) => v.includes(c.id) ? v.filter((id) => id !== c.id) : [...v, c.id])}>{c.name}</button>)}</div>
    <input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Başlık" />
    <DateField value={date} onChange={setDate} />
    <button className="icon-btn disclosure" onClick={() => setExtra((v) => !v)} aria-label="Ek alanlar"><span className={`collapse-arrow${extra ? " open" : ""}`} aria-hidden="true" /></button>
    {extra && <div className="stack-s"><TimeField clearable value={time} onChange={setTime} label="Saat" /><input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Açıklama" /></div>}
    {error && <p className="error small">{error}</p>}
    <button className="btn primary" disabled={busy} onClick={save}>{busy ? "Ekleniyor…" : "Ekle"}</button>
  </div></div>;
}

function AgendaDetail({ item, task, childName, onClose, onToggle, onRemove, onConvert, onOpenTask }: { item: AgendaItem; task?: Task; childName: string; onClose: () => void; onToggle: () => void; onRemove: () => void; onConvert: () => void; onOpenTask: () => void }) {
  return <div className="sheet-backdrop" onClick={onClose}><div className="sheet compact-sheet" onClick={(e) => e.stopPropagation()}>
    <div className="row between"><h2>{item.title}</h2><button className="icon-btn" onClick={onClose} aria-label="Kapat">×</button></div>
    <div className="muted small">{childName} · {new Date(item.entered_at).toLocaleDateString("tr-TR")} {new Date(item.entered_at).toLocaleTimeString("tr-TR", { hour: "2-digit", minute: "2-digit" })}'de yazdı</div>
    <div className="detail-line">{agendaDateText(item.due_date)}{item.due_time ? ` · ${item.due_time.slice(0, 5)}` : ""}</div>
    {item.note && <p className="muted small">{item.note}</p>}
    {task ? (
      <div className="card soft">
        <span className="pop-label">BU GİRDİ BİR GÖREV</span>
        <span className="small"><b>{task.title}</b> · {task.reward_minutes ? `+${task.reward_minutes} dk` : "ödülsüz"}. Çocuk görevi yapıp sen onaylayınca burada yapıldı olur.</span>
      </div>
    ) : item.status !== "done" ? (
      <span className="muted tiny">Göreve dönüştürünce bütün görev seçenekleri (ödül, fotoğraf, kamera kaydı, grup…) açılır. Girdi ajandada kalır.</span>
    ) : null}
    <div className="extra-actions">
      <button className="icon-pill" aria-label="Sil" onClick={onRemove}><Icon name="trash" size={16} /></button>
      {!task && <button className="pill-btn" onClick={onToggle}>{item.status === "done" ? "Açık yap" : "Tamamlandı"}</button>}
      <span className="grow" />
      {task ? <button className="pill-btn primary" onClick={onOpenTask}>Göreve git</button> : item.status !== "done" && <button className="pill-btn primary" onClick={onConvert}>Göreve dönüştür</button>}
    </div>
  </div></div>;
}
