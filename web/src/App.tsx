import { useEffect, useState } from "react";
import { NavLink, Route, Routes } from "react-router-dom";
import type { Session } from "@supabase/supabase-js";
import { deviceLabel, errorText, localDevice, supabase } from "./lib/supabase";
import { FamilyProvider } from "./lib/family";
import Login from "./pages/Login";
import Home from "./pages/Home";
import ChildPage from "./pages/ChildPage";
import Rules from "./pages/Rules";
import ProfileEdit from "./pages/ProfileEdit";
import ModeEdit from "./pages/ModeEdit";
import Events from "./pages/Events";
import Settings from "./pages/Settings";
import { Icon } from "./components/Icon";

type Gate = "loading" | "pending" | "revoked" | "approved" | "error";

export default function App() {
  const [session, setSession] = useState<Session | null | undefined>(undefined);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data } = supabase.auth.onAuthStateChange((_e, s) => setSession(s));
    return () => data.subscription.unsubscribe();
  }, []);

  if (session === undefined) return <Splash />;
  if (!session) return <Login />;
  return <DeviceGate key={session.user.id} email={session.user.email ?? ""} />;
}

function Splash() {
  return (
    <div className="center-screen">
      <img src="/icon-192.png" alt="" width={72} height={72} className="splash-icon" />
    </div>
  );
}

function DeviceGate({ email }: { email: string }) {
  const [gate, setGate] = useState<Gate>("loading");
  const [err, setErr] = useState("");

  useEffect(() => {
    let stop = false;
    let t: ReturnType<typeof setTimeout> | undefined;
    const dev = localDevice();
    async function check() {
      const { data, error } = await supabase.rpc("register_parent_device", {
        p_device_id: dev.id,
        p_secret: dev.secret,
        p_label: deviceLabel(),
      });
      if (stop) return;
      if (error) {
        setErr(errorText(error));
        setGate("error");
        return;
      }
      setGate(data as Gate);
      if (data === "approved") {
        supabase.rpc("touch_parent_device");
      } else if (data === "pending") {
        t = setTimeout(check, 5000);
      }
    }
    check();
    return () => {
      stop = true;
      if (t) clearTimeout(t);
    };
  }, []);

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
  return (
    <div className="shell">
      <main className="content">
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/child/:id" element={<ChildPage />} />
          <Route path="/rules" element={<Rules />} />
          <Route path="/rules/profile/:id" element={<ProfileEdit />} />
          <Route path="/rules/mode/:id" element={<ModeEdit />} />
          <Route path="/events" element={<Events />} />
          <Route path="/settings" element={<Settings />} />
        </Routes>
      </main>
      <nav className="tabbar">
        <NavLink to="/" end>
          <Icon name="home" />
          <span>Ana sayfa</span>
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
