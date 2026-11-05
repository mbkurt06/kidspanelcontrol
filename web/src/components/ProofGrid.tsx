import { useState } from "react";
import { GalleryView, galleryOf, proofLabels } from "./PhotoZoom";

type P = { id: string; stage: string; media: string; attempt: number; url?: string | null; thumb?: string | null };

/**
 * Kanıtlar küçük kare resimler halinde, yan yana sütunlar: Öncesi | Sonrası | Ekran görüntüsü.
 * Reddedilen eski denemeler altta ayrı satır. Dokununca tam ekran galeri açılır.
 */
export function ProofGrid({ proofs, attempt, notes }: { proofs: P[]; attempt: number; notes?: { attempt: number; note: string | null }[] }) {
  const [open, setOpen] = useState<number | null>(null);
  const before = proofs.filter((p) => p.stage === "before");
  const now = proofs.filter((p) => p.stage !== "before" && p.stage !== "screenshot" && p.attempt === attempt);
  const shots = proofs.filter((p) => p.stage === "screenshot");
  const oldAttempts = [...new Set(proofs.filter((p) => p.stage !== "before" && p.stage !== "screenshot" && p.attempt < attempt).map((p) => p.attempt))].sort((a, b) => a - b);
  const ordered = [...before, ...now, ...shots, ...oldAttempts.flatMap((a) => proofs.filter((p) => p.stage !== "before" && p.stage !== "screenshot" && p.attempt === a))];
  const labels = proofLabels(ordered, attempt);
  const gallery = galleryOf(ordered, labels);
  const cell = (p: P) => {
    const gi = gallery.findIndex((g) => g.id === p.id);
    const n = (labels.get(p.id) ?? "").split(" ").pop();
    return (
      <button key={p.id} type="button" className="pg-cell" disabled={gi < 0} onClick={() => setOpen(gi)} aria-label={labels.get(p.id)}>
        {p.url ? (
          p.media === "video" && !p.thumb ? <span className="pg-video">▶</span> : <img src={p.thumb ?? p.url} alt="" loading="lazy" />
        ) : (
          <span className="pg-missing">…</span>
        )}
        {p.media === "video" && p.thumb && <span className="pg-play">▶</span>}
        <span className="pg-n">{n}</span>
      </button>
    );
  };
  const col = (title: string, list: P[], cls = "") =>
    list.length > 0 && (
      <div className={`pg-col ${cls}`}>
        <div className="pg-title">{title} <span>{list.length}</span></div>
        <div className="pg-grid">{list.map(cell)}</div>
      </div>
    );
  return (
    <div className="proof-grid">
      <div className="pg-cols">
        {col("Öncesi", before)}
        {col("Sonrası", now, "current")}
        {col("Ekran görüntüsü", shots)}
      </div>
      {oldAttempts.map((a) => {
        const list = proofs.filter((p) => p.stage !== "before" && p.stage !== "screenshot" && p.attempt === a);
        const note = notes?.find((x) => x.attempt === a)?.note;
        return (
          <div key={a} className="pg-old">
            {col(`${a + 1}. deneme`, list)}
            <p className="small warn-text">↩ {note ? `Reddedildi: ${note}` : "Reddedildi"}</p>
          </div>
        );
      })}
      {open != null && <GalleryView items={gallery} index={open} onClose={() => setOpen(null)} />}
    </div>
  );
}
