import { useState } from "react";
import { errorText, supabase } from "../lib/supabase";

// E-posta + şifre. iPhone'da şifre iCloud Anahtar Zinciri'ne kaydedilir ve sonraki girişlerde Face ID ile dolar.
// Yeni hesap açma kapalı: hesaplar sadece veritabanındaki davet listesiyle açılabilir.
export default function Login() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr("");
    const { error } = await supabase.auth.signInWithPassword({ email: email.trim().toLowerCase(), password });
    if (error) setErr(errorText(error));
    setBusy(false);
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
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        </label>
        {err && <p className="error">{err}</p>}
        <button className="btn primary wide" disabled={busy}>
          Giriş yap
        </button>
      </form>
    </div>
  );
}
