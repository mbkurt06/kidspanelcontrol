// Panel teması: otomatik (telefon/bilgisayar ayarına göre), açık ya da gece modu. Bu cihazda saklanır.
export type ThemeChoice = "auto" | "light" | "dark";
const KEY = "orbit.theme";

export function getTheme(): ThemeChoice {
  try {
    const v = localStorage.getItem(KEY);
    if (v === "light" || v === "dark") return v;
  } catch {
    /* depolama yoksa otomatik */
  }
  return "auto";
}

function effective(t: ThemeChoice): "light" | "dark" {
  if (t !== "auto") return t;
  return window.matchMedia?.("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

export function applyTheme(t: ThemeChoice = getTheme()) {
  const root = document.documentElement;
  if (t === "auto") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", t);
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute("content", effective(t) === "light" ? "#f4f5fb" : "#0f1224");
}

export function setTheme(t: ThemeChoice) {
  try {
    if (t === "auto") localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, t);
  } catch {
    /* yoksay */
  }
  applyTheme(t);
}

// Otomatikte sistem değişince tarayıcı rengi de güncellensin
window.matchMedia?.("(prefers-color-scheme: light)").addEventListener?.("change", () => applyTheme());
