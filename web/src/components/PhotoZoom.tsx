import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

export type GalleryItem = { id: string; src: string; label: string };

type ProofLike = { id: string; stage: string; media: string; attempt: number; url?: string | null };

/** Fotoğraf etiketleri: Öncesi 1, Öncesi 2, Sonrası 1, Ekran görüntüsü 1 …  (eski reddedilen denemeler "1. deneme · " ile başlar) */
export function proofLabels(proofs: ProofLike[], currentAttempt: number): Map<string, string> {
  const out = new Map<string, string>();
  const count = new Map<string, number>();
  const multi = new Set(proofs.filter((p) => p.stage !== "before").map((p) => p.attempt)).size > 1;
  for (const p of proofs) {
    const base = p.stage === "before" ? "Öncesi" : p.stage === "screenshot" ? "Ekran görüntüsü" : "Sonrası";
    const key = p.stage === "before" ? "before" : `${base}-${p.attempt}`;
    const n = (count.get(key) ?? 0) + 1;
    count.set(key, n);
    const pre = p.stage !== "before" && multi && p.attempt < currentAttempt ? `${p.attempt + 1}. deneme · ` : "";
    out.set(p.id, `${pre}${base} ${n}`);
  }
  return out;
}

export function galleryOf(proofs: ProofLike[], labels: Map<string, string>): GalleryItem[] {
  return proofs.filter((p) => p.media !== "video" && p.url).map((p) => ({ id: p.id, src: p.url as string, label: labels.get(p.id) ?? "" }));
}

/** Kanıt fotoğrafı: dokununca panel içinde tam ekran açılır; sağa-sola kaydırarak diğer fotoğraflara geçilir. */
export function PhotoZoom({ items, id }: { items: GalleryItem[]; id: string }) {
  const start = Math.max(0, items.findIndex((x) => x.id === id));
  const [open, setOpen] = useState<number | null>(null);
  const touch = useRef<{ x: number; y: number } | null>(null);
  const n = items.length;
  const go = (d: number) => setOpen((i) => (i == null ? i : (i + d + n) % n));
  useEffect(() => {
    if (open == null) return;
    const k = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(null);
      else if (e.key === "ArrowRight") go(1);
      else if (e.key === "ArrowLeft") go(-1);
    };
    window.addEventListener("keydown", k);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { window.removeEventListener("keydown", k); document.body.style.overflow = prev; };
  }, [open == null]);
  const item = open != null ? items[open] : null;
  return (
    <>
      <img src={items[start]?.src} alt="" onClick={() => setOpen(start)} style={{ cursor: "zoom-in" }} />
      {item &&
        createPortal(
          <div
            className="photo-zoom"
            role="dialog"
            onClick={() => setOpen(null)}
            onTouchStart={(e) => { touch.current = { x: e.touches[0].clientX, y: e.touches[0].clientY }; }}
            onTouchEnd={(e) => {
              const t = touch.current; touch.current = null;
              if (!t || e.touches.length) return;
              const dx = e.changedTouches[0].clientX - t.x, dy = e.changedTouches[0].clientY - t.y;
              if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5) { e.preventDefault(); go(dx < 0 ? 1 : -1); }
            }}
          >
            <div className="photo-zoom-top" onClick={(e) => e.stopPropagation()}>
              <b>{item.label}</b>
              {n > 1 && <span>{open! + 1}/{n}</span>}
            </div>
            <img key={item.id} src={item.src} alt="" onClick={(e) => e.stopPropagation()} />
            <button className="photo-zoom-x" aria-label="Kapat" onClick={() => setOpen(null)}>×</button>
            {n > 1 && (
              <>
                <button className="photo-zoom-nav prev" aria-label="Önceki" onClick={(e) => { e.stopPropagation(); go(-1); }}>‹</button>
                <button className="photo-zoom-nav next" aria-label="Sonraki" onClick={(e) => { e.stopPropagation(); go(1); }}>›</button>
              </>
            )}
          </div>,
          document.body,
        )}
    </>
  );
}
