import { useCallback, useEffect, useMemo, useState } from "react";
import { DateField, TimeField } from "../components/DateTime";
import { useFamily } from "../lib/family";
import { errorText, supabase } from "../lib/supabase";
import { minutesText, todayISO } from "../lib/util";
import {
  clockText,
  timerElapsed,
  timerRemaining,
  type AlarmDef,
  type AlarmLog,
  type AllowStop,
  type FocusChange,
  type PauseMode,
  type TimerDefaults,
  type TimerSession,
} from "../lib/types";
import { Icon } from "../components/Icon";
import { Info } from "../components/Info";
import { MinuteStepper } from "../components/MinuteStepper";

const DAYS = ["Pzt", "Sal", "Çar", "Per", "Cum", "Cmt", "Paz"];
const STATUS: Record<TimerSession["status"], string> = { running: "çalışıyor", paused: "molada", done: "tamamlandı", stopped: "erken bitti", cancelled: "iptal" };
const DEF: TimerDefaults = { allow_stop: "notify", pause_mode: "limit", pause_max_minutes: 5, focus_change: "stricter" };

/** Çocuk sayfası → Sayaç & Alarm: canlı sayaç, uzaktan başlatma, rapor, alarmlar. */
export default function TimerTab({ childId, only }: { childId: string; only?: "alarms" }) {
  return (
    <div className="stack">
      {!only && <><LiveTimer childId={childId} /><StartTimer childId={childId} /><Report childId={childId} /></>}
      {only && <AlarmsCard childId={childId} />}
    </div>
  );
}

function LiveTimer({ childId }: { childId: string }) {
  const fam = useFamily();
  const [s, setS] = useState<TimerSession | null>(null);
  const [, tick] = useState(0);
  const [err, setErr] = useState("");

  const load = useCallback(async () => {
    const { data } = await supabase.from("timer_sessions").select("*").eq("child_id", childId).in("status", ["running", "paused"]).maybeSingle();
    setS((data as TimerSession | null) ?? null);
  }, [childId]);
  useEffect(() => {
    load();
    const a = setInterval(load, 5000);
    const b = setInterval(() => tick((x) => x + 1), 1000);
    return () => {
      clearInterval(a);
      clearInterval(b);
    };
  }, [load]);

  if (!s) return null;
  const left = timerRemaining(s);
  const focus = fam.focusProfiles.find((f) => f.id === s.focus_id);

  async function patch(v: Partial<TimerSession>) {
    setErr("");
    const { error } = await supabase.from("timer_sessions").update(v).eq("id", s!.id);
    if (error) setErr(errorText(error));
    load();
    fam.reload();
  }
  const now = new Date().toISOString();

  return (
    <div className="card parent-mode-on">
      <div className="row gap-s" style={{ alignItems: "center" }}>
        <span style={{ fontSize: 30 }}>{s.icon ?? "⏱"}</span>
        <div className="grow">
          <h2 style={{ margin: 0 }}>{s.title}</h2>
          <div className="muted small">
            {s.started_by === "parent" ? "sen başlattın" : "kendisi başlattı"} · {STATUS[s.status]}
            {focus ? ` · ${focus.icon ?? "🎯"} ${focus.name}` : " · serbest"}
          </div>
        </div>
        <b style={{ fontSize: 28 }}>{clockText(left ?? timerElapsed(s))}</b>
      </div>
      <div className="muted small">
        Odaklı {Math.round(s.focused_seconds / 60)} dk · başka şeylerle {Math.round(s.away_seconds / 60)} dk
      </div>
      <div className="row gap-s wrap">
        {s.status === "running" ? (
          <button className="btn" onClick={() => patch({ status: "paused", paused_at: now })}>
            Mola ver
          </button>
        ) : (
          <button
            className="btn"
            onClick={() =>
              patch({
                status: "running",
                paused_at: null,
                paused_seconds: s.paused_seconds + (s.paused_at ? Math.round((Date.now() - new Date(s.paused_at).getTime()) / 1000) : 0),
              })
            }
          >
            Devam ettir
          </button>
        )}
        <button className="btn primary" onClick={() => patch({ status: s.kind === "stopwatch" || (left ?? 0) <= 0 ? "done" : "stopped", ended_at: now, ended_by: "parent" })}>
          Bitir
        </button>
        <button className="btn ghost danger-text" onClick={() => confirm("Sayaç iptal edilsin mi?") && patch({ status: "cancelled", ended_at: now, ended_by: "parent" })}>
          İptal
        </button>
      </div>
      {err && <p className="error">{err}</p>}
    </div>
  );
}

function StartTimer({ childId }: { childId: string }) {
  const fam = useFamily();
  const child = fam.children.find((c) => c.id === childId)!;
  const d = { ...DEF, ...(child.timer_defaults ?? {}) };
  const [open, setOpen] = useState(false);
  const [activity, setActivity] = useState(fam.activities[0]?.id ?? "");
  const [title, setTitle] = useState("");
  const [hours, setHours] = useState(0);
  const [minutePart, setMinutePart] = useState(30);
  const [focus, setFocus] = useState<string>("");
  const [allowStop, setAllowStop] = useState<AllowStop>(d.allow_stop);
  const [pauseMode, setPauseMode] = useState<PauseMode>(d.pause_mode);
  const [pauseMax, setPauseMax] = useState(String(d.pause_max_minutes ?? 5));
  const [focusChange, setFocusChange] = useState<FocusChange>(d.focus_change);
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");

  useEffect(() => {
    const a = fam.activities.find((x) => x.id === activity);
    if (a) setFocus(a.default_focus_id ?? "");
  }, [activity, fam.activities]);

  if (fam.timers[childId]) return null;
  if (!open)
    return (
      <button className="timer-fab" aria-label={`${child.name} için sayaç başlat`} onClick={() => setOpen(true)}>
        +
      </button>
    );

  async function start() {
    setErr("");
    const a = fam.activities.find((x) => x.id === activity);
    const m = hours * 60 + minutePart;
    const { error } = await supabase.from("timer_sessions").insert({
      family_id: child.family_id,
      child_id: childId,
      activity_id: a?.id ?? null,
      title: (activity === "other" ? title : a?.name ?? title).trim() || "Çalışma",
      icon: a?.icon ?? "⏱",
      kind: m > 0 ? "countdown" : "stopwatch",
      planned_seconds: m > 0 ? m * 60 : null,
      focus_id: focus || null,
      started_by: "parent",
      allow_stop: allowStop,
      pause_mode: pauseMode,
      pause_max_minutes: pauseMode === "limit" ? Number(pauseMax) || 5 : null,
      focus_change: focusChange,
    });
    if (error) return setErr(errorText(error));
    setOpen(false);
    setMsg("Başlatıldı, telefona birkaç saniyede geçer.");
    fam.reload();
  }

  async function saveDefaults() {
    const v: TimerDefaults = { allow_stop: allowStop, pause_mode: pauseMode, pause_max_minutes: Number(pauseMax) || 5, focus_change: focusChange };
    const { error } = await supabase.from("children").update({ timer_defaults: v }).eq("id", childId);
    setMsg(error ? errorText(error) : "Varsayılan olarak kaydedildi");
    fam.reload();
  }

  return (
    <div className="sheet-backdrop" onClick={() => setOpen(false)}>
    <div className="sheet compact-sheet" onClick={(e) => e.stopPropagation()}>
      <div className="row between"><h2>Sayaç başlat</h2><button className="icon-btn" onClick={() => setOpen(false)} aria-label="Kapat">×</button></div>
      <div className="extra-group">
        <span className="pop-label">NE ÇALIŞACAK</span>
        <div className="chips">
          {fam.activities.map((a) => (
            <button key={a.id} type="button" className={`chip-btn ${activity === a.id ? "on" : ""}`} onClick={() => setActivity(a.id)}>
              {a.icon} {a.name}
            </button>
          ))}
          <button type="button" className={`chip-btn ${activity === "other" ? "on" : ""}`} onClick={() => setActivity("other")}>
            ✍️ Diğer
          </button>
        </div>
        {activity === "other" && <input className="compact-input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Ne çalışacak?" />}
      </div>
      <div className="extra-group">
        <span className="pop-label">
          SÜRE <Info>İkisi de 0 olursa süre sınırı olmayan kronometre başlar.</Info>
        </span>
        <div className="extra-row">
          <MinuteStepper value={hours} onChange={setHours} max={12} unit="sa" label="Saat" />
          <MinuteStepper value={minutePart} onChange={setMinutePart} max={59} label="Dakika" />
          {hours === 0 && minutePart === 0 && <span className="muted small">⏱ Kronometre</span>}
        </div>
      </div>
      <div className="extra-group">
        <span className="pop-label">ODAK PROFİLİ</span>
        <div className="chips">
          <button type="button" className={`chip-btn ${focus === "" ? "on" : ""}`} onClick={() => setFocus("")}>
            Serbest
          </button>
          {fam.focusProfiles.map((f) => (
            <button key={f.id} type="button" className={`chip-btn ${focus === f.id ? "on" : ""}`} onClick={() => setFocus(f.id)}>
              {f.icon} {f.name}
            </button>
          ))}
        </div>
      </div>
        <div className="extra-group">
          <span className="pop-label">ERKEN BİTİRME</span>
          <div className="chips">
            {([["no", "İzin yok"], ["yes", "İzinli"], ["notify", "İzinli, bana bildir"]] as const).map(([v, l]) => (
              <button key={v} type="button" className={`chip-btn ${allowStop === v ? "on" : ""}`} onClick={() => setAllowStop(v as AllowStop)}>
                {l}
              </button>
            ))}
          </div>
        </div>
        <div className="extra-group">
          <span className="pop-label">ODAK DEĞİŞTİRME</span>
          <div className="chips">
            {([["no", "İzin yok"], ["stricter", "Sadece daha sıkıya"], ["free", "Serbest"]] as const).map(([v, l]) => (
              <button key={v} type="button" className={`chip-btn ${focusChange === v ? "on" : ""}`} onClick={() => setFocusChange(v as FocusChange)}>
                {l}
              </button>
            ))}
          </div>
        </div>
        <div className="extra-group">
          <span className="pop-label">MOLA</span>
          <div className="extra-row">
            <div className="chips">
              {([["none", "Yok"], ["limit", "Sınırlı"], ["child", "Çocuk karar versin"]] as const).map(([v, l]) => (
                <button key={v} type="button" className={`chip-btn ${pauseMode === v ? "on" : ""}`} onClick={() => setPauseMode(v as PauseMode)}>
                  {l}
                </button>
              ))}
            </div>
            {pauseMode === "limit" && <MinuteStepper value={Number(pauseMax) || 5} onChange={(v) => setPauseMax(String(v))} min={1} max={60} label="Mola en fazla" />}
          </div>
        </div>
      {err && <p className="error">{err}</p>}
      <div className="extra-actions">
        <button type="button" className="pill-btn ghost" onClick={saveDefaults}>
          Varsayılan yap
        </button>
        <span className="grow" />
        <button type="button" className="pill-btn" onClick={() => setOpen(false)}>
          Vazgeç
        </button>
        <button type="button" className="pill-btn primary" onClick={start}>
          Başlat
        </button>
      </div>
      {msg && <p className="ok small">{msg}</p>}
    </div>
    </div>
  );
}

function Report({ childId }: { childId: string }) {
  const fam = useFamily();
  const [range, setRange] = useState<"today" | "week" | "month" | "custom">("today");
  const [fromDate, setFromDate] = useState(todayISO("Europe/Berlin", -29));
  const [toDate, setToDate] = useState(todayISO());
  const [rows, setRows] = useState<TimerSession[]>([]);

  useEffect(() => {
    const from = range === "today" ? todayISO() : range === "week" ? todayISO("Europe/Berlin", -6) : range === "month" ? todayISO("Europe/Berlin", -29) : fromDate;
    const to = range === "custom" ? toDate : todayISO();
    supabase
      .from("timer_sessions")
      .select("*")
      .eq("child_id", childId)
      .gte("started_at", new Date(from).toISOString())
      .lte("started_at", new Date(`${to}T23:59:59`).toISOString())
      .order("started_at", { ascending: false })
      .limit(200)
      .then(({ data }) => setRows((data ?? []) as TimerSession[]));
  }, [childId, range, fromDate, toDate, fam.timers]);

  const byActivity = useMemo(() => {
    const m = new Map<string, { title: string; icon: string | null; secs: number; focus: number; n: number }>();
    for (const r of rows) {
      if (r.status === "cancelled") continue;
      const k = r.activity_id ?? `t:${r.title}`;
      const v = m.get(k) ?? { title: r.title, icon: r.icon, secs: 0, focus: 0, n: 0 };
      v.secs += r.focused_seconds + r.away_seconds;
      v.focus += r.focused_seconds;
      v.n++;
      m.set(k, v);
    }
    return [...m.values()].sort((a, b) => b.secs - a.secs);
  }, [rows]);
  const total = byActivity.reduce((a, b) => a + b.secs, 0);

  return (
    <div className="card">
      <div className="row between">
        <h2>Rapor</h2>
        <div className="segmented small">
          {([['today', 'Bugün'], ['week', '7 gün'], ['month', '1 ay'], ['custom', 'Özel']] as const).map(([value, label]) => (
            <button key={value} className={range === value ? "on" : ""} onClick={() => setRange(value)}>{label}</button>
          ))}
        </div>
      </div>
      {range === "custom" && <div className="grid2">
        <label className="field"><span>Başlangıç</span><DateField value={fromDate} onChange={setFromDate} /></label>
        <label className="field"><span>Bitiş</span><DateField value={toDate} onChange={setToDate} /></label>
      </div>}
      {!rows.length && <p className="muted small">Henüz sayaç yok.</p>}
      {total > 0 && <p><b>Toplam {minutesText(Math.round(total / 60))}</b></p>}
      {byActivity.map((a) => (
        <div className="app-row" key={a.title}>
          <span style={{ fontSize: 20 }}>{a.icon ?? "⏱"}</span>
          <div className="grow">
            <b>{a.title}</b>
            <div className="muted tiny">
              {a.n} kez · odak %{a.secs ? Math.round((a.focus / a.secs) * 100) : 0}
            </div>
          </div>
          <b>{minutesText(Math.round(a.secs / 60))}</b>
        </div>
      ))}
      {rows.length > 0 && (
        <details>
          <summary className="sub-collapse-head"><span>Tüm sayaçlar ({rows.length})</span><span className="collapse-arrow" aria-hidden="true" /></summary>
          {rows.map((r) => (
            <div className="app-row" key={r.id}>
              <span>{r.icon ?? "⏱"}</span>
              <div className="grow">
                {r.title}
                <div className="muted tiny">
                  {new Date(r.started_at).toLocaleString("tr-TR", { weekday: "short", hour: "2-digit", minute: "2-digit" })} ·{" "}
                  {r.started_by === "parent" ? "sen" : "kendisi"} · {STATUS[r.status]}
                  {r.ended_by === "parent" ? " (sen bitirdin)" : ""}
                </div>
              </div>
              <span className="muted small">{Math.round((r.focused_seconds + r.away_seconds) / 60)} dk</span>
            </div>
          ))}
        </details>
      )}
    </div>
  );
}

const emptyAlarm = (childId: string, familyId: string): Partial<AlarmDef> => ({
  child_id: childId,
  family_id: familyId,
  title: "",
  kind: "alarm",
  at_time: "07:00",
  days: [1, 2, 3, 4, 5],
  on_date: null,
  active: true,
  child_can_edit: false,
  child_can_delete: false,
  snooze_max: 2,
  snooze_minutes: 5,
});

function AlarmsCard({ childId }: { childId: string }) {
  const fam = useFamily();
  const child = fam.children.find((c) => c.id === childId)!;
  const [list, setList] = useState<AlarmDef[]>([]);
  const [log, setLog] = useState<AlarmLog[]>([]);
  const [edit, setEdit] = useState<Partial<AlarmDef> | null>(null);
  const [err, setErr] = useState("");

  const load = useCallback(async () => {
    const [{ data: a }, { data: l }] = await Promise.all([
      supabase.from("alarms").select("*").eq("child_id", childId).order("at_time"),
      supabase.from("alarm_log").select("*").eq("child_id", childId).order("fired_at", { ascending: false }).limit(10),
    ]);
    setList((a ?? []) as AlarmDef[]);
    setLog((l ?? []) as AlarmLog[]);
  }, [childId]);
  useEffect(() => {
    load();
  }, [load]);

  async function save() {
    if (!edit) return;
    setErr("");
    if (!edit.title?.trim()) return setErr("Başlık yaz.");
    const row = {
      family_id: child.family_id,
      child_id: childId,
      title: edit.title.trim(),
      kind: edit.kind,
      at_time: edit.at_time,
      days: edit.days ?? [],
      on_date: (edit.days ?? []).length ? null : edit.on_date || todayISO("Europe/Berlin", 1),
      active: edit.active ?? true,
      child_can_edit: edit.child_can_edit ?? false,
      child_can_delete: edit.child_can_delete ?? false,
      snooze_max: edit.snooze_max ?? 2,
      snooze_minutes: edit.snooze_minutes ?? 5,
    };
    const { error } = edit.id ? await supabase.from("alarms").update(row).eq("id", edit.id) : await supabase.from("alarms").insert(row);
    if (error) return setErr(errorText(error));
    setEdit(null);
    load();
  }

  async function remove(a: AlarmDef) {
    if (!confirm(`"${a.title}" silinsin mi?`)) return;
    await supabase.from("alarms").delete().eq("id", a.id);
    load();
  }

  return (
    <div className="card">
      <div className="row between">
        <h2>Hatırlatıcılar <Info>Alarm tam ekran ve sesli çalışır; hatırlatıcı yalnızca bildirim gönderir. Alarm telefonda internet olmasa da çalar (bir kez telefona ulaşmış olması yeter).</Info></h2>
      </div>
      {edit && (
        <div className="sub-card extra-card">
          <input className="compact-input" value={edit.title ?? ""} onChange={(e) => setEdit({ ...edit, title: e.target.value })} placeholder="Başlık (ör. Kalk 🌞, İlacını iç)" />
          <div className="extra-group">
            <span className="pop-label">
              TÜR <Info>Alarm tam ekran ve sesli çalar; hatırlatıcı yalnızca bildirim gönderir.</Info>
            </span>
            <div className="chips">
              <button type="button" className={`chip-btn ${edit.kind === "alarm" ? "on" : ""}`} onClick={() => setEdit({ ...edit, kind: "alarm" })}>
                ⏰ Alarm
              </button>
              <button type="button" className={`chip-btn ${edit.kind === "reminder" ? "on" : ""}`} onClick={() => setEdit({ ...edit, kind: "reminder" })}>
                🔔 Hatırlatıcı
              </button>
            </div>
          </div>
          <div className="extra-group">
            <span className="pop-label">
              NE ZAMAN <Info>Gün seçmezsen tek seferlik çalar; o zaman tarih seçersin.</Info>
            </span>
            <div className="extra-row">
              <TimeField value={(edit.at_time ?? "07:00").slice(0, 5)} onChange={(v) => setEdit({ ...edit, at_time: v })} />
              {!(edit.days ?? []).length && <DateField value={edit.on_date ?? todayISO("Europe/Berlin", 1)} onChange={(v) => setEdit({ ...edit, on_date: v })} />}
            </div>
            <div className="chips">
              {DAYS.map((n, i) => {
                const d = i + 1;
                const on = (edit.days ?? []).includes(d);
                return (
                  <button key={d} type="button" className={`chip-btn ${on ? "on" : ""}`} onClick={() => setEdit({ ...edit, days: on ? (edit.days ?? []).filter((x) => x !== d) : [...(edit.days ?? []), d] })}>
                    {n}
                  </button>
                );
              })}
            </div>
          </div>
          <div className="extra-group">
            <span className="pop-label">{child.name.toLocaleUpperCase("tr-TR")} NE YAPABİLİR</span>
            <div className="chips">
              <button type="button" className={`chip-btn ${edit.child_can_edit ? "on" : ""}`} aria-pressed={!!edit.child_can_edit} onClick={() => setEdit({ ...edit, child_can_edit: !edit.child_can_edit })}>
                {edit.child_can_edit ? "✓ " : ""}Değiştirebilir
              </button>
              <button type="button" className={`chip-btn ${edit.child_can_delete ? "on" : ""}`} aria-pressed={!!edit.child_can_delete} onClick={() => setEdit({ ...edit, child_can_delete: !edit.child_can_delete })}>
                {edit.child_can_delete ? "✓ " : ""}Silebilir
              </button>
            </div>
          </div>
          {edit.kind === "alarm" && (
            <div className="extra-group">
              <span className="pop-label">
                ERTELEME <Info>Çocuk alarmı en fazla bu kadar kez, her seferinde bu kadar dakika erteleyebilir. 0 kez = ertelenemez.</Info>
              </span>
              <div className="extra-row">
                <MinuteStepper value={edit.snooze_max ?? 2} onChange={(v) => setEdit({ ...edit, snooze_max: v })} max={10} unit="kez" label="Kaç kez" />
                <MinuteStepper value={edit.snooze_minutes ?? 5} onChange={(v) => setEdit({ ...edit, snooze_minutes: v })} min={1} max={30} label="Kaç dakika" />
              </div>
            </div>
          )}
          {err && <p className="error">{err}</p>}
          <div className="extra-actions">
            <span className="grow" />
            <button type="button" className="pill-btn" onClick={() => setEdit(null)}>
              Vazgeç
            </button>
            <button type="button" className="pill-btn primary" onClick={save}>
              Kaydet
            </button>
          </div>
        </div>
      )}
      {!list.length && !edit && <p className="muted small">Henüz alarm yok.</p>}
      {list.map((a) => (
        <div className="app-row wrap" key={a.id}>
          <b style={{ fontSize: 20, minWidth: 56 }}>{a.at_time.slice(0, 5)}</b>
          <div className="grow">
            {a.kind === "alarm" ? "⏰" : "🔔"} {a.title}
            <div className="muted tiny">
              {a.days.length ? (a.days.length === 7 ? "her gün" : [...a.days].sort().map((d) => DAYS[d - 1]).join(" ")) : a.on_date ?? "tek sefer"}
              {" · "}
              {a.by_parent ? "sen kurdun" : `${child.name} kurdu`}
              {!a.active ? " · kapalı" : ""}
            </div>
          </div>
          <label className="check">
            <input type="checkbox" checked={a.active} onChange={async (e) => { await supabase.from("alarms").update({ active: e.target.checked }).eq("id", a.id); load(); }} />
          </label>
          <button className="icon-btn" aria-label="Düzenle" onClick={() => setEdit(a)}>
            ✎
          </button>
          <button className="icon-btn" aria-label="Sil" onClick={() => remove(a)}>
            <Icon name="trash" size={18} />
          </button>
        </div>
      ))}
      {log.length > 0 && (
        <details>
          <summary className="sub-collapse-head"><span>Son çalan alarmlar</span><span className="collapse-arrow" aria-hidden="true" /></summary>
          {log.map((l) => (
            <div className="muted small" key={l.id}>
              {new Date(l.fired_at).toLocaleString("tr-TR", { weekday: "short", hour: "2-digit", minute: "2-digit" })} · {l.title} ·{" "}
              {l.dismissed_at
                ? `${Math.max(0, Math.round((new Date(l.dismissed_at).getTime() - new Date(l.fired_at).getTime()) / 60000))} dk sonra kapattı`
                : "kapatılmadı"}
              {l.snoozes ? ` · ${l.snoozes} kez erteledi` : ""}
            </div>
          ))}
        </details>
      )}
      <button className="agenda-fab" aria-label="Hatırlatıcı ekle" onClick={() => setEdit(emptyAlarm(childId, child.family_id))}>+</button>
    </div>
  );
}
