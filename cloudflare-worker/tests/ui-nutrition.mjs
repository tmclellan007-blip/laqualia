// Parcours d'interface de l'outil Nutrition (espace TSA) (Playwright) : aucun appel réel, aucun courriel réel.
// Usage : node tests/ui-portal.mjs <dossier du site laqualia> <dossier de captures>
import { chromium } from "/opt/node-tools/node_modules/playwright/index.mjs";
import fs from "node:fs"; import path from "node:path";
import { makeEnv, issueCode, Browser, modelLog, nutritionScript } from "./harness.mjs";
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

const RC = "https://www.royalcanin.com/ca/fr/cats/products/vet-products/urinary-so-3901";
const HP = "https://www.hillspet.ca/fr-ca/cat-food/prescription-diet-cd-multicare-feline";
const E = {
  start: (i, b) => ({ type: "content_block_start", index: i, content_block: b }), json: (i, j) => ({ type: "content_block_delta", index: i, delta: { type: "input_json_delta", partial_json: j } }),
  text: (i, t) => ({ type: "content_block_delta", index: i, delta: { type: "text_delta", text: t } }), stop: (i) => ({ type: "content_block_stop", index: i }), end: () => ({ type: "message_delta", delta: { stop_reason: "end_turn" } }),
};
const CMP = { produits: [
  { nom: "Royal Canin Urinary S/O", fabricant: "Royal Canin", gamme: "Veterinary Diet", espece: "Chat", source: RC, forme: "Sec", indications: "Déclaré par le fabricant : soutien de la santé urinaire.", contre_indications: "Non précisé dans la source", nutrition: "Non précisé dans la source", formats: "Non précisé dans la source", taille_croquette: "Non précisé dans la source" },
  { nom: "Hill's Prescription Diet c/d Multicare", fabricant: "Hill's", gamme: "Prescription Diet", espece: "Chat", source: HP, forme: "Sec", indications: "Inventé : ne doit pas s'afficher" },
], notes: ["Le choix entre ces aliments thérapeutiques revient au vétérinaire."] };
const scenario = () => [
  E.start(0, { type: "server_tool_use", id: "s1", name: "web_search", input: {} }), E.json(0, '{"query":"Urinary S/O chat"}'), E.stop(0),
  E.start(1, { type: "web_search_tool_result", tool_use_id: "s1", content: [{ type: "web_search_result", url: RC, title: "Urinary S/O", encrypted_content: "x" }] }), E.stop(1),
  E.start(2, { type: "server_tool_use", id: "f1", name: "web_fetch", input: {} }), E.json(2, `{"url":"${RC}"}`), E.stop(2),
  E.start(3, { type: "web_fetch_tool_result", tool_use_id: "f1", content: { type: "web_fetch_result", url: RC, retrieved_at: "2026-10-21T22:00:00Z", content: { type: "document", title: "URINARY S/O", source: { type: "text", media_type: "text/plain", data: "…" } } } }), E.stop(3),
  E.start(4, { type: "server_tool_use", id: "f2", name: "web_fetch", input: {} }), E.json(4, `{"url":"${HP}"}`), E.stop(4),
  E.start(5, { type: "web_fetch_tool_result", tool_use_id: "f2", content: { type: "web_fetch_tool_result_error", error_code: "url_not_accessible" } }), E.stop(5),
  E.start(6, { type: "text", text: "" }),
  E.text(6, `### Réponse\n[Royal Canin Urinary S/O](${RC}) [Fabricant] : soutien de la santé urinaire.\nLa fiche c/d Multicare n'a pas pu être consultée.\n\n### À valider par le vétérinaire\n- Le choix de l'aliment thérapeutique.\n\n\`\`\`comparaison\n${JSON.stringify(CMP)}\n\`\`\``), E.stop(6), E.end(),
];

const browser = await chromium.launch();
for (const [label, vp] of [["ordi", { width: 1280, height: 900 }], ["mobile", { width: 390, height: 844 }]]) {
  const ctx = await browser.newContext({ viewport: vp, locale: "fr-CA", ...(label === "mobile" ? { isMobile: true, hasTouch: true } : {}) });
  await wire(ctx);
  const p = await ctx.newPage();
  p.on("pageerror", (e) => errors.push(label + " JS : " + e.message));
  await p.goto(ORIGIN + "/agent/acces.html"); await p.waitForSelector("#fFirst:not([hidden])");
  await p.fill("#first", label === "ordi" ? "Léa" : "Noé"); await p.fill("#email", label + "@csl.ca"); await p.fill("#code", CODE); await p.click("#go");
  await p.waitForURL(ORIGIN + "/agent/"); await gateOpen(p);
  if (await p.locator("#ppLater").count()) await p.click("#ppLater");
  if (await p.locator("#privbox").isVisible()) await p.click("#privOk");
  ok(!(await p.locator(".nutri-tool").count()), label + " : Réception — aucune tuile Nutrition");
  await p.click("#roleTsa"); await p.waitForTimeout(300);
  ok(await p.locator("#examples .card.tool").first().evaluate((e) => e.classList.contains("nutri-tool")), label + " : TSA — Nutrition est la première tuile des outils");
  await shot(p, `n1-tsa-bouton-${label}`);
  await p.click(".nutri-tool");
  ok(await p.locator("#nutriTray").isVisible() && !(await p.locator("dialog[open]").count()), label + " : mode Nutrition dans la même page (aucune fenêtre)");
  ok((await p.getAttribute(".nutri-tool", "aria-pressed")) === "true" && /Mode Nutrition/.test(await p.textContent("#nutriTray")), label + " : mode actif indiqué sur la tuile et au-dessus du champ");
  ok(!(await p.locator("#nutriTray [data-s], #nutriTray input, #nutriTray select").count()), label + " : ni suggestions, ni contexte, ni comparateur : seulement la question libre");
  ok(/^Question nutrition/.test(await p.getAttribute("#q", "placeholder")), label + " : le champ principal devient le champ Nutrition");
  await p.waitForTimeout(600);
  ok(/233, 161, 59/.test(await p.evaluate(() => getComputedStyle(document.getElementById("form")).borderColor)), label + " : champ aux couleurs de l'outil Nutrition");
  await shot(p, `n2-mode-${label}`);
  // Erreur du service, puis nouvel essai
  nutritionScript.push({ status: 500 });
  await p.fill("#q", "Le chien refuse ses croquettes, que dire au client ?"); await p.click("#send");
  await p.waitForSelector(".nutri-msg .nu-err");
  ok(/Réessayez|n'a pas pu/.test(await p.textContent(".nutri-msg .nu-err")), label + " : état d'erreur clair dans le fil");
  nutritionScript.push({ events: [E.end()] });
  await p.click(".nutri-msg .nu-retry");
  await p.waitForSelector(".nutri-msg .nu-empty");
  ok(true, label + " : état « aucun résultat » clair");
  // Comparaison demandée en texte libre : affichée avec ses sources réellement consultées
  nutritionScript.push({ events: scenario() });
  const n0 = modelLog.length;
  await p.fill("#q", "Compare Urinary S/O et c/d Multicare pour un chat de 4,2 kg"); await p.click("#send");
  await p.waitForSelector(".nutri-msg .nu-src h3 >> text=Fiches consultées");
  const req = modelLog.slice(n0).find((r) => r.tools);
  ok(req && /Compare Urinary S\/O/.test(req.messages.at(-1).content), label + " : question libre transmise");
  const last = p.locator(".nutri-msg").last();
  const cards = last.locator(".nu-card");
  ok((await cards.count()) === 2, label + " : comparateur à deux produits dans la réponse");
  ok(/Fiche officielle/.test(await cards.nth(0).textContent()) && /21 octobre 2026/.test(await cards.nth(0).textContent()), label + " : produit vérifié avec lien et date de consultation");
  const unv = await cards.nth(1).textContent();
  ok(/Fiche non consultée/.test(unv) && !/Inventé/.test(unv) && !/Indications déclarées/.test(unv), label + " : produit non consulté : aucune caractéristique affichée");
  ok(/Non précisé dans la source/.test(await cards.nth(0).textContent()), label + " : donnée absente de la fiche : « Non précisé dans la source »");
  ok(/Prix et disponibilité à confirmer auprès de la clinique/.test(await last.locator(".nu-cmp").textContent()), label + " : prix et stock à confirmer");
  ok(/Fiche inaccessible/.test(await last.locator(".nu-src").textContent()), label + " : page inaccessible signalée");
  ok(await last.locator(`.nu-ans a[href="${RC}"]`).count() === 1, label + " : lien exact de la fiche dans la réponse");
  await last.locator(".nu-cmp").scrollIntoViewIfNeeded();
  await shot(p, `n3-comparatif-${label}`);
  ok(!(await p.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1)), label + " : aucun débordement horizontal");
  // Quitter le mode : la question repart vers l'agent TSA habituel
  await p.click("#ntQuit");
  ok(await p.locator("#nutriTray").isHidden(), label + " : quitter le mode Nutrition");
  const n1 = modelLog.length;
  await p.fill("#q", "Question TSA ordinaire"); await p.click("#send");
  await p.waitForFunction(() => /Réponse simulée/.test(document.body.innerText), null, { timeout: 15000 });
  ok(!modelLog.slice(n1).some((r) => r.tools), label + " : hors du mode, aucune recherche web");
  // Passer à la Réception désactive le mode
  await p.click("#clear"); await p.click(".nutri-tool"); await p.waitForSelector("#nutriTray:not([hidden])"); await p.click("#roleRec"); await p.waitForTimeout(300);
  ok(await p.locator("#nutriTray").isHidden(), label + " : passer à la Réception quitte le mode Nutrition");
  await ctx.close();
}
// L'administrateur de la plateforme garde son accès
const pctx = await browser.newContext({ viewport: { width: 1280, height: 900 } }); await wire(pctx);
const pa = await pctx.newPage();
await pa.goto(ORIGIN + "/agent/connexion.html?suite=%2Fagent%2F");
await pa.waitForSelector("#fEmail:not([hidden])"); await pa.fill("#email", "plateforme@laqualia.com"); await pa.click("#sendBtn");
await pa.waitForSelector("#fCode:not([hidden])"); await pa.fill("#code", env.AUTH_EMAIL.lastCodeFor("plateforme@laqualia.com"));
await pa.waitForURL(ORIGIN + "/agent/"); await gateOpen(pa);
await pa.waitForTimeout(400); if (await pa.locator("#privbox").isVisible()) await pa.click("#privOk");
if (await pa.locator("#codebox").isVisible()) { await pa.fill("#prenom", "Terry"); await pa.click("#codeForm button[type=submit]"); }
if (await pa.locator("#privbox").isVisible()) await pa.click("#privOk");
await pa.click("#roleTsa"); await pa.waitForTimeout(300);
ok(await pa.locator(".nutri-tool").isVisible() && !(await pa.locator("#adminLink").isHidden()), "administrateur : Nutrition et Admin accessibles");
await browser.close();
console.log(errors.length ? `\n${errors.length} problème(s)` : "\nOutil Nutrition : tout est conforme.");
process.exit(errors.length ? 1 : 0);
