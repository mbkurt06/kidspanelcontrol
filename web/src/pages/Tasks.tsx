import { useCallback, useEffect, useMemo, useState } from "react";
import { DateField } from "../components/DateTime";
import { Link, useNavigate } from "react-router-dom";
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
  type TaskTemplate,
} from "../lib/types";
import { Icon } from "../components/Icon";
import { Info } from "../components/Info";
import { RecordingList } from "../components/RecordingPlayer";
import { STARTER_TEMPLATES } from "../lib/templates";

export default function Tasks() {
  const fam = useFamily();
  const nav = useNavigate();
  const [tasks, setTasks] = useState<Task[]>([]);
  const [runs, setRuns] = useState<TaskRun[]>([]);
  const [templates, setTemplates] = useState<TaskTemplate[]>([]);
  const [templatesOpen, setTemplatesOpen] = useState(false);
  const [err, setErr] = useState("");
  const today = todayISO();
  const [historyView, setHistoryView] = useState<"day" | "week" | "month" | "range">("day");
  const [rangeFrom, setRangeFrom] = useState(todayISO("Europe/Berlin", -7));
  const [rangeTo, setRangeTo] = useState(today);
  const monthStart = `${today.slice(0, 7)}-01`;

  const load = useCallback(async () => {
    await supabase.rpc("parent_ensure_runs", { p_day: today });
    const [t, r, tp] = await Promise.all([
      supabase.from("tasks").select("*").order("created_at", { ascending: false }),
      supabase
        .from("task_runs")
        .select("*")
        .order("day", { ascending: false })
        .limit(300),
      supabase.from("task_templates").select("*").order("title"),
    ]);
    if (t.error) setErr(errorText(t.error));
    setTasks((t.data ?? []) as Task[]);
    setRuns((r.data ?? []) as TaskRun[]);
    setTemplates((tp.data ?? []) as TaskTemplate[]);
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

  const pending = runs.filter((r) => r.status === "submitted" && visibleChildIds.has(r.child_id));
  const todays = runs.filter(
    (r) => visibleChildIds.has(r.child_id) && (r.day === today || (taskById[r.task_id]?.recurrence === "once" && ["open", "started", "rejected"].includes(r.status)))
  );
  const rewards = runs.filter((r) => r.status === "approved" && r.reward_text && !r.reward_delivered_at && visibleChildIds.has(r.child_id));
  const history = runs.filter((r) => {
    if (!visibleChildIds.has(r.child_id)) return false;
    const from = historyView === "range" ? rangeFrom : historyView === "month" ? monthStart : historyView === "week" ? todayISO("Europe/Berlin", -6) : today;
    const to = historyView === "range" ? rangeTo : today;
    return r.day >= from && r.day <= to;
  });

  async function seedTemplates() {
    const { error } = await supabase.from("task_templates").insert(STARTER_TEMPLATES.map((t) => ({ ...t, family_id: fam.familyId })));
    if (error) setErr(errorText(error));
    load();
  }

  return (
    <div className="page">
      <header className="page-head">
        <h1>Görevler</h1>
      </header>
      {err && <p className="error">{err}</p>}

      {pending.length > 0 && (
        <section className="stack">
          <h2 className="section-title">Onay bekleyen ({pending.length})</h2>
          {pending.map((r) => (
            <ReviewCard key={r.id} run={r} task={taskById[r.task_id]} childName={childName(r.child_id)} color={childColor(r.child_id)} onDone={load} />
          ))}
        </section>
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
                className="btn small"
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
        <h2>Bugün</h2>
        {!todays.length && <p className="muted small">Bugün için görev yok.</p>}
        {fam.visibleChildren.map((c) => {
          const list = todays.filter((r) => r.child_id === c.id);
          if (!list.length) return null;
          return (
            <div key={c.id} className="stack-s">
              <div className="row gap-s">
                <span className="dot" style={{ background: c.color, marginTop: 0 }} />
                <b>{c.name}</b>
                <span className="muted small">
                  {list.filter((r) => r.status === "approved").length}/{list.filter((r) => r.status !== "claimed").length} tamam
                </span>
              </div>
              {list.map((r) => {
                const t = taskById[r.task_id];
                return (
                  <div className="app-row" key={r.id}>
                    <div className="grow">
                      <b>
                        {t?.title}
                      </b>
                      <div className="muted tiny">
                        {t ? dateTimeText(t.created_at) : ""}{t?.due_date ? ` · ${agendaDateText(t.due_date)}` : ""}
                      </div>
                    </div>
                    <span className={`pill ${r.status === "approved" ? "" : r.status === "submitted" ? "accent" : r.status === "rejected" ? "warn" : "quiet"}`}>
                      {STATUS_LABEL[r.status]}
                    </span>
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>

      <div className="card">
        <div className="row between wrap">
          <h2>Görev geçmişi <Info>Bugün, son 7 gün, bu ay veya seçtiğin tarih aralığındaki görev kayıtları.</Info></h2>
          <div className="row gap-xs wrap">
            {(["day", "week", "month", "range"] as const).map((v) => (
              <button key={v} className={`chip small ${historyView === v ? "on" : ""}`} onClick={() => setHistoryView(v)}>
                {v === "day" ? "Bugün" : v === "week" ? "7 gün" : v === "month" ? "1 ay" : "Özel"}
              </button>
            ))}
          </div>
        </div>
        {historyView === "range" && <div className="grid2">
          <label className="field"><span>Başlangıç</span><DateField value={rangeFrom} onChange={setRangeFrom} /></label>
          <label className="field"><span>Bitiş</span><DateField value={rangeTo} onChange={setRangeTo} /></label>
        </div>}
        {!history.length && <p className="muted small">Bu görünümde görev yok.</p>}
        {history.map((r) => {
          const t = taskById[r.task_id];
          return <Link to={t ? `/tasks/${t.id}` : "/tasks"} className="app-row" key={r.id}>
            <div className="grow">
              <b>{t?.title ?? "Görev"}</b>
              <div className="muted tiny">{childName(r.child_id)} · {r.day} · {STATUS_LABEL[r.status]}{t?.due_date ? ` · ${agendaDateText(t.due_date)}` : ""}</div>
            </div>
            <Icon name="chevron" size={18} />
          </Link>;
        })}
      </div>

      <div className="card">
        <div className="row between">
          <button className="section-title row gap-xs templates-head" type="button" onClick={() => setTemplatesOpen((v) => !v)} aria-expanded={templatesOpen}>
            <span className={`collapse-arrow${templatesOpen ? " open" : ""}`} aria-hidden="true" />
            <span>Şablonlar</span>
            <Info>Sık verilen görevler. Bir şablonu açınca ayarları hazır yeni görev formu açılır.</Info>
          </button>
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
            <button className="btn small" onClick={() => nav(`/tasks/new?template=${t.id}`)}>
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
          <button className="btn" onClick={seedTemplates}>
            Hazır şablonları ekle (Odanı topla, Ödevini yap…)
          </button>
        )}
      </div>
      <button className="agenda-fab" aria-label="Yeni görev ekle" onClick={() => nav("/tasks/new")}>+</button>
    </div>
  );
}

// ---------------------------------------------------------------------------

function ReviewCard({ run, task, childName, color, onDone }: { run: TaskRun; task?: Task; childName: string; color: string; onDone: () => void }) {
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
                {proofs.filter((p) => p.stage !== "before" && p.attempt === a).map((p) => proofFig(p, last ? (attempts.length > 1 ? `${a + 1}. deneme · şimdi` : "Sonrası") : `${a + 1}. deneme`))}
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
          <div className="grid2">
            <label className="field">
              <span>Ekstra süre (dk)</span>
              <input type="number" min={0} value={minutes} onChange={(e) => setMinutes(e.target.value)} placeholder="yok" />
            </label>
            <label className="field">
              <span>Ne zaman</span>
              <select value={validity} onChange={(e) => setValidity(e.target.value as RewardValidity)}>
                {(Object.keys(VALIDITY_LABEL) as RewardValidity[]).map((v) => (
                  <option key={v} value={v}>
                    {VALIDITY_LABEL[v]}
                  </option>
                ))}
              </select>
            </label>
          </div>
          {validity === "date" && (
            <div className="field">
              <span>Gün</span>
              <DateField value={date} onChange={(v) => setDate(v)} />
            </div>
          )}
          {validity !== "wallet" && validity !== "vault" && Number(minutes) > 0 && (
            <label className="field">
              <span>Nereye eklensin</span>
              <select value={sectionId} onChange={(e) => setSectionId(e.target.value)}>
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
          <div className="row gap-s">
            <button className="btn primary grow" disabled={busy} onClick={() => decide(true)}>
              <Icon name="check" size={18} /> Onayla
            </button>
            <button className="btn grow" disabled={busy} onClick={() => setRejecting(true)}>
              <Icon name="x" size={18} /> Reddet
            </button>
          </div>
        </>
      ) : (
        <>
          <label className="field">
            <span>Neden? (çocuk görecek)</span>
            <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Masanın altı hâlâ dağınık" autoFocus />
          </label>
          {err && <p className="error">{err}</p>}
          <div className="row gap-s">
            <button className="btn primary grow" disabled={busy} onClick={() => decide(false)}>
              Geri gönder
            </button>
            <button className="btn grow" disabled={busy} onClick={() => setRejecting(false)}>
              Vazgeç
            </button>
          </div>
        </>
      )}
    </div>
  );
}
