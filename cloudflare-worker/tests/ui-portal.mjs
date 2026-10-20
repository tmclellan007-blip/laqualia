// Parcours d'interface complet du portail par compte (Playwright) : aucun appel réel, aucun courriel réel.
// Usage : node tests/ui-portal.mjs <dossier du site laqualia> <dossier de captures>
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
}

const ok = (c, m) => { if (!c) { errors.push(m); console.log("ÉCHEC :", m); } else console.log("ok :", m); };
const shot = (p, n, full = false) => p.screenshot({ path: `${OUT}/${n}.png`, fullPage: full });

// Préparation (côté serveur) : plateforme, établissement et son administratrice
const plat = new Browser(env);
await plat.loginEmail("plateforme@laqualia.com");
await plat.api("/api/platform/bootstrap", { method: "POST", body: { code: env.ADMIN_CODE } });
const org = (await plat.api("/api/platform/orgs", { method: "POST", body: { name: "Clinique vétérinaire Saint-Laurent", ownerEmail: "direction@csl.ca" } })).data;
const owner = new Browser(env);
await owner.loginEmail("direction@csl.ca");
await owner.api(`/api/invitations/${org.invite.link.split("#")[1]}/accept`, { method: "POST" });
await owner.api("/api/me", { method: "PATCH", body: { first_name: "Sophie", last_name: "Tremblay" } });

async function emailLogin(p, email) {
  await p.waitForSelector("#fEmail:not([hidden])");
  await p.fill("#email", email); await p.click("#sendBtn");
  await p.waitForSelector("#fCode:not([hidden])");
  await p.fill("#code", env.AUTH_EMAIL.lastCodeFor(email));
}
const browser = await chromium.launch();

// 1. L'administratrice génère un code dans Mon compte › Codes d'accès
const actx = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: "fr-CA" });
await wire(actx);
const a = await actx.newPage();
a.on("pageerror", (e) => errors.push("admin JS : " + e.message));
await a.goto(ORIGIN + "/agent/connexion.html?suite=" + encodeURIComponent("/agent/compte.html#codes"));
await emailLogin(a, "direction@csl.ca");
await a.waitForURL(/compte\.html#codes/);
await a.waitForSelector("#newCode");
ok(!(await a.locator("#navCodes").isHidden()), "admin : entrée « Codes d'accès » visible");
await a.click("#newCode");
await a.fill("#cLabel", "Équipe de soir"); await a.selectOption("#cDays", "14"); await a.fill("#cMax", "10");
await shot(a, "01-admin-generer");
await a.click("#dlgForm button[value=ok]");
await a.waitForSelector("#cpNew");
const CODE = (await a.textContent("#dlgForm .codeval")).trim();
ok(/^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(CODE), "admin : code généré et affiché une fois prêt à copier");
await shot(a, "02-admin-code-pret");
await a.click("#dlgForm button[value=ok]");
await a.waitForSelector(".codecard");
ok((await a.textContent(".codecard .codeval")).startsWith("••••"), "admin : code masqué par défaut dans la liste");
await a.click("[data-show]");
ok((await a.textContent(".codecard .codeval")).trim() === CODE, "admin : « Afficher » révèle le code");
await shot(a, "03-admin-liste-codes", true);

// 2. Nouvelle personne, sur téléphone : création de compte, code, portail
const mctx = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: "fr-CA", hasTouch: true, isMobile: true });
await wire(mctx);
const m = await mctx.newPage();
m.on("pageerror", (e) => errors.push("membre JS : " + e.message));
const urls = [];
m.on("request", (r) => urls.push(r.url()));
await m.goto(ORIGIN + "/agent/");
await m.waitForURL(/connexion\.html\?suite=%2Fagent%2F/);
ok(true, "membre : le portail exige d'abord une connexion");
await emailLogin(m, "julie.roy@csl.ca");
await m.waitForURL(/acces\.html/);
await m.waitForSelector("#fCode:not([hidden])");
ok(true, "membre : compte créé, mais sans rattachement le portail renvoie à la saisie du code");
await shot(m, "04-membre-saisie-code", true);
await m.fill("#code", "ABCD-EFGH-JKMN"); await m.click("#go");
await m.waitForSelector("#codeErr:not([hidden])");
ok(/pas valide/.test(await m.textContent("#codeErr")), "membre : message clair pour un code invalide");
await shot(m, "05-membre-code-invalide", true);
await m.fill("#code", CODE.toLowerCase().replace(/-/g, "")); await m.click("#go");
await m.waitForSelector("#okBox:not([hidden])");
ok(/Clinique vétérinaire Saint-Laurent/.test(await m.textContent("#okBox")), "membre : rattachée au bon établissement");
await shot(m, "06-membre-bienvenue", true);
await m.waitForURL(ORIGIN + "/agent/");
await m.waitForFunction(() => !document.documentElement.classList.contains("lq-gate"));
// Prénom (le compte par courriel n'a pas encore de nom)
if (await m.locator("#codebox").isVisible()) {
  ok(await m.locator("#code").isHidden(), "membre : aucune demande de code d'équipe, seulement le prénom");
  await m.fill("#prenom", "Julie"); await m.click("#codeForm button[type=submit], #codeForm button:not([type])");
}
if (await m.locator("#privbox").isVisible()) await m.click("#privOk");
await shot(m, "07-membre-portail");
await m.fill("#q", "Comment annoncer un retard de 30 minutes à un client ?");
await m.click("#send");
await m.waitForFunction(() => /Réponse simulée/.test(document.body.innerText), null, { timeout: 15000 });
ok(true, "membre : question Réception traitée sans code");
await m.click("#roleTsa");
await m.waitForTimeout(400);
ok(await m.locator("#tsabox").isHidden(), "membre : onglet TSA ouvert sans code TSA");
ok(await m.locator("#tsaLock").isHidden(), "membre : cadenas TSA retiré");
await shot(m, "08-membre-tsa");
ok(await m.locator("#adminLink").isHidden(), "membre : lien Admin absent (aucun droit d'administration)");
ok(!urls.some((u) => u.includes(CODE) || u.includes(CODE.replace(/-/g, "")) || u.toLowerCase().includes(CODE.toLowerCase().replace(/-/g, ""))), "aucune URL ne contient le code");

// 3. Navigation et reconnexion : aucune nouvelle demande de code
await m.reload(); await m.waitForFunction(() => !document.documentElement.classList.contains("lq-gate"));
ok(m.url() === ORIGIN + "/agent/" && (await m.locator("#codebox").isHidden()), "membre : rechargement sans nouvelle demande");
await m.goto(ORIGIN + "/agent/compte.html#profil"); await m.waitForSelector("#fProfile");
ok(await m.locator("#navCodes").isHidden(), "membre : pas d'accès à la page des codes");
await m.goto(ORIGIN + "/agent/compte.html#codes"); await m.waitForTimeout(500);
ok(/réservée aux administrateurs/.test(await m.textContent("main")), "membre : page des codes refusée");
await m.goto(ORIGIN + "/agent/"); await m.waitForFunction(() => !document.documentElement.classList.contains("lq-gate"));
await m.click("#menuBtn").catch(() => {});
await m.click("#logout"); await m.click("#logout");
await m.waitForURL(/connexion\.html/);
await emailLogin(m, "julie.roy@csl.ca");
await m.waitForURL(ORIGIN + "/agent/");
await m.waitForFunction(() => !document.documentElement.classList.contains("lq-gate"));
ok(await m.locator("#codebox").isHidden(), "membre : reconnexion, portail ouvert directement sans code");

// 4. Retrait d'accès : effet à la requête suivante, même page ouverte
const mid = (await owner.api(`/api/orgs/${org.org.id}/members`)).data.members.find((x) => x.email === "julie.roy@csl.ca").id;
await owner.api(`/api/orgs/${org.org.id}/members/${mid}`, { method: "PATCH", body: { status: "disabled" } });
await m.fill("#q", "Encore une question");
await m.click("#send");
await m.waitForURL(/acces\.html/);
await m.waitForSelector("#warn:not([hidden])");
ok(/a été retiré/.test(await m.textContent("#warn")), "retrait : la personne est sortie du portail avec un message clair");
await shot(m, "09-membre-acces-retire", true);
await m.fill("#code", CODE); await m.click("#go");
await m.waitForSelector("#codeErr:not([hidden])");
ok(/retiré/.test(await m.textContent("#codeErr")), "retrait : le code ne rétablit pas l'accès");

// 5. Révocation du code depuis l'interface admin
await a.reload(); await a.waitForSelector("[data-revoke]");
await a.click("[data-revoke]"); await a.click("#dlgForm button[value=ok]");
await a.waitForSelector(".codecard .badge.b-disabled");
ok(true, "admin : code révoqué");
await shot(a, "10-admin-code-revoque", true);
const n2 = await mctx.newPage();
const late = await browser.newContext({ viewport: { width: 820, height: 1180 }, locale: "fr-CA" }); await wire(late);
const l = await late.newPage();
await l.goto(ORIGIN + "/agent/acces.html"); await emailLogin(l, "retard@csl.ca");
await l.waitForURL(/acces\.html|agent\/$/);
if (!/acces\.html/.test(l.url())) await l.goto(ORIGIN + "/agent/acces.html");
await l.waitForSelector("#fCode:not([hidden])");
await l.fill("#code", CODE); await l.click("#go");
await l.waitForSelector("#codeErr:not([hidden])");
ok(/révoqué/.test(await l.textContent("#codeErr")), "code révoqué : message clair (tablette)");
await shot(l, "11-tablette-code-revoque", true);
const over = await l.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1);
ok(!over, "tablette : aucun débordement horizontal");
const overM = await m.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1);
ok(!overM, "téléphone : aucun débordement horizontal");
await browser.close();
const dump = JSON.stringify(env.DB.raw("SELECT * FROM audit_log")) + JSON.stringify(env.DB.raw("SELECT * FROM access_codes"));
ok(!dump.includes(CODE) && !dump.includes(CODE.replace(/-/g, "")), "le code n'est ni dans le journal ni en clair dans la base");
console.log(errors.length ? `\n${errors.length} problème(s)` : "\nParcours du portail : tout est conforme.");
process.exit(errors.length ? 1 : 0);
