import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useFamily } from "../lib/family";
import { errorText, supabase } from "../lib/supabase";
import { sendCommand } from "../lib/actions";
import { hhmm, relTime } from "../lib/util";
import { mins, nowBerlin } from "../lib/sections";
import { KIOSK_SCREENS, type KioskScreen, type KioskSettings } from "../lib/types";

const DEFAULT_KIOSK: KioskSettings = { message: null, screens: ["tasks", "messages", "music", "timer", "alarms"], calls: "emergency" };
const KIND_LABEL: Record<string, string> = { kiosk: "🔒 Tam kilit", music_off: "🔇 Müzik kapalı", music_on: "🎵 Müzik açık" };
const DAYS = ["Pzt", "Sal", "Çar", "Per", "Cum", "Cmt", "Paz"];

async function sha256(text: string) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function ScreenPicker({ value, onChange }: { value: KioskScreen[]; onChange: (v: KioskScreen[]) => void }) {
  return (
    <div className="row gap-xs wrap">
      {KIOSK_SCREENS.map(([k, label]) => {
        const on = value.includes(k);
        return (
          <button key={k} className={`chip small ${on ? "on" : ""}`} onClick={() => onChange(on ? value.filter((x) => x !== k) : [...value, k])}>
            {label}
          </button>
        );
      })}
    </div>
  );
}

type Cmd = { id: string; type: string; until_at: string | null; payload: { message?: string; screens?: KioskScreen[] }; created_at: string };

/** Çocuk sayfası: tam kilit (kiosk), ebeveyn PIN'i ve müzik ayarları. */
export default function LockTab({ childId }: { childId: string }) {
  const fam = useFamily();
  const child = fam.children.find((c) => c.id === childId)!;
  const ks: KioskSettings = { ...DEFAULT_KIOSK, ...(child.kiosk_settings ?? {}) };
  const [last, setLast] = useState<Cmd | null>(null);
  const [dur, setDur] = useState("60");
  const [until, setUntil] = useState("19:00");
  const [message, setMessage] = useState(ks.message ?? "");
  const [screens, setScreens] = useState<KioskScreen[]>(ks.screens);
  const [defMsg, setDefMsg] = useState(ks.message ?? "");
  const [pin, setPin] = useState("");
  const [err, setErr] = useState("");
  const [msg, setMsg] = useState("");

  const load = useCallback(async () => {
    const { data } = await supabase
      .from("commands")
      .select("id,type,until_at,payload,created_at")
      .eq("child_id", childId)
      .in("type", ["kiosk_start", "kiosk_end"])
      .is("cancelled_at", null)
      .order("created_at", { ascending: false })
      .limit(1);
    setLast(((data ?? [])[0] as Cmd) ?? null);
  }, [childId]);
  useEffect(() => {
    load();
  }, [load]);

  const manualOn = last?.type === "kiosk_start" && (!last.until_at || Date.parse(last.until_at) > Date.now());

  async function start() {
    setErr("");
    setMsg("");
    let untilAt: string | null = null;
    if (dur === "until") {
      const { minute } = nowBerlin();
      const diff = (mins(until) - minute + 1440) % 1440 || 1440;
      untilAt = new Date(Date.now() + diff * 60000).toISOString();
    } else if (dur !== "none") untilAt = new Date(Date.now() + Number(dur) * 60000).toISOString();
    try {
      await sendCommand(childId, "kiosk_start", { message: message.trim() || null, screens }, untilAt);
      setMsg("Tam kilit gönderildi (birkaç saniye içinde telefonda açılır)");
      load();
    } catch (e) {
      setErr(errorText(e));
    }
  }

  async function end() {
    setErr("");
    try {
      await sendCommand(childId, "kiosk_end", {});
      setMsg("Kilit kaldırıldı. Programdaki bir tam kilit sürüyorsa o da bu sefer biter.");
      load();
    } catch (e) {
      setErr(errorText(e));
    }
  }

  async function saveChild(v: Record<string, unknown>, ok?: string) {
    setErr("");
    const { error } = await supabase.from("children").update(v).eq("id", childId);
    if (error) return setErr(errorText(error));
    if (ok) setMsg(ok);
    fam.reload();
  }

  async function savePin() {
    if (!/^\d{4,8}$/.test(pin)) return setErr("PIN 4–8 rakam olmalı.");
    await saveChild({ parent_pin_hash: await sha256(`${childId}:${pin}`), parent_pin_enabled: true }, "PIN kaydedildi ve açıldı");
    setPin("");
  }

  const rules = fam.timeRules.filter((r) => !r.child_ids.length || r.child_ids.includes(childId));
  const kioskSections = fam.sections.filter((s) => s.kiosk);
  const musicOffSections = fam.sections.filter((s) => s.music === false);
  const profName = (id: string) => fam.profiles.find((p) => p.id === id)?.name ?? "";
  const daysText = (d: number[]) => (d.length === 7 ? "her gün" : d.map((x) => DAYS[x - 1]).join(" "));

  return (
    <div className="stack">
      {err && <p className="error">{err}</p>}
      {msg && <p className="ok">{msg}</p>}

      <div className="card">
        <h2>🔒 Tam kilit</h2>
        <p className="muted small">
          Telefonda sadece Orbit'in kilit ekranı kalır: diğer uygulamalar, ayarlar, bildirim paneli açılmaz. Ekranı kapatıp açınca kendi PIN'ini girer ve yine bu ekrana döner.
        </p>
        {manualOn ? (
          <>
            <p>
              <b>Açık</b> · {last!.until_at ? `${new Date(last!.until_at).toLocaleTimeString("tr-TR", { hour: "2-digit", minute: "2-digit" })}'e kadar` : "sen kaldırana kadar"}
              <span className="muted small"> · {relTime(last!.created_at)} başladı</span>
            </p>
            {last!.payload?.message && <p className="small">"{last!.payload.message}"</p>}
            <button className="btn primary" onClick={end}>
              Kilidi kaldır
            </button>
          </>
        ) : (
          <>
            <label className="field">
              <span>Ne kadar</span>
              <select value={dur} onChange={(e) => setDur(e.target.value)}>
                <option value="15">15 dk</option>
                <option value="30">30 dk</option>
                <option value="60">1 saat</option>
                <option value="120">2 saat</option>
                <option value="until">Belirli saate kadar</option>
                <option value="none">Ben kaldırana kadar</option>
              </select>
            </label>
            {dur === "until" && <input type="time" value={until} onChange={(e) => setUntil(e.target.value)} aria-label="Bitiş saati" />}
            <label className="field">
              <span>Çocuğa mesaj</span>
              <input value={message} onChange={(e) => setMessage(e.target.value)} placeholder="Ders saati — önce ödevlerini bitir" maxLength={160} />
            </label>
            <span className="small">Orbit'te açık kalacak ekranlar</span>
            <ScreenPicker value={screens} onChange={setScreens} />
            <div className="row gap-s">
              <button className="btn primary" onClick={start}>
                Şimdi kilitle
              </button>
              <button className="btn ghost" onClick={end}>
                Süren kilidi kaldır
              </button>
            </div>
          </>
        )}
      </div>

      <div className="card">
        <h2>Programdaki kilitler ve müzik</h2>
        {!rules.length && !kioskSections.length && !musicOffSections.length && <p className="muted small">Henüz yok.</p>}
        {kioskSections.map((s) => (
          <p className="small" key={s.id}>
            🔒 Bölüm: {profName(s.profile_id)} · {s.name} {hhmm(s.start_time)}–{hhmm(s.end_time)}
          </p>
        ))}
        {musicOffSections.map((s) => (
          <p className="small" key={`m${s.id}`}>
            🔇 Bölüm: {profName(s.profile_id)} · {s.name} {hhmm(s.start_time)}–{hhmm(s.end_time)}
          </p>
        ))}
        {rules.map((r) => (
          <p className={`small ${r.active ? "" : "muted"}`} key={r.id}>
            {KIND_LABEL[r.kind]}: {r.name} · {daysText(r.days)} {hhmm(r.start_time)}–{hhmm(r.end_time)}
            {r.active ? "" : " (kapalı)"}
          </p>
        ))}
        <p className="muted tiny">Bölümlerde: Kurallar → gün tipi → bölüm → "Tam kilit" / "Müzik çalabilir". Bölümlerden bağımsız kurallar için:</p>
        <Link to="/rules/time" className="btn small">
          Zaman kuralları
        </Link>
      </div>

      <div className="card">
        <h2>Tam kilit varsayılanları</h2>
        <label className="field">
          <span>Varsayılan mesaj</span>
          <input
            value={defMsg}
            onChange={(e) => setDefMsg(e.target.value)}
            onBlur={() => defMsg !== (ks.message ?? "") && saveChild({ kiosk_settings: { ...ks, message: defMsg.trim() || null } }, "Kaydedildi")}
            placeholder="Şu an telefon kilitli"
          />
        </label>
        <span className="small">Açık kalacak Orbit ekranları</span>
        <ScreenPicker value={ks.screens} onChange={(v) => saveChild({ kiosk_settings: { ...ks, screens: v } })} />
        <label className="field">
          <span>Telefon aramaları</span>
          <select value={ks.calls} onChange={(e) => saveChild({ kiosk_settings: { ...ks, calls: e.target.value } }, "Kaydedildi")}>
            <option value="emergency">Sadece acil arama</option>
            <option value="all">Aramalar açık (telefon uygulaması)</option>
          </select>
        </label>
      </div>

      <div className="card">
        <h2>🔐 Ebeveyn PIN'i (telefonda)</h2>
        <p className="muted small">Telefonda doğru PIN girilince 15 dakika boyunca tam kilit ve bütün kısıtlamalar kalkar (ayarlara girebilirsin). Her girişte sana bildirilir.</p>
        <label className="check">
          <input
            type="checkbox"
            checked={!!child.parent_pin_enabled}
            disabled={!child.parent_pin_hash}
            onChange={(e) => saveChild({ parent_pin_enabled: e.target.checked }, e.target.checked ? "PIN açık" : "PIN kapalı")}
          />
          PIN ile açma {child.parent_pin_hash ? (child.parent_pin_enabled ? "açık" : "kapalı") : "(önce PIN belirle)"}
        </label>
        <div className="row gap-s">
          <input type="password" inputMode="numeric" className="grow" value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, "").slice(0, 8))} placeholder={child.parent_pin_hash ? "Yeni PIN" : "PIN (4–8 rakam)"} />
          <button className="btn small" onClick={savePin}>
            Kaydet
          </button>
        </div>
      </div>

      <div className="card">
        <h2>🎵 Müzik</h2>
        <p className="muted small">Orbit'teki müzik çalar süreden düşmez; arka planda ve ekran kapalıyken de çalar.</p>
        <label className="field">
          <span>Ne zaman çalabilir</span>
          <select value={child.music_mode ?? "rules"} onChange={(e) => saveChild({ music_mode: e.target.value }, "Kaydedildi")}>
            <option value="rules">Kurallara göre (bölüm ve zaman kuralları)</option>
            <option value="always">Her zaman</option>
            <option value="never">Hiç (müzik kapalı)</option>
          </select>
        </label>
        <label className="field">
          <span>Klasör</span>
          <select value={child.music_folder ?? ""} onChange={(e) => saveChild({ music_folder: e.target.value || null }, "Kaydedildi")}>
            <option value="">Çocuk kendisi seçsin</option>
            {(child.music_folders ?? []).map((f) => (
              <option key={f} value={f}>
                📁 {f}
              </option>
            ))}
          </select>
        </label>
        {!(child.music_folders ?? []).length && <p className="muted tiny">Klasör listesi, çocuk telefonda Müzik ekranını ilk açtığında buraya gelir.</p>}
      </div>
    </div>
  );
}
