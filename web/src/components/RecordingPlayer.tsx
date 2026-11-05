import { useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "../lib/supabase";
import type { TaskProof, TaskRecording } from "../lib/types";
import { mediaUrls } from "../lib/media";

type Seg = TaskProof & { url?: string; startMs: number; endMs: number };

const SPEEDS = [5, 10, 20, 40];

function clock(ms: number) {
  return new Date(ms).toLocaleTimeString("tr-TR", { hour: "2-digit", minute: "2-digit", second: "2-digit", timeZone: "Europe/Berlin" });
}
function mm(sec: number) {
  const m = Math.round(sec / 60);
  return m >= 60 ? `${Math.floor(m / 60)} sa ${m % 60} dk` : `${m} dk`;
}

const EVENT_LABEL: Record<string, string> = {
  start: "başladı",
  pause: "mola",
  resume: "devam",
  gap: "kesinti",
  leave: "çıktı",
  done: "bitti",
  cancel: "iptal",
};

/** Görevin kamera kayıtları: zaman atlamalı parçaları sırayla, seçilen hızda oynatır. */
export function RecordingList({ runId }: { runId: string }) {
  const [recs, setRecs] = useState<TaskRecording[]>([]);
  const [segs, setSegs] = useState<Seg[]>([]);

  useEffect(() => {
    (async () => {
      const [{ data: r }, { data: p }] = await Promise.all([
        supabase.from("task_recordings").select("*").eq("run_id", runId).order("started_at"),
        supabase.from("task_proofs").select("*").eq("run_id", runId).eq("stage", "record").is("removed_at", null).order("seq"),
      ]);
      const list = (r ?? []) as TaskRecording[];
      setRecs(list);
      const ps = (p ?? []) as TaskProof[];
      if (!ps.length) return setSegs([]);
      const urls = await mediaUrls(ps.map((x) => x.path), 3600 * 3);
      const signed = urls.map((u) => ({ signedUrl: u }));
      setSegs(
        ps.map((x, i) => ({
          ...x,
          url: signed?.[i]?.signedUrl ?? undefined,
          startMs: x.started_at ? Date.parse(x.started_at) : 0,
          endMs: x.ended_at ? Date.parse(x.ended_at) : 0,
        }))
      );
    })();
  }, [runId]);

  if (!recs.length) return null;
  return (
    <div className="stack">
      {recs.map((r, i) => (
        <RecordingPlayer key={r.id} rec={r} segs={segs.filter((s) => s.recording_id === r.id)} label={recs.filter((x) => (x.camera === "screen") === (r.camera === "screen")).length > 1 ? `${r.attempt + 1}. deneme` : undefined} last={i === recs.length - 1} />
      ))}
    </div>
  );
}

function RecordingPlayer({ rec, segs, label, last }: { rec: TaskRecording; segs: Seg[]; label?: string; last: boolean }) {
  // İki oynatıcı: biri oynarken diğeri sıradaki parçayı önceden yükler (geçişte kesinti olmaz)
  const els = useRef<(HTMLVideoElement | null)[]>([null, null]);
  const idxRef = useRef(0);
  const video = useMemo(() => ({ get current() { return els.current[idxRef.current % 2]; } }), []);
  const [open, setOpen] = useState(last);
  const [big, setBig] = useState(false);
  const [idx, setIdx] = useState(0);
  // Gerçek zamanlı video (yeni kayıtlar) ya da zaman atlamalı (eski kayıtlar)
  const realtime = (rec.video_fps || 40) === (rec.capture_fps || 2);
  const [speed, setSpeed] = useState(realtime ? 10 : 20);
  const [playing, setPlaying] = useState(false);
  const [nowMs, setNowMs] = useState<number | null>(null);
  const seekTo = useRef<number | null>(null);
  // Video saniyesi başına gerçek saniye (2 kare/sn çekim, 40 kare/sn oynatma → 20)
  const ratio = (rec.video_fps || 40) / (rec.capture_fps || 2);
  const seg = segs[idx];

  const span = useMemo(() => {
    const start = Date.parse(rec.started_at);
    const end = rec.ended_at ? Date.parse(rec.ended_at) : Math.max(start + 1, ...segs.map((s) => s.endMs));
    return { start, end, len: Math.max(1, end - start) };
  }, [rec, segs]);

  // Tarayıcılar videoyu en fazla 2–16 kat hızlı oynatır; daha hızlısı için oynatırken ileri atlanır
  const want = speed / ratio;
  const applyRate = (v: HTMLVideoElement) => {
    try { v.playbackRate = Math.min(want, 2); } catch { v.playbackRate = 1; }
  };
  useEffect(() => {
    const v = video.current;
    if (v) applyRate(v);
  }, [speed, ratio, idx]);
  useEffect(() => {
    if (!playing || want <= 2) return;
    const step = (want - Math.min(want, 2)) * 0.25;
    const t = setInterval(() => {
      const v = video.current;
      if (!v || v.paused || v.seeking) return;
      if (v.duration && v.currentTime + step >= v.duration - 0.2) { v.currentTime = v.duration; return; }
      v.currentTime += step;
    }, 250);
    return () => clearInterval(t);
  }, [playing, want, idx]);

  // Parça değişince: önceden yüklenmiş oynatıcıya geç
  useEffect(() => {
    idxRef.current = idx;
    const v = video.current;
    const other = els.current[(idx + 1) % 2];
    if (other && !other.paused) other.pause();
    if (!v || v.readyState < 1) return;
    applyRate(v);
    if (seekTo.current != null) { v.currentTime = seekTo.current; seekTo.current = null; }
    else if (v.currentTime > 0 && v.ended) v.currentTime = 0;
    if (playing) v.play().catch(() => setPlaying(false));
  }, [idx]);

  function onLoaded(e: React.SyntheticEvent<HTMLVideoElement>) {
    const v = video.current;
    if (!v || e.currentTarget !== v) return;
    applyRate(v);
    if (seekTo.current != null) {
      v.currentTime = seekTo.current;
      seekTo.current = null;
    }
    if (playing) v.play().catch(() => setPlaying(false));
  }

  function onTime(e: React.SyntheticEvent<HTMLVideoElement>) {
    const v = video.current;
    if (v && e.currentTarget === v && seg) setNowMs(seg.startMs + v.currentTime * ratio * 1000);
  }

  function onEnded(e: React.SyntheticEvent<HTMLVideoElement>) {
    if (e.currentTarget !== video.current) return;
    if (idx + 1 < segs.length) setIdx(idx + 1);
    else setPlaying(false);
  }

  function toggle() {
    const v = video.current;
    if (!v) return;
    if (v.paused) {
      applyRate(v);
      v.play().then(() => setPlaying(true)).catch(() => setPlaying(false));
    } else {
      v.pause();
      setPlaying(false);
    }
  }

  function seekReal(ms: number) {
    let i = segs.findIndex((s) => ms >= s.startMs && ms < s.endMs);
    if (i < 0) i = segs.findIndex((s) => s.startMs >= ms);
    if (i < 0) return;
    const off = Math.max(0, (ms - segs[i].startMs) / 1000 / ratio);
    if (i === idx && video.current) video.current.currentTime = off;
    else {
      seekTo.current = off;
      setIdx(i);
    }
  }

  const pct = (ms: number) => `${(((ms - span.start) / span.len) * 100).toFixed(2)}%`;
  const evs = (rec.events ?? []).filter((e) => e.type !== "start");
  const alerts = evs.filter((e) => e.type === "gap" || e.type === "leave").length;
  const early = rec.status === "done" && rec.planned_seconds != null && rec.recorded_seconds < rec.planned_seconds - 30;

  return (
    <div className={`rec-box ${big && open ? "big" : ""}`}>
      <button className="rec-head" onClick={() => { if (big) setBig(false); else setOpen(!open); }}>
        <span>{rec.camera === "screen" ? "🎬" : "📹"} {label ? `${label} · ` : ""}{rec.camera === "screen" ? "Ekran kaydı" : "Kayıt"}</span>
        <span className={`small ${early || alerts ? "warn-text" : "muted"}`}>
          {mm(rec.recorded_seconds)}
          {rec.planned_seconds ? ` / ${mm(rec.planned_seconds)}` : ""}
          {rec.pause_count ? ` · ${rec.pause_count} mola (${mm(rec.paused_seconds)})` : ""}
          {alerts ? ` · ${alerts} kesinti` : ""}
          {rec.status === "recording" ? " · sürüyor" : rec.status === "paused" ? " · molada" : rec.status === "cancelled" ? " · iptal" : early ? " · erken bitti" : ""}
        </span>
      </button>
      {open && (
        <>
          {!segs.length ? (
            <p className="muted small">Kayıt parçaları henüz yüklenmedi (telefon internete bağlanınca gelir).</p>
          ) : (
            <>
              <div className="rec-video">
                {[0, 1].map((k) => {
                  // Bu oynatıcının parçası: etkinse şimdiki, değilse sıradaki
                  const si = idx % 2 === k ? idx : idx + 1;
                  const s = segs[si];
                  return (
                    <video
                      key={k}
                      ref={(el) => { els.current[k] = el; }}
                      src={s?.url}
                      muted={!(realtime && speed <= 2) || idx % 2 !== k}
                      playsInline
                      preload="auto"
                      style={idx % 2 === k ? undefined : { display: "none" }}
                      onLoadedMetadata={onLoaded}
                      onTimeUpdate={onTime}
                      onEnded={onEnded}
                      onClick={toggle}
                    />
                  );
                })}
                {nowMs != null && <span className="rec-clock">{clock(nowMs)}</span>}
                <button className="rec-size" onClick={(e) => { e.stopPropagation(); setBig(!big); }} aria-label={big ? "Küçült" : "Büyüt"} title={big ? "Küçült" : "Büyüt"}>
                  {big ? "✕" : "⤢"}
                </button>
                {!playing && (
                  <button className="rec-play" onClick={toggle} aria-label="Oynat">
                    ▶
                  </button>
                )}
              </div>
              <div
                className="rec-bar"
                onClick={(e) => {
                  const r = (e.currentTarget as HTMLDivElement).getBoundingClientRect();
                  seekReal(span.start + ((e.clientX - r.left) / r.width) * span.len);
                }}
              >
                {segs.map((s) => (
                  <span key={s.id} className="rec-seg" style={{ left: pct(s.startMs), width: `calc(${pct(s.endMs)} - ${pct(s.startMs)})` }} />
                ))}
                {evs
                  .filter((e) => e.type === "gap" || e.type === "leave")
                  .map((e, i) => (
                    <span key={i} className="rec-mark" style={{ left: pct(Date.parse(e.at)) }} title={EVENT_LABEL[e.type] ?? e.type} />
                  ))}
                {nowMs != null && <span className="rec-cursor" style={{ left: pct(nowMs) }} />}
              </div>
              <div className="row gap-xs wrap" style={{ alignItems: "center" }}>
                <span className="muted tiny">{clock(span.start)}</span>
                <span className="grow" />
                {(realtime ? [1, 2, 5, 10, 20, 40] : SPEEDS).map((x) => (
                  <button key={x} className={`chip small ${speed === x ? "on" : ""}`} onClick={() => setSpeed(x)}>
                    {x}x
                  </button>
                ))}
                <span className="grow" />
                <span className="muted tiny">{clock(span.end)}</span>
              </div>
            </>
          )}
          {evs.length > 0 && (
            <p className="muted tiny">
              {evs.map((e) => `${clock(Date.parse(e.at)).slice(0, 5)} ${EVENT_LABEL[e.type] ?? e.type}${e.note ? ` (${e.note})` : ""}`).join(" · ")}
            </p>
          )}
        </>
      )}
    </div>
  );
}
