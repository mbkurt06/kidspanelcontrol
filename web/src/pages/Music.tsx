import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useFamily } from "../lib/family";
import { errorText, supabase } from "../lib/supabase";
import type { Child } from "../lib/types";
import { Icon } from "../components/Icon";
import { Info } from "../components/Info";
import { RuleCard, WeekGrid, addRule } from "../components/RuleEditor";

/** Müzik: çocuk başına ne zaman çalabileceği, klasör ve müzik programı. */
export default function Music({ embeddedChildId }: { embeddedChildId?: string } = {}) {
  const fam = useFamily();
  const [params] = useSearchParams();
  const childParam = embeddedChildId ?? params.get("child");
  const [err, setErr] = useState("");
  const [openRule, setOpenRule] = useState<string | null>(null);
  const rules = fam.timeRules.filter((r) => r.kind === "music_off" || r.kind === "music_on");

  async function add() {
    try {
      const id = await addRule(fam.familyId, "music_off", null, "Gece müzik yok", "22:00", "07:00", [1, 2, 3, 4, 5, 6, 7]);
      await fam.reload();
      setOpenRule(id);
    } catch (e) {
      setErr(errorText(e));
    }
  }

  return (
    <div className={embeddedChildId ? "stack" : "page"}>
      {!embeddedChildId && <header className="page-head">
        <Link to="/rules" className="icon-btn" aria-label="Geri">
          <Icon name="back" />
        </Link>
        <h1>🎵 Müzik</h1>
        <span />
      </header>}
      {err && <p className="error">{err}</p>}
      <h2 className="section-title">Müzik <Info>Orbit müzik çaları süreden düşmez. Kilitliyken çalması için kilit ekranında Müzik açık olmalı.</Info></h2>
      {fam.visibleChildren.filter((c) => !childParam || c.id === childParam).map((c) => (
        <ChildMusic key={c.id} child={c} onErr={setErr} />
      ))}
      <section className="stack">
        <div className="row between">
          <h2 className="section-title">Müzik programı</h2>
          <button className="btn small" onClick={add}>
            <Icon name="plus" size={16} /> Kural
          </button>
        </div>
        <h2 className="section-title">Müzik programı <Info>“Programa göre” seçili çocuklarda geçerlidir. Müzik açık kuralı, aynı saatteki müzik kapalı kuralını geçersiz kılar.</Info></h2>
        {rules.length > 0 && (
          <div className="card">
            <WeekGrid rules={rules} onPick={(id) => setOpenRule(id)} />
          </div>
        )}
        {rules.map((r) => (
          <RuleCard key={r.id} r={r} kinds={["music_off", "music_on"]} open={openRule === r.id} onToggle={() => setOpenRule(openRule === r.id ? null : r.id)} onErr={setErr} />
        ))}
      </section>
    </div>
  );
}

function ChildMusic({ child, onErr }: { child: Child; onErr: (e: string) => void }) {
  const fam = useFamily();
  async function save(v: Record<string, unknown>) {
    onErr("");
    const { error } = await supabase.from("children").update(v).eq("id", child.id);
    if (error) onErr(errorText(error));
    fam.reload();
  }
  return (
    <div className="card">
      <b>
        <span className="dot" style={{ background: child.color, marginTop: 0 }} /> {child.name}
      </b>
      <MusicLibrary childId={child.id} />
      <label className="field">
        <span>Ne zaman çalabilir</span>
        <select value={child.music_mode ?? "rules"} onChange={(e) => save({ music_mode: e.target.value })}>
          <option value="rules">Programa göre</option>
          <option value="always">Her zaman</option>
          <option value="never">Hiç (müzik kapalı)</option>
        </select>
      </label>
      <label className="field">
        <span>Klasör</span>
        <select value={child.music_folder ?? ""} onChange={(e) => save({ music_folder: e.target.value || null })}>
          <option value="">Klasör seçilmedi (çalma kapalı)</option>
          {(child.music_folders ?? []).map((f) => (
            <option key={f} value={f}>
              📁 {f}
            </option>
          ))}
        </select>
      </label>
      {!(child.music_folders ?? []).length && <p className="muted tiny">Klasörler, çocuk telefonda Müzik ekranını ilk açtığında burada görünür.</p>}
    </div>
  );
}

/** Read-only parent view: children manage their own playlists on the phone. */
function MusicLibrary({ childId }: { childId: string }) {
  type Song = { track_key: string; file_name: string | null; missing: boolean };
  type Playlist = { id: string; name: string };
  const [songs, setSongs] = useState<Song[]>([]);
  const [playlists, setPlaylists] = useState<Playlist[]>([]);
  const [counts, setCounts] = useState<Record<string, number>>({});
  useEffect(() => {
    let active = true;
    async function load() {
      const [t, p] = await Promise.all([
        supabase.from("music_meta").select("track_key,file_name,missing").eq("child_id", childId).order("sort"),
        supabase.from("music_playlists").select("id,name").eq("child_id", childId).order("sort"),
      ]);
      if (!active) return;
      const ts = (t.data ?? []) as Song[];
      const ps = (p.data ?? []) as Playlist[];
      setSongs(ts);
      setPlaylists(ps);
      if (ps.length) {
        const e = await supabase.from("music_playlist_items").select("playlist_id").in("playlist_id", ps.map((x) => x.id));
        if (!active) return;
        const next: Record<string, number> = {};
        for (const row of e.data ?? []) next[row.playlist_id] = (next[row.playlist_id] ?? 0) + 1;
        setCounts(next);
      } else setCounts({});
    }
    load();
    return () => { active = false; };
  }, [childId]);
  return (
    <div className="stack">
      <div className="muted small">Müzik arşivi: {songs.length} dosya{songs.some((s) => s.missing) ? ` · ${songs.filter((s) => s.missing).length} eksik` : ""}</div>
      {playlists.length > 0 && (
        <div>
          <b>Çalma listeleri (yalnızca görüntüleme)</b>
          {playlists.map((p) => <div className="muted small" key={p.id}>🎵 {p.name} · {counts[p.id] ?? 0} şarkı</div>)}
        </div>
      )}
      {songs.some((s) => s.missing) && (
        <div>
          <b>Eksik dosyalar</b>
          {songs.filter((s) => s.missing).map((s) => <div className="muted small" key={s.track_key}>⚠️ {s.file_name ?? s.track_key}</div>)}
        </div>
      )}
    </div>
  );
}
