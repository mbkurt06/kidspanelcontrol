import { useEffect, useState } from "react";
import { createPortal } from "react-dom";

/** Kanıt fotoğrafı: dokununca panel içinde tam ekran açılır (OneDrive adresi tarayıcıda açılınca indirme sayfası boş kalıyordu). */
export function PhotoZoom({ src }: { src: string }) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const k = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [open]);
  return (
    <>
      <img src={src} alt="" onClick={() => setOpen(true)} style={{ cursor: "zoom-in" }} />
      {open &&
        createPortal(
          <div className="photo-zoom" onClick={() => setOpen(false)} role="dialog">
            <img src={src} alt="" />
            <button className="photo-zoom-x" aria-label="Kapat">×</button>
          </div>,
          document.body,
        )}
    </>
  );
}
