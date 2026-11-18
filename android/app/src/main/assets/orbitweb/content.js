/* Orbit Web: YouTube sadeleştirme, izinsiz bağlantı engeli, kasadan giriş. Uygulama ile "orbit" kanalından konuşur. */
(() => {
  const send = (m) => browser.runtime.sendNativeMessage("orbit", m).catch(() => null);
  let cfg = null;

  const css = (text) => {
    const s = document.createElement("style");
    s.textContent = text;
    (document.head || document.documentElement).appendChild(s);
  };

  // --- YouTube: sadece oynatıcı kalsın ---
  const YT_CSS = `
    html, body { background: #000 !important; overflow: hidden !important; }
    body * { visibility: hidden !important; }
    .html5-video-player, .html5-video-player *, #player-container-id, #player-container-id *,
    ytm-consent-bump-v2-renderer, ytm-consent-bump-v2-renderer *, .consent-bump-v2-lightbox, .consent-bump-v2-lightbox *,
    .ytp-ad-skip-button-container, .ytp-ad-skip-button-container *, .ytp-skip-ad, .ytp-skip-ad * { visibility: visible !important; }
    .html5-video-player { position: fixed !important; top: 0 !important; left: 0 !important; width: 100vw !important; height: 100vh !important; z-index: 2147483646 !important; }
    .html5-video-player video { object-fit: contain !important; width: 100% !important; height: 100% !important; left: 0 !important; top: 0 !important; }
    .ytp-ce-element, .ytp-endscreen-content, .ytp-pause-overlay, .ytp-suggested-action, .ytp-cards-teaser, .ytp-cards-button,
    .ytp-title-channel, .ytp-title-link, .ytp-youtube-button, .ytp-watermark, .ytp-share-button, .ytp-overflow-button,
    .ytm-autonav-toggle-button-container, .ytp-autonav-toggle-button, .ytmVideoInfoVideoTitle, a.ytp-title-fullerscreen-link { display: none !important; }
  `;

  function allowedHref(href) {
    if (!cfg) return true;
    if (cfg.parent) return true;
    try {
      const u = new URL(href, location.href);
      if (u.protocol === "javascript:") return true;
      if (u.href.split("#")[0] === location.href.split("#")[0]) return true;
      if (cfg.yt) {
        const v = u.searchParams.get("v");
        const l = u.searchParams.get("list");
        if (l && cfg.lists.includes(l)) return true;
        return !!(v && cfg.videos.includes(v));
      }
      const h = u.hostname.toLowerCase();
      return cfg.hosts.some((d) => h === d || h.endsWith("." + d));
    } catch (e) {
      return false;
    }
  }

  // İzinli olmayan bağlantıya tıklama: hiçbir şey olmaz (reklamlar dahil)
  document.addEventListener("click", (ev) => {
    const a = ev.target && ev.target.closest ? ev.target.closest("a[href]") : null;
    if (!a) return;
    if (!allowedHref(a.getAttribute("href"))) {
      ev.preventDefault();
      ev.stopImmediatePropagation();
      send({ t: "blocked", url: new URL(a.getAttribute("href"), location.href).href });
    }
  }, true);

  // window.open ile yeni pencere: izinliyse aynı sayfada aç
  try {
    const page = window.wrappedJSObject;
    exportFunction(function (url) {
      if (url && allowedHref(String(url))) location.href = new URL(String(url), location.href).href;
      else if (url) send({ t: "blocked", url: String(url) });
      return null;
    }, page, { defineAs: "open" });
  } catch (e) {}

  // --- Video bitti / sıradaki ---
  function watchVideo() {
    const v = document.querySelector("video");
    if (!v || v.__orbit) return;
    v.__orbit = true;
    v.addEventListener("ended", () => send({ t: "ended", url: location.href }));
  }

  // --- Kasadan giriş ---
  const tries = () => {
    try { return JSON.parse(sessionStorage.getItem("__orbitLogin") || "[]").filter((t) => Date.now() - t < 120000); } catch (e) { return []; }
  };
  const mark = () => { try { const t = tries(); t.push(Date.now()); sessionStorage.setItem("__orbitLogin", JSON.stringify(t)); } catch (e) {} };
  const visible = (el) => !!(el && el.offsetParent !== null && !el.disabled && el.type !== "hidden");
  const setVal = (el, val) => {
    const proto = Object.getPrototypeOf(el);
    const desc = Object.getOwnPropertyDescriptor(proto, "value") || Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
    el.focus();
    if (desc && desc.set) desc.set.call(el, val); else el.value = val;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    el.blur();
  };
  const USER_SEL = "input[autocomplete='username'], input[autocomplete='email'], input[type='email'], input[name*='user' i], input[name*='mail' i], input[name*='login' i], input[id*='user' i], input[id*='mail' i], input[id*='login' i]";

  function guard(pw) {
    if (pw.__orbitGuard) return;
    pw.__orbitGuard = true;
    for (const e of ["copy", "cut", "dragstart", "contextmenu"]) pw.addEventListener(e, (x) => x.preventDefault(), true);
    // "Şifreyi göster" düğmesi şifreyi açamasın
    new MutationObserver(() => { if (pw.type !== "password") pw.type = "password"; }).observe(pw, { attributes: true, attributeFilter: ["type"] });
  }

  function submit(form, near) {
    const btn = (form || document).querySelector("button[type='submit'], input[type='submit'], button:not([type])")
      || [...document.querySelectorAll("button, [role='button']")].find((b) => visible(b) && /giri|log ?in|sign ?in|anmeld|weiter|next|ileri|devam/i.test(b.textContent || b.value || ""));
    if (btn) { btn.click(); return; }
    if (form && form.requestSubmit) form.requestSubmit();
    else if (near) near.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  }

  let filling = false;
  async function login() {
    if (!cfg || cfg.login === "off" || cfg.parent || filling) return;
    const pw = [...document.querySelectorAll("input[type='password']")].find(visible);
    const user = [...document.querySelectorAll(USER_SEL)].find((u) => visible(u) && u.type !== "password");
    if (pw) guard(pw);
    if (!pw && !user) return;
    if ((pw && pw.value) || (!pw && user.value)) return;
    if (tries().length >= 2) return;
    filling = true;
    try {
      const c = await send({ t: "cred", host: location.hostname });
      if (!c || !c.p) return;
      if (user && c.u && !user.value) setVal(user, c.u);
      if (pw) setVal(pw, c.p);
      if (cfg.login === "auto") {
        mark();
        setTimeout(() => submit((pw || user).form, pw || user), 400);
      }
    } finally {
      filling = false;
    }
  }

  async function start() {
    cfg = await send({ t: "cfg", url: location.href });
    if (!cfg) return;
    if (cfg.yt && !cfg.parent) css(YT_CSS);
    const tick = () => { if (cfg.yt) watchVideo(); login(); };
    tick();
    new MutationObserver(() => { clearTimeout(start.t); start.t = setTimeout(tick, 300); })
      .observe(document.documentElement, { childList: true, subtree: true });
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start); else start();
})();
