import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ReactNode } from "react";

export function Info({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const [position, setPosition] = useState({ left: 12, top: 12 });
  useLayoutEffect(() => {
    if (!open || !buttonRef.current) return;
    const place = () => {
      const r = buttonRef.current!.getBoundingClientRect();
      const width = Math.min(280, window.innerWidth - 24);
      const left = Math.max(12, Math.min(r.left, window.innerWidth - width - 12));
      const below = r.bottom + 8;
      const top = below + 180 <= window.innerHeight ? below : Math.max(12, r.top - 188);
      setPosition({ left, top });
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open]);
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
      <button ref={buttonRef} type="button" className="info-btn" aria-label="Bilgi" onClick={(e) => { e.stopPropagation(); setOpen((v) => !v); }}>
        i
      </button>
      <span className="info-popover" role="tooltip" style={{ left: position.left, top: position.top }} onClick={(e) => e.stopPropagation()}>{children}</span>
    </span>
  );
}
