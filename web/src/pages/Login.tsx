import { useState } from "react";
import { errorText, supabase } from "../lib/supabase";

// E-posta + şifre. iPhone'da şifre iCloud Anahtar Zinciri'ne kaydedilir ve sonraki girişlerde Face ID ile dolar.
// Kayıt sadece davet listesindeki e-postalar için işe yarar; diğerleri giriş yapsa bile veri göremez.
export default function Login() {
  const [mode, setMode] = useState<"login" | "signup">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr("");
    setMsg("");
    if (mode === "login") {
      const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
      if (error) setErr(errorText(error));
    } else {
      if (password.length < 10) {
        setErr("Şifre en az 10 karakter olmalı.");
        setBusy(false);
        return;
      }
      const { data, error } = await supabase.auth.signUp({
        email: email.trim(),
        password,
        options: { emailRedirectTo: window.location.origin },
      });
      if (error) setErr(errorText(error));
      else if (!data.session) setMsg("Doğrulama e-postası gönderildi. Bağlantıya dokun, sonra buradan giriş yap.");
    }
    setBusy(false);
  }

  async function reset() {
    if (!email.trim()) {
      setErr("Önce e-posta adresini yaz.");
      return;
    }
    const { error } = await supabase.auth.resetPasswordForEmail(email.trim(), { redirectTo: window.location.origin });
    if (error) setErr(errorText(error));
    else setMsg("Şifre sıfırlama bağlantısı e-postana gönderildi.");
  }

  return (
    <div className="center-screen">
      <form className="card narrow" onSubmit={submit}>
        <img src="/icon-192.png" alt="" width={64} height={64} />
        <h1>Orbit</h1>
        <p className="muted">Ebeveyn paneli</p>
        <label className="field">
          <span>E-posta</span>
          <input type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required />
        </label>
        <label className="field">
          <span>Şifre</span>
          <input
            type="password"
            autoComplete={mode === "login" ? "current-password" : "new-password"}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        </label>
        {err && <p className="error">{err}</p>}
        {msg && <p className="ok">{msg}</p>}
        <button className="btn primary wide" disabled={busy}>
          {mode === "login" ? "Giriş yap" : "Hesap oluştur"}
        </button>
        <div className="row between small">
          <button type="button" className="link" onClick={() => setMode(mode === "login" ? "signup" : "login")}>
            {mode === "login" ? "İlk kez mi? Hesap oluştur" : "Hesabın var mı? Giriş yap"}
          </button>
          {mode === "login" && (
            <button type="button" className="link" onClick={reset}>
              Şifremi unuttum
            </button>
          )}
        </div>
      </form>
    </div>
  );
}
