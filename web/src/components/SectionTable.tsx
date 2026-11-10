import { useEffect, useMemo, useState } from "react";
import { useFamily } from "../lib/family";
import { errorText, supabase } from "../lib/supabase";
import { hhmm, minutesText } from "../lib/util";
import { RULE_LABEL, type Profile, type SecRule, type Section, type SectionRule } from "../lib/types";
import { Icon } from "./Icon";
import { Info } from "./Info";

type AppInfo = { package: string; label: string };

/** Hücre: bir bölümde bir grup / tek uygulama / "diğer uygulamalar" için kural. */
type CellTarget =
  | { kind: "group"; groupId: string; name: string }
  | { kind: "app"; pkg: string; name: string }
  | { kind: "default"; name: string };

/**
 * Kural tablosu: satırlar gruplar, "diğer uygulamalar" ve uygulama istisnaları; sütunlar bölümler.
 * Hücreye dokununca Açık / Süreli (sınırlı) / Kapalı seçilir.
 */
export function SectionTable({ profile, sections }: { profile: Profile; sections: Section[] }) {
  const fam = useFamily();
  const [apps, setApps] = useState<AppInfo[]>([]);
  const [edit, setEdit] = useState<{ section: Section; target: CellTarget } | null>(null);
  const [addPkg, setAddPkg] = useState("");
  const [extraPkgs, setExtraPkgs] = useState<string[]>([]);
  const [err, setErr] = useState("");

  useEffect(() => {
    supabase
      .from("child_apps")
      .select("package,label")
      .eq("approved", true)
      .eq("installed", true)
      .order("label")
      .then(({ data }) => {
        const seen = new Map<string, AppInfo>();
        for (const a of (data ?? []) as AppInfo[]) if (!seen.has(a.package)) seen.set(a.package, a);
        setApps([...seen.values()]);
      });
  }, []);

  const secIds = useMemo(() => new Set(sections.map((s) => s.id)), [sections]);
  const rules = fam.sectionRules.filter((r) => secIds.has(r.section_id));
  const exceptionPkgs = [...new Set([...rules.filter((r) => r.package).map((r) => r.package!), ...extraPkgs])];
  const appName = (p: string) => apps.find((a) => a.package === p)?.label ?? p;

  function ruleFor(sec: Section, t: CellTarget): SectionRule | undefined {
    if (t.kind === "group") return rules.find((r) => r.section_id === sec.id && r.group_id === t.groupId);
    if (t.kind === "app") return rules.find((r) => r.section_id === sec.id && r.package === t.pkg);
    return undefined;
  }

  function cellText(sec: Section, t: CellTarget) {
    if (t.kind === "default") return { text: RULE_LABEL[sec.default_rule], rule: sec.default_rule as SecRule, inherit: false };
    const r = ruleFor(sec, t);
    if (!r) {
      // Kuralı olmayan grup → bölümün varsayılanı; istisnası olmayan uygulama → grubunun kuralı
      return { text: "—", rule: null, inherit: true };
    }
    return { text: RULE_LABEL[r.rule] + (r.rule === "timed" && r.limit_minutes != null ? ` ${r.limit_minutes}dk` : ""), rule: r.rule, inherit: false };
  }

  const groupLimit = (gid: string) => fam.groupLimits.find((l) => l.profile_id === profile.id && l.group_id === gid)?.daily_minutes ?? null;

  async function setGroupLimit(gid: string, v: number | null) {
    setErr("");
    const q =
      v == null
        ? supabase.from("profile_group_limits").delete().eq("profile_id", profile.id).eq("group_id", gid)
        : supabase.from("profile_group_limits").upsert({ profile_id: profile.id, group_id: gid, daily_minutes: v });
    const { error } = await q;
    if (error) setErr(errorText(error));
    fam.reload();
  }

  async function removeException(pkg: string) {
    await supabase.from("section_rules").delete().in("section_id", [...secIds]).eq("package", pkg);
    setExtraPkgs((l) => l.filter((x) => x !== pkg));
    fam.reload();
  }

  const rows: CellTarget[] = [
    ...fam.groups.map((g) => ({ kind: "group" as const, groupId: g.id, name: g.name })),
    { kind: "default" as const, name: "Diğer uygulamalar" },
    ...exceptionPkgs.map((p) => ({ kind: "app" as const, pkg: p, name: appName(p) })),
  ];

  return (
    <div className="stack-s">
      {err && <p className="error">{err}</p>}
      <div className="rule-table-wrap">
        <table className="rule-table">
          <thead>
            <tr>
              <th />
              {sections.map((s) => (
                <th key={s.id}>
                  <span className="sec-name" style={{ borderColor: s.color }}>{s.name}</span>
                  <span className="muted tiny">
                    {hhmm(s.start_time)}–{hhmm(s.end_time)}
                  </span>
                  <span className="muted tiny">{s.kiosk ? "🔒 tam kilit" : s.default_rule === "blocked" ? "kilitli" : s.default_rule === "open" ? "serbest" : s.budget_minutes == null ? "sınırsız" : s.budget_minutes === 0 ? "süre yok" : minutesText(s.budget_minutes)}</span>
                </th>
              ))}
              <th className="muted tiny">Günde en fazla</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((t) => {
              const key = t.kind === "group" ? t.groupId : t.kind === "app" ? `app:${t.pkg}` : "default";
              const g = t.kind === "group" ? fam.groups.find((x) => x.id === t.groupId) : null;
              return (
                <tr key={key} className={t.kind === "default" ? "row-default" : t.kind === "app" ? "row-app" : ""}>
                  <th>
                    {g && <span className="dot" style={{ background: g.color }} />}
                    {t.kind === "app" && <span className="muted tiny">istisna · </span>}
                    {t.name}
                    {t.kind === "app" && (
                      <button className="icon-btn tiny-btn" aria-label="İstisnayı kaldır" onClick={() => removeException(t.pkg)}>
                        <Icon name="x" size={14} />
                      </button>
                    )}
                  </th>
                  {sections.map((s) => {
                    const c = cellText(s, t);
                    return (
                      <td key={s.id}>
                        <button className={`cell ${c.rule ?? "inherit"}`} onClick={() => setEdit({ section: s, target: t })}>
                          {c.text}
                        </button>
                      </td>
                    );
                  })}
                  <td>
                    {t.kind === "group" ? (
                      <input
                        className="mini"
                        type="number"
                        min={0}
                        placeholder="—"
                        defaultValue={groupLimit(t.groupId) ?? ""}
                        key={`${t.groupId}-${groupLimit(t.groupId)}`}
                        onBlur={(e) => {
                          const v = e.target.value === "" ? null : Number(e.target.value);
                          if (v !== groupLimit(t.groupId)) setGroupLimit(t.groupId, v);
                        }}
                        aria-label={`${t.name} günlük en fazla (dk)`}
                      />
                    ) : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="muted tiny"><Info>— kural yok demektir. Süreli uygulamalar bölüm süresinden düşer; hücreye sınır yazarsan o grup veya uygulama o bölümde en fazla o kadar kullanılır.</Info></p>
      <div className="row gap-s wrap">
        <select value={addPkg} onChange={(e) => setAddPkg(e.target.value)} aria-label="İstisna için uygulama">
          <option value="">Uygulamaya özel kural (istisna) ekle…</option>
          {apps
            .filter((a) => !exceptionPkgs.includes(a.package))
            .map((a) => (
              <option key={a.package} value={a.package}>
                {a.label}
              </option>
            ))}
        </select>
        <button
          className="btn small"
          disabled={!addPkg}
          onClick={() => {
            setExtraPkgs((l) => [...l, addPkg]);
            setAddPkg("");
          }}
        >
          <Icon name="plus" size={16} /> Ekle
        </button>
      </div>
      {edit && (
        <CellEditor
          section={edit.section}
          target={edit.target}
          current={ruleFor(edit.section, edit.target)}
          onClose={() => setEdit(null)}
          onSaved={() => {
            setEdit(null);
            fam.reload();
          }}
        />
      )}
    </div>
  );
}

function CellEditor({
  section,
  target,
  current,
  onClose,
  onSaved,
}: {
  section: Section;
  target: CellTarget;
  current: SectionRule | undefined;
  onClose: () => void;
  onSaved: () => void;
}) {
  const initial: SecRule | "inherit" = target.kind === "default" ? section.default_rule : current?.rule ?? "inherit";
  const [rule, setRule] = useState<SecRule | "inherit">(initial);
  const [limit, setLimit] = useState(current?.limit_minutes != null ? String(current.limit_minutes) : "");
  const [err, setErr] = useState("");

  async function save() {
    setErr("");
    let error = null;
    if (target.kind === "default") {
      ({ error } = await supabase.from("profile_sections").update({ default_rule: rule }).eq("id", section.id));
    } else if (rule === "inherit") {
      if (current) ({ error } = await supabase.from("section_rules").delete().eq("id", current.id));
    } else {
      const row = {
        section_id: section.id,
        group_id: target.kind === "group" ? target.groupId : null,
        package: target.kind === "app" ? target.pkg : null,
        rule,
        limit_minutes: rule === "timed" && limit !== "" ? Number(limit) : null,
      };
      if (current) ({ error } = await supabase.from("section_rules").update(row).eq("id", current.id));
      else ({ error } = await supabase.from("section_rules").insert(row));
    }
    if (error) return setErr(errorText(error));
    onSaved();
  }

  const options: (SecRule | "inherit")[] = target.kind === "default" ? ["open", "timed", "blocked"] : ["inherit", "open", "timed", "blocked"];
  const hint: Record<SecRule | "inherit", string> = {
    inherit: target.kind === "app" ? "Grubunun kuralı geçerli" : "Bölümün “Diğer uygulamalar” kuralı geçerli",
    open: "Süre sınırı yok: her şey açık, süreden düşmez",
    timed: "Bölüm süresinden düşer, süre bitince kapanır",
    blocked: "Bu bölümde açılmaz",
  };

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <h2>
          {target.name} · {section.name}
        </h2>
        <div className="stack-s">
          {options.map((o) => (
            <label className="radio-row" key={o}>
              <input type="radio" checked={rule === o} onChange={() => setRule(o)} />
              <span>
                <b>{o === "inherit" ? "Kural yok" : RULE_LABEL[o]}</b>
                <span className="muted small"> · {hint[o]}</span>
              </span>
            </label>
          ))}
        </div>
        {rule === "timed" && target.kind !== "default" && (
          <label className="field">
            <span>Bu bölümde en fazla (dk, isteğe bağlı)</span>
            <input type="number" min={0} value={limit} placeholder="bölüm süresi kadar" onChange={(e) => setLimit(e.target.value)} />
          </label>
        )}
        {err && <p className="error">{err}</p>}
        <div className="row gap-s">
          <button className="btn primary" onClick={save}>
            Kaydet
          </button>
          <button className="btn ghost" onClick={onClose}>
            Vazgeç
          </button>
        </div>
      </div>
    </div>
  );
}
