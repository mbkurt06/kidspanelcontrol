import { useEffect, useRef, useState } from "react";
import { Navigate, NavLink, Route, Routes, useLocation } from "react-router-dom";
import type { Session } from "@supabase/supabase-js";
import { confirmDevice, deviceLabel, errorText, renewDeviceFor, selectDeviceFor, supabase } from "./lib/supabase";
import { FamilyProvider } from "./lib/family";
import Login from "./pages/Login";
import Home from "./pages/Home";
import ChildPage from "./pages/ChildPage";
import Rules from "./pages/Rules";
import ProfileEdit from "./pages/ProfileEdit";
import Groups from "./pages/Groups";
import { ActivitiesPage, FocusEdit } from "./pages/Focus";
import ModeEdit from "./pages/ModeEdit";
import Events from "./pages/Events";
import { MessagesChat, MessagesList } from "./pages/Messages";
import { useFamily } from "./lib/family";
import Settings from "./pages/Settings";
import ChildSettings from "./pages/ChildSettings";
import Tasks from "./pages/Tasks";
import Agenda from "./pages/Agenda";
import TaskEdit from "./pages/TaskEdit";
import AppRuleEdit from "./pages/AppRuleEdit";
import Vault from "./pages/Vault";
import Vocab from "./pages/Vocab";
import { Icon } from "./components/Icon";
import { authenticateBiometric, biometricDue, biometricEnabled, markSeen } from "./lib/biometric";

type Gate = "loading" | "pending" | "revoked" | "approved" | "error";

export default function App() {
  const [session, setSession] = useState<Session | null | undefined>(undefined);
  const [recovery, setRecovery] = useState(() => window.location.hash.includes("type=recovery"));

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
    });
    const { data } = supabase.auth.onAuthStateChange((event, s) => {
      if (event === "PASSWORD_RECOVERY") setRecovery(true);
      setSession(s);
    });
    return () => data.subscription.unsubscribe();
  }, []);

  if (session === undefined) return <Splash />;
  if (!session) return <Login />;
  if (recovery) return <PasswordReset onDone={() => setRecovery(false)} />;
  return <DeviceGate key={session.user.id} userId={session.user.id} email={session.user.email ?? ""} />;
}

function PasswordReset({ onDone }: { onDone: () => void }) {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setErr("");
    setMsg("");
    if (password.length < 6) return setErr("Şifre en az 6 karakter olmalı.");
    if (password !== confirm) return setErr("Şifreler aynı değil.");
    setBusy(true);
    const { error } = await supabase.auth.updateUser({ password });
    setBusy(false);
    if (error) return setErr(errorText(error));
    setMsg("Şifren güncellendi. Panel açılıyor...");
    setTimeout(onDone, 600);
  }

  return (
    <div className="center-screen">
      <form className="card narrow" onSubmit={save}>
        <img src="/icon-192.png" alt="" width={64} height={64} />
        <h1>Yeni şifre</h1>
        <p className="muted">Orbit hesabın için yeni bir şifre belirle.</p>
        <label className="field">
          <span>Yeni şifre</span>
          <input type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        </label>
        <label className="field">
          <span>Yeni şifre tekrar</span>
          <input type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required />
        </label>
        {err && <p className="error">{err}</p>}
        {msg && <p className="ok">{msg}</p>}
        <button className="btn primary wide" disabled={busy}>
          Şifreyi kaydet
        </button>
      </form>
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
  return <BiometricGate><ShellContent /></BiometricGate>;
}

function BiometricGate({ children }: { children: React.ReactNode }) {
  const [locked, setLocked] = useState(() => biometricDue());
  // Kilitliyken "son kullanım" yazılmaz (yoksa kilit ekranından çıkıp dönünce sormadan açılırdı)
  const lockedRef = useRef(locked);
  lockedRef.current = locked;
  const seen = () => { if (!lockedRef.current) markSeen(); };
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const authenticating = useRef(false);

  async function unlock() {
    if (authenticating.current) return;
    authenticating.current = true;
    setBusy(true);
    setErr("");
    try {
      if (await authenticateBiometric()) { markSeen(); setLocked(false); }
      else setErr("Face ID doğrulaması yapılamadı.");
    } catch {
      setErr("Face ID doğrulaması iptal edildi veya başarısız oldu.");
    }
    setBusy(false);
    authenticating.current = false;
  }

  useEffect(() => {
    if (!biometricEnabled()) return;
    // Ayardaki süre içinde geri dönülürse tekrar sorulmaz
    const onVisibility = () => {
      if (document.visibilityState === "hidden") seen();
      else if (biometricDue()) { setLocked(true); unlock(); }
    };
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pagehide", seen);
    const beat = window.setInterval(() => { if (document.visibilityState === "visible") seen(); }, 30_000);
    if (document.visibilityState === "visible" && biometricDue()) unlock();
    return () => { document.removeEventListener("visibilitychange", onVisibility); window.removeEventListener("pagehide", seen); window.clearInterval(beat); };
  }, []);

  if (!locked) return <>{children}</>;
  return (
    <div className="center-screen">
      <div className="card narrow center">
        <img src="/icon-192.png" alt="" width={64} height={64} />
        <h1>Orbit kilitli</h1>
        <p className="muted">Devam etmek için Face ID veya Touch ID kullan.</p>
        {err && <p className="error">{err}</p>}
        <button className="btn primary wide" onClick={unlock} disabled={busy}>{busy ? "Doğrulanıyor…" : "Face ID ile aç"}</button>
      </div>
    </div>
  );
}

function ShellContent() {
  const fam = useFamily();
  const [menuOpen, setMenuOpen] = useState(false);
  // Sayfa değişince içerik başa dönsün (sayfa artık kendi kutusunda kayıyor)
  const loc = useLocation();
  const prevPath = useRef(loc.pathname);
  useEffect(() => {
    const prev = prevPath.current;
    prevPath.current = loc.pathname;
    // Çocuk sayfasında çocuklar arası geçişte konum korunur (ChildPage geri yükler)
    const child = /^\/child\/[^/]+$/;
    if (child.test(prev) && child.test(loc.pathname)) return;
    document.getElementById("scroller")?.scrollTo(0, 0);
  }, [loc.pathname]);
  return (
    <div className="shell">
      <button className="menu-toggle" aria-label="Menüyü aç" onClick={() => setMenuOpen(true)}>☰</button>
      {menuOpen && <div className="menu-backdrop" onClick={() => setMenuOpen(false)}><aside className="side-menu" onClick={(e) => e.stopPropagation()}>
        <div className="side-menu-head"><b>Orbit</b><button className="icon-btn" onClick={() => setMenuOpen(false)} aria-label="Menüyü kapat">×</button></div>
        <div className="side-menu-list">
          <button className={fam.selectedChildId === "all" ? "selected" : ""} onClick={() => { fam.setSelectedChildId("all"); setMenuOpen(false); }}>Tümü</button>
          {fam.children.map((c) => <button key={c.id} className={fam.selectedChildId === c.id ? "selected" : ""} onClick={() => { fam.setSelectedChildId(c.id); setMenuOpen(false); }}><span className="dot" style={{ background: c.color }} />{c.name}</button>)}
        </div>
        <NavLink to="/vocab" className="side-menu-link" onClick={() => setMenuOpen(false)}>📚 Kelime kartları</NavLink>
        <div className="side-menu-bottom"><NavLink to="/settings" onClick={() => setMenuOpen(false)} aria-label="Web sayfası ayarları"><Icon name="gear" /></NavLink></div>
      </aside></div>}
      <div className="scroller" id="scroller">
      <main className="content">
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/child/:id" element={<ChildPage />} />
          <Route path="/child/:id/vault" element={<Vault />} />
          <Route path="/rules" element={<Rules />} />
          <Route path="/rules/profile/:id" element={<ProfileEdit />} />
          <Route path="/rules/mode/:id" element={<ModeEdit />} />
          <Route path="/rules/groups" element={<Groups />} />
          <Route path="/rules/focus/:id" element={<FocusEdit />} />
          <Route path="/rules/activities" element={<ActivitiesPage />} />
          <Route path="/rules/lock" element={<Navigate to="/rules" replace />} />
          <Route path="/rules/music" element={<Navigate to="/child-settings" replace />} />
          <Route path="/rules/time" element={<Navigate to="/rules" replace />} />
          <Route path="/rules/app-rule/:id" element={<AppRuleEdit />} />
          <Route path="/tasks" element={<Tasks />} />
          <Route path="/tasks/new" element={<TaskEdit />} />
          <Route path="/tasks/:id" element={<TaskEdit />} />
          <Route path="/agenda" element={<Agenda />} />
          <Route path="/vocab" element={<Vocab />} />
          <Route path="/events" element={<Events />} />
          <Route path="/messages" element={<MessagesList />} />
          <Route path="/messages/:id" element={<MessagesChat />} />
          <Route path="/settings" element={<Settings />} />
          <Route path="/child-settings" element={<ChildSettings />} />
        </Routes>
      </main>
      </div>
      <nav className="tabbar">
        <NavLink to="/" end>
          <Icon name="home" />
          <span>Ana sayfa</span>
        </NavLink>
        <NavLink to="/tasks">
          <Icon name="tasks" />
          <span>Görevler</span>
        </NavLink>
        <NavLink to="/agenda">
          <Icon name="calendar" />
          <span>Ajanda</span>
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
        <NavLink to="/child-settings">
          <Icon name="gear" />
          <span>Ayarlar</span>
        </NavLink>
      </nav>
    </div>
  );
}
