// Protection anti-robots (Cloudflare Turnstile) pour la page d'accès et la connexion administrateur.
// Le script de Cloudflare n'est chargé que si le relais annonce une clé de site (secret TURNSTILE_SECRET ajouté).
// La vérification se fait en arrière-plan ; une case à cocher n'apparaît que si quelque chose semble suspect.
window.LQHuman = (() => {
  "use strict";
  let widget = null, token = "", on = false, waiters = [];
  function init(sitekey, container) {
    if (!sitekey || on) return;
    on = true;
    window.lqTurnstileLoad = () => {
      widget = window.turnstile.render(container, {
        sitekey, language: "fr", theme: "light", appearance: "interaction-only",
        callback: (t) => { token = t; waiters.splice(0).forEach((f) => f(t)); },
        "expired-callback": () => { token = ""; reset(); },
        "error-callback": () => { token = ""; },
      });
    };
    const s = document.createElement("script");
    s.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit&onload=lqTurnstileLoad";
    s.async = true; s.defer = true;
    document.head.append(s);
  }
  // Jeton à usage unique : on le remet au serveur une seule fois, puis on en demande un nouveau.
  function get(timeout = 20000) {
    if (!on) return Promise.resolve(undefined);
    if (token) { const t = token; token = ""; return Promise.resolve(t); }
    return new Promise((res) => {
      const f = (t) => { clearTimeout(tm); token = ""; res(t); };
      const tm = setTimeout(() => { waiters = waiters.filter((x) => x !== f); res(""); }, timeout);
      waiters.push(f);
    });
  }
  function reset() { if (widget !== null && window.turnstile) { token = ""; try { window.turnstile.reset(widget); } catch {} } }
  return { init, get, reset, get active() { return on; } };
})();
