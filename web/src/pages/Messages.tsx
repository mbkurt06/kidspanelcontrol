import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useFamily } from "../lib/family";
import { errorText, supabase } from "../lib/supabase";
import { relTime } from "../lib/util";
import { Icon } from "../components/Icon";
import { Info } from "../components/Info";
import { ChildChips } from "../components/ChildChips";

type Msg = {
  id: string; chat_id: string; child_id: string | null; from_parent: boolean; sender_user: string | null; sender_name: string | null;
  body: string; created_at: string; read_at: string | null; reply_to: string | null; deleted_at: string | null; deleted_by: string | null;
};
type Chat = {
  id: string; family_id: string; kind: "direct" | "group"; title: string | null; child_ids: string[]; parent_ids: string[];
  kids_can_write: boolean; frozen_until: string | null; frozen_by: string | null; archived: boolean; created_at: string;
};
type Parent = { user_id: string; display_name: string | null };

const frozen = (c: Chat) => !!c.frozen_until && new Date(c.frozen_until).getTime() > Date.now();
const frozenText = (c: Chat) => {
  if (!c.frozen_until) return "";
  const d = new Date(c.frozen_until);
  if (d.getFullYear() > 2100) return "sen açana kadar";
  return `${d.toLocaleString("tr-TR", { weekday: d.toDateString() === new Date().toDateString() ? undefined : "short", hour: "2-digit", minute: "2-digit" })}'e kadar`;
};

/** Oturumdaki ebeveyn ve ailedeki ebeveynler */
function useMe() {
  const [me, setMe] = useState<string | null>(null);
  const [parents, setParents] = useState<Parent[]>([]);
  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => setMe(data.user?.id ?? null));
    supabase.from("parents").select("user_id,display_name").then(({ data }) => setParents((data ?? []) as Parent[]));
  }, []);
  return { me, parents };
}

function useChatTitle() {
  const fam = useFamily();
  const { me, parents } = useMe();
  const pName = (u: string) => (u === me ? "Sen" : parents.find((p) => p.user_id === u)?.display_name ?? "Ebeveyn");
  const cName = (id: string) => fam.children.find((c) => c.id === id)?.name ?? "Çocuk";
  const title = (c: Chat) => {
    if (c.kind === "direct") {
      const kid = cName(c.child_ids[0]);
      return c.parent_ids[0] === me ? kid : `${kid} ↔ ${pName(c.parent_ids[0])}`;
    }
    return c.title || [...c.child_ids.map(cName), ...c.parent_ids.filter((u) => u !== me).map(pName)].join(", ");
  };
  return { me, parents, pName, cName, title };
}

/** Mesajlar: sohbet listesi (birebir ve gruplar), son mesaj, okunmamış sayısı. */
export function MessagesList() {
  const fam = useFamily();
  const { me, parents, title, cName, pName } = useChatTitle();
  const [chats, setChats] = useState<Chat[]>([]);
  const [last, setLast] = useState<Record<string, Msg>>({});
  const [unread, setUnread] = useState<Record<string, number>>({});
  const [newOpen, setNewOpen] = useState(false);

  const load = useCallback(async () => {
    if (!me) return;
    const [c, m, r] = await Promise.all([
      supabase.from("chats").select("*").eq("archived", false),
      supabase.from("messages").select("id,chat_id,from_parent,sender_user,sender_name,body,created_at,deleted_at").order("created_at", { ascending: false }).limit(400),
      supabase.from("chat_reads").select("chat_id,read_at").eq("member", `p:${me}`),
    ]);
    setChats((c.data ?? []) as Chat[]);
    const reads: Record<string, string> = {};
    for (const x of (r.data ?? []) as { chat_id: string; read_at: string }[]) reads[x.chat_id] = x.read_at;
    const l: Record<string, Msg> = {};
    const u: Record<string, number> = {};
    for (const x of (m.data ?? []) as Msg[]) {
      if (!l[x.chat_id]) l[x.chat_id] = x;
      const mine = x.sender_user === me;
      if (!mine && !x.deleted_at && (!reads[x.chat_id] || x.created_at > reads[x.chat_id])) u[x.chat_id] = (u[x.chat_id] ?? 0) + 1;
    }
    setLast(l);
    setUnread(u);
  }, [me]);

  useEffect(() => {
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [load]);

  const visible = new Set(fam.visibleChildren.map((c) => c.id));
  const list = chats
    .filter((c) => c.child_ids.some((id) => visible.has(id)) || !c.child_ids.length)
    .sort((a, b) => (last[b.id]?.created_at ?? b.created_at).localeCompare(last[a.id]?.created_at ?? a.created_at));
  // Önce benim sohbetlerim, sonra diğer ebeveynin birebir sohbetleri (denetim için)
  const mineList = list.filter((c) => c.kind === "group" || (me && c.parent_ids.includes(me)));
  const others = list.filter((c) => !mineList.includes(c));

  const row = (c: Chat) => {
    const m = last[c.id];
    const color = c.kind === "direct" ? fam.children.find((k) => k.id === c.child_ids[0])?.color : undefined;
    return (
      <Link to={`/messages/${c.id}`} className="card link-card" key={c.id}>
        {c.kind === "direct" ? <span className="dot" style={{ background: color }} /> : <span aria-hidden="true">👥</span>}
        <div className="grow">
          <b>{title(c)}</b> {frozen(c) && <span className="pill warn tiny">⏸ durduruldu</span>}
          <div className="muted small ellipsis">
            {m ? (m.deleted_at ? "🗑 Bu mesaj silindi" : `${m.sender_user === me ? "Sen: " : c.kind === "group" ? `${m.sender_name ?? ""}: ` : ""}${m.body}`) : "Henüz mesaj yok"}
          </div>
        </div>
        {unread[c.id] ? <span className="badge">{unread[c.id]}</span> : m ? <span className="muted tiny">{relTime(m.created_at)}</span> : null}
        <Icon name="chevron" size={18} />
      </Link>
    );
  };

  return (
    <div className="page">
      <header className="page-head">
        <h1>Mesajlar</h1>
        <button className="pill-btn" onClick={() => setNewOpen(true)}>+ Grup</button>
      </header>
      <ChildChips />
      {mineList.map(row)}
      {others.length > 0 && (
        <>
          <h3 className="muted small" style={{ margin: "12px 4px 4px" }}>Diğer ebeveynin sohbetleri</h3>
          {others.map(row)}
        </>
      )}
      {newOpen && me && (
        <GroupSheet
          me={me}
          parents={parents}
          cName={cName}
          pName={pName}
          onClose={() => setNewOpen(false)}
          onSaved={() => { setNewOpen(false); load(); }}
        />
      )}
    </div>
  );
}

/** Grup oluştur / düzenle */
function GroupSheet({ me, parents, cName, pName, chat, onClose, onSaved }: {
  me: string; parents: Parent[]; cName: (id: string) => string; pName: (u: string) => string; chat?: Chat; onClose: () => void; onSaved: () => void;
}) {
  const fam = useFamily();
  const [title, setTitle] = useState(chat?.title ?? "");
  const [kids, setKids] = useState<string[]>(chat?.child_ids ?? []);
  const [pars, setPars] = useState<string[]>(chat?.parent_ids ?? [me]);
  const [kidsWrite, setKidsWrite] = useState(chat?.kids_can_write ?? false);
  const [err, setErr] = useState("");
  const toggle = (arr: string[], v: string) => (arr.includes(v) ? arr.filter((x) => x !== v) : [...arr, v]);
  const save = async () => {
    if (!fam.familyId) return;
    if (!kids.length && pars.length < 2) return setErr("En az bir çocuk ya da iki ebeveyn seç");
    const row = { title: title.trim() || null, child_ids: kids, parent_ids: pars.includes(me) ? pars : [...pars, me], kids_can_write: kidsWrite };
    const { error } = chat
      ? await supabase.from("chats").update(row).eq("id", chat.id)
      : await supabase.from("chats").insert({ ...row, family_id: fam.familyId, kind: "group", created_by: me });
    if (error) return setErr(errorText(error));
    onSaved();
  };
  return createPortal(
    <>
      <div className="pop-backdrop sheet-like" onClick={onClose} />
      <div className="lock-pop sheet-pop" role="dialog" aria-label="Grup">
        <b className="sheet-pop-title">{chat ? "Grubu düzenle" : "Yeni grup"}</b>
        <label className="field"><span>Grup adı</span><input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="ör. Aile" /></label>
        <span className="pop-label">ÇOCUKLAR</span>
        <div className="chips">
          {fam.children.map((c) => (
            <button key={c.id} type="button" className={`chip-btn ${kids.includes(c.id) ? "on" : ""}`} onClick={() => setKids(toggle(kids, c.id))}>{cName(c.id)}</button>
          ))}
        </div>
        <span className="pop-label">EBEVEYNLER</span>
        <div className="chips">
          {parents.map((p) => (
            <button key={p.user_id} type="button" className={`chip-btn ${pars.includes(p.user_id) ? "on" : ""}`} disabled={p.user_id === me} onClick={() => setPars(toggle(pars, p.user_id))}>{pName(p.user_id)}</button>
          ))}
        </div>
        {kids.length > 1 && (
          <label className="check">
            <input type="checkbox" checked={kidsWrite} onChange={(e) => setKidsWrite(e.target.checked)} />
            Çocuklar bu grupta yazabilsin <Info>Kapalıyken grupta sadece ebeveynler yazar, çocuklar okur. Tek çocuklu grupta çocuk her zaman yazabilir.</Info>
          </label>
        )}
        {err && <p className="error small">{err}</p>}
        <div className="pop-actions">
          <button className="pill-btn ghost" onClick={onClose}>Vazgeç</button>
          <button className="pill-btn primary" onClick={save}>{chat ? "Kaydet" : "Oluştur"}</button>
        </div>
      </div>
    </>,
    document.body
  );
}

/** Sohbet. Mesajlar 3 sn'de bir yenilenir; açıkken okundu sayılır. Yanıtla / kopyala / sil, sohbeti durdur. */
export function MessagesChat() {
  const { id } = useParams();
  const nav = useNavigate();
  const fam = useFamily();
  const { me, parents, title, cName, pName } = useChatTitle();
  const [chat, setChat] = useState<Chat | null>(null);
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [trash, setTrash] = useState<Record<string, string>>({});
  const [text, setText] = useState("");
  const [reply, setReply] = useState<Msg | null>(null);
  const [sel, setSel] = useState<string | null>(null);
  const [menu, setMenu] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [missing, setMissing] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);
  const count = useRef(0);

  // Eski bağlantılar (/messages/<çocuk>): o çocukla benim birebir sohbetim
  useEffect(() => {
    if (!id || !me) return;
    if (fam.children.some((c) => c.id === id)) {
      supabase.from("chats").select("id").eq("kind", "direct").contains("child_ids", [id]).contains("parent_ids", [me]).maybeSingle()
        .then(({ data }) => { if (data) nav(`/messages/${(data as { id: string }).id}`, { replace: true }); else setMissing(true); });
    }
  }, [id, me, fam.children, nav]);

  const load = useCallback(async () => {
    if (!id || fam.children.some((c) => c.id === id)) return;
    const [c, m] = await Promise.all([
      supabase.from("chats").select("*").eq("id", id).maybeSingle(),
      supabase.from("messages").select("*").eq("chat_id", id).order("created_at", { ascending: false }).limit(300),
    ]);
    if (!c.data) { setMissing(true); return; }
    setChat(c.data as Chat);
    const list = ((m.data ?? []) as Msg[]).reverse();
    setMsgs(list);
    const del = list.filter((x) => x.deleted_at).map((x) => x.id);
    if (del.length) {
      const { data } = await supabase.from("message_trash").select("message_id,body").in("message_id", del);
      const t: Record<string, string> = {};
      for (const x of (data ?? []) as { message_id: string; body: string }[]) t[x.message_id] = x.body;
      setTrash(t);
    }
    if (me && list.some((x) => x.sender_user !== me && !x.read_at)) await supabase.rpc("chat_mark_read", { p_chat: id });
  }, [id, me, fam.children]);

  useEffect(() => {
    load();
    const t = setInterval(load, 3000);
    return () => clearInterval(t);
  }, [load]);

  useEffect(() => {
    if (msgs.length !== count.current) {
      count.current = msgs.length;
      endRef.current?.scrollIntoView({ block: "end" });
    }
  }, [msgs]);

  const byId = useMemo(() => Object.fromEntries(msgs.map((m) => [m.id, m])), [msgs]);
  const who = (m: Msg) => (m.sender_user === me ? "Sen" : m.from_parent ? (m.sender_name ?? "Ebeveyn") : (m.sender_name ?? (m.child_id ? cName(m.child_id) : "Çocuk")));

  async function send(e?: React.FormEvent) {
    e?.preventDefault();
    const body = text.trim();
    if (!body || !chat) return;
    setBusy(true);
    setErr("");
    const { error } = await supabase.from("messages").insert({ family_id: chat.family_id, chat_id: chat.id, from_parent: true, body, reply_to: reply?.id ?? null });
    setBusy(false);
    if (error) return setErr(errorText(error));
    setText("");
    setReply(null);
    load();
  }

  async function del(m: Msg) {
    if (!confirm("Bu mesaj herkes için silinsin mi?")) return;
    const { error } = await supabase.rpc("message_delete", { p_id: m.id });
    if (error) setErr(errorText(error));
    setSel(null);
    load();
  }

  async function freeze(minutes: number | "tomorrow" | "forever" | null) {
    if (!chat || !me) return;
    let until: string | null = null;
    if (minutes === "forever") until = "2999-12-31T00:00:00Z";
    else if (minutes === "tomorrow") { const d = new Date(); d.setDate(d.getDate() + 1); d.setHours(7, 0, 0, 0); until = d.toISOString(); }
    else if (typeof minutes === "number") until = new Date(Date.now() + minutes * 60000).toISOString();
    const { error } = await supabase.from("chats").update({ frozen_until: until, frozen_by: until ? me : null }).eq("id", chat.id);
    if (error) setErr(errorText(error));
    setMenu(false);
    load();
  }

  async function archive() {
    if (!chat || !confirm("Grup silinsin mi? Mesajlar da kaldırılır.")) return;
    const { error } = await supabase.from("chats").update({ archived: true }).eq("id", chat.id);
    if (error) return setErr(errorText(error));
    nav("/messages");
  }

  if (missing) return <div className="page"><p className="muted">Sohbet bulunamadı.</p></div>;
  if (!chat) return <div className="page"><p className="muted">Yükleniyor…</p></div>;
  const isFrozen = frozen(chat);
  const kidsReadonly = chat.kind === "group" && chat.child_ids.length > 1 && !chat.kids_can_write;

  return (
    <div className="page chat-page">
      <header className="page-head">
        <Link to="/messages" className="icon-btn" aria-label="Geri"><Icon name="back" /></Link>
        <h1 className="ellipsis">{title(chat)}</h1>
        <button className="icon-btn" aria-label="Sohbet seçenekleri" onClick={() => setMenu(true)}>⋯</button>
      </header>
      {isFrozen && (
        <div className="chat-frozen">⏸ Sohbet durduruldu · {frozenText(chat)} · çocuk mesaj yazamaz
          <button className="pill-btn small" onClick={() => freeze(null)}>Devam ettir</button>
        </div>
      )}
      {kidsReadonly && !isFrozen && <div className="chat-frozen soft">Bu grupta sadece ebeveynler yazabiliyor</div>}
      <div className="chat">
        {!msgs.length && <p className="muted small center">Henüz mesaj yok.</p>}
        {msgs.map((m) => {
          const mine = m.sender_user === me;
          const q = m.reply_to ? byId[m.reply_to] : null;
          return (
            <div key={m.id} className={`bubble ${mine ? "mine" : ""} ${m.deleted_at ? "deleted" : ""} ${sel === m.id ? "sel" : ""}`} onClick={() => setSel(sel === m.id ? null : m.id)}>
              {!mine && <span className="who">{who(m)}</span>}
              {q && (
                <span className="quote" onClick={(e) => { e.stopPropagation(); document.getElementById(`m-${q.id}`)?.scrollIntoView({ block: "center" }); }}>
                  <b>{who(q)}</b> {q.deleted_at ? "🗑 silindi" : q.body.slice(0, 120)}
                </span>
              )}
              <span className="body" id={`m-${m.id}`}>
                {m.deleted_at ? <>🗑 Bu mesaj silindi{trash[m.id] && <span className="trash"> · “{trash[m.id]}”</span>}</> : m.body}
              </span>
              <span className="meta">
                {new Date(m.created_at).toLocaleString("tr-TR", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}
                {mine && m.read_at ? " · görüldü" : ""}
              </span>
              {sel === m.id && !m.deleted_at && (
                <span className="bubble-actions" onClick={(e) => e.stopPropagation()}>
                  <button onClick={() => { setReply(m); setSel(null); }}>↩ Yanıtla</button>
                  <button onClick={() => { navigator.clipboard?.writeText(m.body); setSel(null); }}>📋 Kopyala</button>
                  <button onClick={() => del(m)}>🗑 Sil</button>
                </span>
              )}
            </div>
          );
        })}
        <div ref={endRef} />
      </div>
      {err && <p className="error">{err}</p>}
      {reply && (
        <div className="reply-bar">
          <span className="grow ellipsis"><b>{who(reply)}</b>: {reply.body}</span>
          <button className="icon-btn" aria-label="Yanıtı kaldır" onClick={() => setReply(null)}>✕</button>
        </div>
      )}
      <form className="chat-input" onSubmit={send}>
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value.slice(0, 1000))}
          placeholder="Mesaj yaz"
          rows={1}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }}
        />
        <button className="btn primary" disabled={busy || !text.trim()}>Gönder</button>
      </form>

      {menu && createPortal(
        <>
          <div className="pop-backdrop sheet-like" onClick={() => setMenu(false)} />
          <div className="lock-pop sheet-pop" role="dialog" aria-label="Sohbet seçenekleri">
            <b className="sheet-pop-title">{title(chat)}</b>
            <span className="pop-label">SOHBETİ DURDUR <Info>Çocuk eski mesajları görür ama yazamaz; sohbetin üstünde “Bu sohbet durduruldu” yazar. Ebeveynler yazmaya devam edebilir.</Info></span>
            <div className="chips">
              <button className="chip-btn" onClick={() => freeze(15)}>15 dk</button>
              <button className="chip-btn" onClick={() => freeze(60)}>1 saat</button>
              <button className="chip-btn" onClick={() => freeze("tomorrow")}>Yarın sabaha kadar</button>
              <button className="chip-btn" onClick={() => freeze("forever")}>Ben açana kadar</button>
            </div>
            {isFrozen && <button className="pill-btn" onClick={() => freeze(null)}>▶ Devam ettir</button>}
            {chat.kind === "group" && (
              <div className="pop-actions">
                <button className="pill-btn" onClick={() => { setMenu(false); setEditOpen(true); }}>Grubu düzenle</button>
                <button className="pill-btn ghost" onClick={archive}>Grubu sil</button>
              </div>
            )}
          </div>
        </>,
        document.body
      )}
      {editOpen && me && (
        <GroupSheet me={me} parents={parents} cName={cName} pName={pName} chat={chat} onClose={() => setEditOpen(false)} onSaved={() => { setEditOpen(false); load(); }} />
      )}
    </div>
  );
}
