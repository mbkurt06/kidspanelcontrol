import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

export type GalleryItem = { id: string; src: string; thumb?: string; label: string; video?: boolean };

type ProofLike = { id: string; stage: string; media: string; attempt: number; url?: string | null; thumb?: string | null };

/** Etiketler: Öncesi 1, Öncesi 2, Sonrası 1, Ekran görüntüsü 1 …  (eski reddedilen denemeler "1. deneme · " ile başlar) */
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
  return proofs.filter((p) => p.url).map((p) => ({ id: p.id, src: p.url as string, thumb: p.thumb ?? undefined, label: labels.get(p.id) ?? "", video: p.media === "video" }));
}

/** Tam ekran galeri: sağa-sola kaydırarak geçiş, üstte etiket ve sıra */
export function GalleryView({ items, index, onClose }: { items: GalleryItem[]; index: number; onClose: () => void }) {
  const [i, setI] = useState(index);
  const touch = useRef<{ x: number; y: number } | null>(null);
  const n = items.length;
  const go = (d: number) => setI((x) => (x + d + n) % n);
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      else if (e.key === "ArrowRight") go(1);
      else if (e.key === "ArrowLeft") go(-1);
    };
    window.addEventListener("keydown", k);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { window.removeEventListener("keydown", k); document.body.style.overflow = prev; };
  }, []);
  const item = items[i];
  if (!item) return null;
  return createPortal(
    <div
      className="photo-zoom"
      role="dialog"
      onClick={onClose}
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
        {n > 1 && <span>{i + 1}/{n}</span>}
      </div>
      {item.video ? (
        <video key={item.id} src={item.src} controls playsInline autoPlay onClick={(e) => e.stopPropagation()} />
      ) : (
        <img key={item.id} src={item.src} alt="" onClick={(e) => e.stopPropagation()} />
      )}
      <button className="photo-zoom-x" aria-label="Kapat" onClick={onClose}>×</button>
      {n > 1 && (
        <>
          <button className="photo-zoom-nav prev" aria-label="Önceki" onClick={(e) => { e.stopPropagation(); go(-1); }}>‹</button>
          <button className="photo-zoom-nav next" aria-label="Sonraki" onClick={(e) => { e.stopPropagation(); go(1); }}>›</button>
        </>
      )}
    </div>,
    document.body,
  );
}
