import { useEffect, useState } from "react";
import { createPortal } from "react-dom";

/** Fotoğrafı tam ekran gösterir: ‹ › ile sayfalar arası, dokununca yakınlaştır, ✕ ile kapat */
export default function Lightbox({ urls, start, title, onClose }: { urls: (string | undefined)[]; start: number; title?: string; onClose: () => void }) {
  const [i, setI] = useState(start);
  const [zoom, setZoom] = useState(false);
  const n = urls.length;
  const go = (d: number) => { setZoom(false); setI((x) => (x + d + n) % n); };
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      if (e.key === "ArrowRight") go(1);
      if (e.key === "ArrowLeft") go(-1);
    };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  });
  // Kaydırarak sayfa değiştir
  const [x0, setX0] = useState<number | null>(null);
  const url = urls[i];
  return createPortal(
    <div className="lightbox" role="dialog" aria-label="Fotoğraf">
      <div className="lb-top">
        <span className="small">{title ? `${title} · ` : ""}Sayfa {i + 1} / {n}</span>
        <span className="grow" />
        {url && <a href={url} target="_blank" rel="noreferrer" className="lb-btn" aria-label="Yeni sekmede aç">↗</a>}
        <button type="button" className="lb-btn" onClick={onClose} aria-label="Kapat">✕</button>
      </div>
      <div
        className={`lb-stage ${zoom ? "zoom" : ""}`}
        onTouchStart={(e) => !zoom && setX0(e.touches[0].clientX)}
        onTouchEnd={(e) => { if (x0 != null && !zoom) { const dx = e.changedTouches[0].clientX - x0; if (Math.abs(dx) > 60) go(dx < 0 ? 1 : -1); } setX0(null); }}
      >
        {url ? <img src={url} alt="" onClick={() => setZoom((z) => !z)} /> : <span className="muted">Yükleniyor…</span>}
      </div>
      {n > 1 && (
        <>
          <button type="button" className="lb-nav prev" onClick={() => go(-1)} aria-label="Önceki">‹</button>
          <button type="button" className="lb-nav next" onClick={() => go(1)} aria-label="Sonraki">›</button>
        </>
      )}
    </div>,
    document.body,
  );
}
