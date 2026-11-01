import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useFamily } from "../lib/family";
import { errorText, supabase } from "../lib/supabase";
import { relTime } from "../lib/util";
import { Icon } from "../components/Icon";

type Msg = { id: string; child_id: string; from_parent: boolean; sender_name: string | null; body: string; created_at: string; read_at: string | null };

/** Mesajlar: çocuk listesi (son mesaj, okunmamış sayısı). */
export function MessagesList() {
  const fam = useFamily();
  const [last, setLast] = useState<Record<string, Msg>>({});
  const [unread, setUnread] = useState<Record<string, number>>({});

  useEffect(() => {
    let alive = true;
    const load = async () => {
      const { data } = await supabase.from("messages").select("*").order("created_at", { ascending: false }).limit(200);
      if (!alive) return;
      const l: Record<string, Msg> = {};
      const u: Record<string, number> = {};
      for (const m of (data ?? []) as Msg[]) {
        if (!l[m.child_id]) l[m.child_id] = m;
        if (!m.from_parent && !m.read_at) u[m.child_id] = (u[m.child_id] ?? 0) + 1;
      }
      setLast(l);
      setUnread(u);
    };
    load();
    const t = setInterval(load, 5000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  return (
    <div className="page">
      <header className="page-head">
        <h1>Mesajlar</h1>
      </header>
      {fam.children.map((c) => {
        const m = last[c.id];
        return (
          <Link to={`/messages/${c.id}`} className="card link-card" key={c.id}>
            <span className="dot" style={{ background: c.color }} />
            <div className="grow">
              <b>{c.name}</b>
              <div className="muted small ellipsis">{m ? `${m.from_parent ? "Sen: " : ""}${m.body}` : "Henüz mesaj yok"}</div>
            </div>
            {unread[c.id] ? <span className="badge">{unread[c.id]}</span> : m ? <span className="muted tiny">{relTime(m.created_at)}</span> : null}
            <Icon name="chevron" size={18} />
          </Link>
        );
      })}
    </div>
  );
}

/** Bir çocukla sohbet. Mesajlar 3 sn'de bir yenilenir; açıkken çocuğun mesajları okundu sayılır. */
export function MessagesChat() {
  const { id } = useParams();
  const fam = useFamily();
  const child = fam.children.find((c) => c.id === id);
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const endRef = useRef<HTMLDivElement>(null);
  const count = useRef(0);

  const load = useCallback(async () => {
    if (!id) return;
    const { data } = await supabase.from("messages").select("*").eq("child_id", id).order("created_at", { ascending: false }).limit(200);
    const list = ((data ?? []) as Msg[]).reverse();
    setMsgs(list);
    if (list.some((m) => !m.from_parent && !m.read_at)) {
      await supabase.from("messages").update({ read_at: new Date().toISOString() }).eq("child_id", id).eq("from_parent", false).is("read_at", null);
    }
  }, [id]);

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

  async function send(e?: React.FormEvent) {
    e?.preventDefault();
    const body = text.trim();
    if (!body || !child) return;
    setBusy(true);
    setErr("");
    const { error } = await supabase.from("messages").insert({ family_id: child.family_id, child_id: child.id, from_parent: true, body });
    setBusy(false);
    if (error) return setErr(errorText(error));
    setText("");
    load();
  }

  if (!child) return <div className="page"><p className="muted">Çocuk bulunamadı.</p></div>;

  return (
    <div className="page chat-page">
      <header className="page-head">
        <Link to="/messages" className="icon-btn" aria-label="Geri">
          <Icon name="back" />
        </Link>
        <h1>{child.name}</h1>
        <span />
      </header>
      <div className="chat">
        {!msgs.length && <p className="muted small center">Henüz mesaj yok. {child.name} telefonundaki Orbit'ten sana yazabilir.</p>}
        {msgs.map((m) => (
          <div key={m.id} className={`bubble ${m.from_parent ? "mine" : ""}`}>
            {m.from_parent && <span className="who">{m.sender_name ?? "Ebeveyn"}</span>}
            <span className="body">{m.body}</span>
            <span className="meta">
              {new Date(m.created_at).toLocaleString("tr-TR", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}
              {m.from_parent && m.read_at ? " · görüldü" : ""}
            </span>
          </div>
        ))}
        <div ref={endRef} />
      </div>
      {err && <p className="error">{err}</p>}
      <form className="chat-input" onSubmit={send}>
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value.slice(0, 1000))}
          placeholder={`${child.name}'e yaz`}
          rows={1}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
        />
        <button className="btn primary" disabled={busy || !text.trim()}>
          Gönder
        </button>
      </form>
    </div>
  );
}
