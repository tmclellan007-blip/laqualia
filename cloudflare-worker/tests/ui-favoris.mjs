// Favoris du portail (Playwright) : aucun appel réel, aucun courriel réel.
// Usage : node tests/ui-favoris.mjs <dossier du site laqualia> <dossier de captures>
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
  await ctx.grantPermissions(["clipboard-read", "clipboard-write"]).catch(() => {});
  const p = await ctx.newPage();
  p.on("pageerror", (e) => errors.push(label + " JS : " + e.message));
  await p.goto(ORIGIN + "/agent/acces.html"); await p.waitForSelector("#fFirst:not([hidden])");
  await p.fill("#first", "Léa"); await p.fill("#email", "fav-" + label + "@csl.ca"); await p.fill("#code", CODE); await p.click("#go");
  await p.waitForURL(ORIGIN + "/agent/"); await gateOpen(p);
  if (await p.locator("#ppLater").count()) await p.click("#ppLater");
  if (await p.locator("#privbox").isVisible()) await p.click("#privOk");
  const menu = async () => { if (label === "mobile") { await p.click("#menuBtn"); await p.waitForTimeout(250); } };
  const ask = async (q) => { const n = (await p.locator("#thread .msg.q").count()) + 1; await p.fill("#q", q); await p.click("#send"); await p.waitForFunction((n) => document.querySelectorAll("#thread .msg.q").length >= n && document.querySelectorAll("#thread .msg.a .actions").length >= n, n, { timeout: 15000 }); await p.waitForTimeout(300); };
  const lastHeart = () => p.locator("#thread .msg.a .fav-btn").last();

  await menu();
  ok(await p.locator("#sideFav").isVisible(), label + " : « Mes favoris » dans le menu");
  await p.click("#sideFav"); await p.waitForSelector("#favPage:not([hidden])");
  ok(/Aucun favori pour l'instant/.test(await p.textContent("#favPage")), label + " : message simple sans favori");
  await p.waitForTimeout(400); await shot(p, `f0-vide-${label}`);
  await p.click("#clear");

  // Réception
  await ask("Quels sont les horaires pour une vaccination ?");
  await p.waitForSelector("#thread .fav-btn:not([disabled])");
  ok((await lastHeart().getAttribute("aria-pressed")) === "false", label + " : cœur discret sous la réponse");
  await lastHeart().click();
  await p.waitForFunction(() => document.querySelector("#thread .fav-btn")?.getAttribute("aria-pressed") === "true" && !document.querySelector("[data-busy]"));
  ok((await p.locator("#thread .msg.a").last().locator(".who .fav-btn.fav-top").getAttribute("aria-pressed")) === "true", label + " : cœur du haut synchronisé avec celui du bas");
  ok(/Dans mes favoris/.test(await lastHeart().textContent()), label + " : libellé visible sous la réponse");
  ok(/Ajouté à Mes favoris/.test(await p.textContent("#favToast")) && /ne confirme pas l'exactitude/.test(await p.textContent("#favToast")), label + " : cœur rempli et rappel : favori personnel, pas une validation");
  await shot(p, `f1-coeur-${label}`);
  await p.locator("#thread .who .fav-top").last().click();
  await p.waitForFunction(() => [...document.querySelectorAll("#thread .fav-btn")].every((b) => b.getAttribute("aria-pressed") === "false") && !document.querySelector("[data-busy]"));
  ok(true, label + " : second clic : retiré des favoris");
  await lastHeart().click();
  await p.waitForFunction(() => document.querySelector("#thread .fav-btn")?.getAttribute("aria-pressed") === "true" && !document.querySelector("[data-busy]"));

  // TSA
  await p.click("#roleTsa"); await p.waitForTimeout(300);
  await ask("Comment préparer la salle de chirurgie ?");
  await p.waitForSelector("#thread .fav-btn:not([disabled])");
  await lastHeart().click(); await p.waitForFunction(() => [...document.querySelectorAll("#thread .fav-btn")].at(-1).getAttribute("aria-pressed") === "true" && !document.querySelector("[data-busy]"));

  // Nutrition
  await p.click("#clear"); await p.click(".nutri-tool"); await p.waitForSelector("#nutriTray:not([hidden])");
  nutritionScript.push({ events: scenario() });
  await p.fill("#q", "Compare Urinary S/O et c/d Multicare pour un chat"); await p.click("#send");
  await p.waitForSelector(".nutri-msg .nu-src h3 >> text=Fiches consultées");
  await p.waitForSelector(".nutri-msg .fav-btn:not([disabled])");
  ok(true, label + " : cœur aussi sous les réponses Nutrition");
  await p.locator(".nutri-msg .fav-btn").last().click();
  await p.waitForFunction(() => [...document.querySelectorAll(".nutri-msg .fav-btn")].at(-1).getAttribute("aria-pressed") === "true" && !document.querySelector("[data-busy]"));
  await p.click("#ntQuit");

  // Les favoris restent après rechargement ; le cœur reste rempli dans l'historique
  await p.reload(); await gateOpen(p); await p.waitForTimeout(500);
  if (await p.locator("#privbox").isVisible()) await p.click("#privOk");
  await menu();
  await p.waitForFunction(() => document.getElementById("favNavCount").textContent === "3", null, { timeout: 5000 }).catch(() => {});
  ok((await p.textContent("#favNavCount")).trim() === "3", label + " : trois favoris conservés après rechargement");
  await p.click("#sideHist"); await p.waitForSelector(".hpg-row");
  await p.locator(".hpg-open", { hasText: "Nutrition" }).click();
  await p.waitForSelector("#thread .nutri-msg .nu-cmp");
  await p.waitForSelector("#thread .fav-btn[aria-pressed=\"true\"]", { timeout: 5000 }).catch(() => {});
  ok((await p.locator("#thread .fav-btn").last().getAttribute("aria-pressed")) === "true", label + " : historique rouvert : comparatif conservé et cœur rempli");

  // Page Mes favoris
  await menu(); await p.click("#sideFav"); await p.waitForSelector("#favPage .hpg-row");
  ok((await p.locator("#favPage .hpg-row").count()) === 3, label + " : trois favoris listés");
  const tags = (await p.locator("#favPage .fp-tag").allTextContents()).join("|");
  ok(/Réception/.test(tags) && /TSA/.test(tags) && /Nutrition/.test(tags), label + " : contexte affiché (Réception, TSA, Nutrition)");
  ok(/\d{4}/.test(await p.locator("#favPage .hpg-row .meta").first().textContent()), label + " : date affichée");
  ok((await p.textContent("#convTitle")).trim() === "Mes favoris", label + " : titre de la barre du haut");
  await p.waitForTimeout(400); await shot(p, `f2-liste-${label}`);
  await p.fill("#fpSearch", "chirurgie");
  ok((await p.locator("#favPage .hpg-row").count()) === 1, label + " : recherche");
  await p.fill("#fpSearch", "");
  await p.click('[data-fp-tab="nutrition"]');
  ok((await p.locator("#favPage .hpg-row").count()) === 1, label + " : filtre par contexte");
  await p.locator("#favPage .hpg-open").first().click();
  await p.waitForSelector("#fpAnswer .nu-cmp");
  ok(/Compare Urinary S\/O/.test(await p.textContent("#fpTitle")), label + " : question complète");
  ok((await p.locator("#fpAnswer .nu-card").count()) === 2 && /Fiches consultées/.test(await p.textContent("#fpAnswer")) && (await p.locator(`#fpAnswer a[href="${RC}"]`).count()) >= 1, label + " : réponse complète avec comparatif et sources");
  ok(/ne confirme pas son exactitude/.test(await p.textContent("#favPage")), label + " : rappel : pas une validation");
  await p.waitForTimeout(300); await shot(p, `f3-detail-nutrition-${label}`);
  ok(!(await p.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1)), label + " : aucun débordement horizontal (détail)");
  await p.click("#fpBack");
  await p.click('[data-fp-tab="reception"]');
  await p.locator("#favPage .hpg-open").first().click();
  await p.waitForSelector("#fpAnswer .box-live, #fpAnswer p");
  ok(/Réponse simulée/.test(await p.textContent("#fpAnswer")) && /vaccination/.test(await p.textContent("#fpTitle")), label + " : favori Réception : question et réponse");
  await p.click("#fpRemove");
  await p.waitForSelector("#favPage .hpg-row, #favPage .hpg-empty");
  await p.click('[data-fp-tab="all"]');
  ok((await p.locator("#favPage .hpg-row").count()) === 2 && (await p.textContent("#favNavCount")).trim() === "2", label + " : retirer depuis la page");
  ok(!(await p.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1)), label + " : aucun débordement horizontal (liste)");
  await p.keyboard.press("Escape");
  ok(await p.locator("#favPage").isHidden(), label + " : Échap ferme la page");
  await ctx.close();
}
// Une autre personne du même établissement ne voit pas ces favoris
const octx = await browser.newContext({ viewport: { width: 1280, height: 900 } }); await wire(octx);
const o = await octx.newPage();
await o.goto(ORIGIN + "/agent/acces.html"); await o.waitForSelector("#fFirst:not([hidden])");
await o.fill("#first", "Marc"); await o.fill("#email", "marc@csl.ca"); await o.fill("#code", CODE); await o.click("#go");
await o.waitForURL(ORIGIN + "/agent/"); await gateOpen(o);
if (await o.locator("#ppLater").count()) await o.click("#ppLater");
if (await o.locator("#privbox").isVisible()) await o.click("#privOk");
await o.click("#sideFav"); await o.waitForSelector("#favPage:not([hidden])"); await o.waitForTimeout(300);
ok(/Aucun favori pour l'instant/.test(await o.textContent("#favPage")), "autre utilisateur : ne voit que ses propres favoris (aucun)");
await browser.close();
console.log(errors.length ? `\n${errors.length} problème(s)` : "\nFavoris : tout est conforme.");
process.exit(errors.length ? 1 : 0);
