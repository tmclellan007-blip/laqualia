// Parcours d'interface de la connexion par code courriel (Playwright). Aucun courriel réel.
// Usage : node tests/ui-email.mjs <dossier du site> <dossier de captures>
import { chromium } from "/opt/node-tools/node_modules/playwright/index.mjs";
import fs from "node:fs"; import path from "node:path";
import { makeEnv, issueCode } from "./harness.mjs";
import worker from "../agent-worker.js";

const SITE = process.argv[2], OUT = process.argv[3];
fs.mkdirSync(OUT, { recursive: true });
const ORIGIN = "https://laqualia.test";
const env = { ...(await makeEnv()), ACCOUNT_ORIGIN: ORIGIN };
env.MEMBER_EMAIL_LINK = "on"; // l'association d'une adresse est testée ici telle qu'elle fonctionnera en production
// Comme en production aujourd'hui : Google et Apple pas encore configurés.
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
const browser = await chromium.launch();
for (const [label, vp] of [["ordi", { width: 1280, height: 860 }], ["mobile", { width: 390, height: 844 }]]) {
  const ctx = await browser.newContext({ viewport: vp, locale: "fr-CA" });
  await wire(ctx);
  const p = await ctx.newPage();
  p.on("pageerror", (e) => errors.push(label + " JS : " + e.message));
  await p.goto(ORIGIN + "/agent/connexion.html");
  await p.waitForSelector("#fEmail:not([hidden])");
  ok(await p.locator("#buttons").isHidden(), label + " : boutons Google/Apple masqués tant qu'ils ne sont pas configurés");
  await p.screenshot({ path: `${OUT}/email-1-${label}.png`, fullPage: true });
  await p.fill("#email", "pas-une-adresse"); await p.click("#sendBtn");
  ok(/valide/.test(await p.textContent("#err")), label + " : adresse invalide signalée");
  const addr = `nouvelle.${label}@clinique.ca`;
  await p.fill("#email", addr); await p.click("#sendBtn");
  await p.waitForSelector("#fCode:not([hidden])");
  ok(/Code envoyé à no•+@clinique\.ca/.test(await p.textContent("#sentTo")), label + " : adresse masquée affichée");
  ok(await p.evaluate(() => document.activeElement.id) === "code", label + " : focus sur le champ du code");
  const code = env.AUTH_EMAIL.lastCodeFor(addr);
  await p.fill("#code", code === "000000" ? "111111" : "000000");
  await p.waitForFunction(() => /Code incorrect/.test(document.getElementById("err").textContent));
  ok(/4 essais/.test(await p.textContent("#err")), label + " : mauvais code, essais restants indiqués");
  await p.screenshot({ path: `${OUT}/email-2-${label}.png`, fullPage: true });
  await p.fill("#code", code);
  await p.waitForURL(/compte\.html/);
  await p.waitForSelector("text=Bienvenue !");
  ok(true, label + " : compte créé, arrivée sur Mon profil avec invitation à compléter le nom");
  await p.screenshot({ path: `${OUT}/email-3-${label}.png`, fullPage: false });
  if (label === "ordi") {
    await p.click("#linkEmail");
    await p.fill("#lkEmail", "deuxieme@clinique.ca"); await p.click("#dlgForm button[value=ok]");
    await p.waitForSelector("#lkCode");
    await p.screenshot({ path: `${OUT}/email-4-associer.png` });
    await p.fill("#lkCode", env.AUTH_EMAIL.lastCodeFor("deuxieme@clinique.ca")); await p.click("#dlgForm button[value=ok]");
    await p.waitForSelector("text=deuxieme@clinique.ca");
    ok(true, "deuxième adresse associée et affichée dans Moyens de connexion");
    await p.waitForTimeout(400);
    await p.screenshot({ path: `${OUT}/email-5-moyens.png`, fullPage: true });
  }
  await ctx.close();
}
await browser.close();
console.log(errors.length ? `\n${errors.length} problème(s)` : "\nParcours courriel : tout est conforme.");
process.exit(errors.length ? 1 : 0);
