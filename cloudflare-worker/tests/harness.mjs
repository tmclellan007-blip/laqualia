// Banc d'essai : D1 simulé (SQLite intégré à Node), fournisseurs Google/Apple simulés
// avec de vraies signatures (clés générées pour l'essai). Aucun appel réseau, aucun courriel.
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { generateKeyPair, exportJWK, exportPKCS8, SignJWT } from "../vendor/jose.js";
import worker from "../agent-worker.js";

const MIGRATION = ["0001_comptes.sql", "0002_connexion_courriel.sql", "0003_codes_acces.sql", "0004_premier_acces.sql", "0005_favoris.sql"].map((f) => readFileSync(new URL("../migrations/" + f, import.meta.url), "utf8")).join("\n");
export const ORIGIN = "https://laqualia.com";

class Stmt {
  constructor(db, sql) { this.db = db; this.sql = sql; this.params = []; }
  bind(...p) { this.params = p.map((v) => (v === undefined ? null : typeof v === "boolean" ? (v ? 1 : 0) : v)); return this; }
  _s() { return this.db.prepare(this.sql); }
  async first() { const r = this._s().get(...this.params); return r ? { ...r } : null; }
  async all() { return { results: this._s().all(...this.params).map((r) => ({ ...r })) }; }
  async run() { const r = this._s().run(...this.params); return { meta: { changes: Number(r.changes) } }; }
}
export class FakeD1 {
  constructor() { this.db = new DatabaseSync(":memory:"); this.db.exec("PRAGMA foreign_keys = ON;"); this.db.exec(MIGRATION); }
  prepare(sql) { return new Stmt(this.db, sql); }
  async batch(stmts) {
    this.db.exec("BEGIN");
    try { const out = []; for (const s of stmts) out.push(await s.run()); this.db.exec("COMMIT"); return out; }
    catch (e) { this.db.exec("ROLLBACK"); throw e; }
  }
  raw(sql, ...p) { return this.db.prepare(sql).all(...p).map((r) => ({ ...r })); }
  exec(sql, ...p) { return this.db.prepare(sql).run(...p); }
}

// ----- Fournisseurs simulés -----
const google = await generateKeyPair("RS256");
const apple = await generateKeyPair("ES256");
const appleClient = await generateKeyPair("ES256", { extractable: true });
const gJwk = { ...(await exportJWK(google.publicKey)), kid: "g1", alg: "RS256", use: "sig" };
const aJwk = { ...(await exportJWK(apple.publicKey)), kid: "a1", alg: "ES256", use: "sig" };
export const providerLog = [];
export const modelLog = [];
export const nutritionScript = []; // étapes { events: [...] } ou { status: 500 }
export const turnstileLog = [];
export class FakeKV {
  constructor() { this.m = new Map(); }
  async get(k) { return this.m.has(k) ? this.m.get(k) : null; }
  async put(k, v) { this.m.set(k, String(v)); }
  async delete(k) { this.m.delete(k); }
}
const pendingCodes = new Map(); // code -> { provider, claims }

export function issueCode(provider, claims) { const code = "code_" + Math.random().toString(36).slice(2); pendingCodes.set(code, { provider, claims }); return code; }

globalThis.fetch = async (input, init = {}) => {
  const url = typeof input === "string" ? input : input.url;
  if (url === "https://www.googleapis.com/oauth2/v3/certs") return Response.json({ keys: [gJwk] });
  if (url === "https://appleid.apple.com/auth/keys") return Response.json({ keys: [aJwk] });
  if (url === "https://oauth2.googleapis.com/token" || url === "https://appleid.apple.com/auth/token") {
    const body = new URLSearchParams(String(init.body));
    providerLog.push({ url, body: Object.fromEntries(body) });
    const p = pendingCodes.get(body.get("code"));
    if (!p) return new Response("{}", { status: 400 });
    pendingCodes.delete(body.get("code"));
    const isG = url.includes("google");
    const key = isG ? google.privateKey : apple.privateKey;
    const id_token = await new SignJWT(p.claims).setProtectedHeader({ alg: isG ? "RS256" : "ES256", kid: isG ? "g1" : "a1" })
      .setIssuer(isG ? "https://accounts.google.com" : "https://appleid.apple.com").setAudience(p.claims.aud ?? (isG ? "google-client" : "com.laqualia.web"))
      .setIssuedAt().setExpirationTime(p.claims.expOverride || "10m").sign(key);
    return Response.json({ id_token, access_token: "x" });
  }
  // Modèle simulé (aucun appel réel à Anthropic) : flux SSE minimal
  if (url === "https://api.anthropic.com/v1/messages") {
    const body = JSON.parse(String(init.body)); modelLog.push(body);
    // Outil Nutrition : scénario SSE programmé par l'essai (outils serveur simulés)
    if (nutritionScript.length && (Array.isArray(body.tools) || String(body.system || "").includes("Nutrition — Aide au conseil client"))) {
      const step = nutritionScript.shift();
      if (step.status) return new Response(JSON.stringify({ error: { message: "simulé" } }), { status: step.status });
      return new Response(step.events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
    }
    const sse = `data: ${JSON.stringify({ type: "content_block_delta", delta: { type: "text_delta", text: "Réponse simulée." } })}\n\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`;
    return new Response(sse, { headers: { "content-type": "text/event-stream" } });
  }
  // Turnstile simulé : « humain… » réussit ; « humain-autre-site » est émis pour un autre domaine
  if (url === "https://challenges.cloudflare.com/turnstile/v0/siteverify") {
    const b = JSON.parse(String(init.body)); turnstileLog.push(b);
    const ok = String(b.response).startsWith("humain") && b.secret === "secret-turnstile-essai";
    if (b.secret !== "secret-turnstile-essai") return Response.json({ success: false, "error-codes": ["invalid-input-secret"] });
    return Response.json({ success: ok, "error-codes": ok ? [] : ["invalid-input-response"], hostname: b.response === "humain-autre-site" ? "pirate.example" : "laqualia.com" });
  }
  if (url.endsWith("/agent/config.json")) return Response.json({ name: "Assistant La Qualia", instructions: "Instructions d'essai.", examples: ["Exemple"] });
  if (url.endsWith("/agent/docs/index.json")) return Response.json([]);
  throw new Error("Appel réseau inattendu pendant l'essai : " + url);
};

export async function makeEnv() {
  return {
    DB: new FakeD1(), ADMIN_CODE: "Code-Plateforme-Test", ACCOUNT_ORIGIN: ORIGIN,
    GOOGLE_CLIENT_ID: "google-client", GOOGLE_CLIENT_SECRET: "google-secret",
    AUTH_EMAIL: new FakeMailer(), AGENT_KV: new FakeKV(), ANTHROPIC_API_KEY: "cle-essai",
    APPLE_CLIENT_ID: "com.laqualia.web", APPLE_TEAM_ID: "TEAM123456", APPLE_KEY_ID: "KEY1234567", APPLE_PRIVATE_KEY: await exportPKCS8(appleClient.privateKey),
  };
}

// Envoi de courriels simulé : rien ne sort, les messages sont gardés pour l'essai.
export class FakeMailer {
  constructor() { this.sent = []; this.failNext = false; }
  async send(m) { if (this.failNext) { this.failNext = false; throw Object.assign(new Error("refusé"), { code: "E_TEST" }); } this.sent.push(m); return { messageId: "test-" + this.sent.length }; }
  lastCodeFor(to) { const m = [...this.sent].reverse().find((x) => x.to === to); return m && (m.text.match(/code : (\d{6})/) || [])[1]; }
}

// Navigateur simulé : garde ses témoins.
export class Browser {
  constructor(env) { this.env = env; this.jar = {}; }
  cookieHeader() { return Object.entries(this.jar).map(([k, v]) => `${k}=${v}`).join("; "); }
  absorb(res) {
    for (const c of res.headers.getSetCookie?.() || []) {
      const [kv, ...attrs] = c.split(/;\s*/); const i = kv.indexOf("="); const k = kv.slice(0, i), v = kv.slice(i + 1);
      if (attrs.some((a) => /^Max-Age=0$/i.test(a)) || !v) delete this.jar[k]; else this.jar[k] = v;
    }
    return res;
  }
  async raw(path, { method = "GET", body, headers = {}, csrf = true, origin = ORIGIN } = {}) {
    const h = { cookie: this.cookieHeader(), ...headers };
    if (method !== "GET" && csrf) h["x-lq-csrf"] = "1";
    if (method !== "GET" && origin) h.origin = origin;
    if (body !== undefined && typeof body !== "string") { h["content-type"] = "application/json"; body = JSON.stringify(body); }
    return this.absorb(await worker.fetch(new Request(ORIGIN + path, { method, headers: h, body }), this.env, {}));
  }
  async api(path, opts) { const r = await this.raw(path, opts); let data = null; try { data = await r.json(); } catch {} return { status: r.status, data, res: r }; }
  // Connexion complète par le fournisseur : start -> (fournisseur) -> callback
  async login(provider, claims, { mode = "login", next, token, tamperState = false } = {}) {
    const q = new URLSearchParams({ mode }); if (next) q.set("next", next); if (token) q.set("token", token);
    const start = await this.raw(`/auth/${provider}/start?${q}`);
    const loc = start.headers.get("location") || "";
    if (!loc.startsWith("https://accounts.google.com") && !loc.startsWith("https://appleid.apple.com")) return { res: start, location: loc };
    const au = new URL(loc);
    const state = tamperState ? "etat-fabrique" : au.searchParams.get("state");
    const code = issueCode(provider, { nonce: au.searchParams.get("nonce"), ...claims });
    let res;
    if (provider === "apple") res = await this.raw(`/auth/apple/callback`, { method: "POST", csrf: false, origin: "https://appleid.apple.com", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ code, state, ...(claims.__user ? { user: JSON.stringify(claims.__user) } : {}) }).toString() });
    else res = await this.raw(`/auth/google/callback?${new URLSearchParams({ code, state })}`);
    return { res, location: res.headers.get("location") || "", authUrl: au };
  }
  // Connexion par code courriel : demande, lecture du code dans le courriel simulé, saisie.
  async loginEmail(email, { mode = "login", next, token, code } = {}) {
    const start = await this.api("/auth/email/start", { method: "POST", body: { email, mode, next, token } });
    if (start.status !== 200) return { start };
    const c = code ?? this.env.AUTH_EMAIL.lastCodeFor(email.trim().toLowerCase());
    const verify = await this.api("/auth/email/verify", { method: "POST", body: { code: c } });
    return { start, verify, code: c };
  }
}
