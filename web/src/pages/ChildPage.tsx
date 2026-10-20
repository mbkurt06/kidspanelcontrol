import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useFamily } from "../lib/family";
import { errorText, supabase } from "../lib/supabase";
import { grantMinutes, sendCommand } from "../lib/actions";
import { dateText, minutesText, relTime, todayISO } from "../lib/util";
import { GROUP_HINT, GROUP_LABEL, WEEKDAYS_LONG, type AppGroup, type Assignment, type ChildApp, type DayOverride, type Device, type TimeGrant } from "../lib/types";
import { Icon } from "../components/Icon";

type Tab = "apps" | "program" | "time" | "device";

export default function ChildPage() {
  const { id } = useParams();
  const fam = useFamily();
  const child = fam.children.find((c) => c.id === id);
  const [tab, setTab] = useState<Tab>("apps");

  if (!child) return <div className="page"><p className="muted">Çocuk bulunamadı.</p></div>;

  return (
    <div className="page">
      <header className="page-head">
        <Link to="/" className="icon-btn" aria-label="Geri">
          <Icon name="back" />
        </Link>
        <h1>{child.name}</h1>
        <span />
      </header>
      <div className="segmented">
        {(
          [
            ["apps", "Uygulamalar"],
            ["program", "Program"],
            ["time", "Süre"],
            ["device", "Telefon"],
          ] as [Tab, string][]
        ).map(([k, l]) => (
          <button key={k} className={tab === k ? "on" : ""} onClick={() => setTab(k)}>
            {l}
          </button>
        ))}
      </div>
      {tab === "apps" && <AppsTab childId={child.id} />}
      {tab === "program" && <ProgramTab childId={child.id} />}
      {tab === "time" && <TimeTab childId={child.id} />}
      {tab === "device" && <DeviceTab childId={child.id} />}
    </div>
  );
}

// ---------------------------------------------------------------------------

const GROUPS: AppGroup[] = ["always_open", "unlimited", "timed", "blocked"];

function AppsTab({ childId }: { childId: string }) {
  const [apps, setApps] = useState<ChildApp[] | null>(null);
  const [q, setQ] = useState("");
  const [showSystem, setShowSystem] = useState(false);
  const [err, setErr] = useState("");

  const load = useCallback(async () => {
    const { data, error } = await supabase.from("child_apps").select("*").eq("child_id", childId).order("label");
    if (error) setErr(errorText(error));
    setApps((data ?? []) as ChildApp[]);
  }, [childId]);
  useEffect(() => {
    load();
  }, [load]);

  async function update(app: ChildApp, patch: Partial<ChildApp>) {
    setApps((list) => list?.map((a) => (a.package === app.package ? { ...a, ...patch } : a)) ?? null);
    const { error } = await supabase
      .from("child_apps")
      .update({ ...patch, updated_at: new Date().toISOString() })
      .eq("child_id", childId)
      .eq("package", app.package);
    if (error) {
      setErr(errorText(error));
      load();
    }
  }

  if (!apps) return <p className="muted">Yükleniyor…</p>;
  if (!apps.length)
    return (
      <div className="card soft">
        <p className="muted">Telefon eşleşince yüklü uygulamalar burada listelenir.</p>
      </div>
    );

  const filtered = apps.filter(
    (a) =>
      a.installed &&
      (showSystem || !a.is_system) &&
      (!q || a.label.toLowerCase().includes(q.toLowerCase()) || a.package.includes(q.toLowerCase()))
  );
  const pending = filtered.filter((a) => !a.approved);
  const approved = filtered.filter((a) => a.approved);

  return (
    <div className="stack">
      {err && <p className="error">{err}</p>}
      <input className="search" placeholder="Uygulama ara" value={q} onChange={(e) => setQ(e.target.value)} />
      {pending.length > 0 && (
        <div className="card attention">
          <h2>Onay bekleyen ({pending.length})</h2>
          <p className="muted small">Yeni yüklenen uygulamalar sen bir gruba atayana kadar kapalı kalır.</p>
          {pending.map((a) => (
            <div className="app-row" key={a.package}>
              <div className="grow">
                <b>{a.label}</b>
                <div className="muted tiny">{a.package}</div>
              </div>
              <select
                value=""
                onChange={(e) => update(a, { approved: true, app_group: e.target.value as AppGroup })}
                aria-label="Grup seç"
              >
                <option value="" disabled>
                  Grup seç
                </option>
                {GROUPS.map((g) => (
                  <option key={g} value={g}>
                    {GROUP_LABEL[g]}
                  </option>
                ))}
              </select>
            </div>
          ))}
        </div>
      )}
      {GROUPS.map((g) => {
        const list = approved.filter((a) => a.app_group === g);
        if (!list.length) return null;
        return (
          <div className="card" key={g}>
            <h2>
              {GROUP_LABEL[g]} <span className="muted small">· {GROUP_HINT[g]}</span>
            </h2>
            {list.map((a) => (
              <div className="app-row" key={a.package}>
                <div className="grow">
                  <b>{a.label}</b>
                  <div className="muted tiny">{a.package}</div>
                </div>
                {g === "timed" && (
                  <input
                    className="mini"
                    type="number"
                    min={0}
                    placeholder="sınır dk"
                    value={a.daily_limit_minutes ?? ""}
                    onChange={(e) => update(a, { daily_limit_minutes: e.target.value === "" ? null : Number(e.target.value) })}
                    aria-label="Günlük üst sınır (dakika)"
                  />
                )}
                <select value={a.app_group} onChange={(e) => update(a, { app_group: e.target.value as AppGroup })} aria-label="Grup">
                  {GROUPS.map((x) => (
                    <option key={x} value={x}>
                      {GROUP_LABEL[x]}
                    </option>
                  ))}
                </select>
              </div>
            ))}
          </div>
        );
      })}
      <label className="check">
        <input type="checkbox" checked={showSystem} onChange={(e) => setShowSystem(e.target.checked)} /> Sistem uygulamalarını da göster
      </label>
    </div>
  );
}

// ---------------------------------------------------------------------------

function ProgramTab({ childId }: { childId: string }) {
  const fam = useFamily();
  const [assign, setAssign] = useState<Record<number, string>>({});
  const [overrides, setOverrides] = useState<DayOverride[]>([]);
  const [err, setErr] = useState("");
  const [od, setOd] = useState({ day: todayISO(), profile_id: "", daily_minutes: "", note: "" });
  const [modeId, setModeId] = useState("");
  const [modeMin, setModeMin] = useState("30");
  const [msg, setMsg] = useState("");

  const load = useCallback(async () => {
    const [a, o] = await Promise.all([
      supabase.from("profile_assignments").select("*").eq("child_id", childId),
      supabase.from("day_overrides").select("*").eq("child_id", childId).gte("day", todayISO()).order("day"),
    ]);
    const m: Record<number, string> = {};
    for (const r of (a.data ?? []) as Assignment[]) m[r.weekday] = r.profile_id;
    setAssign(m);
    setOverrides((o.data ?? []) as DayOverride[]);
  }, [childId]);
  useEffect(() => {
    load();
  }, [load]);

  async function setDay(weekday: number, profileId: string) {
    setAssign({ ...assign, [weekday]: profileId });
    const { error } = profileId
      ? await supabase.from("profile_assignments").upsert({ child_id: childId, weekday, profile_id: profileId })
      : await supabase.from("profile_assignments").delete().eq("child_id", childId).eq("weekday", weekday);
    if (error) setErr(errorText(error));
  }

  async function addOverride() {
    setErr("");
    const { error } = await supabase.from("day_overrides").upsert(
      {
        child_id: childId,
        day: od.day,
        profile_id: od.profile_id || null,
        daily_minutes: od.daily_minutes === "" ? null : Number(od.daily_minutes),
        note: od.note || null,
      },
      { onConflict: "child_id,day" }
    );
    if (error) setErr(errorText(error));
    else {
      setOd({ ...od, daily_minutes: "", note: "" });
      load();
    }
  }

  async function startMode() {
    if (!modeId) return;
    const until = modeMin ? new Date(Date.now() + Number(modeMin) * 60000).toISOString() : null;
    try {
      await sendCommand(childId, "start_mode", { mode_id: modeId }, until);
      setMsg("Durum başlatılıyor");
    } catch (e) {
      setErr(errorText(e));
    }
  }

  return (
    <div className="stack">
      {err && <p className="error">{err}</p>}
      <div className="card">
        <h2>Haftalık program</h2>
        <p className="muted small">Her gün için bir kural profili seç. Profilleri Kurallar sekmesinden düzenleyebilirsin.</p>
        {WEEKDAYS_LONG.map((d, i) => (
          <div className="app-row" key={d}>
            <span className="grow">{d}</span>
            <select value={assign[i + 1] ?? ""} onChange={(e) => setDay(i + 1, e.target.value)}>
              <option value="">— Profil yok —</option>
              {fam.profiles.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} · {minutesText(p.daily_minutes)}
                </option>
              ))}
            </select>
          </div>
        ))}
      </div>

      <div className="card">
        <h2>Durumu şimdi başlat</h2>
        <p className="muted small">Örneğin "Oyun zamanı"nı programı beklemeden şimdi açabilirsin.</p>
        <div className="row gap-s wrap">
          <select value={modeId} onChange={(e) => setModeId(e.target.value)} className="grow">
            <option value="">Durum seç</option>
            {fam.modes.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
          <select value={modeMin} onChange={(e) => setModeMin(e.target.value)}>
            <option value="15">15 dk</option>
            <option value="30">30 dk</option>
            <option value="60">1 saat</option>
            <option value="120">2 saat</option>
            <option value="">Ben bitirene kadar</option>
          </select>
        </div>
        <div className="row gap-s">
          <button className="btn primary" onClick={startMode} disabled={!modeId}>
            <Icon name="play" size={16} /> Başlat
          </button>
          <button
            className="btn"
            onClick={async () => {
              try {
                await sendCommand(childId, "end_mode");
                setMsg("Elle başlatılan durum bitiriliyor");
              } catch (e) {
                setErr(errorText(e));
              }
            }}
          >
            <Icon name="stop" size={16} /> Bitir
          </button>
        </div>
        {msg && <p className="ok small">{msg}</p>}
      </div>

      <div className="card">
        <h2>Gün istisnaları</h2>
        <p className="muted small">Tek bir gün için başka profil veya farklı günlük süre (örneğin bayram günü 3 saat).</p>
        {overrides.map((o) => (
          <div className="app-row" key={o.id}>
            <div className="grow">
              <b>{dateText(o.day)}</b>
              <div className="muted tiny">
                {o.profile_id ? fam.profiles.find((p) => p.id === o.profile_id)?.name ?? "Profil" : "Kendi profili"}
                {o.daily_minutes != null ? ` · ${minutesText(o.daily_minutes)}` : ""}
                {o.note ? ` · ${o.note}` : ""}
              </div>
            </div>
            <button
              className="icon-btn"
              aria-label="Sil"
              onClick={async () => {
                await supabase.from("day_overrides").delete().eq("id", o.id);
                load();
              }}
            >
              <Icon name="trash" size={18} />
            </button>
          </div>
        ))}
        <div className="grid2">
          <label className="field">
            <span>Gün</span>
            <input type="date" value={od.day} onChange={(e) => setOd({ ...od, day: e.target.value })} />
          </label>
          <label className="field">
            <span>Profil</span>
            <select value={od.profile_id} onChange={(e) => setOd({ ...od, profile_id: e.target.value })}>
              <option value="">Değişmesin</option>
              {fam.profiles.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Günlük süre (dk)</span>
            <input type="number" min={0} value={od.daily_minutes} onChange={(e) => setOd({ ...od, daily_minutes: e.target.value })} placeholder="değişmesin" />
          </label>
          <label className="field">
            <span>Not</span>
            <input value={od.note} onChange={(e) => setOd({ ...od, note: e.target.value })} placeholder="Bayram" />
          </label>
        </div>
        <button className="btn" onClick={addOverride}>
          İstisna ekle
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

function TimeTab({ childId }: { childId: string }) {
  const fam = useFamily();
  const [grants, setGrants] = useState<TimeGrant[]>([]);
  const [minutes, setMinutes] = useState("20");
  const [when, setWhen] = useState<"today" | "tomorrow" | "date" | "child">("today");
  const [date, setDate] = useState(todayISO("Europe/Berlin", 1));
  const [expires, setExpires] = useState("");
  const [note, setNote] = useState("");
  const [err, setErr] = useState("");
  const [msg, setMsg] = useState("");

  const load = useCallback(async () => {
    const { data } = await supabase
      .from("time_grants")
      .select("*")
      .eq("child_id", childId)
      .order("created_at", { ascending: false })
      .limit(30);
    setGrants((data ?? []) as TimeGrant[]);
  }, [childId]);
  useEffect(() => {
    load();
  }, [load]);

  const today = todayISO();
  const live = useMemo(
    () => grants.filter((g) => (g.valid_on && g.valid_on >= today) || (!g.valid_on && !g.activated_on && (!g.expires_on || g.expires_on >= today)) || g.activated_on === today),
    [grants, today]
  );

  async function give() {
    setErr("");
    setMsg("");
    const m = Number(minutes);
    if (!m) return;
    const validOn = when === "today" ? today : when === "tomorrow" ? todayISO("Europe/Berlin", 1) : when === "date" ? date : null;
    try {
      await grantMinutes(childId, m, { validOn, expiresOn: when === "child" ? expires || null : null, note: note || undefined });
      setMsg(`${minutesText(m)} verildi`);
      setNote("");
      load();
      fam.reload();
    } catch (e) {
      setErr(errorText(e));
    }
  }

  return (
    <div className="stack">
      <div className="card">
        <h2>Ekstra süre ver</h2>
        <div className="row gap-s wrap">
          {["10", "15", "20", "30", "45", "60"].map((m) => (
            <button key={m} className={`chip ${minutes === m ? "on" : ""}`} onClick={() => setMinutes(m)}>
              {m} dk
            </button>
          ))}
          <input className="mini" type="number" min={1} value={minutes} onChange={(e) => setMinutes(e.target.value)} aria-label="Dakika" />
        </div>
        <label className="field">
          <span>Ne zaman geçerli</span>
          <select value={when} onChange={(e) => setWhen(e.target.value as typeof when)}>
            <option value="today">Bugün</option>
            <option value="tomorrow">Yarın</option>
            <option value="date">Belirli bir gün</option>
            <option value="child">Çocuk istediği gün kullansın</option>
          </select>
        </label>
        {when === "date" && (
          <label className="field">
            <span>Gün</span>
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </label>
        )}
        {when === "child" && (
          <label className="field">
            <span>Son kullanma (isteğe bağlı)</span>
            <input type="date" value={expires} onChange={(e) => setExpires(e.target.value)} />
          </label>
        )}
        <label className="field">
          <span>Not</span>
          <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="İyi davrandın" />
        </label>
        {err && <p className="error">{err}</p>}
        {msg && <p className="ok">{msg}</p>}
        <button className="btn primary" onClick={give}>
          Süre ver
        </button>
        <button
          className="btn ghost"
          onClick={async () => {
            const m = Number(minutes);
            if (!m) return;
            try {
              await sendCommand(childId, "adjust_minutes", { minutes: -m });
              setMsg(`Bugünden ${minutesText(m)} düşülüyor`);
            } catch (e) {
              setErr(errorText(e));
            }
          }}
        >
          Bugünden {minutes} dk düş
        </button>
      </div>
      <div className="card">
        <h2>Süre cüzdanı</h2>
        {!live.length && <p className="muted small">Bekleyen ekstra süre yok.</p>}
        {live.map((g) => (
          <div className="app-row" key={g.id}>
            <div className="grow">
              <b>{minutesText(g.minutes)}</b>
              <div className="muted tiny">
                {g.valid_on ? dateText(g.valid_on) : g.activated_on ? `kullanıldı · ${dateText(g.activated_on)}` : `çocuk seçecek${g.expires_on ? ` · son ${dateText(g.expires_on)}` : ""}`}
                {g.note ? ` · ${g.note}` : ""}
              </div>
            </div>
            {!g.activated_on && (
              <button
                className="icon-btn"
                aria-label="Geri al"
                onClick={async () => {
                  await supabase.from("time_grants").delete().eq("id", g.id);
                  load();
                  fam.reload();
                }}
              >
                <Icon name="trash" size={18} />
              </button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

function DeviceTab({ childId }: { childId: string }) {
  const fam = useFamily();
  const nav = useNavigate();
  const child = fam.children.find((c) => c.id === childId)!;
  const [devices, setDevices] = useState<Device[]>([]);
  const [code, setCode] = useState("");
  const [err, setErr] = useState("");
  const [name, setName] = useState(child.name);
  const [color, setColor] = useState(child.color);

  const load = useCallback(async () => {
    const { data } = await supabase.from("devices").select("*").eq("child_id", childId).order("created_at", { ascending: false });
    setDevices((data ?? []) as Device[]);
  }, [childId]);
  useEffect(() => {
    load();
  }, [load]);

  async function newCode() {
    setErr("");
    const { data, error } = await supabase.rpc("create_pairing_code", { p_kind: "child_phone", p_child_id: childId });
    if (error) setErr(errorText(error));
    else setCode(String(data));
  }

  return (
    <div className="stack">
      {err && <p className="error">{err}</p>}
      <div className="card">
        <h2>Telefonu eşleştir</h2>
        <p className="muted small">
          Orbit çocuğun telefonuna kurulunca eşleştirme kodunu ister. Kod 15 dakika geçerli ve tek kullanımlık.
        </p>
        {code ? (
          <div className="code">{code.slice(0, 4)} {code.slice(4)}</div>
        ) : (
          <button className="btn primary" onClick={newCode}>
            <Icon name="phone" size={18} /> Eşleştirme kodu al
          </button>
        )}
      </div>
      <div className="card">
        <h2>Eşleşen telefonlar</h2>
        {!devices.length && <p className="muted small">Henüz telefon yok.</p>}
        {devices.map((d) => (
          <div className="app-row" key={d.id}>
            <div className="grow">
              <b>{d.model ?? d.label}</b>
              <div className="muted tiny">
                {d.os_version ? `Android ${d.os_version} · ` : ""}
                {d.app_version ? `Orbit ${d.app_version} · ` : ""}
                {d.is_device_owner === false ? "device owner DEĞİL · " : ""}
                son görülme {relTime(d.last_seen_at)}
              </div>
            </div>
            {d.status === "active" ? (
              <button
                className="btn small danger-text"
                onClick={async () => {
                  if (!confirm("Bu telefonun bağlantısı kesilsin mi? Telefon kuralları almayı durdurur.")) return;
                  await supabase.from("devices").update({ status: "revoked" }).eq("id", d.id);
                  load();
                }}
              >
                Bağlantıyı kes
              </button>
            ) : (
              <span className="pill quiet">kesildi</span>
            )}
          </div>
        ))}
      </div>
      <div className="card">
        <h2>Çocuk bilgileri</h2>
        <label className="field">
          <span>Ad</span>
          <input value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label className="field">
          <span>Renk</span>
          <input type="color" value={color} onChange={(e) => setColor(e.target.value)} />
        </label>
        <button
          className="btn"
          onClick={async () => {
            const { error } = await supabase.from("children").update({ name, color }).eq("id", childId);
            if (error) setErr(errorText(error));
            else fam.reload();
          }}
        >
          Kaydet
        </button>
        <button
          className="btn ghost danger-text"
          onClick={async () => {
            if (!confirm(`${child.name} ve tüm kayıtları silinsin mi? Bu geri alınamaz.`)) return;
            await supabase.from("children").delete().eq("id", childId);
            await fam.reload();
            nav("/");
          }}
        >
          Çocuğu sil
        </button>
      </div>
    </div>
  );
}
