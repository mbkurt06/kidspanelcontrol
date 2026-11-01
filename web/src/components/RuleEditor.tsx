import { useState } from "react";
import { DateField, TimeField } from "./DateTime";
import { useFamily } from "../lib/family";
import { errorText, supabase } from "../lib/supabase";
import { hhmm, todayISO } from "../lib/util";
import { mins } from "../lib/sections";
import { KIOSK_SCREENS, RULE_KIND, type KioskScreen, type RuleKind, type TimeRule } from "../lib/types";
import { Icon } from "./Icon";
import { DayPicker } from "./Windows";

const DAY_NAMES = ["Pzt", "Sal", "Çar", "Per", "Cum", "Cmt", "Paz"];

export function ScreenPicker({ value, onChange }: { value: KioskScreen[]; onChange: (v: KioskScreen[]) => void }) {
  return (
    <div className="row gap-xs wrap">
      {KIOSK_SCREENS.map(([k, label]) => {
        const on = value.includes(k);
        return (
          <button key={k} className={`chip small ${on ? "on" : ""}`} onClick={() => onChange(on ? value.filter((x) => x !== k) : [...value, k])}>
            {label}
          </button>
        );
      })}
    </div>
  );
}

export function ruleText(r: TimeRule) {
  const single = r.start_date && r.start_date === r.end_date;
  const days =
    single ? new Date(`${r.start_date}T12:00:00`).toLocaleDateString("tr-TR", { day: "numeric", month: "long", weekday: "short" })
    : r.days.length === 7 ? "her gün"
    : r.days.join() === "1,2,3,4,5" ? "hafta içi"
    : r.days.join() === "6,7" ? "hafta sonu"
    : r.days.map((d) => DAY_NAMES[d - 1]).join(" ");
  const range = !single && (r.start_date || r.end_date) ? ` · ${r.start_date ?? "…"} → ${r.end_date ?? "…"}` : "";
  return `${days} ${hhmm(r.start_time)}–${hhmm(r.end_time)}${range}`;
}

/** Haftalık takvim: her gün bir sütun, kurallar renkli bloklar. Bloğa dokununca o kural seçilir. */
export function WeekGrid({ rules, onPick }: { rules: TimeRule[]; onPick?: (id: string) => void }) {
  const blocks: { day: number; from: number; to: number; r: TimeRule }[] = [];
  for (const r of rules) {
    if (!r.active) continue;
    const a = mins(r.start_time);
    const b = mins(r.end_time);
    for (const d of r.days) {
      if (a < b) blocks.push({ day: d, from: a, to: b, r });
      else {
        blocks.push({ day: d, from: a, to: 1440, r });
        blocks.push({ day: (d % 7) + 1, from: 0, to: b, r });
      }
    }
  }
  return (
    <div className="week">
      <div className="week-hours">
        {[0, 6, 12, 18].map((h) => (
          <span key={h} style={{ top: `${(h / 24) * 100}%` }}>
            {String(h).padStart(2, "0")}
          </span>
        ))}
      </div>
      {DAY_NAMES.map((n, i) => (
        <div className="week-col" key={n}>
          <div className="week-day">{n}</div>
          <div className="week-body">
            {blocks
              .filter((b) => b.day === i + 1)
              .map((b, j) => (
                <button
                  key={j}
                  className="week-block"
                  title={`${b.r.name} · ${hhmm(b.r.start_time)}–${hhmm(b.r.end_time)}`}
                  style={{ top: `${(b.from / 1440) * 100}%`, height: `${((b.to - b.from) / 1440) * 100}%`, background: RULE_KIND[b.r.kind].color }}
                  onClick={() => onPick?.(b.r.id)}
                />
              ))}
          </div>
        </div>
      ))}
    </div>
  );
}

type Repeat = "every" | "weekdays" | "weekend" | "days" | "once";
function repeatOf(r: TimeRule): Repeat {
  if (r.start_date && r.start_date === r.end_date) return "once";
  const d = r.days.join();
  if (d === "1,2,3,4,5,6,7") return "every";
  if (d === "1,2,3,4,5") return "weekdays";
  if (d === "6,7") return "weekend";
  return "days";
}

/** Tek kuralın düzenleyicisi. `kinds` hangi türlerin seçilebileceğini belirler. */
export function RuleCard({ r, kinds, open, onToggle, onErr }: { r: TimeRule; kinds: RuleKind[]; open: boolean; onToggle: () => void; onErr: (e: string) => void }) {
  const fam = useFamily();
  const [name, setName] = useState(r.name);
  const [message, setMessage] = useState(r.message ?? "");
  const rep = repeatOf(r);

  async function patch(v: Partial<TimeRule>) {
    onErr("");
    const { error } = await supabase.from("time_rules").update(v).eq("id", r.id);
    if (error) onErr(errorText(error));
    fam.reload();
  }
  async function remove() {
    if (!confirm(`"${r.name}" silinsin mi?`)) return;
    await supabase.from("time_rules").delete().eq("id", r.id);
    fam.reload();
  }
  function setRepeat(v: Repeat) {
    if (v === "every") patch({ days: [1, 2, 3, 4, 5, 6, 7], ...(rep === "once" ? { start_date: null, end_date: null } : {}) });
    if (v === "weekdays") patch({ days: [1, 2, 3, 4, 5], ...(rep === "once" ? { start_date: null, end_date: null } : {}) });
    if (v === "weekend") patch({ days: [6, 7], ...(rep === "once" ? { start_date: null, end_date: null } : {}) });
    if (v === "days") patch({ ...(rep === "once" ? { start_date: null, end_date: null } : {}) });
    if (v === "once") {
      const d = todayISO();
      patch({ days: [1, 2, 3, 4, 5, 6, 7], start_date: d, end_date: d });
    }
  }
  const kidNames = r.child_ids.length ? fam.children.filter((c) => r.child_ids.includes(c.id)).map((c) => c.name).join(", ") : "Hepsi";

  return (
    <div className={`card rule-card ${r.active ? "" : "inactive"}`} id={`rule-${r.id}`}>
      <button className="rule-head" onClick={onToggle}>
        <span className="dot" style={{ background: RULE_KIND[r.kind].color, marginTop: 0 }} />
        <span className="grow">
          <b>{r.name}</b>
          <span className="muted small">
            {" "}
            · {RULE_KIND[r.kind].label} · {ruleText(r)} · {kidNames}
            {r.active ? "" : " · kapalı"}
          </span>
        </span>
        <Icon name="chevron" size={16} />
      </button>
      {open && (
        <div className="stack-s">
          <div className="row gap-s">
            <input className="grow" value={name} onChange={(e) => setName(e.target.value)} onBlur={() => name.trim() && name !== r.name && patch({ name: name.trim() })} aria-label="Ad" />
            <label className="check">
              <input type="checkbox" checked={r.active} onChange={(e) => patch({ active: e.target.checked })} /> Etkin
            </label>
            <button className="icon-btn" aria-label="Sil" onClick={remove}>
              <Icon name="trash" size={18} />
            </button>
          </div>
          <div className="row gap-xs wrap">
            {kinds.map((k) => (
              <button key={k} className={`chip small ${r.kind === k ? "on" : ""}`} onClick={() => patch({ kind: k })}>
                {RULE_KIND[k].label}
              </button>
            ))}
          </div>
          <p className="muted tiny">{RULE_KIND[r.kind].hint}</p>
          <div className="row gap-s" style={{ alignItems: "center" }}>
            <TimeField value={hhmm(r.start_time)} onCommit={(v) => v && v !== hhmm(r.start_time) && patch({ start_time: v })} label="Başlangıç" />
            <span className="muted">–</span>
            <TimeField value={hhmm(r.end_time)} onCommit={(v) => v && v !== hhmm(r.end_time) && patch({ end_time: v })} label="Bitiş" />
            {mins(r.end_time) <= mins(r.start_time) && <span className="muted tiny">ertesi gün biter</span>}
          </div>
          <label className="field">
            <span>Tekrar</span>
            <select value={rep} onChange={(e) => setRepeat(e.target.value as Repeat)}>
              <option value="every">Her gün</option>
              <option value="weekdays">Hafta içi</option>
              <option value="weekend">Hafta sonu</option>
              <option value="days">Seçili günler</option>
              <option value="once">Tek seferlik (bir gün)</option>
            </select>
          </label>
          {rep === "days" && <DayPicker value={r.days} onChange={(d) => patch({ days: d })} />}
          {rep === "once" ? (
            <DateField value={r.start_date ?? ""} onChange={(v) => v && patch({ start_date: v, end_date: v })} label="Gün" />
          ) : (
            <div className="grid2">
              <div className="field">
                <span>Başlangıç tarihi (isteğe bağlı)</span>
                <DateField clearable value={r.start_date ?? ""} onChange={(v) => patch({ start_date: v || null })} placeholder="Yok" />
              </div>
              <div className="field">
                <span>Bitiş tarihi (isteğe bağlı)</span>
                <DateField clearable value={r.end_date ?? ""} onChange={(v) => patch({ end_date: v || null })} placeholder="Yok" />
              </div>
            </div>
          )}
          <div className="row gap-xs wrap">
            <span className="small">Kime:</span>
            <button className={`chip small ${!r.child_ids.length ? "on" : ""}`} onClick={() => patch({ child_ids: [] })}>
              Hepsi
            </button>
            {fam.children.map((c) => (
              <button
                key={c.id}
                className={`chip small ${r.child_ids.includes(c.id) ? "on" : ""}`}
                onClick={() => patch({ child_ids: r.child_ids.includes(c.id) ? r.child_ids.filter((x) => x !== c.id) : [...r.child_ids, c.id] })}
              >
                {c.name}
              </button>
            ))}
          </div>
          {r.kind === "kiosk" && (
            <>
              <input value={message} onChange={(e) => setMessage(e.target.value)} onBlur={() => message !== (r.message ?? "") && patch({ message: message.trim() || null })} placeholder="Çocuğa mesaj (boş = varsayılan)" />
              <label className="check">
                <input type="checkbox" checked={r.screens == null} onChange={(e) => patch({ screens: e.target.checked ? null : ["tasks", "messages"] })} /> Açık Orbit ekranları: çocuğun varsayılanı
              </label>
              {r.screens != null && <ScreenPicker value={r.screens} onChange={(v) => patch({ screens: v })} />}
            </>
          )}
        </div>
      )}
    </div>
  );
}

/** Yeni kural ekler (varsayılan değerlerle) ve id'sini döner. */
export async function addRule(familyId: string | null, kind: RuleKind, childId: string | null, name: string, start: string, end: string, days: number[]) {
  const { data, error } = await supabase
    .from("time_rules")
    .insert({ family_id: familyId, name, kind, start_time: start, end_time: end, days, child_ids: childId ? [childId] : [] })
    .select("id")
    .single();
  if (error) throw error;
  return (data as { id: string }).id;
}
