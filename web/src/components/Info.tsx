import { useState } from "react";
import type { ReactNode } from "react";

export function Info({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <span className="info-wrap" data-open={open}>
      <button type="button" className="info-btn" aria-label="Bilgi" onClick={() => setOpen((v) => !v)}>
        i
      </button>
      <span className="info-popover" role="tooltip">{children}</span>
    </span>
  );
}
