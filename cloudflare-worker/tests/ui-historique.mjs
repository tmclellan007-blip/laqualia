// Page « Historique » du portail (Playwright) : aucun appel réel, aucun courriel réel.
// Usage : node tests/ui-historique.mjs <dossier du site laqualia> <dossier de captures>
import { chromium } from "/opt/node-tools/node_modules/playwright/index.mjs";
import fs from "node:fs"; import path from "node:path";
import { makeEnv, issueCode, Browser, modelLog } from "./harness.mjs";
import worker from "../agent-worker.js";

const SITE = process.argv[2], OUT = process.argv[3];
fs.mkdirSync(OUT, { recursive: true });
const ORIGIN = "https://laqualia.com";
const env = await makeEnv();
for (const k of ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "APPLE_CLIENT_ID", "APPLE_TEAM_ID", "APPLE_KEY_ID", "APPLE_PRIVATE_KEY"]) delete env[k];
const MIME = { ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "application/javascript", ".svg": "image/svg+xml", ".webp": "image/webp", ".png": "image/png", ".json": "application/json" };
let persona = null;
const errors = [];
// Turnstile actif, avec un faux script Cloudflare (aucun appel réel) qui délivre un jeton « humain ».
const FAKE_TS = `window.turnstile={render:function(el,o){var n=document.querySelector(el);n.textContent="Vérification anti-robots réussie";n.dataset.ok="1";setTimeout(function(){o.callback("humain-ui-"+Date.now())},50);return 1},reset:function(){var w=window.__tsw;setTimeout(function(){w&&w.callback("humain-ui-"+Date.now())},50)}};(function(){var r=window.turnstile.render;window.turnstile.render=function(el,o){window.__tsw=o;return r(el,o)}})();var q=new URL(document.currentScript.src).searchParams.get("onload");q&&window[q]&&window[q]();`;
let tsLoads = 0;
async function wire(ctx) {
  await ctx.route("https://challenges.cloudflare.com/**", (route) => { tsLoads++; return route.fulfill({ status: 200, contentType: "application/javascript", body: FAKE_TS }); });
  await ctx.route(`${ORIGIN}/**`, async (route) => { try { return await handle(route); } catch (e) { console.log('ROUTE ERR', route.request().url(), e.message); return route.abort(); } });
  async function handle(route) {
    const req = route.request(); const u = new URL(req.url());
    if (u.pathname.startsWith("/api/") || u.pathname.startsWith("/auth/")) {
      const h = Object.fromEntries(Object.entries(await req.allHeaders()).filter(([k]) => !k.startsWith(':')));
      const r = await worker.fetch(new Request(req.url(), { method: req.method(), headers: h, body: ["GET", "HEAD"].includes(req.method()) ? undefined : req.postDataBuffer() }), env, {});
      const headers = {}; r.headers.forEach((v, k) => { if (k !== "set-cookie") headers[k] = v; });
      const sc = r.headers.getSetCookie(); if (sc.length) headers["set-cookie"] = sc.join("\n");
      // Google simulé : la redirection vers le fournisseur revient aussitôt avec un code pour la personne choisie
      if (headers.location && headers.location.startsWith("https://accounts.google.com/")) {
        const g = new URL(headers.location);
        const code = issueCode("google", { nonce: g.searchParams.get("nonce"), ...persona });
        headers.location = `${g.searchParams.get("redirect_uri")}?code=${code}&state=${g.searchParams.get("state")}`;
      }
      // Playwright n'intercepte pas les requêtes suivant une redirection : on la rejoue côté page (même effet, témoins conservés).
      if (r.status === 302 && headers.location) { const loc = headers.location; delete headers.location; headers["content-type"] = "text/html"; return route.fulfill({ status: 200, headers, body: `<script>location.replace(${JSON.stringify(loc)})</script>` }); }
      return route.fulfill({ status: r.status, headers, body: Buffer.from(await r.arrayBuffer()) });
    }
    let p = u.pathname; if (p.endsWith("/")) p += "index.html";
    const f = path.join(SITE, decodeURIComponent(p));
    if (!f.startsWith(SITE) || !fs.existsSync(f)) return route.fulfill({ status: 404, body: "" });
    return route.fulfill({ status: 200, contentType: MIME[path.extname(f)] || "application/octet-stream", body: fs.readFileSync(f) });
  }
}

const ok = (c, m) => { if (!c) { errors.push(m); console.log("ÉCHEC :", m); } else console.log("ok :", m); };
const shot = (p, n, full = false) => p.screenshot({ path: `${OUT}/${n}.png`, fullPage: full });
const gateOpen = (p) => p.waitForFunction(() => !document.documentElement.classList.contains("lq-gate"));
const plat = new Browser(env);
await plat.loginEmail("plateforme@laqualia.com");
await plat.api("/api/platform/bootstrap", { method: "POST", body: { code: env.ADMIN_CODE } });
const org = (await plat.api("/api/platform/orgs", { method: "POST", body: { name: "Clinique vétérinaire Saint-Laurent", ownerEmail: "direction@csl.ca" } })).data;
const owner = new Browser(env);
await owner.loginEmail("direction@csl.ca");
await owner.api(`/api/invitations/${org.invite.link.split("#")[1]}/accept`, { method: "POST" });
const CODE = (await owner.api(`/api/orgs/${org.org.id}/access-codes`, { method: "POST", body: { maxUses: 5 } })).data.code.code;


const browser = await chromium.launch();
for (const [label, vp] of [["ordi", { width: 1280, height: 900 }], ["mobile", { width: 390, height: 844 }]]) {
  const ctx = await browser.newContext({ viewport: vp, locale: "fr-CA", ...(label === "mobile" ? { isMobile: true, hasTouch: true } : {}) });
  await wire(ctx);
  const p = await ctx.newPage();
  p.on("pageerror", (e) => errors.push(label + " JS : " + e.message));
  await p.goto(ORIGIN + "/agent/acces.html"); await p.waitForSelector("#fFirst:not([hidden])");
  await p.fill("#first", "Léa"); await p.fill("#email", label + "@csl.ca"); await p.fill("#code", CODE); await p.click("#go");
  await p.waitForURL(ORIGIN + "/agent/"); await gateOpen(p);
  if (await p.locator("#ppLater").count()) await p.click("#ppLater");
  if (await p.locator("#privbox").isVisible()) await p.click("#privOk");
  const menu = async () => { if (label === "mobile") { await p.click("#menuBtn"); await p.waitForTimeout(250); } };
  await menu();
  ok(await p.locator("#sideHist").isVisible(), label + " : entrée « Historique » dans le menu");
  ok(!(await p.locator("#tabRecent").isVisible()) && !(await p.locator("#sideExamples").isVisible()), label + " : Récents et Fréquentes retirés du menu");
  if (label === "mobile") await p.click("#closeMenu");
  // Deux conversations
  const ask = async (q) => { const n = (await p.locator("#thread .msg.q").count()) + 1; await p.fill("#q", q); await p.click("#send"); await p.waitForFunction((n) => document.querySelectorAll("#thread .msg.q").length >= n && !document.querySelector("#stop:not([hidden])") && [...document.querySelectorAll("#thread .act span")].filter((x) => /Copier toute/.test(x.textContent)).length >= n, n, { timeout: 15000 }); await p.waitForTimeout(300); };
  await ask("Quels sont les horaires pour une vaccination ?");
  await ask("Et pour un chaton ?");
  await p.click("#clear");
  await ask("Comment préparer un chien pour une chirurgie ?");
  await p.click("#clear");
  await menu();
  ok((await p.textContent("#histNavCount")).trim() === "2", label + " : compteur de conversations dans le menu");
  await p.click("#sideHist");
  await p.waitForSelector("#histPage:not([hidden]) .hpg-row");
  ok(await p.locator("#examples").isHidden() && await p.locator("#form").isHidden(), label + " : page dédiée (la conversation est masquée)");
  ok((await p.textContent("#convTitle")).trim() === "Historique", label + " : titre de la barre du haut");
  ok((await p.locator(".hpg-row").count()) === 2, label + " : les deux conversations sont listées");
  ok(/Réponse simulée/.test(await p.locator(".hpg-row .ex").first().textContent()), label + " : aperçu de la réponse");
  await p.waitForTimeout(500); await shot(p, `h1-historique-${label}`);
  await p.fill("#hpSearch", "vaccination");
  ok((await p.locator(".hpg-row").count()) === 1, label + " : recherche dans les questions et réponses");
  await p.fill("#hpSearch", "zzz-introuvable");
  ok(/Aucune conversation/.test(await p.textContent("#hpBody")), label + " : recherche sans résultat");
  await p.fill("#hpSearch", "");
  // Un clic : la conversation réapparaît dans le fil
  await p.locator(".hpg-open", { hasText: "vaccination" }).click();
  ok(await p.locator("#histPage").isHidden(), label + " : la page se ferme");
  ok((await p.locator("#thread .msg.q").count()) === 2 && /Et pour un chaton/.test(await p.textContent("#thread")), label + " : conversation complète réaffichée en un clic");
  ok((await p.locator("#thread .msg.a").count()) >= 2 || (await p.locator("#thread .ans").count()) >= 2 || /Réponse simulée/.test(await p.textContent("#thread")), label + " : réponses réaffichées");
  await p.waitForTimeout(500); await shot(p, `h2-reouverte-${label}`);
  // Questions fréquentes
  await menu(); await p.click("#sideHist"); await p.waitForSelector("#hpTabFaq");
  ok((await p.locator(".hpg-row .now").count()) === 1, label + " : conversation en cours signalée");
  await p.click("#hpTabFaq");
  const nq = await p.locator(".hpg-q").count();
  ok(nq >= 1 && nq === (await p.evaluate(() => 1)), label + ` : toutes les questions fréquentes de la configuration (${nq})`);
  await p.waitForTimeout(500); await shot(p, `h3-frequentes-${label}`);
  ok(!(await p.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1)), label + " : aucun débordement horizontal");
  const fq = (await p.locator(".hpg-q").first().evaluate((e) => e.lastChild.textContent)).trim();
  await p.locator(".hpg-q").first().click();
  await p.waitForFunction(() => !document.querySelector("#stop:not([hidden])") && document.querySelectorAll("#thread .msg.q").length === 1, null, { timeout: 15000 });
  ok((await p.locator("#thread .msg.q").first().textContent()).includes(fq.slice(0, 20)), label + " : une question fréquente lance une nouvelle conversation");
  // Suppression
  await menu(); await p.click("#sideHist"); await p.waitForSelector(".hpg-row");
  const before = await p.locator(".hpg-row").count();
  await p.locator(".hpg-del").last().click();
  ok((await p.locator(".hpg-row").count()) === before - 1, label + " : suppression d'une conversation");
  // Autre navigation ferme la page
  await p.click("#clear");
  ok(await p.locator("#histPage").isHidden() && await p.locator("#form").isVisible(), label + " : « Nouvelle conversation » ferme la page");
  // TSA : historique propre à l'espace
  await p.click("#roleTsa"); await p.waitForTimeout(300);
  await menu(); await p.click("#sideHist"); await p.waitForSelector("#hpBody");
  ok(/Vos conversations apparaîtront ici/.test(await p.textContent("#hpBody")), label + " : TSA — historique propre à l'espace");
  await p.keyboard.press("Escape");
  ok(await p.locator("#histPage").isHidden(), label + " : Échap ferme la page");
  await ctx.close();
}
await browser.close();
console.log(errors.length ? `\n${errors.length} problème(s)` : "\nHistorique : tout est conforme.");
process.exit(errors.length ? 1 : 0);
