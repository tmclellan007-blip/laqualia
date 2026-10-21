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

// Préparation : plateforme (administrateur existant), établissement et sa propriétaire
const plat = new Browser(env);
await plat.loginEmail("plateforme@laqualia.com");
await plat.api("/api/platform/bootstrap", { method: "POST", body: { code: env.ADMIN_CODE } });
await plat.api("/api/me", { method: "PATCH", body: { first_name: "Terry", last_name: "Admin" } });
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
env.TURNSTILE_SECRET = "secret-turnstile-essai"; // actif pour tout le parcours dans le navigateur
const browser = await chromium.launch();

// 1. L'administratrice génère un code (24 h, usage unique par défaut)
const actx = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: "fr-CA" });
await wire(actx);
const a = await actx.newPage();
a.on("pageerror", (e) => errors.push("admin JS : " + e.message));
await a.goto(ORIGIN + "/agent/acces.html");
await a.waitForSelector("#fFirst:not([hidden])");
await shot(a, "01-accueil-ordinateur");
await a.click("text=Connexion administrateur");
await a.waitForURL(/connexion\.html/);
ok(/Connexion administrateur/.test(await a.textContent("h1")), "accueil : option distincte « Connexion administrateur »");
await emailLogin(a, "direction@csl.ca");
await a.waitForURL(ORIGIN + "/agent/"); await gateOpen(a);
ok(true, "administratrice : connexion existante, sans code d'invitation");
ok(await a.evaluate(() => { const m = document.getElementById("orgMono"); return m.classList.contains("can-edit") && /compte\.html#etablissement$/.test(m.href); }), "bandeau : la responsable peut ajouter le logo (lien vers Mon établissement)");
ok(!/Votre logo d'entreprise ici/.test(await a.textContent(".topbar")), "bandeau : plus de texte d'instruction");
await a.goto(ORIGIN + "/agent/compte.html#codes");
await a.waitForSelector("#newCode"); await a.click("#newCode");
ok((await a.inputValue("#cMax")) === "1", "codes : usage unique proposé par défaut");
ok((await a.inputValue("#cHours")) === "24", "codes : 24 heures proposées par défaut");
await a.fill("#cHours", "48");
await a.fill("#cLabel", "Julie (accueil)");
await shot(a, "02-admin-generer");
await a.click("#dlgForm button[value=ok]");
await a.waitForSelector("#cpNew");
const CODE = (await a.textContent("#dlgForm .codeval")).trim();
await a.click("#dlgForm button[value=ok]");
const exp48 = env.DB.raw("SELECT expires_at - created_at AS d FROM access_codes ORDER BY created_at DESC LIMIT 1")[0].d;
ok(exp48 === 48 * 3600e3, "codes : durée choisie en heures appliquée (48 h)");
const code2 = (await owner.api(`/api/orgs/${org.org.id}/access-codes`, { method: "POST", body: { label: "Équipe", maxUses: 5 } })).data.code.code;

// 2. Premier accès sur téléphone : prénom, courriel, code
const mctx = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: "fr-CA", hasTouch: true, isMobile: true });
await wire(mctx);
const m = await mctx.newPage();
m.on("pageerror", (e) => errors.push("membre JS : " + e.message));
const urls = []; m.on("request", (r) => urls.push(r.url()));
await m.goto(ORIGIN + "/agent/");
await m.waitForURL(/acces\.html/);
await m.waitForSelector("#fFirst:not([hidden])");
ok((await m.locator("#fFirst input").count()) === 3, "accueil : trois champs seulement");
ok(/Accéder au portail/.test(await m.textContent("#go")), "accueil : bouton « Accéder au portail »");
await shot(m, "03-accueil-telephone", true);
await m.click("#go");
ok(!(await m.locator("#firstErr").isHidden()), "validation : prénom requis signalé");
await m.fill("#first", "Julie"); await m.fill("#email", "julie.roy@csl.ca"); await m.fill("#code", "ABCD-EFGH-JKMN");
await m.click("#go"); await m.waitForSelector("#codeErr:not([hidden])");
ok(/pas valide/.test(await m.textContent("#codeErr")), "code invalide : message clair sous le champ");
await shot(m, "04-code-invalide", true);
await m.fill("#code", CODE.toLowerCase().replace(/-/g, ""));
await m.click("#go");
await m.waitForSelector("#done:not([hidden])");
ok(/Bienvenue Julie/.test(await m.textContent("#doneTitle")), "premier accès : accueil personnalisé avec le prénom");
await shot(m, "05-bienvenue", true);
await m.waitForURL(ORIGIN + "/agent/"); await gateOpen(m);
ok(await m.locator("#codebox").isHidden(), "portail : aucune autre fenêtre (ni prénom ni code)");
ok(/Julie/.test(await m.textContent("#helloName")), "portail : prénom du compte utilisé dans la salutation");
ok(await m.evaluate(() => !document.getElementById("orgMono").classList.contains("can-edit") && document.getElementById("orgMonoTxt").textContent === "SL"), "bandeau : monogramme de l'établissement, sans action d'administration pour un membre");
ok((await m.textContent("#orgName")).trim() === "Clinique vétérinaire Saint-Laurent", "portail : nom de l'établissement de la personne affiché");
await m.waitForSelector("#profPrompt");
ok(/Compléter mon profil/.test(await m.textContent("#profPrompt")) && /Plus tard/.test(await m.textContent("#profPrompt")), "invitation discrète à compléter le profil");
if (await m.locator("#privbox").isVisible()) await m.click("#privOk");
await shot(m, "06-portail-invitation-profil");
await m.fill("#q", "Comment annoncer un retard de 30 minutes à un client ?");
await m.click("#send");
await m.waitForFunction(() => /Réponse simulée/.test(document.body.innerText), null, { timeout: 15000 });
ok(true, "portail utilisable sans compléter le profil (question traitée)");
await m.click("#ppLater");
ok(!(await m.locator("#profPrompt").count()), "« Plus tard » referme l'invitation");
await m.click("#roleTsa"); await m.waitForTimeout(300);
ok(await m.locator("#tsabox").isHidden(), "TSA ouverte sans code TSA");
ok(await m.locator("#adminLink").isHidden(), "aucun lien Admin : aucun droit d'administration");
ok(!urls.some((u) => u.toUpperCase().includes(CODE.replace(/-/g, "")) || u.toUpperCase().includes(CODE)), "le code n'apparaît dans aucune URL");

// 3. Code déjà utilisé, code expiré (autre personne, tablette)
const tctx = await browser.newContext({ viewport: { width: 820, height: 1180 }, locale: "fr-CA" }); await wire(tctx);
const t = await tctx.newPage();
await t.goto(ORIGIN + "/agent/acces.html"); await t.waitForSelector("#fFirst:not([hidden])");
await t.fill("#first", "Marc"); await t.fill("#email", "marc@csl.ca"); await t.fill("#code", CODE); await t.click("#go");
await t.waitForSelector("#codeErr:not([hidden])");
ok(/déjà été utilisé/.test(await t.textContent("#codeErr")), "code déjà utilisé : message clair");
await shot(t, "07-code-deja-utilise", true);
const expired = (await owner.api(`/api/orgs/${org.org.id}/access-codes`, { method: "POST", body: {} })).data.code;
env.DB.exec("UPDATE access_codes SET expires_at = ? WHERE id = ?", Date.now() - 1, expired.id);
await t.fill("#code", expired.code); await t.click("#go");
await t.waitForFunction(() => /expiré/.test(document.getElementById("codeErr").textContent));
ok(true, "code expiré : message clair");
await t.fill("#code", code2); await t.click("#go");
await t.waitForURL(ORIGIN + "/agent/"); await gateOpen(t);
ok(/Marc/.test(await t.textContent("#helloName")), "tablette : deuxième personne entrée avec un code d'équipe");
ok((await t.textContent("#orgName")).trim() === "Clinique vétérinaire Saint-Laurent", "tablette : nom de l'établissement affiché");
ok(!(await t.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1)), "tablette : aucun débordement horizontal");

// 4. Reconnexion : nouvel onglet, rechargement, retour plus tard
const m2 = await mctx.newPage();
await m2.goto(ORIGIN + "/agent/"); await gateOpen(m2);
ok(m2.url() === ORIGIN + "/agent/" && (await m2.locator("#codebox").isHidden()), "reconnexion : portail ouvert directement, sans code");
ok(!(await m2.locator("#profPrompt").count()), "reconnexion : l'invitation reportée ne revient pas");
await m2.goto(ORIGIN + "/agent/acces.html"); await m2.waitForURL(ORIGIN + "/agent/");
ok(true, "page d'accès : une personne déjà entrée est renvoyée au portail");
await m2.goto(ORIGIN + "/agent/compte.html#profil"); await m2.waitForSelector("#fProfile");
ok(await m2.inputValue("#ce") === "julie.roy@csl.ca", "profil : courriel saisi affiché comme coordonnée");
ok(/Aucun moyen de connexion associé/.test(await m2.textContent("main")), "profil : explique comment se reconnecter ailleurs");
await m2.fill("#ln", "Roy"); await m2.click("#fProfile > button.btn"); await m2.waitForSelector("#toast:not([hidden])");
await shot(m2, "08-profil-a-completer", true);
ok(!(await m2.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1)), "téléphone : aucun débordement horizontal");
await m2.close();

// 5. Retrait d'accès : effet immédiat, même page ouverte
const mid = (await owner.api(`/api/orgs/${org.org.id}/members`)).data.members.find((x) => x.email === "julie.roy@csl.ca").id;
await owner.api(`/api/orgs/${org.org.id}/members/${mid}`, { method: "PATCH", body: { status: "disabled" } });
await m.fill("#q", "Encore une question"); await m.click("#send");
await m.waitForURL(/acces\.html/);
await m.waitForSelector("#fJoin:not([hidden])");
ok(/a été retiré/.test(await m.textContent("#joinWarn")), "retrait : sortie du portail avec un message clair");
await shot(m, "09-acces-retire", true);

// 6. Mon accès administrateur (plateforme) : connexion existante et toutes les fonctions
const pctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: "fr-CA" }); await wire(pctx);
const p = await pctx.newPage();
p.on("pageerror", (e) => errors.push("plateforme JS : " + e.message));
await p.goto(ORIGIN + "/agent/"); await p.waitForURL(/acces\.html/);
await p.click("text=Connexion administrateur"); await p.waitForURL(/connexion\.html/);
await emailLogin(p, "plateforme@laqualia.com");
await p.waitForURL(ORIGIN + "/agent/"); await gateOpen(p);
ok(!(await p.locator("#adminLink").isHidden()), "plateforme : lien Admin présent");
ok(!(await p.locator("#profPrompt").count()), "plateforme : aucune invitation à compléter (profil complet)");
await p.goto(ORIGIN + "/agent/admin.html");
await p.waitForSelector("#app:not([hidden])", { timeout: 15000 });
ok(true, "plateforme : configuration de l'agent ouverte sans code Admin");
ok(await p.locator("#inviteBox").isVisible(), "Admin : lien vers les codes d'invitation visible");
await p.locator("#inviteBox").scrollIntoViewIfNeeded(); await shot(p, "11-admin-lien-codes");
await p.goto(ORIGIN + "/agent/compte.html#plateforme"); await p.waitForTimeout(800);
ok(!(await p.locator("#navPlat").isHidden()), "plateforme : section Plateforme accessible");
await shot(p, "10-admin-plateforme");
await browser.close();
ok(tsLoads > 0, "Turnstile chargé sur la page d'accès et la connexion administrateur");
const { turnstileLog } = await import("./harness.mjs");
ok(turnstileLog.length >= 4 && turnstileLog.every((x) => x.secret === "secret-turnstile-essai"), "chaque premier accès et chaque envoi de code a été vérifié côté serveur");
const dump = JSON.stringify(env.DB.raw("SELECT * FROM audit_log")) + JSON.stringify(env.DB.raw("SELECT * FROM access_codes"));
ok(!dump.includes(CODE) && !dump.includes(CODE.replace(/-/g, "")), "le code n'est ni dans le journal ni en clair dans la base");
console.log(errors.length ? `\n${errors.length} problème(s)` : "\nParcours du portail : tout est conforme.");
process.exit(errors.length ? 1 : 0);
