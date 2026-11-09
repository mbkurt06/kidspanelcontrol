import { useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { useFamily } from "../lib/family";
import { errorText, supabase } from "../lib/supabase";
import { ChildChips } from "../components/ChildChips";

type Deck = { id: string; name: string; created_by_child: string | null; created_at: string };
type Card = { id: string; deck_id: string; fr: string; de: string; example: string | null; created_by_child: string | null; created_at: string };
type Prog = { child_id: string; card_id: string; box: number; right_count: number; wrong_count: number; due_on: string | null };
type Study = { child_id: string; deck_id: string };
type Sess = { child_id: string; day: string; cards: number; known: number; unknown: number; seconds: number };
type VSet = { direction: string; daily_goal: number; allow_closed: boolean };

const DIR: Record<string, string> = { fr_de: "Önce Fransızca", de_fr: "Önce Almanca", mixed: "Karışık" };

/** "le chat - die Katze" satırları (ayraç: tab, " = ", " - ", " – ", ";") */
function parseLines(t: string) {
  return t.split("\n").map((l) => l.trim()).filter(Boolean).map((l) => {
    const sep = ["\t", " = ", " - ", " – ", ";", "="].find((x) => l.includes(x));
    if (!sep) return null;
    const i = l.indexOf(sep);
    const fr = l.slice(0, i).trim(), de = l.slice(i + sep.length).trim();
    return fr && de ? { fr, de } : null;
  }).filter(Boolean) as { fr: string; de: string }[];
}

export default function Vocab() {
  const fam = useFamily();
  const [decks, setDecks] = useState<Deck[]>([]);
  const [cards, setCards] = useState<Card[]>([]);
  const [prog, setProg] = useState<Prog[]>([]);
  const [study, setStudy] = useState<Study[]>([]);
  const [sess, setSess] = useState<Sess[]>([]);
  const [sets, setSets] = useState<Record<string, VSet>>({});
  const [open, setOpen] = useState<string | null>(null);
  const [err, setErr] = useState("");
  const [newName, setNewName] = useState("");

  const load = useCallback(async () => {
    const since = new Date(Date.now() - 14 * 864e5).toISOString().slice(0, 10);
    const [d, c, p, s, ss, ch] = await Promise.all([
      supabase.from("vocab_decks").select("*").is("deleted_at", null).order("created_at", { ascending: false }),
      supabase.from("vocab_cards").select("*").is("deleted_at", null).order("created_at"),
      supabase.from("vocab_progress").select("child_id,card_id,box,right_count,wrong_count,due_on"),
      supabase.from("vocab_study").select("child_id,deck_id"),
      supabase.from("vocab_sessions").select("child_id,day,cards,known,unknown,seconds").gte("day", since),
      supabase.from("children").select("id,vocab_settings"),
    ]);
    const e = d.error || c.error || p.error || s.error || ss.error || ch.error;
    if (e) return setErr(errorText(e));
    setDecks((d.data ?? []) as Deck[]);
    setCards((c.data ?? []) as Card[]);
    setProg((p.data ?? []) as Prog[]);
    setStudy((s.data ?? []) as Study[]);
    setSess((ss.data ?? []) as Sess[]);
    setSets(Object.fromEntries(((ch.data ?? []) as { id: string; vocab_settings: VSet }[]).map((x) => [x.id, x.vocab_settings])));
  }, []);
  useEffect(() => { load(); }, [load]);

  const kids = fam.visibleChildren;
  const nameOf = (id: string | null) => (id ? fam.children.find((c) => c.id === id)?.name ?? "Çocuk" : "Sen");
  const progOf = useMemo(() => {
    const m = new Map<string, Prog>();
    for (const p of prog) m.set(`${p.child_id}|${p.card_id}`, p);
    return m;
  }, [prog]);
  const stat = (childId: string, list: Card[]) => {
    let n = 0, l = 0, k = 0;
    for (const c of list) {
      const b = progOf.get(`${childId}|${c.id}`)?.box ?? 0;
      if (b === 0) n++; else if (b >= 4) k++; else l++;
    }
    return { n, l, k };
  };

  async function addDeck() {
    if (!newName.trim() || !fam.family) return;
    const { error } = await supabase.from("vocab_decks").insert({ family_id: fam.family.id, name: newName.trim() });
    if (error) return setErr(errorText(error));
    setNewName("");
    load();
  }

  async function saveSet(childId: string, patch: Partial<VSet>) {
    const next = { ...(sets[childId] ?? { direction: "fr_de", daily_goal: 20, allow_closed: true }), ...patch };
    setSets({ ...sets, [childId]: next });
    const { error } = await supabase.from("children").update({ vocab_settings: next }).eq("id", childId);
    if (error) setErr(errorText(error));
  }

  return (
    <div className="stack">
      <header className="page-head"><h1>Kelime kartları</h1></header>
      <ChildChips />
      {err && <p className="error">{err}</p>}

      {kids.map((ch) => {
        const mine = study.filter((s) => s.child_id === ch.id).map((s) => s.deck_id);
        const myCards = cards.filter((c) => mine.includes(c.deck_id));
        const st = stat(ch.id, myCards);
        const days = sess.filter((s) => s.child_id === ch.id);
        const today = new Date().toLocaleDateString("en-CA", { timeZone: "Europe/Berlin" });
        const todayCards = days.filter((d) => d.day === today).reduce((a, d) => a + d.cards, 0);
        const week = days.filter((d) => d.day > new Date(Date.now() - 7 * 864e5).toISOString().slice(0, 10));
        const hard = prog
          .filter((p) => p.child_id === ch.id && p.wrong_count > 0)
          .sort((a, b) => b.wrong_count - a.wrong_count || a.box - b.box)
          .slice(0, 8)
          .map((p) => ({ p, c: cards.find((c) => c.id === p.card_id) }))
          .filter((x) => x.c);
        const vs = sets[ch.id] ?? { direction: "fr_de", daily_goal: 20, allow_closed: true };
        return (
          <section className="card stack" key={ch.id}>
            <h2><span className="dot" style={{ background: ch.color }} /> {ch.name}</h2>
            <div className="report-stats">
              <div><b>{todayCards} / {vs.daily_goal}</b><span>bugün kart</span></div>
              <div><b>{week.reduce((a, d) => a + d.cards, 0)}</b><span>son 7 gün</span></div>
              <div><b>{st.k} / {myCards.length}</b><span>öğrenildi</span></div>
            </div>
            <p className="muted small">Çalışma alanı: {mine.length ? decks.filter((d) => mine.includes(d.id)).map((d) => d.name).join(", ") : "boş"} · yeni {st.n} · öğreniliyor {st.l} · öğrenildi {st.k}</p>
            {hard.length > 0 && (
              <div>
                <b className="small">En çok zorlandığı kelimeler</b>
                <div className="vocab-hard">{hard.map(({ p, c }) => <span key={p.card_id}>{c!.fr} – {c!.de} <em>✗{p.wrong_count}</em></span>)}</div>
              </div>
            )}
            <details className="section-collapse-card">
              <summary className="section-collapse-head"><span>Ayarlar</span><span className="collapse-arrow" aria-hidden="true" /></summary>
              <div className="stack">
                <label className="field"><span>Kartın ön yüzü (çocuk da değiştirebilir)</span>
                  <select value={vs.direction} onChange={(e) => saveSet(ch.id, { direction: e.target.value })}>
                    {Object.entries(DIR).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                  </select>
                </label>
                <label className="field"><span>Günlük hedef (kart)</span>
                  <input type="number" min={5} max={200} step={5} value={vs.daily_goal} onChange={(e) => saveSet(ch.id, { daily_goal: Math.max(5, Math.min(200, Number(e.target.value) || 20)) })} />
                </label>
                <label className="check"><input type="checkbox" checked={vs.allow_closed} onChange={(e) => saveSet(ch.id, { allow_closed: e.target.checked })} /> Kapalı saatlerde de açık olsun</label>
                <p className="muted tiny">Tam kilit ve odak profillerinde "📚 Kelime kartları" ekranı ayrıca seçilebilir.</p>
              </div>
            </details>
          </section>
        );
      })}

      <section className="card stack">
        <h2>Desteler</h2>
        <div className="row gap-xs">
          <input className="grow" placeholder="Yeni deste adı (ör. Unité 3)" value={newName} onChange={(e) => setNewName(e.target.value)} />
          <button className="btn primary" disabled={!newName.trim()} onClick={addDeck}>Oluştur</button>
        </div>
        {decks.length === 0 && <p className="muted">Henüz deste yok.</p>}
        {decks.map((d) => (
          <DeckBox key={d.id} deck={d} cards={cards.filter((c) => c.deck_id === d.id)} open={open === d.id} onToggle={() => setOpen(open === d.id ? null : d.id)}
            by={nameOf(d.created_by_child)} kids={fam.children} study={study} stat={stat} familyId={fam.family?.id ?? ""} onChange={load} onErr={setErr} />
        ))}
      </section>
    </div>
  );
}

function DeckBox(props: {
  deck: Deck; cards: Card[]; open: boolean; onToggle: () => void; by: string;
  kids: { id: string; name: string; color: string }[]; study: Study[];
  stat: (childId: string, list: Card[]) => { n: number; l: number; k: number };
  familyId: string; onChange: () => void; onErr: (e: string) => void;
}) {
  const { deck, cards, kids, study } = props;
  const [text, setText] = useState("");
  const [edit, setEdit] = useState<Card | null>(null);
  const [busy, setBusy] = useState(false);
  const parsed = useMemo(() => parseLines(text), [text]);

  async function add() {
    if (busy) return;
    // Destede zaten olanları ve listedeki tekrarları atla (çift basmaya karşı düğme de kilitli)
    const key = (fr: string, de: string) => `${fr.trim().toLowerCase()}|${de.trim().toLowerCase()}`;
    const seen = new Set(cards.map((c) => key(c.fr, c.de)));
    const rows = parsed.filter((p) => { const k = key(p.fr, p.de); if (seen.has(k)) return false; seen.add(k); return true; })
      .map((p) => ({ deck_id: deck.id, family_id: props.familyId, fr: p.fr, de: p.de }));
    setText("");
    if (!rows.length) return;
    setBusy(true);
    const { error } = await supabase.from("vocab_cards").insert(rows);
    setBusy(false);
    if (error) return props.onErr(errorText(error));
    props.onChange();
  }
  async function toggleStudy(childId: string, on: boolean) {
    const q = on
      ? supabase.from("vocab_study").insert({ child_id: childId, deck_id: deck.id, family_id: props.familyId })
      : supabase.from("vocab_study").delete().eq("child_id", childId).eq("deck_id", deck.id);
    const { error } = await q;
    if (error) return props.onErr(errorText(error));
    props.onChange();
  }
  async function removeDeck() {
    if (!confirm(`"${deck.name}" destesi silinsin mi? (${cards.length} kart)`)) return;
    const { error } = await supabase.from("vocab_decks").update({ deleted_at: new Date().toISOString() }).eq("id", deck.id);
    if (error) return props.onErr(errorText(error));
    props.onChange();
  }
  async function saveCard(c: Card, del: boolean) {
    const q = del
      ? supabase.from("vocab_cards").update({ deleted_at: new Date().toISOString() }).eq("id", c.id)
      : supabase.from("vocab_cards").update({ fr: c.fr.trim(), de: c.de.trim(), example: c.example?.trim() || null }).eq("id", c.id);
    const { error } = await q;
    if (error) return props.onErr(errorText(error));
    setEdit(null);
    props.onChange();
  }

  return (
    <div className="vocab-deck">
      <button className="vocab-deck-head" onClick={props.onToggle}>
        <span className="grow"><b>{deck.name}</b><span className="muted small"> · {cards.length} kart · {props.by} ekledi</span></span>
        <span className="muted small">{kids.filter((k) => study.some((s) => s.child_id === k.id && s.deck_id === deck.id)).map((k) => k.name).join(", ") || "kimse çalışmıyor"}</span>
      </button>
      {props.open && (
        <div className="stack">
          <div className="vocab-who">
            {kids.map((k) => {
              const on = study.some((s) => s.child_id === k.id && s.deck_id === deck.id);
              const st = props.stat(k.id, cards);
              return (
                <label key={k.id} className="check">
                  <input type="checkbox" checked={on} onChange={(e) => toggleStudy(k.id, e.target.checked)} />
                  <span className="dot" style={{ background: k.color }} /> {k.name} çalışsın
                  {on && <span className="muted tiny"> · öğrenildi {st.k}/{cards.length}</span>}
                </label>
              );
            })}
          </div>
          <label className="field">
            <span>Kelime ekle — her satıra: Fransızca - Almanca</span>
            <textarea rows={5} placeholder={"le chat - die Katze\nle chien - der Hund"} value={text} onChange={(e) => setText(e.target.value)} />
          </label>
          {text.trim() && <p className="muted tiny">{parsed.length} kelime algılandı</p>}
          <div className="row gap-xs">
            <button className="btn primary" disabled={!parsed.length || busy} onClick={add}>{busy ? "Ekleniyor…" : "Ekle"}</button>
            <button className="btn ghost danger-text" onClick={removeDeck}>Desteyi sil</button>
          </div>
          <div className="vocab-cards">
            {cards.map((c) => (
              <button key={c.id} className="vocab-card-row" onClick={() => setEdit({ ...c })}>
                <b>{c.fr}</b><span>{c.de}</span>
              </button>
            ))}
          </div>
        </div>
      )}
      {edit && createPortal(
        <div className="sheet-backdrop" onClick={() => setEdit(null)}>
          <div className="sheet" onClick={(e) => e.stopPropagation()}>
            <h2>Kartı düzenle</h2>
            <label className="field"><span>Fransızca</span><input value={edit.fr} onChange={(e) => setEdit({ ...edit, fr: e.target.value })} /></label>
            <label className="field"><span>Almanca</span><input value={edit.de} onChange={(e) => setEdit({ ...edit, de: e.target.value })} /></label>
            <label className="field"><span>Örnek cümle (isteğe bağlı)</span><input value={edit.example ?? ""} onChange={(e) => setEdit({ ...edit, example: e.target.value })} /></label>
            <div className="row gap-xs">
              <button className="btn primary" disabled={!edit.fr.trim() || !edit.de.trim()} onClick={() => saveCard(edit, false)}>Kaydet</button>
              <button className="btn ghost danger-text" onClick={() => saveCard(edit, true)}>Sil</button>
              <button className="btn ghost" onClick={() => setEdit(null)}>Vazgeç</button>
            </div>
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}
