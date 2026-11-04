import { useCallback, useEffect, useMemo, useState } from "react";
import { DateField } from "../components/DateTime";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { useFamily } from "../lib/family";
import { errorText, supabase } from "../lib/supabase";
import { agendaDateText, dateTimeText, minutesText, relTime, todayISO } from "../lib/util";
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
import { groupDay, groupProgress, moveToGroup, newGroup, repeatText } from "../lib/groups";
import { Icon } from "../components/Icon";
import { Info } from "../components/Info";
import { MinuteStepper } from "../components/MinuteStepper";
import { RecordingList } from "../components/RecordingPlayer";
import { STARTER_TEMPLATES } from "../lib/templates";

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
  const [singlesOpen, setSinglesOpen] = useState(true);
  const [addFor, setAddFor] = useState<string | null>(null);
  const [view, setView] = useState<"all" | "groups" | "single">("all");
  const [childFilter, setChildFilter] = useState<string>("all");
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
    return r.day >= from && r.day <= to;
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
    return out;
  }, [history, groups, taskById]);
  const shownGroups = groups.filter((g) => forChild(g.child_ids));
  const selected = groups.find((g) => g.id === selectedId) ?? null;

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

  const groupCard = (g: TaskGroup) => {
    const n = tasks.filter((t) => t.group_id === g.id).length;
    const kids = fam.children.filter((c) => g.child_ids.includes(c.id) && (childFilter === "all" || c.id === childFilter));
    return (
      <div key={g.id} className={`group-card ${selected?.id === g.id ? "on" : ""} ${g.active ? "" : "inactive"}`}>
        <button className="group-card-main" onClick={() => select(selected?.id === g.id ? null : g.id)}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /></svg>
          <span className="grow group-card-copy">
            <b>{g.name}</b>
            <span className="muted tiny">{n} görev · {repeatText(g)} · {fam.children.filter((c) => g.child_ids.includes(c.id)).map((c) => c.name).join(", ") || "kimse"}</span>
          </span>
          <span className="group-card-progress">
            {kids.map((c) => {
              const pr = groupProgress(g, tasks, runs, groupRuns, c.id);
              if (!pr.total) return null;
              return <span key={c.id} className={pr.status === "met" ? "good-text" : ""} title={c.name}>{kids.length > 1 ? `${c.name.slice(0, 1)} ` : ""}{pr.approved}/{pr.need}</span>;
            })}
          </span>
        </button>
        <button className={`switch ${g.active ? "on" : ""}`} role="switch" aria-checked={g.active} aria-label={`${g.name} aktif`} onClick={async () => { await supabase.from("task_groups").update({ active: !g.active }).eq("id", g.id); load(); }}>
          <span />
        </button>
      </div>
    );
  };

  return (
    <div className="page wide-page">
      <header className="page-head">
        <h1>Görevler</h1>
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

      <div className="tasks-layout">
        <aside className="tasks-aside">
          <div className="chips">
            {([["all", `Tümü ${tasks.filter((t) => forChild(t.child_ids)).length}`], ["groups", `Gruplar ${shownGroups.length}`], ["single", `Tek görevler ${singles.length}`]] as const).map(([k, l]) => (
              <button key={k} className={`chip-btn ${view === k ? "on" : ""}`} onClick={() => setView(k)}>{l}</button>
            ))}
          </div>
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

          {view !== "single" && (
            <div className="stack-s">
              {shownGroups.map(groupCard)}
              {!shownGroups.length && <button className="group-card empty" onClick={createGroup}>+ İlk görev grubunu oluştur</button>}
            </div>
          )}

          {view !== "groups" && (
            <div className="stack-s">
              <div className="sub-collapse-head" role="button" tabIndex={0} onClick={() => setSinglesOpen((v) => !v)} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setSinglesOpen((v) => !v); } }}>
                <span>TEK GÖREVLER</span>
                <span className={`collapse-arrow${singlesOpen ? " open" : ""}`} aria-hidden="true" />
              </div>
              {singlesOpen && (
                <div className="card list-card">
                  {!singles.length && <p className="muted small" style={{ padding: 12 }}>Gruba bağlı olmayan görev yok.</p>}
                  {singles.map((t) => (
                    <div className="single-row" key={t.id}>
                      <Link to={`/tasks/${t.id}`} className="grow single-copy">
                        <b>{t.title}</b>
                        <span className="muted tiny">
                          {t.recurrence === "days" ? (t.days.length === 7 ? "Her gün" : "Tekrarlı") : t.due_date ? agendaDateText(t.due_date) : "Tek sefer"} · {t.child_ids.map(childName).join(", ")}{t.active ? "" : " · kapalı"}
                        </span>
                      </Link>
                      <span className="reward-chip">{t.reward_minutes ? `${t.reward_minutes > 0 ? "+" : ""}${t.reward_minutes} dk` : "—"}</span>
                      {groups.length > 0 && (
                        <div className="pop-anchor">
                          <button className="chip-btn small-chip accent-text" onClick={() => setAddFor(addFor === t.id ? null : t.id)}>Gruba ekle</button>
                          {addFor === t.id && (
                            <>
                              <div className="pop-backdrop" onClick={() => setAddFor(null)} />
                              <div className="lock-pop menu-pop right" role="menu">
                                <span className="pop-label">HANGİ GRUBA</span>
                                {groups.map((g) => (
                                  <button key={g.id} className="menu-item" role="menuitem" onClick={async () => { await moveToGroup(t, g, tasks); setAddFor(null); load(); }}>{g.name}</button>
                                ))}
                              </div>
                            </>
                          )}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </aside>

        <main className="tasks-main">
          {selected ? (
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
                            <div className={`app-row ${sub ? "hist-sub" : ""}`} key={r.id}>
                              <div className="grow">
                                <b>{t?.title}</b>
                                <div className="muted tiny">
                                  {t ? dateTimeText(t.created_at) : ""}{t?.due_date ? ` · ${agendaDateText(t.due_date)}` : ""}
                                </div>
                              </div>
                              <span className={`pill ${r.status === "approved" ? "" : r.status === "submitted" ? "accent" : r.status === "rejected" ? "warn" : "quiet"}`}>
                                {STATUS_LABEL[r.status]}
                              </span>
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
                              <button className="app-row hist-group-head" onClick={() => setOpenHist(open ? null : key)} aria-expanded={open}>
                                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /></svg>
                                <div className="grow">
                                  <b>{g.name}</b>
                                  <div className="muted tiny">{rs.length} görev · {pr.approved}/{pr.need} tamam{pr.submitted ? ` · ${pr.submitted} onay bekliyor` : ""}</div>
                                </div>
                                <span className={`pill ${pr.status === "met" ? "" : pr.submitted ? "accent" : pr.status === "failed" ? "warn" : "quiet"}`}>
                                  {pr.status === "met" ? "Tamam" : pr.status === "failed" ? "Olmadı" : pr.submitted ? "Onay bekliyor" : "Devam ediyor"}
                                </span>
                                <span className={`collapse-arrow${open ? " open" : ""}`} aria-hidden="true" />
                              </button>
                              {open && rs.map((r) => row(r, true))}
                              {open && <button className="pill-btn ghost" style={{ marginLeft: 22 }} onClick={() => select(g.id)}>Gruba git</button>}
                            </div>
                          );
                        }
                        return out;
                      })()}
                    </div>
                  );
                })}
              </div>

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
                  <h2>Görev geçmişi <Info>Bugün, son 7 gün, bu ay veya seçtiğin tarih aralığındaki görev kayıtları.</Info></h2>
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
                {!history.length && <p className="muted small">Bu görünümde görev yok.</p>}
                {historyRows.map((row) => {
                  if (row.kind === "task") {
                    const r = row.run;
                    const t = taskById[r.task_id];
                    return (
                      <Link to={t ? `/tasks/${t.id}` : "/tasks"} className="app-row" key={row.key}>
                        <div className="grow">
                          <b>{t?.title ?? "Görev"}</b>
                          <div className="muted tiny">{childName(r.child_id)} · {r.day} · {STATUS_LABEL[r.status]}{t?.due_date ? ` · ${agendaDateText(t.due_date)}` : ""}</div>
                        </div>
                        <Icon name="chevron" size={18} />
                      </Link>
                    );
                  }
                  const gr = groupRuns.find((x) => x.group_id === row.group.id && x.child_id === row.child && x.day === row.day);
                  const pr = groupProgress(row.group, tasks, runs, groupRuns, row.child, row.day);
                  const open = openHist === row.key;
                  return (
                    <div key={row.key} className="hist-group">
                      <button className="app-row hist-group-head" onClick={() => setOpenHist(open ? null : row.key)} aria-expanded={open}>
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /></svg>
                        <div className="grow">
                          <b>{row.group.name}</b>
                          <div className="muted tiny">{childName(row.child)} · {row.day} · {pr.approved}/{pr.need} görev{gr?.status === "met" ? " · koşul sağlandı" : gr?.status === "failed" ? " · koşul sağlanmadı" : ""}</div>
                        </div>
                        <span className={`collapse-arrow${open ? " open" : ""}`} aria-hidden="true" />
                      </button>
                      {open && row.runs.map((r) => {
                        const t = taskById[r.task_id];
                        return (
                          <Link to={t ? `/tasks/${t.id}` : "/tasks"} className="app-row hist-sub" key={r.id}>
                            <div className="grow">
                              <b>{t?.title ?? "Görev"}</b>
                              <div className="muted tiny">{STATUS_LABEL[r.status]}{r.granted_minutes ? ` · ${r.granted_minutes} dk` : ""}</div>
                            </div>
                            <Icon name="chevron" size={18} />
                          </Link>
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
      const { data: signed } = await supabase.storage.from("orbit-proofs").createSignedUrls(list.map((p) => p.path), 600);
      setProofs(list.map((p, i) => ({ ...p, url: signed?.[i]?.signedUrl ?? undefined })));
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
    if (paths.length) await supabase.storage.from("orbit-proofs").remove(paths);
    setBusy(false);
    onDone();
  }

  // Öncesi (ilk) + her denemenin sonrası; en yenisi en sonda
  const before = proofs.filter((p) => p.stage === "before").slice(0, 1);
  const attempts = [...new Set(proofs.filter((p) => p.stage !== "before").map((p) => p.attempt))].sort((a, b) => a - b);
  const proofFig = (p: TaskProof & { url?: string }, caption: string) => (
    <figure key={p.id}>
      {p.url ? (
        p.media === "video" ? (
          <video src={p.url} controls playsInline preload="metadata" />
        ) : (
          <a href={p.url} target="_blank" rel="noreferrer">
            <img src={p.url} alt="" />
          </a>
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
      {task?.record_minutes != null && <RecordingList runId={run.id} />}
      {proofs.length > 0 ? (
        <div className="proof-timeline">
          {before.map((p) => proofFig(p, "Öncesi"))}
          {attempts.map((a) => {
            const last = a === run.attempts;
            const n = notes.find((x) => x.attempt === a);
            return (
              <div key={a} className={`proof-attempt ${last ? "current" : ""}`}>
                {proofs.filter((p) => p.stage !== "before" && p.attempt === a).map((p) => proofFig(p, p.stage === "screenshot" ? "Ekran görüntüsü" : last ? (attempts.length > 1 ? `${a + 1}. deneme · şimdi` : "Sonrası") : `${a + 1}. deneme`))}
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
