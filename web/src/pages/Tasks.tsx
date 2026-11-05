import { useCallback, useEffect, useMemo, useState, type MouseEvent } from "react";
import { DateField } from "../components/DateTime";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { useFamily } from "../lib/family";
import { errorText, supabase } from "../lib/supabase";
import { minutesText, relTime, todayISO } from "../lib/util";
import {
  PROOF_LABEL,
  STATUS_LABEL,
  VALIDITY_LABEL,
  type RewardValidity,
  type Task,
  type TaskProof,
  type TaskRun,
  type TaskGroup,
  type TaskGroupRun,
  type TaskTemplate,
} from "../lib/types";
import TaskGroupDetail from "../components/TaskGroupDetail";
import { groupDay, groupProgress, newGroup, repeatText } from "../lib/groups";
import { Icon } from "../components/Icon";
import { Info } from "../components/Info";
import { MinuteStepper } from "../components/MinuteStepper";
import { RecordingList } from "../components/RecordingPlayer";
import { STARTER_TEMPLATES } from "../lib/templates";
import { mediaUrls } from "../lib/media";
import { PhotoZoom, galleryOf, proofLabels } from "../components/PhotoZoom";

// --- Görev zaman aralığı: başlangıç (oluşturulma ya da ileri tarih) → bitiş ---
const BERLIN = "Europe/Berlin";
const isoLocal = (iso: string) => {
  const d = new Date(iso);
  const date = d.toLocaleDateString("sv-SE", { timeZone: BERLIN });
  const time = d.toLocaleTimeString("tr-TR", { hour: "2-digit", minute: "2-digit", timeZone: BERLIN });
  return { date, time };
};
const dShort = (iso: string) => { const [y, m, d] = iso.split("-"); return `${d}.${m}.${y}`; };
const hm = (t: string | null | undefined) => (t ? t.slice(0, 5) : null);
type Win = { sDate: string; sTime: string; eDate: string; eTime: string };
function startOf(createdAt: string, date: string, time: string | null | undefined): [string, string] {
  if (time) return [date, hm(time)!];
  const c = isoLocal(createdAt);
  return c.date >= date ? [c.date, c.time] : [date, "00:00"];
}
function taskWindow(t: Task, g: TaskGroup | null | undefined, day: string): Win {
  if (g) {
    if (g.recurrence === "once") {
      const [sDate, sTime] = startOf(g.created_at, g.start_date, g.start_time);
      return { sDate, sTime, eDate: g.end_date ?? g.start_date, eTime: hm(g.due_time) ?? "23:59" };
    }
    const [sDate, sTime] = startOf(g.created_at, day, g.start_time);
    return { sDate, sTime, eDate: day, eTime: hm(g.due_time) ?? "23:59" };
  }
  if (t.recurrence === "days") {
    const [sDate, sTime] = startOf(t.created_at, day, null);
    return { sDate, sTime, eDate: day, eTime: hm(t.due_time) ?? "23:59" };
  }
  const [sDate, sTime] = startOf(t.created_at, t.start_date, null);
  return { sDate, sTime, eDate: t.due_date ?? t.end_date ?? t.start_date, eTime: hm(t.due_time) ?? "23:59" };
}
/** Liste için tüm süre: başlangıç (oluşturulma ya da ileri tarih) → son yapılması gereken gün ve saat */
function taskSpan(t: Task, g: TaskGroup | null | undefined): Win | (Omit<Win, "eDate" | "eTime"> & { eDate: null; eTime: null }) {
  if (g) {
    const [sDate, sTime] = startOf(g.created_at, g.start_date, g.start_time);
    const eDate = g.recurrence === "once" ? g.end_date ?? g.start_date : g.end_date;
    return eDate ? { sDate, sTime, eDate, eTime: hm(g.due_time) ?? "23:59" } : { sDate, sTime, eDate: null, eTime: null };
  }
  const [sDate, sTime] = startOf(t.created_at, t.start_date, null);
  const eDate = t.recurrence === "days" ? t.end_date : t.due_date ?? t.end_date ?? t.start_date;
  return eDate ? { sDate, sTime, eDate, eTime: hm(t.due_time) ?? "23:59" } : { sDate, sTime, eDate: null, eTime: null };
}
const spanText = (w: ReturnType<typeof taskSpan>) => (w.eDate ? winText(w as Win) : `${dShort(w.sDate)} ${w.sTime} – süresiz`);
const winText = (w: Win) =>
  w.sDate === w.eDate ? `${dShort(w.sDate)} ${w.sTime}–${w.eTime}` : `${dShort(w.sDate)} ${w.sTime} – ${dShort(w.eDate)} ${w.eTime}`;
const winEnded = (w: Win) => new Date(`${w.eDate}T${w.eTime}:00`).getTime() < Date.now();
const FINAL = new Set(["approved", "expired", "claimed"]);
const Pencil = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" /></svg>
);
/** Kanıt özeti: fotoğraf, kamera kaydı, ekran görüntüsü, ekran kaydı */
const proofText = (t?: Task) =>
  !t
    ? ""
    : [
        t.proof === "none" ? null : t.before_after ? "önce + sonra fotoğraf" : "fotoğraf",
        t.record_minutes != null ? "kamera kaydı" : null,
        t.screenshot_min != null ? "ekran görüntüsü" : null,
        t.screen_record_minutes != null ? "ekran kaydı" : null,
      ].filter(Boolean).join(" · ");
const runTone = (st: string) => (st === "approved" ? "good" : st === "submitted" ? "accent" : st === "rejected" || st === "expired" ? "warn" : "quiet");
const rewardText = (n: number | null | undefined) => (n ? `${n > 0 ? "+" : ""}${n} dk` : "—");
/** Satır sonu sütunları: tekrar · puan · durum · düzenle · aç/kapa — her satırda aynı hizada */
function Meta({ repeat, repeatTitle, reward, status, edit, arrow }: { repeat?: boolean; repeatTitle?: string; reward?: string | null; status?: string | null; edit?: JSX.Element | null; arrow?: JSX.Element | null }) {
  return (
    <span className="row-meta">
      <span className="m-repeat">{repeat && <span className="repeat-badge" title={repeatTitle ?? "Tekrarlı"} aria-label="Tekrarlı">↻</span>}</span>
      <span className="m-reward">{reward != null && <span className="reward-chip">{reward}</span>}</span>
      <span className="m-status">{status && <span className={`pill ${runTone(status)}`}>{STATUS_LABEL[status as keyof typeof STATUS_LABEL] ?? status}</span>}</span>
      <span className="m-edit">{edit}</span>
      <span className="m-arrow">{arrow}</span>
    </span>
  );
}
/** Grubun durumu, tek görevlerle aynı sözcüklerle */
function groupStatus(pr: { status: string }, rs: TaskRun[]): string {
  if (pr.status === "met") return "approved";
  if (pr.status === "failed") return "expired";
  if (rs.some((r) => r.status === "submitted")) return "submitted";
  if (rs.some((r) => r.status === "rejected")) return "rejected";
  if (rs.some((r) => r.status === "approved" || r.status === "started")) return "started";
  return "open";
}
const EditIcon = ({ onClick, label }: { onClick?: (e: MouseEvent) => void; label: string }) =>
  onClick ? (
    <button className="icon-pill" aria-label={label} title={label} onClick={onClick}><Pencil /></button>
  ) : (
    <span className="icon-pill" aria-hidden="true" title={label}><Pencil /></span>
  );
const Folder = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /></svg>
);

export default function Tasks() {
  const fam = useFamily();
  const nav = useNavigate();
  const [params, setParams] = useSearchParams();
  const [tasks, setTasks] = useState<Task[]>([]);
  const [runs, setRuns] = useState<TaskRun[]>([]);
  const [groups, setGroups] = useState<TaskGroup[]>([]);
  const [groupRuns, setGroupRuns] = useState<TaskGroupRun[]>([]);
  const [templates, setTemplates] = useState<TaskTemplate[]>([]);
  const [templatesOpen, setTemplatesOpen] = useState(false);
  // Çocuk seçimi menüdeki seçimle aynı (ayrı tutulunca menüde başka çocuk seçiliyken görevler "bugün olmayan" görünüyordu)
  const childFilter = fam.selectedChildId;
  const setChildFilter = fam.setSelectedChildId;
  const [err, setErr] = useState("");
  const today = todayISO();
  const [historyView, setHistoryView] = useState<"day" | "week" | "month" | "range">("day");
  const [rangeFrom, setRangeFrom] = useState(todayISO("Europe/Berlin", -7));
  const [rangeTo, setRangeTo] = useState(today);
  const monthStart = `${today.slice(0, 7)}-01`;
  const selectedId = params.get("group");
  const tabParam = params.get("tab") as "tasks" | "settings" | "history" | null;

  const load = useCallback(async () => {
    await supabase.rpc("parent_ensure_runs", { p_day: today });
    const [t, r, tp, g, gr] = await Promise.all([
      supabase.from("tasks").select("*").order("created_at", { ascending: false }),
      supabase.from("task_runs").select("*").order("day", { ascending: false }).limit(400),
      supabase.from("task_templates").select("*").order("title"),
      supabase.from("task_groups").select("*").order("sort").order("created_at"),
      supabase.from("task_group_runs").select("*").gte("day", todayISO("Europe/Berlin", -40)),
    ]);
    if (t.error) setErr(errorText(t.error));
    setTasks((t.data ?? []) as Task[]);
    setRuns((r.data ?? []) as TaskRun[]);
    setTemplates((tp.data ?? []) as TaskTemplate[]);
    setGroups((g.data ?? []) as TaskGroup[]);
    setGroupRuns((gr.data ?? []) as TaskGroupRun[]);
  }, [today]);

  useEffect(() => {
    load();
    const t = setInterval(load, 30000);
    return () => clearInterval(t);
  }, [load]);

  const taskById = useMemo(() => Object.fromEntries(tasks.map((t) => [t.id, t])), [tasks]);
  const childName = (id: string) => fam.children.find((c) => c.id === id)?.name ?? "";
  const childColor = (id: string) => fam.children.find((c) => c.id === id)?.color ?? "#888";
  const visibleChildIds = new Set(fam.visibleChildren.map((c) => c.id));
  const forChild = (ids: string[]) => childFilter === "all" || ids.includes(childFilter);

  const pending = runs.filter((r) => r.status === "submitted" && visibleChildIds.has(r.child_id) && (childFilter === "all" || r.child_id === childFilter));
  const todays = runs.filter(
    (r) => visibleChildIds.has(r.child_id) && (childFilter === "all" || r.child_id === childFilter) && (() => {
      const t = taskById[r.task_id];
      const g = t?.group_id ? groups.find((x) => x.id === t.group_id) : null;
      if (g) return r.day === groupDay(g);
      return r.day === today || (t?.recurrence === "once" && ["open", "started", "rejected"].includes(r.status));
    })()
  );
  const rewards = runs.filter((r) => r.status === "approved" && r.reward_text && !r.reward_delivered_at && visibleChildIds.has(r.child_id));
  const history = runs.filter((r) => {
    if (!visibleChildIds.has(r.child_id) || (childFilter !== "all" && r.child_id !== childFilter)) return false;
    const from = historyView === "range" ? rangeFrom : historyView === "month" ? monthStart : historyView === "week" ? todayISO("Europe/Berlin", -6) : today;
    const to = historyView === "range" ? rangeTo : today;
    if (r.day < from || r.day > to) return false;
    const t = taskById[r.task_id];
    if (!t) return FINAL.has(r.status);
    if (t.group_id) return true; // grup satırında karar verilir
    return FINAL.has(r.status) || winEnded(taskWindow(t, null, r.day));
  });
  // Tek görevler: tekrarlılar ve henüz bitmemiş / bugüne ait tek seferlikler. Bitmiş eski görevler geçmişte görünür.
  const singles = tasks.filter((t) => {
    if (t.group_id || !forChild(t.child_ids)) return false;
    if (t.recurrence === "days") return true;
    const rs = runs.filter((r) => r.task_id === t.id);
    if (!rs.length) return true;
    return rs.some((r) => ["open", "started", "submitted", "rejected"].includes(r.status) || r.day === today);
  });
  const [openHist, setOpenHist] = useState<string | null>(null);
  const [othersOpen, setOthersOpen] = useState(false);
  // Kanıtı (fotoğraf, ekran görüntüsü, kayıt) hâlâ duran koşular: geçmişten de açılabilir
  const [proofRuns, setProofRuns] = useState<Set<string>>(new Set());
  const [openProof, setOpenProof] = useState<string | null>(null);
  useEffect(() => {
    supabase.from("task_proofs").select("run_id").is("removed_at", null).gte("created_at", new Date(Date.now() - 45 * 86400_000).toISOString()).limit(2000)
      .then(({ data }) => setProofRuns(new Set(((data ?? []) as { run_id: string }[]).map((x) => x.run_id))));
  }, [runs]);
  const proofBtn = (r: TaskRun) =>
    proofRuns.has(r.id) ? (
      <button className={`icon-pill proof-btn ${openProof === r.id ? "on" : ""}`} title="Kanıtları göster" aria-label="Kanıtları göster" onClick={(e) => { e.preventDefault(); e.stopPropagation(); setOpenProof(openProof === r.id ? null : r.id); }}>📎</button>
    ) : null;
  const todayTaskIds = new Set(todays.map((r) => r.task_id));
  const otherSingles = singles.filter((t) => !todayTaskIds.has(t.id));
  // Geçmiş: gruptaki görevler grup adıyla tek satır
  const historyRows = useMemo(() => {
    const out: Array<{ key: string; kind: "task"; run: TaskRun } | { key: string; kind: "group"; group: TaskGroup; child: string; day: string; runs: TaskRun[] }> = [];
    const seen = new Map<string, number>();
    for (const r of history) {
      const g = groups.find((x) => x.id === taskById[r.task_id]?.group_id);
      if (!g) { out.push({ key: r.id, kind: "task", run: r }); continue; }
      const k = `${g.id}|${r.child_id}|${r.day}`;
      const i = seen.get(k);
      if (i == null) { seen.set(k, out.length); out.push({ key: k, kind: "group", group: g, child: r.child_id, day: r.day, runs: [r] }); }
      else (out[i] as { runs: TaskRun[] }).runs.push(r);
    }
    // Grup: koşul kararı verilmişse, hepsi bitmişse ya da süresi geçmişse
    return out.filter((row) => {
      if (row.kind === "task") return true;
      const gr = groupRuns.find((x) => x.group_id === row.group.id && x.child_id === row.child && x.day === row.day);
      if (gr && gr.status !== "open") return true;
      if (row.runs.every((r) => FINAL.has(r.status))) return true;
      const t = taskById[row.runs[0].task_id];
      return !!t && winEnded(taskWindow(t, row.group, row.day));
    });
  }, [history, groups, groupRuns, taskById]);
  const shownGroups = groups.filter((g) => forChild(g.child_ids));
  const otherGroups = shownGroups.filter((g) => !todays.some((r) => taskById[r.task_id]?.group_id === g.id));
  const selected = groups.find((g) => g.id === selectedId) ?? null;
  const taskMeta = (t: Task | undefined, status: string | null, arrow: JSX.Element | null = null) => {
    const g = t?.group_id ? groups.find((x) => x.id === t.group_id) : null;
    const repeat = !!t && !g && t.recurrence === "days";
    return <Meta repeat={repeat} repeatTitle="Tekrarlı görev" reward={t ? rewardText(t.reward_minutes) : null} status={status} edit={<EditIcon label="Görevi düzenle" />} arrow={arrow} />;
  };
  const groupMeta = (g: TaskGroup, pr: { all: number }, status: string | null, open: boolean | null) => (
    <Meta
      repeat={g.recurrence !== "once"}
      repeatTitle={`Tekrarlı · ${repeatText(g)}`}
      reward={`+${pr.all} dk`}
      status={status}
      edit={<EditIcon label={`${g.name} grubunu düzenle`} onClick={(e) => { e.preventDefault(); e.stopPropagation(); select(g.id); }} />}
      arrow={open == null ? null : <span className={`collapse-arrow${open ? " open" : ""}`} aria-hidden="true" />}
    />
  );
  const groupText = (g: TaskGroup, rs: TaskRun[], pr: { approved: number; need: number }) => {
    const mand = rs.filter((r) => taskById[r.task_id]?.mandatory).length;
    const parts = [`${pr.approved}/${rs.length} tamam`];
    if (mand) parts.push(`${mand} zorunlu`);
    if (g.min_count && pr.need > mand && pr.need < rs.length) parts.push(`en az ${pr.need}`);
    return parts.join(" · ");
  };

  const select = (id: string | null, tab?: string) => {
    const next = new URLSearchParams(params);
    if (id) next.set("group", id); else next.delete("group");
    if (tab) next.set("tab", tab); else next.delete("tab");
    setParams(next, { replace: true });
  };

  async function createGroup() {
    const kids = childFilter === "all" ? fam.children.map((c) => c.id) : [childFilter];
    const { data, error } = await supabase.from("task_groups").insert({ ...newGroup(fam.familyId ?? "", kids), sort: groups.length }).select().single();
    if (error) return setErr(errorText(error));
    await load();
    select((data as TaskGroup).id, "settings");
  }

  async function seedTemplates() {
    const { error } = await supabase.from("task_templates").insert(STARTER_TEMPLATES.map((t) => ({ ...t, family_id: fam.familyId })));
    if (error) setErr(errorText(error));
    load();
  }

  return (
    <div className="page wide-page">
      <header className="page-head">
        <h1 className="row gap-s">
          {selected && (
            <button className="icon-pill" aria-label="Görevlere dön" title="Görevlere dön" onClick={() => select(null)}>←</button>
          )}
          Görevler
        </h1>
        <div className="row gap-s">
          <button className="pill-btn" onClick={createGroup}>
            <Icon name="plus" size={14} /> Grup
          </button>
          <button className="pill-btn primary" onClick={() => nav(selected ? `/tasks/new?group=${selected.id}` : "/tasks/new")}>
            <Icon name="plus" size={14} /> Görev
          </button>
        </div>
      </header>
      {err && <p className="error">{err}</p>}

      {pending.length > 0 && (
        <section className="stack" id="onay">
          <h2 className="section-title">Onay bekleyen ({pending.length})</h2>
          {pending.map((r) => (
            <ReviewCard key={r.id} run={r} task={taskById[r.task_id]} group={groups.find((g) => g.id === taskById[r.task_id]?.group_id)} childName={childName(r.child_id)} color={childColor(r.child_id)} onDone={load} />
          ))}
        </section>
      )}

      {fam.children.length > 1 && (
        <div className="chips">
          <button className={`chip-btn small-chip ${childFilter === "all" ? "on" : ""}`} onClick={() => setChildFilter("all")}>Herkes</button>
          {fam.children.map((c) => (
            <button key={c.id} className={`chip-btn small-chip ${childFilter === c.id ? "on" : ""}`} onClick={() => setChildFilter(c.id)}>
              <span className="dot" style={{ background: c.color, marginTop: 0 }} /> {c.name}
            </button>
          ))}
        </div>
      )}

      <div className="tasks-layout">
        <main className="tasks-main">
          {selected ? (
            <>
            <TaskGroupDetail
              group={selected}
              groups={groups}
              tasks={tasks}
              runs={runs}
              groupRuns={groupRuns}
              childFilter={childFilter}
              initialTab={tabParam ?? undefined}
              onChange={load}
              onDeleted={() => { select(null); load(); }}
            />
            </>
          ) : (
            <>
              <div className="card">
                <h2>Bugün</h2>
                {!todays.length && <p className="muted small">Bugün için görev yok.</p>}
                {fam.visibleChildren.filter((c) => childFilter === "all" || c.id === childFilter).map((c) => {
                  const list = todays.filter((r) => r.child_id === c.id);
                  if (!list.length) return null;
                  return (
                    <div key={c.id} className="stack-s">
                      <div className="row gap-s">
                        <span className="dot" style={{ background: c.color, marginTop: 0 }} />
                        <b>{c.name}</b>
                        <span className="muted small">
                          {list.filter((r) => r.status === "approved").length}/{list.filter((r) => r.status !== "claimed").length} görev tamam
                        </span>
                      </div>
                      {(() => {
                        const row = (r: TaskRun, sub = false) => {
                          const t = taskById[r.task_id];
                          return (
                            <div key={r.id}>
                              <Link to={t ? `/tasks/${t.id}` : "/tasks"} className={`app-row ${sub ? "hist-sub" : ""}`}>
                                <div className="grow">
                                  <b>{t?.title}</b>
                                  <div className="muted tiny">
                                    {[t && !sub ? spanText(taskSpan(t, null)) : t?.mandatory ? "Zorunlu" : "Seçmeli", proofText(t)].filter(Boolean).join(" · ")}
                                  </div>
                                </div>
                                {r.status !== "submitted" && proofBtn(r)}
                                {taskMeta(t, r.status)}
                              </Link>
                              {openProof === r.id && <RunProofs run={r} task={t} />}
                            </div>
                          );
                        };
                        const out: JSX.Element[] = [];
                        const done = new Set<string>();
                        for (const r of list) {
                          const g = groups.find((x) => x.id === taskById[r.task_id]?.group_id);
                          if (!g) { out.push(row(r)); continue; }
                          if (done.has(g.id)) continue;
                          done.add(g.id);
                          const rs = list.filter((x) => taskById[x.task_id]?.group_id === g.id);
                          const pr = groupProgress(g, tasks, runs, groupRuns, c.id);
                          const key = `t|${g.id}|${c.id}`;
                          const open = openHist === key;
                          out.push(
                            <div key={key} className="hist-group">
                              <div className="app-row hist-group-head" role="button" tabIndex={0} onClick={() => setOpenHist(open ? null : key)} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setOpenHist(open ? null : key); } }} aria-expanded={open}>
                                <Folder />
                                <div className="grow">
                                  <b>{g.name}</b>
                                  <div className="muted tiny">
                                    {(() => { const t0 = taskById[rs[0].task_id]; return t0 ? spanText(taskSpan(t0, g)) : ""; })()} · {groupText(g, rs, pr)}
                                  </div>
                                </div>
                                {groupMeta(g, pr, groupStatus(pr, rs), open)}
                              </div>
                              {open && rs.map((r) => row(r, true))}
                            </div>
                          );
                        }
                        return out;
                      })()}
                    </div>
                  );
                })}
              </div>

              {(otherGroups.length > 0 || otherSingles.length > 0) && (
                <div className="card">
                  <div className="section-collapse-head collapse-title" role="button" tabIndex={0} onClick={() => setOthersOpen((v) => !v)} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setOthersOpen((v) => !v); } }} aria-expanded={othersOpen}>
                    <span>Bugün olmayan görevler ({otherGroups.length + otherSingles.length}) <Info>Kapalı gruplar, bugün günü olmayan ya da ileri tarihli görevler. Düzenlemek için dokun.</Info></span>
                    <span className={`collapse-arrow${othersOpen ? " open" : ""}`} aria-hidden="true" />
                  </div>
                  {othersOpen && otherGroups.map((g) => (
                    <button key={g.id} className="app-row" onClick={() => select(g.id)}>
                      <Folder />
                      <div className="grow">
                        <b>{g.name}</b>
                        <div className="muted tiny">{tasks.filter((t) => t.group_id === g.id).length} görev · {repeatText(g)}{g.active ? "" : " · kapalı"}</div>
                      </div>
                      <Meta repeat={g.recurrence !== "once"} repeatTitle={`Tekrarlı · ${repeatText(g)}`} reward={`+${tasks.filter((t) => t.group_id === g.id).reduce((a, t) => a + Math.max(0, t.reward_minutes ?? 0), 0)} dk`} status={null} edit={<EditIcon label="Grubu düzenle" />} />
                    </button>
                  ))}
                  {othersOpen && otherSingles.map((t) => (
                    <Link key={t.id} to={`/tasks/${t.id}`} className="app-row">
                      <div className="grow">
                        <b>{t.title}</b>
                        <div className="muted tiny">{spanText(taskSpan(t, null))} · {t.child_ids.map(childName).join(", ")}{t.active ? "" : " · kapalı"}</div>
                      </div>
                      {taskMeta(t, null)}
                    </Link>
                  ))}
                </div>
              )}

              {rewards.length > 0 && (
                <div className="card soft">
                  <h2>Verilecek ödüller</h2>
                  {rewards.map((r) => (
                    <div className="app-row" key={r.id}>
                      <span className="dot" style={{ background: childColor(r.child_id) }} />
                      <div className="grow">
                        <b>{r.reward_text}</b>
                        <div className="muted tiny">
                          {childName(r.child_id)} · {taskById[r.task_id]?.title}
                        </div>
                      </div>
                      <button
                        className="pill-btn"
                        onClick={async () => {
                          await supabase.from("task_runs").update({ reward_delivered_at: new Date().toISOString() }).eq("id", r.id);
                          load();
                        }}
                      >
                        Verildi
                      </button>
                    </div>
                  ))}
                </div>
              )}

              <div className="card">
                <div className="row between wrap">
                  <h2>Görev geçmişi <Info>Yalnızca biten (onaylanan, kardeşi yapan) ya da süresi dolan görevler. Devam edenler “Bugün” bölümündedir.</Info></h2>
                  <div className="chips">
                    {(["day", "week", "month", "range"] as const).map((v) => (
                      <button key={v} className={`chip-btn ${historyView === v ? "on" : ""}`} onClick={() => setHistoryView(v)}>
                        {v === "day" ? "Bugün" : v === "week" ? "7 gün" : v === "month" ? "1 ay" : "Özel"}
                      </button>
                    ))}
                  </div>
                </div>
                {historyView === "range" && (
                  <div className="extra-row">
                    <DateField value={rangeFrom} onChange={setRangeFrom} />
                    <span className="muted">–</span>
                    <DateField value={rangeTo} onChange={setRangeTo} />
                  </div>
                )}
                {!historyRows.length && <p className="muted small">{historyView === "day" ? "Bugün biten ya da süresi dolan görev yok." : "Bu aralıkta biten görev yok."}</p>}
                {historyRows.map((row) => {
                  if (row.kind === "task") {
                    const r = row.run;
                    const t = taskById[r.task_id];
                    return (
                      <div key={row.key}>
                        <Link to={t ? `/tasks/${t.id}` : "/tasks"} className="app-row">
                          <div className="grow">
                            <b>{t?.title ?? "Görev"}</b>
                            <div className="muted tiny">{childName(r.child_id)} · {t ? winText(taskWindow(t, null, r.day)) : dShort(r.day)}</div>
                          </div>
                          {proofBtn(r)}
                          {taskMeta(t, r.status)}
                        </Link>
                        {openProof === r.id && <RunProofs run={r} task={t} />}
                      </div>
                    );
                  }
                  const gr = groupRuns.find((x) => x.group_id === row.group.id && x.child_id === row.child && x.day === row.day);
                  const pr = groupProgress(row.group, tasks, runs, groupRuns, row.child, row.day);
                  const open = openHist === row.key;
                  return (
                    <div key={row.key} className="hist-group">
                      <div className="app-row hist-group-head" role="button" tabIndex={0} onClick={() => setOpenHist(open ? null : row.key)} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setOpenHist(open ? null : row.key); } }} aria-expanded={open}>
                        <Folder />
                        <div className="grow">
                          <b>{row.group.name}</b>
                          <div className="muted tiny">{childName(row.child)} · {(() => { const t0 = taskById[row.runs[0].task_id]; return t0 ? winText(taskWindow(t0, row.group, row.day)) : dShort(row.day); })()} · {groupText(row.group, row.runs, pr)}{gr?.status === "met" ? " · koşul sağlandı" : gr?.status === "failed" ? " · koşul sağlanmadı" : ""}</div>
                        </div>
                        {groupMeta(row.group, pr, groupStatus(gr ? { status: gr.status } : pr, row.runs), open)}
                      </div>
                      {open && row.runs.map((r) => {
                        const t = taskById[r.task_id];
                        return (
                          <div key={r.id}>
                          <Link to={t ? `/tasks/${t.id}` : "/tasks"} className="app-row hist-sub">
                            <div className="grow">
                              <b>{t?.title ?? "Görev"}</b>
                              <div className="muted tiny">{[t?.mandatory ? "Zorunlu" : "Seçmeli", proofText(t)].filter(Boolean).join(" · ")}{r.granted_minutes ? ` · ${r.granted_minutes} dk verildi` : ""}</div>
                            </div>
                            {proofBtn(r)}
                            {taskMeta(t, r.status)}
                          </Link>
                          {openProof === r.id && <RunProofs run={r} task={t} />}
                          </div>
                        );
                      })}
                    </div>
                  );
                })}
              </div>

              <div className="card">
                <div className="section-collapse-head collapse-title" role="button" tabIndex={0} onClick={() => setTemplatesOpen((v) => !v)} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setTemplatesOpen((v) => !v); } }} aria-expanded={templatesOpen}>
                  <span>Şablonlar <Info>Sık verilen görevler. Bir şablonu açınca ayarları hazır yeni görev formu açılır.</Info></span>
                  <span className={`collapse-arrow${templatesOpen ? " open" : ""}`} aria-hidden="true" />
                </div>
                {templatesOpen && templates.map((t) => (
                  <div className="app-row" key={t.id}>
                    <div className="grow">
                      <b>{t.title}</b>
                      <div className="muted tiny">
                        {PROOF_LABEL[t.proof]}
                        {t.before_after ? " (öncesi/sonrası)" : ""}
                        {t.reward_minutes != null ? ` · ${t.reward_minutes > 0 ? "+" : ""}${minutesText(t.reward_minutes)}` : ""}
                        {t.reward_text ? ` · ${t.reward_text}` : ""}
                      </div>
                    </div>
                    <button className="pill-btn" onClick={() => nav(`/tasks/new?template=${t.id}`)}>
                      Ver
                    </button>
                    <button
                      className="icon-btn"
                      aria-label="Şablonu sil"
                      onClick={async () => {
                        if (!confirm(`"${t.title}" şablonu silinsin mi?`)) return;
                        await supabase.from("task_templates").delete().eq("id", t.id);
                        load();
                      }}
                    >
                      <Icon name="trash" size={18} />
                    </button>
                  </div>
                ))}
                {templatesOpen && !templates.length && (
                  <button className="pill-btn" onClick={seedTemplates}>
                    Hazır şablonları ekle (Odanı topla, Ödevini yap…)
                  </button>
                )}
              </div>
            </>
          )}
        </main>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

/** Bir görev koşusunun kanıtları (onaydan sonra da, silinene kadar): fotoğraf, ekran görüntüsü, kayıtlar */
function RunProofs({ run, task }: { run: TaskRun; task?: Task }) {
  const [proofs, setProofs] = useState<Array<TaskProof & { url?: string }> | null>(null);
  useEffect(() => {
    (async () => {
      const { data } = await supabase.from("task_proofs").select("*").eq("run_id", run.id).neq("stage", "record").is("removed_at", null).order("attempt").order("created_at");
      const list = (data ?? []) as TaskProof[];
      const urls = list.length ? await mediaUrls(list.map((p) => p.path), 3600) : [];
      setProofs(list.map((p, i) => ({ ...p, url: urls[i] })));
    })();
  }, [run.id]);
  const labels = proofLabels(proofs ?? [], run.attempts);
  const gallery = galleryOf(proofs ?? [], labels);
  const label = (p: TaskProof) => labels.get(p.id) ?? "";
  return (
    <div className="run-proofs">
      {proofs == null ? (
        <p className="muted small">Yükleniyor…</p>
      ) : (
        proofs.length > 0 && (
          <div className="proof-attempt current">
            {proofs.map((p) => (
              <figure key={p.id}>
                {p.url ? (
                  p.media === "video" ? <video src={p.url} controls playsInline preload="metadata" /> : <PhotoZoom items={gallery} id={p.id} />
                ) : (
                  <div className="proof-missing">silinmiş</div>
                )}
                <figcaption>{label(p)}</figcaption>
              </figure>
            ))}
          </div>
        )
      )}
      <RecordingList runId={run.id} />
      {proofs != null && !proofs.length && !task?.record_minutes && !task?.screen_record_minutes && <p className="muted small">Kanıt kalmamış (saklama süresi dolmuş).</p>}
    </div>
  );
}

function ReviewCard({ run, task, group, childName, color, onDone }: { run: TaskRun; task?: Task; group?: TaskGroup; childName: string; color: string; onDone: () => void }) {
  const [proofs, setProofs] = useState<(TaskProof & { url?: string })[]>([]);
  const [minutes, setMinutes] = useState(String(task?.reward_minutes ?? ""));
  const [validity, setValidity] = useState<RewardValidity>(task?.reward_validity ?? "today");
  const [date, setDate] = useState(todayISO("Europe/Berlin", 1));
  const fam = useFamily();
  const [sectionId, setSectionId] = useState<string>((task as (Task & { reward_section_id?: string | null }) | undefined)?.reward_section_id ?? "");
  const [note, setNote] = useState("");
  const [rejecting, setRejecting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [notes, setNotes] = useState<{ attempt: number; note: string | null }[]>([]);

  useEffect(() => {
    (async () => {
      // Bütün denemelerin kanıtları (reddedilenler de) ve her reddin notu
      const [{ data }, { data: nt }] = await Promise.all([
        supabase.from("task_proofs").select("*").eq("run_id", run.id).neq("stage", "record").is("removed_at", null).order("attempt").order("created_at"),
        supabase.from("task_run_notes").select("attempt, note").eq("run_id", run.id).order("attempt"),
      ]);
      setNotes((nt ?? []) as { attempt: number; note: string | null }[]);
      const list = (data ?? []) as TaskProof[];
      if (!list.length) return setProofs([]);
      const urls = await mediaUrls(list.map((p) => p.path), 600);
      setProofs(list.map((p, i) => ({ ...p, url: urls[i] })));
    })();
  }, [run.id, run.attempts]);

  async function decide(approve: boolean) {
    setBusy(true);
    setErr("");
    const { data, error } = await supabase.rpc("parent_decide_run", {
      p_run: run.id,
      p_approve: approve,
      p_note: approve ? null : note,
      p_minutes: approve && minutes ? Number(minutes) : approve ? 0 : null,
      p_validity: approve ? validity : null,
      p_date: approve && validity === "date" ? date : null,
      p_expires: null,
    });
    if (error) {
      setErr(errorText(error));
      setBusy(false);
      return;
    }
    // Süre nereye eklensin: görevin varsayılanından farklı seçildiyse verilen süreyi güncelle
    const def = (task as (Task & { reward_section_id?: string | null }) | undefined)?.reward_section_id ?? "";
    if (approve && validity !== "wallet" && validity !== "vault" && sectionId !== def) {
      await supabase.from("time_grants").update({ section_id: sectionId || null }).eq("task_run_id", run.id);
    }
    // Kasa seçimi onayda değiştirildiyse süreyi ona göre işaretle
    if (approve) await supabase.from("time_grants").update({ vault: validity === "vault" }).eq("task_run_id", run.id);
    // Kanıtlar karar verilince hemen silinir (sunucu da 15 dk'da bir kontrol eder).
    const paths = (data ?? []) as string[];
    const stPaths = paths.filter((p) => !p.includes("/od:"));
    if (stPaths.length) await supabase.storage.from("orbit-proofs").remove(stPaths);
    setBusy(false);
    onDone();
  }

  // Öncesi (ilk) + her denemenin sonrası; en yenisi en sonda
  const before = proofs.filter((p) => p.stage === "before");
  const ordered = [...before, ...proofs.filter((p) => p.stage !== "before").sort((a, b) => a.attempt - b.attempt)];
  const labels = proofLabels(ordered, run.attempts);
  const gallery = galleryOf(ordered, labels);
  const attempts = [...new Set(proofs.filter((p) => p.stage !== "before").map((p) => p.attempt))].sort((a, b) => a - b);
  const proofFig = (p: TaskProof & { url?: string }, caption: string) => (
    <figure key={p.id}>
      {p.url ? (
        p.media === "video" ? (
          <video src={p.url} controls playsInline preload="metadata" />
        ) : (
          <PhotoZoom items={gallery} id={p.id} />
        )
      ) : (
        <div className="proof-missing">yükleniyor…</div>
      )}
      <figcaption>{caption}</figcaption>
    </figure>
  );

  return (
    <div className="card attention">
      <div className="row gap-s">
        <span className="dot" style={{ background: color, marginTop: 0 }} />
        <b className="grow">
          {childName} · {task?.title}
        </b>
        <span className="muted tiny">{relTime(run.submitted_at)}</span>
      </div>
      {task?.description && <p className="muted small">{task.description}</p>}
      {(task?.record_minutes != null || task?.screen_record_minutes != null) && <RecordingList runId={run.id} />}
      {proofs.length > 0 ? (
        <div className="proof-timeline">
          {before.map((p) => proofFig(p, labels.get(p.id) ?? "Öncesi"))}
          {attempts.map((a) => {
            const last = a === run.attempts;
            const n = notes.find((x) => x.attempt === a);
            return (
              <div key={a} className={`proof-attempt ${last ? "current" : ""}`}>
                {proofs.filter((p) => p.stage !== "before" && p.attempt === a).map((p) => proofFig(p, `${labels.get(p.id) ?? ""}${last && attempts.length > 1 ? " · şimdi" : ""}`))}
                {!last && <p className="small warn-text">↩ {n?.note ? `Reddedildi: ${n.note}` : "Reddedildi"}</p>}
              </div>
            );
          })}
        </div>
      ) : (
        task?.proof !== "none" && <p className="muted small">Kanıt bulunamadı.</p>
      )}
      {!rejecting ? (
        <>
          <div className="extra-group">
            <span className="pop-label">ÖDÜL</span>
            <div className="extra-row">
              <MinuteStepper value={Number(minutes) || 0} onChange={(v) => setMinutes(String(v))} max={1440} label="Ödül dakikası" />
              {!group && (
                <div className="chips">
                  {(Object.keys(VALIDITY_LABEL) as RewardValidity[]).filter((v) => ["today", "wallet", "vault"].includes(v) || v === validity).map((v) => (
                    <button key={v} type="button" className={`chip-btn ${validity === v ? "on" : ""}`} onClick={() => setValidity(v)}>{VALIDITY_LABEL[v]}</button>
                  ))}
                </div>
              )}
            </div>
            {group && <span className="muted tiny">“{group.name}” grubunda: süre grubun koşulu sağlanınca açılır{group.sequential ? "; onaylayınca sıradaki görev açılır" : ""}.</span>}
          </div>
          {!group && validity === "date" && <DateField value={date} onChange={(v) => setDate(v)} />}
          {!group && validity !== "wallet" && validity !== "vault" && Number(minutes) > 0 && (
            <label className="field compact">
              <span>Nereye eklensin</span>
              <select className="compact-select" value={sectionId} onChange={(e) => setSectionId(e.target.value)}>
                <option value="">Gün boyu</option>
                {fam.sections.map((s) => (
                  <option key={s.id} value={s.id}>
                    {fam.profiles.find((p) => p.id === s.profile_id)?.name} · {s.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          {task?.reward_text && <p className="small">Ödül: {task.reward_text}</p>}
          {err && <p className="error">{err}</p>}
          <div className="extra-actions">
            <button className="pill-btn minus" disabled={busy} onClick={() => setRejecting(true)}>
              <Icon name="x" size={14} /> Reddet
            </button>
            <span className="grow" />
            <button className="pill-btn primary" disabled={busy} onClick={() => decide(true)}>
              <Icon name="check" size={14} /> Onayla
            </button>
          </div>
        </>
      ) : (
        <>
          <input className="compact-input" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Neden? Çocuk görecek · ör. Masanın altı hâlâ dağınık" autoFocus />
          {err && <p className="error">{err}</p>}
          <div className="extra-actions">
            <button className="pill-btn" disabled={busy} onClick={() => setRejecting(false)}>
              Vazgeç
            </button>
            <span className="grow" />
            <button className="pill-btn primary" disabled={busy} onClick={() => decide(false)}>
              Geri gönder
            </button>
          </div>
        </>
      )}
    </div>
  );
}
