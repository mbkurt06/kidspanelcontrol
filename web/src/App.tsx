import { useEffect, useRef, useState } from "react";
import { NavLink, Route, Routes } from "react-router-dom";
import type { Session } from "@supabase/supabase-js";
import { confirmDevice, deviceLabel, errorText, renewDeviceFor, selectDeviceFor, supabase } from "./lib/supabase";
import { FamilyProvider } from "./lib/family";
import Login from "./pages/Login";
import Home from "./pages/Home";
import ChildPage from "./pages/ChildPage";
import Rules from "./pages/Rules";
import ProfileEdit from "./pages/ProfileEdit";
import Groups from "./pages/Groups";
import ModeEdit from "./pages/ModeEdit";
import Events from "./pages/Events";
import { MessagesChat, MessagesList } from "./pages/Messages";
import { useFamily } from "./lib/family";
import Settings from "./pages/Settings";
import Tasks from "./pages/Tasks";
import TaskEdit from "./pages/TaskEdit";
import Vault from "./pages/Vault";
import { Icon } from "./components/Icon";
import { consumeKeyFromUrl, hasAccess, rememberAccess, tryKey } from "./lib/accessKey";

type Gate = "loading" | "pending" | "revoked" | "approved" | "error";

export default function App() {
  const [session, setSession] = useState<Session | null | undefined>(undefined);
  const [access, setAccess] = useState(hasAccess());

  useEffect(() => {
    consumeKeyFromUrl().then((ok) => ok && setAccess(true));
    supabase.auth.getSession().then(({ data }) => {
      if (data.session) {
        rememberAccess();
        setAccess(true);
      }
      setSession(data.session);
    });
    const { data } = supabase.auth.onAuthStateChange((_e, s) => setSession(s));
    return () => data.subscription.unsubscribe();
  }, []);

  if (session === undefined) return access ? <Splash /> : <Blank onUnlock={() => setAccess(true)} />;
  if (!session) return access ? <Login /> : <Blank onUnlock={() => setAccess(true)} />;
  return <DeviceGate key={session.user.id} userId={session.user.id} email={session.user.email ?? ""} />;
}

// Anahtarı bilmeyen ziyaretçi sadece boş bir sayfa görür.
// Gizli giriş: ekranın sol üst köşesine 3 saniye basılı tut → anahtar alanı açılır.
function Blank({ onUnlock }: { onUnlock: () => void }) {
  const [show, setShow] = useState(false);
  const [k, setK] = useState("");
  const timer = useRef<ReturnType<typeof setTimeout>>();
  const start = () => {
    timer.current = setTimeout(() => setShow(true), 3000);
  };
  const stop = () => timer.current && clearTimeout(timer.current);
  return (
    <div className="blank">
      <div className="blank-corner" onPointerDown={start} onPointerUp={stop} onPointerLeave={stop} onContextMenu={(e) => e.preventDefault()} />
      {show && (
        <form
          className="blank-form"
          onSubmit={async (e) => {
            e.preventDefault();
            if (await tryKey(k)) onUnlock();
            else setK("");
          }}
        >
          <input type="password" value={k} onChange={(e) => setK(e.target.value)} autoFocus autoComplete="off" aria-label="Anahtar" />
        </form>
      )}
    </div>
  );
}

function Splash() {
  return (
    <div className="center-screen">
      <img src="/icon-192.png" alt="" width={72} height={72} className="splash-icon" />
    </div>
  );
}

function DeviceGate({ userId, email }: { userId: string; email: string }) {
  const [gate, setGate] = useState<Gate>("loading");
  const [err, setErr] = useState("");

  useEffect(() => {
    let stop = false;
    let t: ReturnType<typeof setTimeout> | undefined;
    let dev = selectDeviceFor(userId);
    let renewed = false;
    async function check() {
      const { data, error } = await supabase.rpc("register_parent_device", {
        p_device_id: dev.id,
        p_secret: dev.secret,
        p_label: deviceLabel(),
      });
      if (stop) return;
      if (error && error.message.includes("device_conflict") && !renewed) {
        // Bu tarayıcı daha önce başka bir ebeveyn hesabıyla kaydedilmiş: bu hesap için yeni cihaz kaydı aç.
        renewed = true;
        dev = renewDeviceFor(userId);
        return check();
      }
      if (error) {
        setErr(errorText(error));
        setGate("error");
        return;
      }
      confirmDevice(userId);
      setGate(data as Gate);
      if (data === "approved") {
        supabase.rpc("touch_parent_device").then(() => {});
      } else if (data === "pending") {
        t = setTimeout(check, 5000);
      }
    }
    check();
    return () => {
      stop = true;
      if (t) clearTimeout(t);
    };
  }, [userId]);

  if (gate === "loading") return <Splash />;
  if (gate === "approved")
    return (
      <FamilyProvider>
        <Shell />
      </FamilyProvider>
    );

  return (
    <div className="center-screen">
      <div className="card narrow">
        <img src="/icon-192.png" alt="" width={56} height={56} />
        {gate === "pending" && (
          <>
            <h1>Bu cihaz onay bekliyor</h1>
            <p className="muted">
              Onaylı bir cihazdan <b>Ayarlar → Ebeveyn cihazları</b> bölümüne gir ve bu cihazı onayla. Onaylanınca bu
              ekran kendiliğinden açılır.
            </p>
            <p className="tag">{deviceLabel()}</p>
          </>
        )}
        {gate === "revoked" && (
          <>
            <h1>Bu cihazın erişimi kaldırıldı</h1>
            <p className="muted">Tekrar erişim için diğer ebeveynden yeni onay iste.</p>
          </>
        )}
        {gate === "error" && (
          <>
            <h1>Giriş yapılamadı</h1>
            <p className="muted">{err}</p>
          </>
        )}
        <p className="muted small">{email}</p>
        <button className="btn ghost" onClick={() => supabase.auth.signOut()}>
          Çıkış yap
        </button>
      </div>
    </div>
  );
}

function Shell() {
  const fam = useFamily();
  return (
    <div className="shell">
      <main className="content">
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/child/:id" element={<ChildPage />} />
          <Route path="/child/:id/vault" element={<Vault />} />
          <Route path="/rules" element={<Rules />} />
          <Route path="/rules/profile/:id" element={<ProfileEdit />} />
          <Route path="/rules/mode/:id" element={<ModeEdit />} />
          <Route path="/rules/groups" element={<Groups />} />
          <Route path="/tasks" element={<Tasks />} />
          <Route path="/tasks/new" element={<TaskEdit />} />
          <Route path="/tasks/:id" element={<TaskEdit />} />
          <Route path="/events" element={<Events />} />
          <Route path="/messages" element={<MessagesList />} />
          <Route path="/messages/:id" element={<MessagesChat />} />
          <Route path="/settings" element={<Settings />} />
        </Routes>
      </main>
      <nav className="tabbar">
        <NavLink to="/" end>
          <Icon name="home" />
          <span>Ana sayfa</span>
        </NavLink>
        <NavLink to="/tasks">
          <Icon name="tasks" />
          <span>Görevler</span>
        </NavLink>
        <NavLink to="/messages">
          <Icon name="chat" />
          <span>Mesajlar</span>
          {fam.unreadMessages > 0 && <span className="badge">{fam.unreadMessages}</span>}
        </NavLink>
        <NavLink to="/rules">
          <Icon name="rules" />
          <span>Kurallar</span>
        </NavLink>
        <NavLink to="/events">
          <Icon name="bell" />
          <span>Olaylar</span>
        </NavLink>
        <NavLink to="/settings">
          <Icon name="gear" />
          <span>Ayarlar</span>
        </NavLink>
      </nav>
    </div>
  );
}
