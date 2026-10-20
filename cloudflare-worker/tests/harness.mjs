// Banc d'essai : D1 simulé (SQLite intégré à Node), fournisseurs Google/Apple simulés
// avec de vraies signatures (clés générées pour l'essai). Aucun appel réseau, aucun courriel.
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { generateKeyPair, exportJWK, exportPKCS8, SignJWT } from "../vendor/jose.js";
import worker from "../agent-worker.js";

const MIGRATION = readFileSync(new URL("../migrations/0001_comptes.sql", import.meta.url), "utf8");
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
  throw new Error("Appel réseau inattendu pendant l'essai : " + url);
};

export async function makeEnv() {
  return {
    DB: new FakeD1(), ADMIN_CODE: "Code-Plateforme-Test", ACCOUNT_ORIGIN: ORIGIN,
    GOOGLE_CLIENT_ID: "google-client", GOOGLE_CLIENT_SECRET: "google-secret",
    APPLE_CLIENT_ID: "com.laqualia.web", APPLE_TEAM_ID: "TEAM123456", APPLE_KEY_ID: "KEY1234567", APPLE_PRIVATE_KEY: await exportPKCS8(appleClient.privateKey),
  };
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
}
