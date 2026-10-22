// Avis « nouvelle version » + favoris en mode test (code d'équipe, sans compte). Aucun appel réel.
// Usage : node tests/ui-favoris-essai.mjs <dossier du site laqualia> <dossier de captures>
import { chromium } from "/opt/node-tools/node_modules/playwright/index.mjs";
import fs from "node:fs"; import path from "node:path";
import { makeEnv } from "./harness.mjs";
import worker from "../agent-worker.js";

const SITE = process.argv[2], OUT = process.argv[3];
fs.mkdirSync(OUT, { recursive: true });
const PAGES = "https://essai.github.io", RELAY = "https://laqualia-agent.tmclellan007.workers.dev";
const env = await makeEnv(); env.ALLOWED_ORIGINS = PAGES;
const MIME = { ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "application/javascript", ".svg": "image/svg+xml", ".webp": "image/webp", ".png": "image/png", ".json": "application/json" };
const errors = [], favCalls = []; let bumped = false;
const ok = (c, m) => { if (!c) { errors.push(m); console.log("ÉCHEC :", m); } else console.log("ok :", m); };
const browser = await chromium.launch();
for (const [label, vp] of [["ordi", { width: 1280, height: 900 }], ["mobile", { width: 390, height: 844 }]]) {
  const ctx = await browser.newContext({ viewport: vp, locale: "fr-CA", ...(label === "mobile" ? { isMobile: true, hasTouch: true } : {}) });
  await ctx.route(`${RELAY}/**`, async (route) => {
    const req = route.request();
    if (/\/api\/favorites/.test(req.url())) favCalls.push(req.url());
    const h = Object.fromEntries(Object.entries(await req.allHeaders()).filter(([k]) => !k.startsWith(":")));
    const r = await worker.fetch(new Request(req.url(), { method: req.method(), headers: h, body: ["GET", "HEAD"].includes(req.method()) ? undefined : req.postDataBuffer() }), env, {});
    const headers = {}; r.headers.forEach((v, k) => (headers[k] = v));
    return route.fulfill({ status: r.status, headers, body: Buffer.from(await r.arrayBuffer()) });
  });
  await ctx.route(`${PAGES}/**`, (route) => {
    const u = new URL(route.request().url()); let p = u.pathname; if (p.endsWith("/")) p += "index.html";
    const f = path.join(SITE, decodeURIComponent(p));
    if (!f.startsWith(SITE) || !fs.existsSync(f)) return route.fulfill({ status: 404, body: "" });
    let data = fs.readFileSync(f);
    if (bumped && p.endsWith("/agent/index.html")) data = Buffer.from(String(data).replace(/app-agent\.js\?v=\w+/, "app-agent.js?v=nouvelle"));
    return route.fulfill({ status: 200, contentType: MIME[path.extname(f)] || "application/octet-stream", body: data });
  });
  const p = await ctx.newPage();
  p.on("pageerror", (e) => errors.push(label + " JS : " + e.message));
  await p.goto(PAGES + "/agent/");
  await p.waitForTimeout(800);
  if (await p.locator("#codebox").isVisible()) { await p.fill("#prenom", "Léa"); await p.click("#codeForm button[type=submit]"); }
  if (await p.locator("#privbox").isVisible()) await p.click("#privOk");
  const menu = async () => { if (label === "mobile") { await p.click("#menuBtn"); await p.waitForTimeout(250); } };
  await p.fill("#q", "Quels sont les horaires pour une vaccination ?"); await p.click("#send");
  await p.waitForSelector("#thread .fav-btn:not([disabled])", { timeout: 15000 });
  ok(true, label + " : mode test — cœur sous la réponse");
  await p.locator("#thread .fav-btn").last().click();
  await p.waitForFunction(() => document.querySelector("#thread .fav-btn").getAttribute("aria-pressed") === "true" && !document.querySelector("[data-busy]"));
  ok(true, label + " : mode test — cœur rempli");
  await p.reload(); await p.waitForTimeout(800);
  if (await p.locator("#privbox").isVisible()) await p.click("#privOk");
  await menu();
  ok(await p.locator("#sideFav").isVisible(), label + " : mode test — « Mes favoris » dans le menu");
  await p.click("#sideFav"); await p.waitForSelector("#favPage .hpg-row");
  ok((await p.locator("#favPage .hpg-row").count()) === 1, label + " : mode test — favori conservé après rechargement");
  ok(/Mode test/.test(await p.textContent("#favPage")), label + " : mode test indiqué (gardé dans ce navigateur)");
  await p.waitForTimeout(400); await p.screenshot({ path: `${OUT}/t1-essai-${label}.png` });
  await p.locator("#favPage .hpg-open").first().click();
  await p.waitForSelector("#fpAnswer");
  ok(/Réponse simulée/.test(await p.textContent("#fpAnswer")), label + " : mode test — détail complet");
  await p.click("#fpRemove"); await p.waitForSelector("#favPage .fp-empty");
  ok(true, label + " : mode test — retrait");
  await menu(); await p.click("#accountLink"); await p.waitForTimeout(300);
  ok(await p.locator("#codebox").isVisible() && /\/agent\/$/.test(p.url()), label + " : mode test — « Mon profil » ouvre le prénom (sans compte)");
  await p.fill("#prenom", "Léa"); await p.click("#codeForm button[type=submit]");
  ok(!(await p.locator(".ver-bar").count()), label + " : aucun avis de version sans mise à jour");
  bumped = true; await p.waitForTimeout(61000); await p.evaluate(() => dispatchEvent(new Event("focus")));
  await p.waitForSelector(".ver-bar", { timeout: 5000 }).catch(() => {});
  ok(await p.locator(".ver-bar").isVisible(), label + " : avis « nouvelle version disponible » après une mise à jour");
  await p.screenshot({ path: `${OUT}/t2-version-${label}.png` });
  bumped = false;
  await ctx.close();
}
ok(!favCalls.length, "mode test : rien n'est envoyé à la base des comptes");
await browser.close();
console.log(errors.length ? `\n${errors.length} problème(s)` : "\nFavoris (mode test) : tout est conforme.");
process.exit(errors.length ? 1 : 0);
