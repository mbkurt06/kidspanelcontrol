import { RestrictionSelect } from "./RestrictionSelect";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useFamily } from "../lib/family";
import { errorText, supabase } from "../lib/supabase";
import { minutesText } from "../lib/util";
import type { Task, TaskGroup, TaskGroupRun, TaskRun, UseMode } from "../lib/types";
import { DAY_SHORT, WEEKDAYS, WEEKEND, groupDay, groupProgress, groupTasks, moveToGroup, repeatChoice, repeatText, saveOrder, type RepeatChoice } from "../lib/groups";
import { DateField, TimeField } from "./DateTime";
import { MinuteStepper } from "./MinuteStepper";
import { Info } from "./Info";
import { Icon } from "./Icon";
import { PROOFS, durationPatch, newGroupTask, phoneSentence, proofKeys, proofPatch, proofText, runBadge, specText, taskDuration, type ProofKey, type RunDest } from "../lib/taskWork";

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

export default function TaskGroupDetail(p: Props) {
  const fam = useFamily();
  const nav = useNavigate();
  const [tab, setTab] = useState<"tasks" | "settings" | "history">(p.initialTab ?? "tasks");
  const [err, setErr] = useState("");
  const g = p.group;
  useEffect(() => setTab(p.initialTab ?? "tasks"), [g.id, p.initialTab]);

  const list = useMemo(() => groupTasks(g, p.tasks), [g, p.tasks]);

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
        <button className={tab === "tasks" ? "on" : ""} onClick={() => setTab("tasks")}>Bugün</button>
        <button className={tab === "settings" ? "on" : ""} onClick={() => setTab("settings")}>⚙ Ayarlar · {list.length} görev</button>
        <button className={tab === "history" ? "on" : ""} onClick={() => setTab("history")}>Geçmiş</button>
      </div>
      {err && <p className="error">{err}</p>}

      {tab === "tasks" && <GroupToday {...p} list={list} onSettings={() => setTab("settings")} />}
      {tab === "settings" && (
        <>
          <TaskTable group={g} groups={p.groups} list={list} allTasks={p.tasks} onChange={p.onChange} onEdit={(id) => nav(`/tasks/${id}`)} />
          <GroupMeta group={g} tasks={list} onSaved={p.onChange} onRemove={removeGroup} />
        </>
      )}
      {tab === "history" && <GroupHistory {...p} />}
    </div>
  );
}

// --- Bugün ------------------------------------------------------------------

const TONE: Record<string, string> = { good: "tone-good", wait: "tone-wait", wallet: "tone-wallet", vault: "tone-vault", bad: "tone-bad", muted: "tone-muted" };

function GroupToday(p: Props & { list: Task[]; onSettings: () => void }) {
  const fam = useFamily();
  const g = p.group;
  const day = groupDay(g);
  const kids = fam.children.filter((c) => g.child_ids.includes(c.id) && (p.childFilter === "all" || p.childFilter === c.id));
  const [kid, setKid] = useState<string | null>(null);
  const child = kids.find((c) => c.id === kid) ?? kids[0];
  const [dest, setDest] = useState<Record<string, RunDest>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState("");
  const grantIds = p.runs.filter((r) => r.grant_id && r.day === day).map((r) => r.grant_id as string);
  const key = grantIds.join(",");
  useEffect(() => {
    if (!grantIds.length) return;
    supabase.from("time_grants").select("id,vault,valid_on,window_start").in("id", grantIds).then(({ data }) => {
      const m: Record<string, RunDest> = {};
      ((data ?? []) as Array<{ id: string; vault: boolean; valid_on: string | null; window_start: string | null }>).forEach((x) => {
        m[x.id] = { vault: x.vault, wallet: !x.vault && !x.valid_on };
      });
      setDest(m);
    });
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!g.child_ids.length) return <p className="warn-text small">Bu grup kimseye verilmedi. ⚙ Ayarlar'dan çocuk seç.</p>;
  if (!child) return null;
  const runOf = (t: Task) => p.runs.find((r) => r.task_id === t.id && r.child_id === child.id && r.day === day);
  const pr = groupProgress(g, p.tasks, p.runs, p.groupRuns, child.id);
  const tot = { now: 0, wait: 0, wallet: 0, vault: 0 };
  const end: string[] = [];
  for (const t of p.list) {
    const r = runOf(t);
    const m = Math.max(0, r?.granted_minutes ?? t.reward_minutes ?? 0);
    if (r?.status === "approved") {
      if (!r.grant_id) { tot.wait += m; end.push(`${t.title}: bekleyen ${m} dk kasaya`); }
      else if (dest[r.grant_id]?.vault) tot.vault += m;
      else if (dest[r.grant_id]?.wallet) tot.wallet += m;
      else tot.now += m;
    } else if (r && r.status !== "expired" && r.status !== "claimed" && t.fail_minutes) {
      end.push(`${t.title} yapılmazsa −${t.fail_minutes} dk`);
    }
  }

  async function release(r: TaskRun, vault: boolean) {
    setErr("");
    setBusy(r.id);
    const { error } = await supabase.rpc("parent_release_run", { p_run: r.id, p_vault: vault });
    setBusy(null);
    if (error) return setErr(errorText(error));
    p.onChange();
  }

  return (
    <div className="stack">
      {kids.length > 1 && (
        <div className="seg-tabs">
          {kids.map((c) => <button key={c.id} className={child.id === c.id ? "on" : ""} onClick={() => setKid(c.id)}>{c.name}</button>)}
        </div>
      )}
      <div className="today-tiles">
        <div className="today-tile tone-good"><span>✅ Açıldı</span><b>{minutesText(tot.now)}</b></div>
        <div className="today-tile tone-wait"><span>⏳ Bekleyen</span><b>{minutesText(tot.wait)}</b></div>
        <div className="today-tile tone-wallet"><span>👛 Cüzdana</span><b>{minutesText(tot.wallet)}</b></div>
        <div className="today-tile tone-vault"><span>🏦 Kasaya</span><b>{minutesText(tot.vault)}</b></div>
      </div>
      {pr.total === 0 && <p className="muted small">Bugün bu grubun günü değil.</p>}
      {err && <p className="error">{err}</p>}
      <div className="card table-card">
        {!p.list.length && <p className="muted small" style={{ padding: 16 }}>Bu grupta görev yok. <button className="link-btn" onClick={p.onSettings}>⚙ Ayarlar</button>'dan ekle.</p>}
        {p.list.map((t) => {
          const r = runOf(t);
          const b = runBadge(t, r, p.list, p.runs, dest);
          return (
            <div key={t.id} className="today-row">
              <div className="grow">
                <Link to={`/tasks/${t.id}`}><b>{t.title}</b></Link>
                <div className="muted tiny">{specText(t, p.list, fam.modes)}</div>
              </div>
              <span className={`today-badge ${TONE[b.tone]}`}>{b.text}</span>
              {r?.status === "submitted" && <a className="pill-btn primary" href="#onay">Onayla ›</a>}
              {r?.status === "approved" && !r.grant_id && (
                <span className="row gap-xs">
                  <button className="pill-btn primary" disabled={busy === r.id} onClick={() => release(r, false)}>Şimdi aç</button>
                  <button className="pill-btn" disabled={busy === r.id} onClick={() => release(r, true)}>Kasaya at</button>
                </span>
              )}
            </div>
          );
        })}
      </div>
      {end.length > 0 && <p className="tip-line">🌙 Gün biterse: {end.join(" · ")}</p>}
    </div>
  );
}

// --- Ayarlar: görev tablosu -------------------------------------------------

function TaskTable({ group, groups, list, allTasks, onChange, onEdit }: { group: TaskGroup; groups: TaskGroup[]; list: Task[]; allTasks: Task[]; onChange: () => void; onEdit: (id: string) => void }) {
  const fam = useFamily();
  const [err, setErr] = useState("");
  const [tip, setTip] = useState(false);
  const [adding, setAdding] = useState(false);
  const [drag, setDrag] = useState<string | null>(null);
  const singles = allTasks.filter((t) => !t.group_id);
  const ordered = list.length > 1 && list.every((t, i) => i === 0 ? !(t.start_after ?? []).length : (t.start_after ?? []).length === 1 && t.start_after![0] === list[i - 1].id);

  async function reorder(from: string, to: string) {
    const ids = list.map((t) => t.id);
    const a = ids.indexOf(from);
    const b = ids.indexOf(to);
    if (a < 0 || b < 0 || a === b) return;
    const next = [...list];
    const [x] = next.splice(a, 1);
    next.splice(b, 0, x);
    await saveOrder(next);
    if (ordered) await chain(true, next);
    onChange();
  }
  async function chain(on: boolean, l = list) {
    setErr("");
    const res = await Promise.all(l.map((t, i) => supabase.from("tasks").update({ start_after: on && i > 0 ? [l[i - 1].id] : [] }).eq("id", t.id)));
    const e = res.find((x) => x.error)?.error;
    if (e) setErr(errorText(e));
    onChange();
  }
  async function add(mandatory: boolean) {
    const title = prompt(mandatory ? "Zorunlu görevin adı" : "Seçmeli görevin adı")?.trim();
    if (!title) return;
    setErr("");
    if (!fam.familyId) return;
    const order = Math.max(0, ...list.map((t) => t.group_order)) + 1;
    const row = newGroupTask(group, fam.family, fam.familyId, title, mandatory, order);
    if (ordered && list.length) row.start_after = [list[list.length - 1].id];
    const { error } = await supabase.from("tasks").insert(row);
    if (error) return setErr(errorText(error));
    onChange();
  }

  return (
    <section className="card table-card">
      <div className="table-head">
        <b>Görev ayarları</b>
        <button type="button" className="info-btn" aria-label="Açıklama" aria-expanded={tip} onClick={() => setTip((v) => !v)}>i</button>
        <span className="grow" />
        <span className="muted tiny">Sıra</span>
        <div className="chips">
          <button type="button" className={`chip-btn ${!ordered ? "on" : ""}`} onClick={() => chain(false)}>İstediği sırada</button>
          <button type="button" className={`chip-btn ${ordered ? "on" : ""}`} onClick={() => chain(true)} disabled={list.length < 2}>Sırayla yapsın</button>
        </div>
      </div>
      {tip && <p className="tip-line" style={{ margin: "0 16px 10px" }}>Her görevin satırında seç; değişiklik hemen kaydedilir. Satırdaki (i) telefonda ne olacağını anlatır. ↑ ↓ ya da sürükleyerek sırala: çocuk görevleri bu sırayla görür. “Sırayla yapsın” her görevi bir öncekine bağlar.</p>}
      {err && <p className="error" style={{ margin: "0 16px" }}>{err}</p>}
      {!list.length && <p className="muted small" style={{ padding: "0 16px 14px" }}>Bu grupta görev yok.</p>}
      {list.map((t, i) => (
        <div
          key={t.id}
          className={`gt-row ${drag === t.id ? "dragging" : ""}`}
          onDragOver={(e) => e.preventDefault()}
          onDrop={() => { if (drag) reorder(drag, t.id); setDrag(null); }}
        >
          <TaskRow
            t={t}
            no={i + 1}
            list={list}
            groups={groups}
            group={group}
            first={i === 0}
            last={i === list.length - 1}
            onUp={() => reorder(t.id, list[i - 1].id)}
            onDown={() => reorder(t.id, list[i + 1].id)}
            onDragStart={() => setDrag(t.id)}
            onDragEnd={() => setDrag(null)}
            onChange={onChange}
            onEdit={() => onEdit(t.id)}
            allTasks={allTasks}
          />
        </div>
      ))}
      <div className="row gap-s wrap" style={{ padding: "4px 16px 16px" }}>
        <button className="pill-btn dashed" onClick={() => add(true)}><Icon name="plus" size={14} /> Zorunlu görev ekle</button>
        <button className="pill-btn dashed" onClick={() => add(false)}><Icon name="plus" size={14} /> Seçmeli görev ekle</button>
        <div className="pop-anchor">
          <button className="pill-btn ghost" onClick={() => setAdding((v) => !v)} disabled={!singles.length}>Var olanı ekle</button>
          {adding && (
            <>
              <div className="pop-backdrop" onClick={() => setAdding(false)} />
              <div className="lock-pop menu-pop" role="menu">
                <span className="pop-label">GRUBA EKLE</span>
                {singles.map((t) => (
                  <button key={t.id} role="menuitem" className="menu-item" onClick={async () => { await moveToGroup(t, group, allTasks); setAdding(false); onChange(); }}>
                    {t.title} <span className="muted tiny">{t.reward_minutes ? `+${t.reward_minutes} dk` : ""}</span>
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
      </div>
    </section>
  );
}

function TaskRow(p: {
  t: Task;
  no: number;
  list: Task[];
  allTasks: Task[];
  groups: TaskGroup[];
  group: TaskGroup;
  first: boolean;
  last: boolean;
  onUp: () => void;
  onDown: () => void;
  onDragStart: () => void;
  onDragEnd: () => void;
  onChange: () => void;
  onEdit: () => void;
}) {
  const fam = useFamily();
  const [v, setV] = useState<Task>(p.t);
  const [info, setInfo] = useState(false);
  const [proofOpen, setProofOpen] = useState(false);
  const [menu, setMenu] = useState(false);
  const [moveFor, setMoveFor] = useState(false);
  const [err, setErr] = useState("");
  const pending = useRef<Partial<Task>>({});
  const timer = useRef<number | null>(null);
  useEffect(() => setV(p.t), [p.t]);
  useEffect(() => () => { if (timer.current) window.clearTimeout(timer.current); }, []);

  async function flush() {
    const patch = pending.current;
    pending.current = {};
    timer.current = null;
    if (!Object.keys(patch).length) return;
    const { error } = await supabase.from("tasks").update(patch).eq("id", p.t.id);
    if (error) setErr(errorText(error));
    else setErr("");
    p.onChange();
  }
  /** Değişikliği hemen göster, kısa bir beklemeden sonra kaydet (basılı tutulan +/− için) */
  function save(patch: Partial<Task>, delay = 500) {
    setV((x) => ({ ...x, ...patch }));
    pending.current = { ...pending.current, ...patch };
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(flush, delay);
  }

  const others = p.list.filter((x) => x.id !== v.id);
  const keys = proofKeys(v);
  const rec = keys.includes("camera") || keys.includes("screenrec");
  const linked = (v.earn_links ?? []).length > 0;
  const after = (v.start_after ?? []).length > 0;
  const toggle = (arr: string[] | undefined, id: string) => ((arr ?? []).includes(id) ? (arr ?? []).filter((x) => x !== id) : [...(arr ?? []), id]);

  return (
    <div className="gt-cells">
      <div className="gt-cell gt-title">
        <div className="gt-order">
          <button type="button" className="icon-pill" aria-label="Yukarı taşı" disabled={p.first} onClick={p.onUp}>↑</button>
          <span className="drag-handle" draggable onDragStart={p.onDragStart} onDragEnd={p.onDragEnd} aria-hidden="true">⋮⋮</span>
          <button type="button" className="icon-pill" aria-label="Aşağı taşı" disabled={p.last} onClick={p.onDown}>↓</button>
        </div>
        <div className="grow">
          <div className="row gap-xs" style={{ alignItems: "center" }}>
            <b>{p.no}. {v.title}</b>
            <button type="button" className="info-btn" aria-label="Telefonda ne olur" aria-expanded={info} onClick={() => setInfo((x) => !x)}>i</button>
          </div>
          <span className="good-text tiny">+{Math.max(0, v.reward_minutes ?? 0)} dk</span>
          {v.fail_minutes ? <span className="bad-text tiny"> · −{v.fail_minutes} dk</span> : null}
        </div>
        <div className="pop-anchor">
          <button className="icon-pill" aria-label="Görev menüsü" onClick={() => { setMenu((x) => !x); setMoveFor(false); }}>⋯</button>
          {menu && (
            <>
              <div className="pop-backdrop" onClick={() => setMenu(false)} />
              <div className="lock-pop menu-pop right" role="menu">
                <button className="menu-item" role="menuitem" onClick={p.onEdit}>Görevi düzenle (ad, açıklama, kanıt ayrıntısı…)</button>
                {p.groups.length > 1 && <button className="menu-item" role="menuitem" onClick={() => setMoveFor((x) => !x)}>Başka gruba taşı…</button>}
                {moveFor && p.groups.filter((x) => x.id !== p.group.id).map((x) => (
                  <button key={x.id} className="menu-item sub" onClick={async () => { await moveToGroup(p.t, x, p.allTasks); setMenu(false); p.onChange(); }}>→ {x.name}</button>
                ))}
                <button className="menu-item" role="menuitem" onClick={async () => { await moveToGroup(p.t, null, p.allTasks); setMenu(false); p.onChange(); }}>Gruptan çıkar · tek görev olsun</button>
                <div className="menu-sep" />
                <button className="menu-item danger-text" role="menuitem" onClick={async () => { if (!confirm(`"${v.title}" görevi ve geçmişi silinsin mi?`)) return; await supabase.from("tasks").delete().eq("id", v.id); setMenu(false); p.onChange(); }}>Sil</button>
              </div>
            </>
          )}
        </div>
      </div>

      <label className="gt-cell">
        <span className="pop-label">ZORUNLU</span>
        <select value={v.mandatory ? "yes" : "no"} onChange={(e) => { const m = e.target.value === "yes"; save({ mandatory: m, phone_restriction: m ? "kiosk" : "none", restriction_mode_id: null }, 0); }}>
          <option value="yes">Evet</option>
          <option value="no">Hayır (seçmeli)</option>
        </select>
      </label>

      <label className="gt-cell">
        <span className="pop-label">BİTENE KADAR TELEFON</span>
        <RestrictionSelect value={{ restriction: v.phone_restriction ?? "none", modeId: v.restriction_mode_id ?? null }} onChange={(x) => save({ phone_restriction: x.restriction, restriction_mode_id: x.modeId }, 0)} />
      </label>

      <div className="gt-cell gt-wide">
        <span className="pop-label">SÜRE NE ZAMAN KAZANILIR</span>
        <select value={linked ? "linked" : "self"} onChange={(e) => save({ earn_links: e.target.value === "linked" ? [v.id] : [] }, 0)} aria-label="Süre ne zaman kazanılır">
          <option value="self">Bu görev onaylanınca</option>
          <option value="linked">Seçtiğim görevler bitince</option>
        </select>
        {linked && (
          <div className="gt-box">
            {p.list.map((o) => (
              <label key={o.id} className="check">
                <input type="checkbox" checked={(v.earn_links ?? []).includes(o.id)} onChange={() => save({ earn_links: toggle(v.earn_links, o.id) }, 0)} />
                {o.title}{o.id === v.id ? " (kendisi)" : ""}{o.mandatory ? " · zorunlu" : ""}
              </label>
            ))}
            <div className="row gap-s wrap" style={{ alignItems: "center" }}>
              <select value={v.earn_mode ?? "all"} onChange={(e) => save({ earn_mode: e.target.value as Task["earn_mode"] }, 0)} aria-label="Kaç tanesi">
                <option value="all">Hepsi bitince</option>
                <option value="any">Herhangi biri bitince</option>
                <option value="min">En az … tanesi</option>
              </select>
              {v.earn_mode === "min" && (
                <MinuteStepper value={v.earn_min ?? 1} onChange={(n) => save({ earn_min: n })} min={1} max={Math.max(1, (v.earn_links ?? []).length)} unit="görev" label="En az kaç görev" />
              )}
            </div>
          </div>
        )}
      </div>

      <div className="gt-cell">
        <span className="pop-label">SÜRE NEREYE GİDER</span>
        <select value={v.reward_validity === "wallet" || v.reward_validity === "vault" ? v.reward_validity : "today"} onChange={(e) => save({ reward_validity: e.target.value as Task["reward_validity"] }, 0)} aria-label="Süre nereye gider">
          <option value="today">Hemen kullansın</option>
          <option value="wallet">Cüzdana</option>
          <option value="vault">Kasaya</option>
        </select>
        {(v.reward_validity ?? "today") === "today" && (
          <select value={v.use_mode ?? "usage"} onChange={(e) => save({ use_mode: e.target.value as UseMode, use_within_minutes: e.target.value === "within" ? v.use_within_minutes ?? 120 : null }, 0)} aria-label="Kullanım şekli">
            <option value="usage">Kullandıkça düşsün</option>
            <option value="clock">Saat gibi aksın</option>
            <option value="within">Belirli süre içinde</option>
          </select>
        )}
        {(v.reward_validity ?? "today") === "today" && v.use_mode === "within" && (
          <select value={String(v.use_within_minutes ?? 120)} onChange={(e) => save({ use_within_minutes: Number(e.target.value) }, 0)} aria-label="Kullanma süresi">
            <option value="60">1 saat içinde</option>
            <option value="120">2 saat içinde</option>
            <option value="180">3 saat içinde</option>
          </select>
        )}
      </div>

      <div className="gt-cell">
        <span className="pop-label">GÖREVE BAŞLAMA</span>
        <select value={after ? "after" : "now"} onChange={(e) => save({ start_after: e.target.value === "after" && others.length ? [others[0].id] : [] }, 0)} aria-label="Göreve başlama">
          <option value="now">Hemen başlayabilir</option>
          <option value="after" disabled={!others.length}>Şu görevler bitince başlayabilir</option>
        </select>
        {after && (
          <div className="gt-box">
            {others.map((o) => (
              <label key={o.id} className="check">
                <input type="checkbox" checked={(v.start_after ?? []).includes(o.id)} onChange={() => save({ start_after: toggle(v.start_after, o.id) }, 0)} />
                {o.title}
              </label>
            ))}
          </div>
        )}
      </div>

      <div className="gt-cell">
        <span className="pop-label">YAPILMA SAATİ</span>
        <div className="row gap-xs" style={{ alignItems: "center" }}>
          <TimeField value={v.start_time?.slice(0, 5) ?? ""} onChange={(x) => save({ start_time: x || null }, 0)} label="Başlangıç" />
          <span className="muted">–</span>
          <TimeField value={v.due_time?.slice(0, 5) ?? ""} onChange={(x) => save({ due_time: x || null }, 0)} label="Bitiş" />
        </div>
      </div>

      <div className="gt-cell">
        <span className="pop-label">KANIT · GÖREV SÜRESİ</span>
        <div className="pop-anchor">
          <button type="button" className="select-like" aria-expanded={proofOpen} onClick={() => setProofOpen((x) => !x)}>{proofText(v)} ▾</button>
          {proofOpen && (
            <>
              <div className="pop-backdrop" onClick={() => setProofOpen(false)} />
              <div className="lock-pop menu-pop" role="group" aria-label="Kanıt">
                {PROOFS.map(([k, l]) => (
                  <label key={k} className="check">
                    <input
                      type="checkbox"
                      checked={keys.includes(k)}
                      onChange={() => {
                        const next: ProofKey[] = keys.includes(k) ? keys.filter((x) => x !== k) : [...keys, k];
                        save(proofPatch(v, next, fam.family), 0);
                      }}
                    />
                    {l}
                  </label>
                ))}
              </div>
            </>
          )}
        </div>
        {rec && <MinuteStepper value={taskDuration(v)} onChange={(n) => save(durationPatch(v, Math.max(1, n)))} min={1} max={240} step={5} label="Görev süresi" />}
      </div>

      <div className="gt-cell">
        <span className="pop-label">ÖDÜL · CEZA</span>
        <div className="gt-stepper"><span className="good-text small">Yaparsa +</span><MinuteStepper value={Math.max(0, v.reward_minutes ?? 0)} onChange={(n) => save({ reward_minutes: n || null })} min={0} max={600} step={5} label="Ödül dakikası" /></div>
        <div className="gt-stepper"><span className="bad-text small">Yapmazsa −</span><MinuteStepper value={v.fail_minutes ?? 0} onChange={(n) => save({ fail_minutes: n || null })} min={0} max={600} step={5} label="Ceza dakikası" /></div>
        {(v.fail_minutes ?? 0) > 0 && (
          <select value={v.fail_target ?? "vault"} onChange={(e) => save({ fail_target: e.target.value as Task["fail_target"] }, 0)} aria-label="Ceza nereden">
            <option value="vault">Kasadan düşsün</option>
            <option value="wallet">Cüzdana borç yazılsın</option>
            <option value="today">O günün süresinden</option>
          </select>
        )}
      </div>

      {info && <p className="tip-line gt-full">📱 {phoneSentence(v, p.list, fam.modes)}</p>}
      {err && <p className="error gt-full">{err}</p>}
    </div>
  );
}

// --- Ayarlar: kime ve ne zaman ---------------------------------------------

function GroupMeta({ group, tasks, onSaved, onRemove }: { group: TaskGroup; tasks: Task[]; onSaved: () => void; onRemove: () => void }) {
  const fam = useFamily();
  const [f, setF] = useState<TaskGroup>(group);
  const [repeat, setRepeat] = useState<RepeatChoice>(repeatChoice(group));
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  useEffect(() => { setF(group); setRepeat(repeatChoice(group)); }, [group.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const set = <K extends keyof TaskGroup>(k: K, v: TaskGroup[K]) => { setSaved(false); setF((x) => ({ ...x, [k]: v })); };

  function pickRepeat(c: RepeatChoice) {
    setRepeat(c);
    setSaved(false);
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
    setBusy(true);
    const { error } = await supabase.from("task_groups").update({
      name: f.name.trim(),
      child_ids: f.child_ids,
      recurrence: f.recurrence,
      days: f.days,
      start_date: f.start_date,
      end_date: f.end_date || null,
      per_task: true,
    }).eq("id", group.id);
    if (!error && f.child_ids.length && tasks.length) await supabase.from("tasks").update({ child_ids: f.child_ids }).eq("group_id", group.id);
    setBusy(false);
    if (error) return setErr(errorText(error));
    setSaved(true);
    onSaved();
  }

  const chip = (on: boolean, label: React.ReactNode, onClick: () => void, key?: string) => (
    <button key={key} type="button" className={`chip-btn ${on ? "on" : ""}`} onClick={onClick}>{label}</button>
  );

  return (
    <section className="card extra-card">
      <b className="card-title">Kime ve hangi günler</b>
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
      {err && <p className="error">{err}</p>}
      <div className="extra-actions">
        <button className="pill-btn minus" onClick={onRemove}>Grubu sil</button>
        <span className="grow" />
        {saved && <span className="good-text small">Kaydedildi</span>}
        <button className="pill-btn primary" disabled={busy} onClick={save}>Kaydet</button>
      </div>
    </section>
  );
}

// --- Geçmiş -----------------------------------------------------------------

function GroupHistory(p: Props) {
  const fam = useFamily();
  const g = p.group;
  const rows = p.groupRuns
    .filter((x) => x.group_id === g.id && (p.childFilter === "all" || x.child_id === p.childFilter))
    .sort((a, b) => b.day.localeCompare(a.day));
  return (
    <div className="card">
      {!rows.length && <p className="muted small">Henüz sonuçlanmış gün yok.</p>}
      {rows.map((x) => {
        const c = fam.children.find((k) => k.id === x.child_id);
        const pr = groupProgress(g, p.tasks, p.runs, p.groupRuns, x.child_id, x.day);
        return (
          <div className="app-row" key={`${x.child_id}-${x.day}`}>
            <span className="dot" style={{ background: c?.color, marginTop: 0 }} />
            <div className="grow">
              <b>{x.day.split("-").reverse().join(".")}</b>
              <div className="muted tiny">{c?.name} · {pr.approved}/{pr.total} görev · {minutesText(pr.earned)} kazandı</div>
            </div>
            <span className={`pill ${x.status === "met" ? "" : x.status === "failed" ? "warn" : "quiet"}`}>
              {x.status === "met" ? "Tamam" : x.status === "failed" ? "Bekleyen kasaya gitti" : "Devam ediyor"}
            </span>
          </div>
        );
      })}
    </div>
  );
}
