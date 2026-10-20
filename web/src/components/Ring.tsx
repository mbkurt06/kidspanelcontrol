// Kalan süre halkası.
export function Ring({ value, max, color, size = 76, children }: { value: number; max: number; color: string; size?: number; children?: React.ReactNode }) {
  const r = (size - 10) / 2;
  const c = 2 * Math.PI * r;
  const frac = max > 0 ? Math.max(0, Math.min(1, value / max)) : 0;
  return (
    <div className="ring" style={{ width: size, height: size }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        <circle cx={size / 2} cy={size / 2} r={r} stroke="var(--line)" strokeWidth={7} fill="none" />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          stroke={color}
          strokeWidth={7}
          fill="none"
          strokeLinecap="round"
          strokeDasharray={`${c * frac} ${c}`}
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
        />
      </svg>
      <div className="ring-label">{children}</div>
    </div>
  );
}
