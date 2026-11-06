import { useFamily } from "../lib/family";

/** Herkes / çocuk seçimi — menüdeki seçimle ortak */
export function ChildChips() {
  const fam = useFamily();
  if (fam.children.length < 2) return null;
  const sel = fam.selectedChildId;
  return (
    <div className="chips">
      <button className={`chip-btn small-chip ${sel === "all" ? "on" : ""}`} onClick={() => fam.setSelectedChildId("all")}>Herkes</button>
      {fam.children.map((c) => (
        <button key={c.id} className={`chip-btn small-chip ${sel === c.id ? "on" : ""}`} onClick={() => fam.setSelectedChildId(c.id)}>
          <span className="dot" style={{ background: c.color, marginTop: 0 }} /> {c.name}
        </button>
      ))}
    </div>
  );
}
