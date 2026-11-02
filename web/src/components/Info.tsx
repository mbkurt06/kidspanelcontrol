import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";

export function Info({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const closeOutside = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const closeEscape = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("pointerdown", closeOutside);
    document.addEventListener("keydown", closeEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOutside);
      document.removeEventListener("keydown", closeEscape);
    };
  }, [open]);
  return (
    <span className="info-wrap" data-open={open} ref={ref}>
      <button type="button" className="info-btn" aria-label="Bilgi" onClick={() => setOpen((v) => !v)}>
        i
      </button>
      <span className="info-popover" role="tooltip" onClick={(e) => e.stopPropagation()}>{children}</span>
    </span>
  );
}
