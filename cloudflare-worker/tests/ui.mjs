// Parcours d'interface de bout en bout (Playwright) : site + relais dans le même processus,
// fournisseurs simulés. Usage : node tests/ui.mjs <dossier du site> <dossier de captures>
import { chromium } from "/opt/node-tools/node_modules/playwright/index.mjs";
import fs from "node:fs"; import path from "node:path";
import { makeEnv, issueCode } from "./harness.mjs";
import worker from "../agent-worker.js";

const SITE = process.argv[2], OUT = process.argv[3];
fs.mkdirSync(OUT, { recursive: true });
const ORIGIN = "https://laqualia.test";
const env = { ...(await makeEnv()), ACCOUNT_ORIGIN: ORIGIN };
const MIME = { ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "application/javascript", ".svg": "image/svg+xml", ".webp": "image/webp", ".png": "image/png", ".json": "application/json" };
let persona = null;
const errors = [];

async function wire(ctx) {
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
  // Google simulé : renvoie immédiatement un code pour la personne choisie
  await ctx.route("https://accounts.google.com/**", (route) => {
    const u = new URL(route.request().url());
    const code = issueCode("google", { nonce: u.searchParams.get("nonce"), ...persona });
    return route.fulfill({ status: 302, headers: { location: `${u.searchParams.get("redirect_uri")}?code=${code}&state=${u.searchParams.get("state")}` } });
  });
  await ctx.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.fulfill({ status: 200, body: "" }));
}
async function newUser(name, sub, email, { width = 1280, height = 860 } = {}) {
  const ctx = await browser.newContext({ viewport: { width, height }, locale: "fr-CA" });
  await wire(ctx);
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(name + ": " + e.message));
  page.on("dialog", (d) => d.accept());
  if (process.env.DBG) { page.on("request", (r) => console.log(">>", r.method(), r.url().slice(0, 120))); page.on("response", (r) => console.log("<<", r.status(), r.url().slice(0, 120))); page.on("requestfailed", (r) => console.log("XX", r.url().slice(0, 120), r.failure()?.errorText)); }
  persona = { sub, email, email_verified: true, given_name: name, family_name: "Test" };
  await page.goto(`${ORIGIN}/agent/connexion.html`);
  await page.click("#btnGoogle:not([aria-disabled])");
  try { await page.waitForURL(/compte\.html|invitation\.html/, { timeout: 8000 }); } catch (e) { console.log("URL", page.url(), (await page.content()).slice(0, 600)); throw e; }
  await page.waitForSelector("h1");
  return page;
}
const shot = (page, n) => page.screenshot({ path: path.join(OUT, n + ".png"), fullPage: true });
const step = (m) => console.log("✓", m);

const browser = await chromium.launch();
// 1. Connexion et page de connexion
{
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 } }); await wire(ctx);
  const p = await ctx.newPage(); await p.goto(`${ORIGIN}/agent/connexion.html?erreur=etat_expire`); await p.waitForTimeout(300);
  await shot(p, "01-connexion"); step("page de connexion avec message d'erreur clair"); await ctx.close();
}
// 2. Administrateur de la plateforme
const plat = await newUser("Terry", "u-plat", "terry@laqualia.com");
await plat.goto(`${ORIGIN}/agent/compte.html#plateforme`); await plat.fill("input[name=code]", env.ADMIN_CODE); await plat.click("#fBoot .btn");
await plat.waitForSelector("#newOrg"); step("activation de l'administrateur de la plateforme");
await plat.click("#newOrg"); await plat.fill("#nn", "Clinique vétérinaire des Monts"); await plat.fill("#nc", "Chicoutimi"); await plat.fill("#no", "julie@monts.ca");
await plat.click("#dlgForm button[value=ok]");
await plat.waitForSelector(".linkbox code");
const ownerLink = await plat.textContent(".linkbox code");
await shot(plat, "02-plateforme-invitation-proprietaire");
await plat.click("#dlgForm button[value=ok]"); step("établissement créé, lien du propriétaire affiché une seule fois");
// 3. Propriétaire : invitation acceptée
const julie = await newUser("Julie", "u-julie", "julie@monts.ca");
await julie.goto(ownerLink.replace("https://laqualia.test", ORIGIN));
await julie.waitForSelector("#ok"); await shot(julie, "03-invitation");
await julie.click("#ok"); await julie.waitForSelector(".notice.ok"); step("invitation acceptée par le bon destinataire");
// 4. Membres et invitations
await julie.goto(`${ORIGIN}/agent/compte.html#membres`); await julie.reload(); await julie.waitForSelector("#mlist .list");
await julie.click("#inv"); await julie.fill("#ie", "marc@monts.ca"); await julie.selectOption("#ir", "member"); await julie.selectOption("#if", "reception");
await julie.click("#dlgForm button[value=ok]"); await julie.waitForSelector(".linkbox code");
const marcLink = await julie.textContent(".linkbox code"); await julie.click("#dlgForm button[value=ok]");
await julie.click("#inv"); await julie.fill("#ie", "sophie@monts.ca"); await julie.selectOption("#ir", "admin"); await julie.selectOption("#if", "tsa");
await julie.click("#dlgForm button[value=ok]"); await julie.waitForSelector(".linkbox code");
const sophieLink = await julie.textContent(".linkbox code"); await julie.click("#dlgForm button[value=ok]");
const marc = await newUser("Marc", "u-marc", "marc@monts.ca"); await marc.goto(marcLink.replace("https://laqualia.test", ORIGIN)); await marc.click("#ok"); await marc.waitForSelector(".notice.ok");
const sophie = await newUser("Sophie", "u-sophie", "sophie@monts.ca"); await sophie.goto(sophieLink.replace("https://laqualia.test", ORIGIN)); await sophie.click("#ok"); await sophie.waitForSelector(".notice.ok");
// mauvais destinataire
const intrus = await newUser("Intrus", "u-x", "intrus@ailleurs.ca");
await julie.reload(); await julie.waitForSelector("#mlist .list");
await julie.click("#inv"); await julie.fill("#ie", "nadia@monts.ca"); await julie.click("#dlgForm button[value=ok]"); await julie.waitForSelector(".linkbox code");
const nadiaLink = await julie.textContent(".linkbox code"); await julie.click("#dlgForm button[value=ok]");
await intrus.goto(nadiaLink.replace("https://laqualia.test", ORIGIN)); await intrus.click("#ok"); await intrus.waitForSelector("#msg .notice.err");
await shot(intrus, "04-invitation-mauvais-destinataire"); step("invitation refusée au mauvais destinataire, message compréhensible");
await julie.reload(); await julie.waitForSelector("#mlist .list"); await julie.waitForSelector("#audit .list");
await shot(julie, "05-membres"); step("liste des membres, invitations en attente, journal");
await julie.fill("#q", "sophie"); await julie.waitForTimeout(500);
if ((await julie.locator("#mlist .item").count()) !== 1) throw new Error("recherche");
await julie.fill("#q", "zzzz"); await julie.waitForTimeout(500); await julie.waitForSelector("#mlist .empty");
await julie.click("#filters button[type=reset]"); await julie.waitForTimeout(400);
await julie.selectOption("#fs", "invited"); await julie.waitForTimeout(400);
if ((await julie.locator("#mlist .item").count()) !== 1) throw new Error("filtre statut");
await julie.selectOption("#fs", ""); await julie.waitForTimeout(400); step("recherche, filtres et état vide");
// 5. Désactivation en direct : Sophie (admin) voit les membres, puis perd l'accès sans se reconnecter
await sophie.goto(`${ORIGIN}/agent/compte.html#membres`); await sophie.reload(); await sophie.waitForSelector("#mlist .list");
const sophieRow = julie.locator("#mlist .item", { hasText: "Sophie" });
await sophieRow.locator("[data-toggle]").click(); await julie.click("#dlgForm button[value=ok]"); await julie.waitForTimeout(400);
await sophie.reload(); await sophie.waitForTimeout(800);
const txt = await sophie.textContent("#main");
if (!/désactivé/i.test(txt)) throw new Error("accès non retiré : " + txt.slice(0, 200));
await shot(sophie, "06-acces-retire"); step("désactivation : accès retiré immédiatement dans la session ouverte de Sophie");
// 6. Dernier propriétaire protégé
await julie.goto(`${ORIGIN}/agent/compte.html#etablissement`); await julie.waitForSelector("#leave");
await julie.waitForTimeout(4500); await julie.click("#leave"); await julie.click("#dlgForm button[value=ok]"); await julie.waitForSelector("#toast:not([hidden])");
const t = await julie.textContent("#toast"); if (!/dernier propriétaire/i.test(t)) throw new Error("dernier propriétaire : " + t);
await shot(julie, "07-dernier-proprietaire"); step("départ du dernier propriétaire bloqué avec explication");
// 7. Membre simple : pas d'accès à la gestion
await marc.goto(`${ORIGIN}/agent/compte.html#membres`); await marc.reload(); await marc.waitForSelector("#mlist .empty");
await shot(marc, "08-membre-acces-reserve"); step("membre : liste des membres réservée");
await marc.goto(`${ORIGIN}/agent/compte.html#roles`); await marc.waitForSelector(".matrix"); await shot(marc, "09-roles-permissions"); step("écran Rôles et permissions");
await marc.goto(`${ORIGIN}/agent/compte.html#profil`); await marc.reload(); await marc.waitForSelector("#fProfile");
await marc.fill("#jt", "Réceptionniste de soir"); await marc.click("#fProfile > button.btn"); await marc.waitForSelector("#toast:not([hidden])"); if (!/enregistré/.test(await marc.textContent("#toast"))) throw new Error("profil");
await shot(marc, "10-mon-profil"); step("Mon profil : modification enregistrée");
await marc.click("#del"); await marc.waitForSelector("#cf"); await shot(marc, "11-suppression-confirmation"); await marc.click("#dlgForm button[value=cancel]");
step("suppression : confirmation explicite avec traitement des données");
// 8. Téléphone et tablette
for (const [w, h, n] of [[390, 844, "12-telephone-membres"], [820, 1180, "13-tablette-profil"]]) {
  const ctx = julie.context(); const p = await ctx.newPage(); await p.setViewportSize({ width: w, height: h });
  await p.goto(`${ORIGIN}/agent/compte.html#${n.includes("membres") ? "membres" : "profil"}`); await p.waitForTimeout(900);
  const over = await p.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1);
  if (over) { console.log(await p.evaluate(() => [...document.querySelectorAll("body *")].filter((e) => e.getBoundingClientRect().right > innerWidth + 1).slice(0, 8).map((e) => e.tagName + "." + e.className + " " + Math.round(e.getBoundingClientRect().right)))); throw new Error("débordement horizontal " + n); }
  await shot(p, n); await p.close();
}
step("affichage téléphone et tablette sans débordement");
await browser.close();
if (errors.length) { console.log("ERREURS JS", errors); process.exit(1); }
console.log("Parcours d'interface : OK");
