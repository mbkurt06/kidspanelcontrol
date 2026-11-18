import { useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import Lightbox from "../components/Lightbox";
import { useFamily } from "../lib/family";
import { errorText, supabase } from "../lib/supabase";
import { mediaLinks } from "../lib/media";

/** Notlar: ortak ders listesi (sınıf düzeyine göre), not tablosu, onay ve ders ağırlıkları */
type Kind = "exam" | "oral" | "test" | "homework";
const KINDS: Kind[] = ["exam", "oral", "test", "homework"];
const KIND_TEXT: Record<Kind, string> = { exam: "Sınav", oral: "Sözlü", test: "Test", homework: "Ödev" };
type Subject = { id: string; family_id: string; grade_level: number; name: string; color: string | null; sort: number; weights: Partial<Record<Kind, number>>; hidden_for: string[] };
type Grade = {
  id: string; child_id: string; subject_id: string; grade_level: number; kind: Kind; grade: string; value: number; taken_on: string;
  note: string | null; photos: string[]; status: "pending" | "approved" | "rejected"; reject_note: string | null; created_at: string;
};
const COLORS = ["#378ADD", "#D85A30", "#1D9E75", "#7F77DD", "#D4537E", "#BA7517", "#639922", "#888780"];
const show = (g: string) => g.replace("-", "−");
const dShort = (d: string) => `${d.slice(8, 10)}.${d.slice(5, 7)}.${d.slice(0, 4)}`;
const fmt = (v: number | null) => (v == null ? "—" : v.toFixed(1).replace(".", ","));

/** Ağırlıklı ortalama: önce türlerin kendi ortalaması, sonra yüzdeler; notu olmayan türün payı diğerlerine dağılır, ayar yoksa düz ortalama */
export function subjectAverage(list: Grade[], weights: Partial<Record<Kind, number>>): number | null {
  const ok = list.filter((g) => g.status === "approved");
  if (!ok.length) return null;
  let sum = 0, w = 0;
  for (const k of KINDS) {
    const xs = ok.filter((g) => g.kind === k);
    const wk = Number(weights[k] ?? 0);
    if (!xs.length || wk <= 0) continue;
    sum += (xs.reduce((a, g) => a + Number(g.value), 0) / xs.length) * wk;
    w += wk;
  }
  if (w > 0) return sum / w;
  return ok.reduce((a, g) => a + Number(g.value), 0) / ok.length;
}

export default function GradesTab({ childId }: { childId: string }) {
  const fam = useFamily();
  const child = fam.children.find((c) => c.id === childId);
  const [level, setLevel] = useState<number | null>((child as { grade_level?: number | null } | undefined)?.grade_level ?? null);
  const [viewLevel, setViewLevel] = useState<number | null>(level);
  const [subjects, setSubjects] = useState<Subject[]>([]);
  const [grades, setGrades] = useState<Grade[]>([]);
  const [edit, setEdit] = useState(false);
  const [review, setReview] = useState<Grade | null>(null);
  const [subject, setSubject] = useState<Subject | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [s, g] = await Promise.all([
      supabase.from("subjects").select("*").order("sort").order("created_at"),
      supabase.from("grades").select("*").eq("child_id", childId).order("taken_on").order("created_at"),
    ]);
    setSubjects((s.data ?? []) as Subject[]);
    setGrades((g.data ?? []) as Grade[]);
  }, [childId]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    const l = (child as { grade_level?: number | null } | undefined)?.grade_level ?? null;
    setLevel(l);
    setViewLevel(l);
  }, [childId]); // eslint-disable-line react-hooks/exhaustive-deps

  const levels = useMemo(() => [...new Set([...(level ? [level] : []), ...grades.map((g) => g.grade_level), ...subjects.map((s) => s.grade_level)])].sort((a, b) => b - a), [level, grades, subjects]);
  const lv = viewLevel ?? level;
  const subs = subjects.filter((s) => s.grade_level === lv);
  const mine = subs.filter((s) => !s.hidden_for.includes(childId));
  const gl = grades.filter((g) => g.grade_level === lv && g.status !== "rejected");
  const pending = grades.filter((g) => g.status === "pending");
  // Sütunlar: her türde en çok notu olan derse göre
  const cols = KINDS.map((k) => ({ k, n: Math.max(0, ...mine.map((s) => gl.filter((g) => g.subject_id === s.id && g.kind === k).length)) })).filter((c) => c.n > 0);
  const avgs = mine.map((s) => subjectAverage(gl.filter((g) => g.subject_id === s.id), s.weights)).filter((x): x is number => x != null);
  const overall = avgs.length ? avgs.reduce((a, b) => a + b, 0) / avgs.length : null;

  async function saveLevel(n: number | null) {
    setLevel(n);
    setViewLevel(n);
    const { error } = await supabase.from("children").update({ grade_level: n }).eq("id", childId);
    if (error) setMsg(errorText(error));
    else { setMsg(n ? `${child?.name} · ${n}. sınıf` : "Sınıf kaldırıldı"); fam.reload(); }
  }

  if (!child) return null;
  return (
    <div className="stack">
      <div className="card stack-s">
        <div className="row between" style={{ alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <h2 style={{ margin: 0 }}>Notlar</h2>
          <label className="row" style={{ gap: 6, alignItems: "center" }}>
            <span className="small muted">Sınıfı</span>
            <select value={level ?? ""} onChange={(e) => saveLevel(e.target.value ? Number(e.target.value) : null)}>
              <option value="">seçilmedi</option>
              {Array.from({ length: 13 }, (_, i) => i + 1).map((n) => <option key={n} value={n}>{n}. sınıf</option>)}
            </select>
          </label>
        </div>
        {levels.length > 1 && (
          <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
            {levels.map((n) => (
              <button key={n} type="button" className={`chip ${n === lv ? "on" : ""}`} onClick={() => setViewLevel(n)}>{n}. sınıf</button>
            ))}
          </div>
        )}
        {!level && <p className="small muted">Önce çocuğun sınıfını seç. Dersler ve notlar sınıfa göre tutulur; sınıf değişince yeni notlar yeni tabloya yazılır.</p>}
        {msg && <p className="small muted">{msg}</p>}
      </div>

      {pending.length > 0 && (
        <div className="card stack-s">
          <h3 style={{ margin: 0 }}>Onay bekliyor</h3>
          {pending.map((g) => {
            const s = subjects.find((x) => x.id === g.subject_id);
            return (
              <button key={g.id} type="button" className="app-row" onClick={() => setReview(g)} style={{ textAlign: "left" }}>
                <div className="grow">
                  <b>{s?.name ?? "Ders"} · {KIND_TEXT[g.kind]} · {show(g.grade)}</b>
                  <div className="muted tiny">{dShort(g.taken_on)}{g.photos.length ? ` · ${g.photos.length} sayfa` : " · fotoğraf yok"}{g.note ? ` · ${g.note}` : ""}</div>
                </div>
                <span className="pill-btn">İncele</span>
              </button>
            );
          })}
        </div>
      )}

      {lv != null && (
        <div className="card stack-s">
          <div className="row between" style={{ alignItems: "center" }}>
            <h3 style={{ margin: 0 }}>{lv}. sınıf</h3>
            <button type="button" className="pill-btn" onClick={() => setEdit(true)}>Dersleri düzenle</button>
          </div>
          {!mine.length ? (
            <p className="small muted">{subs.length ? `${child.name} için açık ders yok.` : "Henüz ders eklenmedi. “Dersleri düzenle”den ekle."}</p>
          ) : (
            <div style={{ overflowX: "auto" }}>
              <table className="grade-table">
                <thead>
                  <tr>
                    <th className="gt-sub" />
                    {cols.map((c) => <th key={c.k} colSpan={c.n} className="gt-kind">{KIND_TEXT[c.k]}</th>)}
                    <th className="gt-avg">Ort.</th>
                  </tr>
                  <tr className="gt-num">
                    <th className="gt-sub" />
                    {cols.flatMap((c) => Array.from({ length: c.n }, (_, i) => <th key={`${c.k}${i}`}>{i + 1}</th>))}
                    <th className="gt-avg" />
                  </tr>
                </thead>
                <tbody>
                  {mine.map((s) => {
                    const list = gl.filter((g) => g.subject_id === s.id);
                    const avg = subjectAverage(list, s.weights);
                    return (
                      <tr key={s.id}>
                        <td className="gt-sub"><button type="button" className="gt-sub-btn" onClick={() => setSubject(s)} title="Tüm notlar ve kâğıtlar"><span className="dot" style={{ background: s.color ?? "var(--muted)" }} /> {s.name} ›</button></td>
                        {cols.flatMap((c) => {
                          const xs = list.filter((g) => g.kind === c.k);
                          return Array.from({ length: c.n }, (_, i) => {
                            const g = xs[i];
                            return (
                              <td key={`${c.k}${i}`}>
                                {g ? (
                                  <button type="button" className={`gt-cell ${g.status === "pending" ? "pending" : ""}`} title={`${dShort(g.taken_on)}${g.note ? ` · ${g.note}` : ""}`} onClick={() => setReview(g)}>{show(g.grade)}</button>
                                ) : <span className="muted">·</span>}
                              </td>
                            );
                          });
                        })}
                        <td className="gt-avg"><b className={avg != null && avg >= 3.5 ? "warn-text" : ""}>{fmt(avg)}</b></td>
                      </tr>
                    );
                  })}
                  <tr className="gt-total">
                    <td className="gt-sub muted">Genel</td>
                    {cols.flatMap((c) => Array.from({ length: c.n }, (_, i) => <td key={`${c.k}${i}`} />))}
                    <td className="gt-avg"><b>{fmt(overall)}</b></td>
                  </tr>
                </tbody>
              </table>
            </div>
          )}
          {pending.some((g) => g.grade_level === lv) && <p className="tiny muted"><span className="gt-cell pending" style={{ display: "inline-block" }}>2</span> onay bekliyor · ortalamaya girmez</p>}
        </div>
      )}

      {subject && <SubjectDialog subject={subject} grades={grades.filter((g) => g.subject_id === subject.id)} onClose={() => setSubject(null)} onOpen={(g) => { setSubject(null); setReview(g); }} />}
      {review && <ReviewDialog g={review} subject={subjects.find((s) => s.id === review.subject_id)} onClose={() => setReview(null)} onDone={(t) => { setReview(null); setMsg(t); load(); }} />}
      {edit && lv != null && <SubjectsDialog level={lv} subjects={subs} onClose={() => { setEdit(false); load(); }} />}
    </div>
  );
}

function ReviewDialog({ g, subject, onClose, onDone }: { g: Grade; subject?: Subject; onClose: () => void; onDone: (msg: string) => void }) {
  const [links, setLinks] = useState<{ url?: string; thumb?: string }[]>([]);
  const [note, setNote] = useState(g.reject_note ?? "");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [big, setBig] = useState<number | null>(null);
  useEffect(() => { if (g.photos.length) mediaLinks(g.photos, 3600).then(setLinks); }, [g.photos]);
  async function decide(approve: boolean) {
    if (!approve && !note.trim()) { setErr("Geri gönderirken neyin düzeltileceğini yaz"); return; }
    setBusy(true);
    const { data: u } = await supabase.auth.getUser();
    const { error } = await supabase.from("grades").update({
      status: approve ? "approved" : "rejected", reject_note: approve ? null : note.trim(), decided_at: new Date().toISOString(), decided_by: u.user?.id ?? null,
    }).eq("id", g.id);
    setBusy(false);
    if (error) setErr(errorText(error));
    else onDone(approve ? "Not onaylandı" : "Not düzeltmesi için geri gönderildi");
  }
  async function remove() {
    if (!confirm("Bu not silinsin mi? (OneDrive'daki fotoğraflar silinmez)")) return;
    const { error } = await supabase.from("grades").delete().eq("id", g.id);
    if (error) setErr(errorText(error)); else onDone("Not silindi");
  }
  return createPortal(
    <>
      <div className="pop-backdrop sheet-like" onClick={onClose} />
      <div className="lock-pop sheet-pop" role="dialog" aria-label="Not">
        <b className="sheet-pop-title">{subject?.name ?? "Ders"} · {KIND_TEXT[g.kind]} · {show(g.grade)}</b>
        <p className="small muted" style={{ margin: 0 }}>
          {dShort(g.taken_on)} · {g.status === "approved" ? "onaylı" : g.status === "pending" ? "onay bekliyor" : "geri gönderildi"}{g.note ? ` · ${g.note}` : ""}
        </p>
        {g.photos.length > 0 ? (
          <div className="grade-photos">
            {g.photos.map((p, i) => (
              <button key={p} type="button" className="pg-cell" onClick={() => setBig(i)} aria-label={`Sayfa ${i + 1}`}>
                {links[i]?.thumb || links[i]?.url ? <img src={links[i].thumb ?? links[i].url} alt="" loading="lazy" /> : <span className="muted tiny">{i + 1}</span>}
              </button>
            ))}
          </div>
        ) : <p className="small muted" style={{ margin: 0 }}>Fotoğraf eklenmemiş.</p>}
        {big != null && <Lightbox urls={links.map((l) => l.url)} start={big} title={`${subject?.name ?? "Ders"} · ${KIND_TEXT[g.kind]}`} onClose={() => setBig(null)} />}
        {g.status !== "approved" && (
          <label className="stack-s">
            <span className="small muted">Geri gönderme notu</span>
            <input value={note} onChange={(e) => { setNote(e.target.value); setErr(null); }} placeholder="Notu yanlış yazmışsın, kâğıtta 2+ görünüyor" />
          </label>
        )}
        {err && <p className="small bad-text" style={{ margin: 0 }}>{err}</p>}
        <div className="pop-actions">
          <button className="pill-btn ghost" onClick={remove} disabled={busy}>Sil</button>
          <span className="grow" />
          {g.status !== "rejected" && g.status !== "approved" && <button className="pill-btn" onClick={() => decide(false)} disabled={busy}>Geri gönder</button>}
          {g.status === "approved" && <button className="pill-btn" onClick={() => decide(false)} disabled={busy}>Geri gönder</button>}
          {g.status !== "approved" && <button className="pill-btn primary" onClick={() => decide(true)} disabled={busy}>Onayla</button>}
          {g.status === "approved" && <button className="pill-btn ghost" onClick={onClose}>Kapat</button>}
        </div>
      </div>
    </>,
    document.body,
  );
}

function SubjectsDialog({ level, subjects, onClose }: { level: number; subjects: Subject[]; onClose: () => void }) {
  const fam = useFamily();
  const [list, setList] = useState<Subject[]>(subjects);
  const [name, setName] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const kids = fam.children;

  async function add() {
    const n = name.trim();
    if (!n) return;
    const { data, error } = await supabase.from("subjects").insert({
      family_id: fam.familyId, grade_level: level, name: n, color: COLORS[list.length % COLORS.length], sort: list.length,
    }).select().single();
    if (error) { setErr(errorText(error)); return; }
    setList([...list, data as Subject]);
    setName("");
  }
  async function patch(s: Subject, p: Partial<Subject>) {
    const next = { ...s, ...p };
    setList(list.map((x) => (x.id === s.id ? next : x)));
    const { error } = await supabase.from("subjects").update(p).eq("id", s.id);
    if (error) setErr(errorText(error));
  }
  async function del(s: Subject) {
    if (!confirm(`“${s.name}” silinsin mi? Bu derse girilmiş notlar da silinir.`)) return;
    const { error } = await supabase.from("subjects").delete().eq("id", s.id);
    if (error) setErr(errorText(error)); else setList(list.filter((x) => x.id !== s.id));
  }

  return createPortal(
    <>
      <div className="pop-backdrop sheet-like" onClick={onClose} />
      <div className="lock-pop sheet-pop" role="dialog" aria-label="Dersler" style={{ maxHeight: "85vh", overflowY: "auto" }}>
        <b className="sheet-pop-title">{level}. sınıf · dersler</b>
        <p className="small muted" style={{ margin: 0 }}>Dersler iki çocukta ortak. Tik kaldırılan çocukta o ders görünmez. Ağırlıkları hocanın söylediği gibi gir (toplam %100); girilmezse düz ortalama alınır.</p>
        <div className="row small muted" style={{ gap: 8 }}>
          <span className="grow">Ders</span>
          {kids.map((c) => <span key={c.id} style={{ width: 54, textAlign: "center" }}>{c.name}</span>)}
        </div>
        {list.map((s) => {
          const w = KINDS.reduce((a, k) => a + Number(s.weights[k] ?? 0), 0);
          return (
            <div key={s.id} className="stack-s" style={{ borderTop: "1px solid var(--line)", paddingTop: 8 }}>
              <div className="row" style={{ gap: 8, alignItems: "center" }}>
                <input type="color" value={s.color ?? "#888780"} onChange={(e) => patch(s, { color: e.target.value })} style={{ width: 28, height: 28, padding: 0, border: "none", background: "none" }} aria-label="Renk" />
                <input className="grow" value={s.name} onChange={(e) => setList(list.map((x) => (x.id === s.id ? { ...x, name: e.target.value } : x)))} onBlur={(e) => e.target.value.trim() && patch(s, { name: e.target.value.trim() })} />
                {kids.map((c) => (
                  <input key={c.id} type="checkbox" style={{ width: 54 }} checked={!s.hidden_for.includes(c.id)} aria-label={`${c.name} için`}
                    onChange={(e) => patch(s, { hidden_for: e.target.checked ? s.hidden_for.filter((x) => x !== c.id) : [...s.hidden_for, c.id] })} />
                ))}
              </div>
              <div className="row" style={{ gap: 8, alignItems: "center" }}>
                <button type="button" className="pill-btn ghost small" onClick={() => setOpen(open === s.id ? null : s.id)}>
                  Ağırlıklar {w ? `· ${KINDS.filter((k) => s.weights[k]).map((k) => `${KIND_TEXT[k]} %${s.weights[k]}`).join(" · ")}` : "· düz ortalama"}
                </button>
                <span className="grow" />
                <button type="button" className="pill-btn ghost small" onClick={() => del(s)}>Sil</button>
              </div>
              {open === s.id && (
                <WeightsEditor value={s.weights} onSave={(v) => { patch(s, { weights: v }); setOpen(null); }} />
              )}
            </div>
          );
        })}
        <div className="row" style={{ gap: 8 }}>
          <input className="grow" value={name} placeholder="Matematik" onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && add()} />
          <button type="button" className="pill-btn primary" onClick={add}>Ders ekle</button>
        </div>
        {err && <p className="small bad-text" style={{ margin: 0 }}>{err}</p>}
        <div className="pop-actions"><button className="pill-btn ghost" onClick={onClose}>Kapat</button></div>
      </div>
    </>,
    document.body,
  );
}

function WeightsEditor({ value, onSave }: { value: Partial<Record<Kind, number>>; onSave: (v: Partial<Record<Kind, number>>) => void }) {
  const [v, setV] = useState<Partial<Record<Kind, number>>>(value);
  const total = KINDS.reduce((a, k) => a + Number(v[k] ?? 0), 0);
  return (
    <div className="stack-s" style={{ background: "var(--surface-2, transparent)", borderRadius: 10, padding: 8 }}>
      {KINDS.map((k) => (
        <label key={k} className="row" style={{ gap: 8, alignItems: "center" }}>
          <span className="grow small">{KIND_TEXT[k]}</span>
          <input type="number" min={0} max={100} step={1} inputMode="numeric" style={{ width: 72 }} value={v[k] ?? ""} placeholder="0"
            onChange={(e) => setV({ ...v, [k]: e.target.value === "" ? undefined : Math.max(0, Math.min(100, Math.round(Number(e.target.value)))) })} />
          <span className="small muted">%</span>
        </label>
      ))}
      <div className="row" style={{ gap: 8, alignItems: "center" }}>
        <span className={`small ${total === 100 || total === 0 ? "muted" : "bad-text"}`}>Toplam %{total}{total !== 100 && total !== 0 ? " · %100 olmalı" : ""}</span>
        <span className="grow" />
        <button type="button" className="pill-btn small" onClick={() => onSave({})}>Temizle</button>
        <button type="button" className="pill-btn primary small" disabled={total !== 100 && total !== 0} onClick={() => onSave(Object.fromEntries(Object.entries(v).filter(([, x]) => x)) as Partial<Record<Kind, number>>)}>Kaydet</button>
      </div>
    </div>
  );
}

/** Bir dersin tüm notları: her not için kâğıt fotoğrafları; fotoğrafa basınca tam ekran büyür */
function SubjectDialog({ subject, grades, onClose, onOpen }: { subject: Subject; grades: Grade[]; onClose: () => void; onOpen: (g: Grade) => void }) {
  const list = [...grades].sort((a, b) => b.taken_on.localeCompare(a.taken_on) || b.created_at.localeCompare(a.created_at));
  const [links, setLinks] = useState<Record<string, { url?: string; thumb?: string }>>({});
  const [big, setBig] = useState<{ g: Grade; i: number } | null>(null);
  useEffect(() => {
    const all = list.flatMap((g) => g.photos);
    if (!all.length) return;
    mediaLinks(all, 3600).then((ls) => setLinks(Object.fromEntries(all.map((p, i) => [p, ls[i] ?? {}]))));
  }, [grades]); // eslint-disable-line react-hooks/exhaustive-deps
  const stat = (g: Grade) => (g.status === "approved" ? "onaylı" : g.status === "pending" ? "onay bekliyor" : "geri gönderildi");
  return createPortal(
    <>
      <div className="pop-backdrop sheet-like" onClick={onClose} />
      <div className="lock-pop sheet-pop" role="dialog" aria-label={subject.name} style={{ maxHeight: "85vh", overflowY: "auto" }}>
        <div className="row between" style={{ alignItems: "center" }}>
          <b className="sheet-pop-title"><span className="dot" style={{ background: subject.color ?? "var(--muted)" }} /> {subject.name}</b>
          <button type="button" className="pill-btn" onClick={onClose}>Kapat</button>
        </div>
        {!list.length && <p className="small muted">Bu derste henüz not yok.</p>}
        {list.map((g) => (
          <div key={g.id} className="subj-grade">
            <div className="row between" style={{ alignItems: "center", gap: 8 }}>
              <span><b>{KIND_TEXT[g.kind]} · {show(g.grade)}</b> <span className="muted tiny">{dShort(g.taken_on)} · {stat(g)}{g.note ? ` · ${g.note}` : ""}</span></span>
              <button type="button" className="pill-btn" onClick={() => onOpen(g)}>{g.status === "pending" ? "İncele" : "Aç"}</button>
            </div>
            {g.photos.length > 0 ? (
              <div className="grade-photos">
                {g.photos.map((p, i) => (
                  <button key={p} type="button" className="pg-cell" onClick={() => setBig({ g, i })} aria-label={`Sayfa ${i + 1}`}>
                    {links[p]?.thumb || links[p]?.url ? <img src={links[p].thumb ?? links[p].url} alt="" loading="lazy" /> : <span className="muted tiny">{i + 1}</span>}
                  </button>
                ))}
              </div>
            ) : <span className="muted tiny">Fotoğraf yok</span>}
          </div>
        ))}
      </div>
      {big && <Lightbox urls={big.g.photos.map((p) => links[p]?.url)} start={big.i} title={`${subject.name} · ${KIND_TEXT[big.g.kind]} · ${show(big.g.grade)}`} onClose={() => setBig(null)} />}
    </>,
    document.body,
  );
}
