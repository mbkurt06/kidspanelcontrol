import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useFamily } from "../lib/family";
import { errorText, supabase } from "../lib/supabase";
import { minutesText } from "../lib/util";
import { STATUS_LABEL, type Task, type TaskGroup, type TaskGroupRun, type TaskRun } from "../lib/types";
import { DAY_SHORT, WEEKDAYS, WEEKEND, groupDay, groupProgress, groupTasks, moveToGroup, repeatChoice, repeatText, saveOrder, type RepeatChoice } from "../lib/groups";
import { DateField, TimeField } from "./DateTime";
import { MinuteStepper } from "./MinuteStepper";
import { Info } from "./Info";
import { Icon } from "./Icon";

type Props = {
  group: TaskGroup;
  groups: TaskGroup[];
  tasks: Task[];
  runs: TaskRun[];
  groupRuns: TaskGroupRun[];
  childFilter: string;
  initialTab?: "tasks" | "settings" | "history";
  onChange: () => void;
  onDeleted: () => void;
};

const STATUS_COLOR: Record<string, string> = { approved: "var(--good)", submitted: "var(--warn)", rejected: "var(--bad)", expired: "var(--muted)" };

export default function TaskGroupDetail(p: Props) {
  const fam = useFamily();
  const [appLabel, setAppLabel] = useState<Record<string, string>>({});
  useEffect(() => {
    supabase.from("child_apps").select("package, label").then(({ data }) => {
      const m: Record<string, string> = {};
      ((data ?? []) as Array<{ package: string; label: string }>).forEach((a) => { if (a.label) m[a.package] = a.label; });
      setAppLabel(m);
    });
  }, []);
  const nav = useNavigate();
  const [tab, setTab] = useState<"tasks" | "settings" | "history">(p.initialTab ?? "tasks");
  const [err, setErr] = useState("");
  const [menu, setMenu] = useState<string | null>(null);
  const [moveFor, setMoveFor] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [drag, setDrag] = useState<string | null>(null);
  const g = p.group;
  useEffect(() => setTab(p.initialTab ?? "tasks"), [g.id, p.initialTab]);

  const list = useMemo(() => groupTasks(g, p.tasks), [g, p.tasks]);
  const kids = fam.children.filter((c) => g.child_ids.includes(c.id) && (p.childFilter === "all" || p.childFilter === c.id));
  const day = groupDay(g);
  const singles = p.tasks.filter((t) => !t.group_id);

  const runOf = (t: Task, childId: string) => p.runs.find((r) => r.task_id === t.id && r.child_id === childId && r.day === day);

  async function patchGroup(v: Partial<TaskGroup>) {
    setErr("");
    const { error } = await supabase.from("task_groups").update(v).eq("id", g.id);
    if (error) setErr(errorText(error));
    p.onChange();
  }
  async function rename() {
    const name = prompt("Grubun adı", g.name)?.trim();
    if (name && name !== g.name) patchGroup({ name });
  }
  async function removeGroup() {
    if (!confirm(`"${g.name}" grubu silinsin mi? İçindeki görevler silinmez, tek görev olarak kalır.`)) return;
    await supabase.from("tasks").update({ group_id: null }).eq("group_id", g.id);
    const { error } = await supabase.from("task_groups").delete().eq("id", g.id);
    if (error) return setErr(errorText(error));
    p.onDeleted();
  }
  async function reorder(from: string, to: string) {
    const ids = list.map((t) => t.id);
    const a = ids.indexOf(from);
    const b = ids.indexOf(to);
    if (a < 0 || b < 0 || a === b) return;
    const next = [...list];
    const [x] = next.splice(a, 1);
    next.splice(b, 0, x);
    await saveOrder(next);
    p.onChange();
  }
  async function step(t: Task, d: number) {
    const i = list.findIndex((x) => x.id === t.id);
    const j = i + d;
    if (j < 0 || j >= list.length) return;
    await reorder(t.id, list[j].id);
  }
  async function toggleMandatory(t: Task) {
    const { error } = await supabase.from("tasks").update({ mandatory: !t.mandatory }).eq("id", t.id);
    if (error) setErr(errorText(error));
    p.onChange();
  }
  async function removeFromGroup(t: Task) {
    await moveToGroup(t, null, p.tasks);
    setMenu(null);
    p.onChange();
  }
  async function moveTo(t: Task, target: TaskGroup) {
    await moveToGroup(t, target, p.tasks);
    setMenu(null);
    setMoveFor(null);
    p.onChange();
  }
  async function deleteTask(t: Task) {
    if (!confirm(`"${t.title}" görevi ve geçmişi silinsin mi?`)) return;
    await supabase.from("tasks").delete().eq("id", t.id);
    setMenu(null);
    p.onChange();
  }

  const settingsText = (t: Task) =>
    [
      t.proof === "none" ? null : t.before_after ? "önce + sonra fotoğraf" : "fotoğraf",
      t.record_minutes != null ? (t.record_min_minutes ? `kamera kaydı ${t.record_min_minutes}–${t.record_minutes} dk` : `kamera kaydı ${t.record_minutes} dk`) : null,
      t.screenshot_min != null ? `ekran görüntüsü ${t.screenshot_min}${t.screenshot_max && t.screenshot_max > t.screenshot_min ? `–${t.screenshot_max}` : ""}` : null,
      t.screen_record_minutes != null ? (t.screen_record_min_minutes ? `ekran kaydı ${t.screen_record_min_minutes}–${t.screen_record_minutes} dk` : `ekran kaydı ${t.screen_record_minutes} dk`) : null,
      t.allowed_packages?.length ? `izinli: ${t.allowed_packages.map((p) => appLabel[p] ?? p.split(".").pop()).join(", ")}` : null,
      "onay",
    ]
      .filter(Boolean)
      .join(" · ");

  return (
    <div className="stack">
      <div className="group-head">
        <h2 className="group-title">{g.name}</h2>
        <button className="icon-pill" aria-label="Adı değiştir" onClick={rename}>✎</button>
        <span className="grow" />
        <span className="muted small">{repeatText(g)}</span>
        <span className="avatar-row">
          {fam.children.filter((c) => g.child_ids.includes(c.id)).map((c) => (
            <span key={c.id} className="mini-avatar" style={{ background: c.color }} title={c.name}>{c.name.slice(0, 1)}</span>
          ))}
        </span>
        <button className={`switch ${g.active ? "on" : ""}`} role="switch" aria-checked={g.active} aria-label="Grup aktif" onClick={() => patchGroup({ active: !g.active })}>
          <span />
        </button>
      </div>

      <div className="seg-tabs">
        <button className={tab === "tasks" ? "on" : ""} onClick={() => setTab("tasks")}>Görevler {list.length}</button>
        <button className={tab === "settings" ? "on" : ""} onClick={() => setTab("settings")}>Ayarlar</button>
        <button className={tab === "history" ? "on" : ""} onClick={() => setTab("history")}>Geçmiş</button>
      </div>
      {err && <p className="error">{err}</p>}

      {tab === "tasks" && (
        <>
          {!g.child_ids.length && <p className="warn-text small">Bu grup kimseye verilmedi. Ayarlar'dan çocuk seç.</p>}
          {kids.map((c) => {
            const pr = groupProgress(g, p.tasks, p.runs, p.groupRuns, c.id);
            const need = pr.need;
            const pct = need ? Math.min(100, Math.round((pr.approved / need) * 100)) : 0;
            const unlocked = g.reward_mode === "all" ? pr.all : pr.held;
            const left = Math.max(0, need - pr.approved);
            const next =
              pr.status === "met" ? `Koşul sağlandı · ${minutesText(unlocked)} açıldı`
              : pr.status === "failed" ? "Koşul sağlanmadı"
              : pr.submitted ? `${pr.submitted} görev onayını bekliyor`
              : pr.mandatoryLeft ? `Zorunlu görev bekleniyor${left ? ` · ${left} görev daha` : ""}`
              : left ? `${left} görev daha → ${minutesText(g.reward_mode === "all" ? pr.all : pr.held)}${g.reward_mode === "all" ? "" : "+"} açılır`
              : pr.total ? "Koşul sağlanmak üzere" : "Bugün bu grubun günü değil";
            return (
              <div className="group-stats" key={c.id}>
                <div className="stat-tile">
                  <span className="muted tiny"><span className="dot" style={{ background: c.color, marginTop: 0 }} /> {c.name} · toplam ödül</span>
                  <b>{minutesText(pr.all)}</b>
                </div>
                <div className="stat-tile">
                  <span className="muted tiny">Kazanılan {pr.status === "met" ? "" : "(kilitli)"}</span>
                  <b className={pr.status === "met" ? "good-text" : "warn-text"}>{minutesText(pr.held)}</b>
                </div>
                <div className="stat-tile">
                  <span className="muted tiny">Koşul · {g.min_count == null ? "hepsi" : `en az ${g.min_count}`}{list.some((t) => t.mandatory) ? " + zorunlu" : ""}</span>
                  <div className="row gap-s" style={{ alignItems: "center" }}>
                    <b>{pr.approved}/{need}</b>
                    <div className="bar grow"><div style={{ width: `${pct}%` }} /></div>
                  </div>
                </div>
                <div className={`stat-tile ${pr.status === "met" ? "good" : pr.status === "failed" ? "bad" : "next"}`}>
                  <span className="tiny" style={{ fontWeight: 600 }}>{pr.status === "met" ? "Tamam" : pr.status === "failed" ? "Bitti" : "Sırada"}</span>
                  <span className="small">{next}</span>
                </div>
              </div>
            );
          })}

          <div className="card table-card">
            <div className="table-head">
              <b>Grubun görevleri</b>
              <span className="muted tiny">{g.sequential ? "Sıralı · onay gelince sıradaki açılır" : "İstediği sırada"} · sürükleyip sırala</span>
              <span className="grow" />
              <div className="pop-anchor">
                <button className="pill-btn" onClick={() => setAdding((v) => !v)} disabled={!singles.length} title={singles.length ? "" : "Grupta olmayan görev yok"}>Var olanı ekle</button>
                {adding && (
                  <>
                    <div className="pop-backdrop" onClick={() => setAdding(false)} />
                    <div className="lock-pop menu-pop" role="menu">
                      <span className="pop-label">GRUBA EKLE</span>
                      {singles.map((t) => (
                        <button key={t.id} role="menuitem" className="menu-item" onClick={async () => { await moveToGroup(t, g, p.tasks); setAdding(false); p.onChange(); }}>
                          {t.title} <span className="muted tiny">{t.reward_minutes ? `+${t.reward_minutes} dk` : ""}</span>
                        </button>
                      ))}
                    </div>
                  </>
                )}
              </div>
              <button className="pill-btn primary" onClick={() => nav(`/tasks/new?group=${g.id}`)}>
                <Icon name="plus" size={14} /> Yeni görev
              </button>
            </div>
            {!list.length && <p className="muted small" style={{ padding: "0 16px 14px" }}>Bu grupta görev yok. "Var olanı ekle" ya da "Yeni görev" ile ekle.</p>}
            {list.map((t, i) => (
              <div
                key={t.id}
                className={`group-row ${drag === t.id ? "dragging" : ""}`}
                draggable
                onDragStart={() => setDrag(t.id)}
                onDragEnd={() => setDrag(null)}
                onDragOver={(e) => e.preventDefault()}
                onDrop={() => { if (drag) reorder(drag, t.id); setDrag(null); }}
              >
                <span className="drag-handle" aria-hidden="true">⋮⋮</span>
                <span className="order-badge">{i + 1}</span>
                <Link to={`/tasks/${t.id}`} className="grow group-row-title">
                  <b>{t.title}</b>
                  <span className="muted tiny">{settingsText(t)}</span>
                </Link>
                {g.recurrence !== "once" && <span className="repeat-badge" title={`Tekrarlı · ${repeatText(g)}`}>↻</span>}
                <span className="reward-chip">{t.reward_minutes ? `${t.reward_minutes > 0 ? "+" : ""}${t.reward_minutes} dk` : "ödülsüz"}</span>
                <button className={`chip-btn small-chip ${t.mandatory ? "mandatory" : ""}`} onClick={() => toggleMandatory(t)} aria-pressed={t.mandatory} title="Zorunlu yap / kaldır">
                  {t.mandatory ? "Zorunlu" : "Seçmeli"}
                </button>
                <span className="run-states">
                  {kids.map((c) => {
                    const r = runOf(t, c.id);
                    const locked = g.sequential && !!r && r.status !== "approved" && list.slice(0, i).some((x) => { const rr = runOf(x, c.id); return !rr || rr.status !== "approved"; });
                    const label = !r ? "—" : locked && r.status === "open" ? "Kilitli" : STATUS_LABEL[r.status];
                    const color = !r ? "var(--muted)" : locked && r.status === "open" ? "var(--muted)" : STATUS_COLOR[r.status] ?? "var(--text)";
                    return (
                      <span key={c.id} className="run-state" style={{ color }}>
                        <span className="dot" style={{ background: kids.length > 1 ? c.color : color, marginTop: 0 }} />
                        {kids.length > 1 ? `${c.name.slice(0, 1)}: ` : ""}{label}
                      </span>
                    );
                  })}
                </span>
                <div className="pop-anchor">
                  <button className="icon-pill" aria-label="Görev menüsü" onClick={() => { setMenu(menu === t.id ? null : t.id); setMoveFor(null); }}>⋯</button>
                  {menu === t.id && (
                    <>
                      <div className="pop-backdrop" onClick={() => setMenu(null)} />
                      <div className="lock-pop menu-pop right" role="menu">
                        {kids.some((c) => runOf(t, c.id)?.status === "submitted") && (
                          <a className="menu-item good-text" href="#onay" onClick={() => setMenu(null)}>✓ Onaya git</a>
                        )}
                        <button className="menu-item" role="menuitem" onClick={() => nav(`/tasks/${t.id}`)}>Görevi düzenle (fotoğraf, kamera, ödül…)</button>
                        <button className="menu-item" role="menuitem" disabled={i === 0} onClick={() => step(t, -1)}>Yukarı taşı</button>
                        <button className="menu-item" role="menuitem" disabled={i === list.length - 1} onClick={() => step(t, 1)}>Aşağı taşı</button>
                        {p.groups.length > 1 && (
                          <button className="menu-item" role="menuitem" onClick={() => setMoveFor(moveFor === t.id ? null : t.id)}>Başka gruba taşı…</button>
                        )}
                        {moveFor === t.id && p.groups.filter((x) => x.id !== g.id).map((x) => (
                          <button key={x.id} className="menu-item sub" onClick={() => moveTo(t, x)}>→ {x.name}</button>
                        ))}
                        <button className="menu-item" role="menuitem" onClick={() => removeFromGroup(t)}>Gruptan çıkar · tek görev olsun</button>
                        <div className="menu-sep" />
                        <button className="menu-item danger-text" role="menuitem" onClick={() => deleteTask(t)}>Sil</button>
                      </div>
                    </>
                  )}
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      {tab === "settings" && <GroupSettings group={g} tasks={list} onSaved={() => { p.onChange(); setTab("tasks"); }} onRemove={removeGroup} />}

      {tab === "history" && (
        <div className="card">
          {!p.groupRuns.filter((x) => x.group_id === g.id).length && <p className="muted small">Henüz sonuçlanmış gün yok.</p>}
          {p.groupRuns
            .filter((x) => x.group_id === g.id && (p.childFilter === "all" || x.child_id === p.childFilter))
            .sort((a, b) => b.day.localeCompare(a.day))
            .map((x) => {
              const c = fam.children.find((k) => k.id === x.child_id);
              const pr = groupProgress(g, p.tasks, p.runs, p.groupRuns, x.child_id, x.day);
              return (
                <div className="app-row" key={`${x.child_id}-${x.day}`}>
                  <span className="dot" style={{ background: c?.color, marginTop: 0 }} />
                  <div className="grow">
                    <b>{x.day.split("-").reverse().join(".")}</b>
                    <div className="muted tiny">{c?.name} · {pr.approved}/{pr.need} görev · {minutesText(pr.held)} kazandı</div>
                  </div>
                  <span className={`pill ${x.status === "met" ? "" : x.status === "failed" ? "warn" : "quiet"}`}>
                    {x.status === "met" ? "Sağlandı" : x.status === "failed" ? (g.fail_mode === "vault" ? "Kasaya gitti" : g.fail_mode === "penalty" ? "Ceza" : "Yandı") : "Devam ediyor"}
                  </span>
                </div>
              );
            })}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

function GroupSettings({ group, tasks, onSaved, onRemove }: { group: TaskGroup; tasks: Task[]; onSaved: () => void; onRemove: () => void }) {
  const fam = useFamily();
  const [f, setF] = useState<TaskGroup>(group);
  const [repeat, setRepeat] = useState<RepeatChoice>(repeatChoice(group));
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => { setF(group); setRepeat(repeatChoice(group)); }, [group]);
  const set = <K extends keyof TaskGroup>(k: K, v: TaskGroup[K]) => setF((x) => ({ ...x, [k]: v }));
  const mandatory = tasks.filter((t) => t.mandatory).length;
  const total = tasks.length;
  const minAllowed = Math.max(1, mandatory);

  function pickRepeat(c: RepeatChoice) {
    setRepeat(c);
    if (c === "once") set("recurrence", "once");
    else if (c === "biweekly") setF((x) => ({ ...x, recurrence: "biweekly", days: x.days.length && x.days.length < 7 ? x.days : [5] }));
    else if (c === "monthly") set("recurrence", "monthly");
    else setF((x) => ({ ...x, recurrence: "days", days: c === "daily" ? [1, 2, 3, 4, 5, 6, 7] : c === "weekdays" ? WEEKDAYS : c === "weekend" ? WEEKEND : x.days.length && x.days.length < 7 ? x.days : [5] }));
  }
  const toggleDay = (d: number) => set("days", f.days.includes(d) ? f.days.filter((x) => x !== d) : [...f.days, d].sort());

  async function save() {
    setErr("");
    if (!f.name.trim()) return setErr("Grubun adını yaz.");
    if (f.recurrence !== "once" && f.recurrence !== "monthly" && !f.days.length) return setErr("En az bir gün seç.");
    if (f.min_count != null && f.min_count < minAllowed) return setErr(`${mandatory} zorunlu görev var; en az ${minAllowed} olmalı.`);
    setBusy(true);
    const row = {
      name: f.name.trim(),
      child_ids: f.child_ids,
      recurrence: f.recurrence,
      days: f.days,
      start_date: f.start_date,
      end_date: f.end_date || null,
      start_time: f.start_time || null,
      due_time: f.due_time || null,
      sequential: f.sequential,
      min_count: f.min_count,
      reward_mode: f.reward_mode,
      reward_validity: f.reward_validity,
      fail_mode: f.fail_mode,
      penalty_minutes: f.fail_mode === "penalty" ? f.penalty_minutes ?? 15 : null,
    };
    const { error } = await supabase.from("task_groups").update(row).eq("id", group.id);
    if (!error && f.child_ids.length) await supabase.from("tasks").update({ child_ids: f.child_ids }).eq("group_id", group.id);
    setBusy(false);
    if (error) return setErr(errorText(error));
    onSaved();
  }

  const chip = (on: boolean, label: React.ReactNode, onClick: () => void, key?: string) => (
    <button key={key} type="button" className={`chip-btn ${on ? "on" : ""}`} onClick={onClick}>{label}</button>
  );

  return (
    <div className="stack">
      <section className="card extra-card">
        <b className="card-title">Kime ve ne zaman</b>
        <label className="field compact">
          <span>Adı</span>
          <input className="compact-input" value={f.name} onChange={(e) => set("name", e.target.value)} />
        </label>
        <div className="extra-group">
          <span className="pop-label">KİME <Info>İki çocuk seçiliyse her biri kendi görevlerini görür; ilerlemeleri ayrı tutulur.</Info></span>
          <div className="chips">
            {fam.children.map((c) => chip(f.child_ids.includes(c.id), <>{f.child_ids.includes(c.id) ? "✓ " : ""}{c.name}</>, () => set("child_ids", f.child_ids.includes(c.id) ? f.child_ids.filter((x) => x !== c.id) : [...f.child_ids, c.id]), c.id))}
          </div>
        </div>
        <div className="extra-group">
          <span className="pop-label">TEKRAR</span>
          <div className="chips">
            {([["once", "Bir kez"], ["daily", "Her gün"], ["weekdays", "Hafta içi"], ["weekend", "Hafta sonu"], ["days", "Seçili günler"], ["biweekly", "2 haftada bir"], ["monthly", "Ayda bir"]] as const).map(([k, l]) => chip(repeat === k, l, () => pickRepeat(k), k))}
          </div>
          {(repeat === "days" || repeat === "biweekly") && (
            <div className="chips">
              {DAY_SHORT.map((n, i) => chip(f.days.includes(i + 1), n, () => toggleDay(i + 1), n))}
            </div>
          )}
          {repeat === "monthly" && <span className="muted tiny">Her ay başlangıç tarihinin günü ({Number(f.start_date.slice(8, 10))}.)</span>}
        </div>
        <div className="extra-row" style={{ alignItems: "flex-end", gap: 20 }}>
          <div className="extra-group">
            <span className="pop-label">BAŞLANGIÇ SAATİ <Info>Bu saatten önce çocuk gruptaki görevlere başlayamaz.</Info></span>
            <TimeField clearable value={f.start_time?.slice(0, 5) ?? ""} onChange={(v) => set("start_time", v || null)} label="Başlangıç" />
          </div>
          <div className="extra-group">
            <span className="pop-label">SON SAAT <Info>Bu saatte grup sonuçlanır. Boşsa gün sonunda.</Info></span>
            <TimeField clearable value={f.due_time?.slice(0, 5) ?? ""} onChange={(v) => set("due_time", v || null)} label="Son saat" />
          </div>
        </div>
        <div className="extra-row" style={{ gap: 20 }}>
          <div className="extra-group">
            <span className="pop-label">{f.recurrence === "once" ? "GÜN" : "BAŞLANGIÇ GÜNÜ"}</span>
            <DateField value={f.start_date} onChange={(v) => set("start_date", v)} />
          </div>
          <div className="extra-group">
            <span className="pop-label">{f.recurrence === "once" ? "SON GÜN" : "BİTİŞ"}</span>
            <DateField clearable value={f.end_date ?? ""} onChange={(v) => set("end_date", v || null)} placeholder={f.recurrence === "once" ? "Aynı gün" : "Bitiş yok"} />
          </div>
        </div>
      </section>

      <section className="card extra-card">
        <b className="card-title">Nasıl yapılır</b>
        <div className="extra-group">
          <span className="pop-label">SIRA <Info>Sırayla: bir görev onaylanmadan sonraki açılmaz; çocuk sıradakileri kilitli görür. İstediği sırada: onay beklemeden diğerine geçebilir. Fotoğraf, kamera kaydı gibi ayarlar her görevin kendi ayarıdır.</Info></span>
          <div className="chips">
            {chip(f.sequential, "Sırayla", () => set("sequential", true))}
            {chip(!f.sequential, "İstediği sırada", () => set("sequential", false))}
          </div>
        </div>
        <div className="extra-group">
          <span className="pop-label">TAMAMLAMA KOŞULU <Info>Zorunlu görevler her zaman şart ve sayıya dahil. Onay isteyen görev onaylanınca sayılır.</Info></span>
          <div className="extra-row">
            <div className="chips">
              {chip(f.min_count == null, "Hepsi", () => set("min_count", null))}
              {chip(f.min_count != null, "En az", () => set("min_count", Math.max(minAllowed, Math.min(total || 1, 3))))}
            </div>
            {f.min_count != null && (
              <>
                <MinuteStepper value={f.min_count} onChange={(v) => set("min_count", v)} min={minAllowed} max={Math.max(minAllowed, total)} unit="görev" label="En az kaç görev" />
                <span className="muted small">/ {total} görev</span>
              </>
            )}
          </div>
          {mandatory > 0 && <span className="muted tiny">{mandatory} zorunlu görev var.</span>}
        </div>
      </section>

      <section className="card extra-card">
        <b className="card-title">Ödül</b>
        <div className="extra-group">
          <span className="pop-label">KOŞUL SAĞLANINCA AÇILAN <Info>Koşul sağlanana kadar kazanılan süre kilitli bekler.</Info></span>
          <div className="chips">
            {chip(f.reward_mode === "done", "Yaptığı görevlerin süresi", () => set("reward_mode", "done"))}
            {chip(f.reward_mode === "all", `Grubun tamamı · ${tasks.reduce((a, t) => a + Math.max(0, t.reward_minutes ?? 0), 0)} dk`, () => set("reward_mode", "all"))}
          </div>
        </div>
        <div className="extra-group">
          <span className="pop-label">NE ZAMAN KULLANILSIN</span>
          <div className="chips">
            {chip(f.reward_validity === "today", "Hemen", () => set("reward_validity", "today"))}
            {chip(f.reward_validity === "wallet", "Cüzdana", () => set("reward_validity", "wallet"))}
            {chip(f.reward_validity === "vault", "Kasaya", () => set("reward_validity", "vault"))}
          </div>
        </div>
        <div className="extra-group">
          <span className="pop-label">KOŞUL SAĞLANMAZSA <Info>Son saatte (ya da gün sonunda) koşul sağlanmadıysa uygulanır. Kasadaki süreyi istediğinde “Şimdi ver” ile açarsın.</Info></span>
          <div className="extra-row">
            <div className="chips">
              {chip(f.fail_mode === "vault", "Kazandığı süre kasaya", () => set("fail_mode", "vault"))}
              {chip(f.fail_mode === "burn", "Süre yansın", () => set("fail_mode", "burn"))}
              {chip(f.fail_mode === "penalty", "Yansın + ceza", () => set("fail_mode", "penalty"))}
            </div>
            {f.fail_mode === "penalty" && <MinuteStepper value={f.penalty_minutes ?? 15} onChange={(v) => set("penalty_minutes", v)} min={1} max={240} label="Ceza dakikası" />}
          </div>
        </div>
      </section>

      {err && <p className="error">{err}</p>}
      <div className="extra-actions">
        <button className="pill-btn minus" onClick={onRemove}>Grubu sil</button>
        <span className="grow" />
        <button className="pill-btn" onClick={() => { setF(group); setRepeat(repeatChoice(group)); }}>Vazgeç</button>
        <button className="pill-btn primary" disabled={busy} onClick={save}>Kaydet</button>
      </div>
    </div>
  );
}
