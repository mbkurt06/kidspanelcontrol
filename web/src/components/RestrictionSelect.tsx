import { useFamily } from "../lib/family";
import type { Mode } from "../lib/types";

/** Eski kayıtlarda ikon adı yazılıydı (moon, book…) */
const ICON_NAMES: Record<string, string> = { moon: "🌙", book: "📚", pause: "⏸️", lock: "🔒", timer: "⏱", sun: "☀️", game: "🎮" };
export const modeIcon = (m: Pick<Mode, "icon">) => (m.icon ? ICON_NAMES[m.icon] ?? m.icon : "🎯");

export type RestrictionValue = { restriction: "none" | "limit" | "kiosk" | "mode"; modeId: string | null };

const BUILTIN_TEXT: Record<string, string> = {
  timed: "sadece günlük süreyle",
  blocked: "sadece her zaman açık uygulamalar",
  kiosk: "sadece Orbit",
};

/**
 * Görev / grup kısıtlaması: kullanım profillerinden biri seçilir.
 * Hazır Kilitli = "limit", Tam kilit = "kiosk" (eski değerlerle uyumlu); Serbest = kısıtlama yok; diğerleri profil.
 */
export function RestrictionSelect({ value, onChange }: { value: RestrictionValue; onChange: (v: RestrictionValue) => void }) {
  const fam = useFamily();
  const modes = [...fam.modes].sort((a, b) => (a.builtin ? 0 : 1) - (b.builtin ? 0 : 1) || (a.priority ?? 0) - (b.priority ?? 0));
  const free = modes.find((m) => m.builtin === "open");
  const v = value.restriction === "mode" && value.modeId ? `mode:${value.modeId}` : value.restriction;
  return (
    <select
      value={v}
      onChange={(e) => {
        const x = e.target.value;
        if (x.startsWith("mode:")) onChange({ restriction: "mode", modeId: x.slice(5) });
        else onChange({ restriction: x as RestrictionValue["restriction"], modeId: null });
      }}
    >
      <option value="none">{free ? `${modeIcon(free)} ${free.name}` : "🟢 Serbest"} — telefonu kısıtlama</option>
      {modes.filter((m) => m.builtin !== "open").map((m) => {
        const key = m.builtin === "blocked" ? "limit" : m.builtin === "kiosk" ? "kiosk" : `mode:${m.id}`;
        const hint = m.builtin ? BUILTIN_TEXT[m.builtin] : null;
        return <option key={m.id} value={key}>{modeIcon(m)} {m.name}{hint ? ` — ${hint}` : ""}</option>;
      })}
    </select>
  );
}
