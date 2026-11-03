import { useState } from "react";
import { useFamily } from "../lib/family";
import { errorText, supabase } from "../lib/supabase";
import Music from "./Music";
import TaskSettingsCard from "../components/TaskSettingsCard";

const AVATARS = ["🙂", "😎", "🦊", "🐼", "🐯", "🦄", "🚀", "⭐"];

export default function ChildSettings() {
  const fam = useFamily();
  return (
    <div className="page">
      <header className="page-head"><h1>Ayarlar</h1></header>
      {!fam.visibleChildren.length && <p className="muted small">Çocuk bulunamadı.</p>}
      <details className="card section-collapse-card" open>
        <summary className="section-collapse-head"><span>Görev ayarları</span><span>⌄</span></summary>
        <TaskSettingsCard embedded />
      </details>
      <details className="card section-collapse-card" open>
        <summary className="section-collapse-head"><span>Müzik</span><span>⌄</span></summary>
        <Music inline />
      </details>
      <details className="card section-collapse-card" open>
        <summary className="section-collapse-head"><span>Profil ayarları</span><span>⌄</span></summary>
        <div className="stack">
          {fam.visibleChildren.map((child) => (
            <details className="card section-collapse-card" key={child.id}>
              <summary className="section-collapse-head"><span>{child.name}</span><span>⌄</span></summary>
              <ProfileRow child={child} />
            </details>
          ))}
        </div>
      </details>
    </div>
  );
}

function ProfileRow({ child }: { child: { id: string; name: string; profile_nickname?: string | null; profile_avatar?: string | null } }) {
  const fam = useFamily();
  const [name, setName] = useState(child.profile_nickname ?? "");
  const [avatar, setAvatar] = useState(child.profile_avatar ?? "🙂");
  const [msg, setMsg] = useState("");
  async function save() {
    const { error } = await supabase.from("children").update({ profile_nickname: name.trim() || null, profile_avatar: avatar }).eq("id", child.id);
    setMsg(error ? errorText(error) : "Kaydedildi");
    if (!error) fam.reload();
  }
  return <div className="profile-mini">
    <div className="row gap-s"><span className="profile-avatar">{avatar.startsWith("data:image") ? <img src={avatar} alt="Profil" /> : avatar}</span><div><h2>{child.name}</h2><div className="muted tiny">Profil</div></div></div>
    <div className="row gap-xs wrap">{AVATARS.map((a) => <button className={`avatar-choice ${avatar === a ? "on" : ""}`} key={a} onClick={() => setAvatar(a)}>{a}</button>)}</div>
    <div className="row gap-s"><input value={name} onChange={(e) => setName(e.target.value.slice(0, 60))} placeholder="İsim veya takma ad" /><button className="btn small" onClick={save}>Kaydet</button></div>
    {msg && <span className="muted tiny">{msg}</span>}
  </div>;
}
