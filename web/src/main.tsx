import React from "react";
import ReactDOM from "react-dom/client";
import { HashRouter } from "react-router-dom";
import App from "./App";
import "./styles.css";
import { applyTheme } from "./lib/theme";

applyTheme();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <HashRouter>
      <App />
    </HashRouter>
  </React.StrictMode>
);

if ("serviceWorker" in navigator && import.meta.env.PROD) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => {});
  });
}

// Yeni sürüm yayınlanınca panel kendiliğinden yenilensin (ana ekrandan açılan uygulama eski sürümde kalıyordu).
if (import.meta.env.PROD) {
  const mine = () => [...document.querySelectorAll<HTMLScriptElement>('script[type="module"][src]')].map((s) => new URL(s.src).pathname).find((p) => p.includes("/assets/"));
  const current = mine();
  let checking = false;
  const check = async () => {
    if (checking || !current || document.visibilityState !== "visible") return;
    checking = true;
    try {
      const html = await (await fetch("/", { cache: "no-store" })).text();
      const latest = html.match(/<script[^>]+type="module"[^>]+src="([^"]+)"/)?.[1];
      const typing = document.activeElement && ["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement.tagName);
      if (latest && new URL(latest, location.href).pathname !== current && !typing) location.reload();
    } catch {
      /* çevrimdışı */
    } finally {
      checking = false;
    }
  };
  document.addEventListener("visibilitychange", check);
  window.addEventListener("focus", check);
  setInterval(check, 5 * 60_000);
}
