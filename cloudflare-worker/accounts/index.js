// Module Comptes : connexion (Google, Apple), profils, établissements, membres, invitations.
// Toutes les vérifications d'accès sont faites ici, côté serveur, à chaque requête.
import { providersStatus, authorizationUrl, exchangeAndVerify, OidcError, randomToken, sha256 } from "./oidc.js";
import { MATRIX, ROLES, ROLE_LABELS, FUNCTIONS, can, permissionsFor, checkTarget } from "./perms.js";

const SESSION_TTL = 14 * 24 * 3600e3;   // expiration absolue
const IDLE_TTL = 12 * 3600e3;           // inactivité
// Premier accès par code d'invitation : le compte n'a pas encore de moyen de connexion vérifié ;
// la session de cet appareil est donc plus longue pour éviter les demandes répétées.
const FIRST_IDLE = 30 * 24 * 3600e3;   // inactivité
const FIRST_TTL = 90 * 24 * 3600e3;    // expiration absolue
const idleFor = (session) => (session.kind === "invite" ? FIRST_IDLE : IDLE_TTL);
const REAUTH_WINDOW = 30 * 60e3;        // association d'un moyen de connexion : authentification récente exigée
const INVITE_TTL = 7 * 24 * 3600e3;
const RECOVERY_TTL = 24 * 3600e3;
const SESSION_COOKIE = "__Host-lq_sess";
const OAUTH_COOKIE = "__Secure-lq_oauth";
const LOGIN_PAGE = "/agent/connexion.html";
const ACCOUNT_PAGE = "/agent/compte.html";

export function isAccountsRequest(url) { return url.pathname.startsWith("/api/") || url.pathname.startsWith("/auth/"); }

export async function handleAccounts(request, env) {
  const url = new URL(request.url);
  if (!env.DB) return json(503, { error: "Le module Comptes n'est pas encore activé (base de données D1 non reliée).", code: "no_db" });
  const ctx = { request, env, url, origin: env.ACCOUNT_ORIGIN || url.origin, now: Date.now() };
  try {
    if (url.pathname.startsWith("/auth/")) return await routeAuth(ctx);
    // Protection CSRF : toute modification exige l'en-tête x-lq-csrf et la même origine.
    if (request.method !== "GET") {
      const o = request.headers.get("origin");
      if (request.headers.get("x-lq-csrf") !== "1" || (o && o !== ctx.origin)) return json(403, { error: "Requête refusée (origine).", code: "csrf" });
    }
    return await routeApi(ctx);
  } catch (e) {
    if (e instanceof HttpError) return json(e.status, { error: e.message, code: e.code, ...(e.extra || {}) });
    console.error("accounts", e && e.stack || e);
    return json(500, { error: "Erreur inattendue. Réessayez dans un instant.", code: "server" });
  }
}

export async function cleanupAccounts(env) {
  if (!env.DB) return;
  const t = Date.now();
  await env.DB.batch([
    env.DB.prepare("DELETE FROM sessions WHERE expires_at < ? OR (kind = 'invite' AND last_seen_at < ?) OR (kind != 'invite' AND last_seen_at < ?)").bind(t, t - FIRST_IDLE, t - IDLE_TTL),
    env.DB.prepare("DELETE FROM auth_requests WHERE expires_at < ?").bind(t),
    env.DB.prepare("DELETE FROM email_codes WHERE expires_at < ?").bind(t),
    env.DB.prepare("DELETE FROM rate_limits WHERE reset_at < ?").bind(t),
  ]);
}

/* ===================== Connexion ===================== */
async function routeAuth(ctx) {
  const { url, request } = ctx;
  const m = url.pathname.match(/^\/auth\/(google|apple)\/(start|callback)$/);
  if (m && m[2] === "start" && request.method === "GET") return authStart(ctx, m[1]);
  if (m && m[2] === "callback" && (request.method === "GET" || request.method === "POST")) return authCallback(ctx, m[1]);
  if (url.pathname === "/auth/providers" && request.method === "GET") return json(200, providers(ctx.env));
  if (url.pathname === "/auth/email/start" && request.method === "POST") return emailStart(ctx);
  if (url.pathname === "/auth/invite" && request.method === "POST") return inviteSignup(ctx);
  if (url.pathname === "/auth/email/verify" && request.method === "POST") return emailVerify(ctx);
  if (url.pathname === "/auth/logout" && request.method === "POST") {
    csrf(ctx);
    const s = await readSession(ctx);
    if (s) await ctx.env.DB.prepare("DELETE FROM sessions WHERE id_hash = ?").bind(s.idHash).run();
    return json(200, { ok: true }, { "set-cookie": clearCookie(SESSION_COOKIE, "/") });
  }
  if (url.pathname === "/auth/logout-all" && request.method === "POST") {
    csrf(ctx);
    const { user } = await requireUser(ctx, { allowDeactivated: true });
    await ctx.env.DB.prepare("DELETE FROM sessions WHERE user_id = ?").bind(user.id).run();
    await audit(ctx, { actor: user.id, action: "session.logout_all", target: user.id });
    return json(200, { ok: true }, { "set-cookie": clearCookie(SESSION_COOKIE, "/") });
  }
  return json(404, { error: "Introuvable." });
}

function csrf(ctx) {
  const o = ctx.request.headers.get("origin");
  if (ctx.request.headers.get("x-lq-csrf") !== "1" || (o && o !== ctx.origin)) throw new HttpError(403, "Requête refusée (origine).", "csrf");
}

const safeNext = (p) => (typeof p === "string" && /^\/(?!\/)[\w\-./#?=&%]*$/.test(p) ? p : ACCOUNT_PAGE);
const loginError = (ctx, code) => redirect(`${ctx.origin}${LOGIN_PAGE}?erreur=${encodeURIComponent(code)}`);

async function authStart(ctx, provider) {
  const { env, url, now } = ctx;
  if (!providersStatus(env)[provider]) return loginError(ctx, "fournisseur_non_configure");
  const mode = ["login", "link", "recovery"].includes(url.searchParams.get("mode")) ? url.searchParams.get("mode") : "login";
  let linkUserId = null, recoveryId = null;
  if (mode === "link") {
    const s = await readSession(ctx);
    if (!s || s.user.status !== "active") return loginError(ctx, "connexion_requise");
    // Compte créé par code d'invitation, sans moyen de connexion : il n'y a rien à revérifier, la session est la seule preuve.
    if (now - s.session.auth_at > REAUTH_WINDOW && (await identityCount(ctx, s.user.id)) > 0) return redirect(`${ctx.origin}${LOGIN_PAGE}?erreur=reauth&suite=${encodeURIComponent(ACCOUNT_PAGE + "#profil")}`);
    linkUserId = s.user.id;
  }
  if (mode === "recovery") {
    const rec = await env.DB.prepare("SELECT * FROM recovery_links WHERE token_hash = ?").bind(await sha256(url.searchParams.get("token") || "")).first();
    if (!rec || rec.used_at || rec.expires_at < now) return loginError(ctx, "recuperation_invalide");
    recoveryId = rec.id;
  }
  const state = randomToken(), nonce = randomToken(), codeVerifier = randomToken(48);
  await env.DB.prepare("INSERT INTO auth_requests (state_hash, provider, nonce, code_verifier, mode, next_path, link_user_id, recovery_id, created_at, expires_at) VALUES (?,?,?,?,?,?,?,?,?,?)")
    .bind(await sha256(state), provider, nonce, codeVerifier, mode, safeNext(url.searchParams.get("next")), linkUserId, recoveryId, now, now + 600e3).run();
  const loc = await authorizationUrl(provider, env, ctx.origin, { state, nonce, codeVerifier });
  // Le témoin lie la demande à ce navigateur (contre la connexion forcée). SameSite=None : Apple répond en POST intersite.
  return redirect(loc, { "set-cookie": cookie(OAUTH_COOKIE, state, { path: "/auth/", maxAge: 600, sameSite: "None" }) });
}

async function authCallback(ctx, provider) {
  const { request, env, now } = ctx;
  const params = request.method === "POST" ? new URLSearchParams(await request.text()) : ctx.url.searchParams;
  const clear = { "set-cookie": clearCookie(OAUTH_COOKIE, "/auth/", "None") };
  if (params.get("error")) return withHeaders(loginError(ctx, params.get("error") === "access_denied" || params.get("error") === "user_cancelled_authorize" ? "annule" : "fournisseur"), clear);
  const state = params.get("state") || "", code = params.get("code") || "";
  const cookieState = readCookie(request, OAUTH_COOKIE);
  if (!state || !code || !cookieState || !timingSafeEqual(state, cookieState)) return withHeaders(loginError(ctx, "etat_invalide"), clear);
  const stateHash = await sha256(state);
  const req = await env.DB.prepare("SELECT * FROM auth_requests WHERE state_hash = ? AND provider = ?").bind(stateHash, provider).first();
  await env.DB.prepare("DELETE FROM auth_requests WHERE state_hash = ?").bind(stateHash).run(); // usage unique
  if (!req || req.expires_at < now) return withHeaders(loginError(ctx, "etat_expire"), clear);

  let info;
  try { info = await exchangeAndVerify(provider, env, ctx.origin, code, { nonce: req.nonce, codeVerifier: req.code_verifier }); }
  catch (e) { console.error("oidc", e.code, e.message); return withHeaders(loginError(ctx, e instanceof OidcError ? e.code : "fournisseur"), clear); }
  // Apple ne transmet le nom qu'à la toute première autorisation, hors du jeton.
  if (provider === "apple" && params.get("user")) {
    try { const u = JSON.parse(params.get("user")); info.givenName ||= u?.name?.firstName || null; info.familyName ||= u?.name?.lastName || null; } catch {}
  }
  const out = await finishAuth(ctx, provider, info, req);
  if (out.kind === "error") return withHeaders(loginError(ctx, out.code), clear);
  if (out.kind === "redirect") return withHeaders(redirect(ctx.origin + out.path), clear);
  const h = new Headers({ location: ctx.origin + out.path, "cache-control": "no-store" });
  h.append("set-cookie", out.cookie);
  h.append("set-cookie", clearCookie(OAUTH_COOKIE, "/auth/", "None"));
  return new Response(null, { status: 302, headers: h });
}

// Commun à Google, Apple et au code par courriel : l'identité est déjà vérifiée ici (provider + subject).
// Retourne { kind: "error", code } | { kind: "redirect", path } | { kind: "session", path, cookie }.
async function finishAuth(ctx, provider, info, req) {
  const { env, now, request } = ctx;
  const existing = await env.DB.prepare("SELECT * FROM identities WHERE provider = ? AND subject = ?").bind(provider, info.subject).first();

  if (req.mode === "link") {
    const s = await readSession(ctx);
    if (!s || s.expired || s.user.id !== req.link_user_id) return { kind: "error", code: "connexion_requise" };
    if (existing && existing.user_id !== s.user.id) return { kind: "redirect", path: `${ACCOUNT_PAGE}?erreur=identite_deja_utilisee#profil` };
    if (!existing) {
      await env.DB.prepare("INSERT INTO identities (id, user_id, provider, subject, email, email_verified, is_private_email, created_at, last_login_at) VALUES (?,?,?,?,?,?,?,?,?)")
        .bind(uid(), s.user.id, provider, info.subject, info.email, info.emailVerified ? 1 : 0, info.isPrivateEmail ? 1 : 0, now, now).run();
      await audit(ctx, { actor: s.user.id, action: "identity.linked", target: s.user.id, details: { provider } });
    }
    return { kind: "redirect", path: `${ACCOUNT_PAGE}?associe=${provider}#profil` };
  }

  let userId;
  if (req.mode === "recovery") {
    const rec = await env.DB.prepare("SELECT * FROM recovery_links WHERE id = ?").bind(req.recovery_id).first();
    if (!rec || rec.used_at || rec.expires_at < now) return { kind: "error", code: "recuperation_invalide" };
    if (!info.emailVerified || info.email !== rec.email) return { kind: "error", code: "recuperation_courriel" };
    if (existing && existing.user_id !== rec.user_id) return { kind: "error", code: "identite_deja_utilisee" };
    const used = await env.DB.prepare("UPDATE recovery_links SET used_at = ? WHERE id = ? AND used_at IS NULL").bind(now, rec.id).run();
    if (!changes(used)) return { kind: "error", code: "recuperation_invalide" };
    if (!existing) await env.DB.prepare("INSERT INTO identities (id, user_id, provider, subject, email, email_verified, is_private_email, created_at, last_login_at) VALUES (?,?,?,?,?,?,?,?,?)")
      .bind(uid(), rec.user_id, provider, info.subject, info.email, 1, info.isPrivateEmail ? 1 : 0, now, now).run();
    await audit(ctx, { actor: rec.user_id, action: "recovery.used", target: rec.user_id, details: { provider } });
    userId = rec.user_id;
  } else if (existing) {
    userId = existing.user_id;
    await env.DB.prepare("UPDATE identities SET email = COALESCE(?, email), email_verified = ?, is_private_email = ?, last_login_at = ? WHERE id = ?")
      .bind(info.email, info.emailVerified ? 1 : 0, info.isPrivateEmail ? 1 : 0, now, existing.id).run();
  } else {
    // Nouveau compte : jamais rattaché à un compte existant sur la seule base de l'adresse courriel.
    userId = uid();
    await env.DB.batch([
      env.DB.prepare("INSERT INTO users (id, first_name, last_name, photo, locale, created_at, updated_at) VALUES (?,?,?,?,?,?,?)")
        .bind(userId, clip(info.givenName, 60), clip(info.familyName, 60), info.picture || null, "fr-CA", now, now),
      env.DB.prepare("INSERT INTO identities (id, user_id, provider, subject, email, email_verified, is_private_email, created_at, last_login_at) VALUES (?,?,?,?,?,?,?,?,?)")
        .bind(uid(), userId, provider, info.subject, info.email, info.emailVerified ? 1 : 0, info.isPrivateEmail ? 1 : 0, now, now),
    ]);
    await audit(ctx, { actor: userId, action: "account.created", target: userId, details: { provider } });
  }
  const user = await env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(userId).first();
  if (!user || user.status === "suspended") return { kind: "error", code: "compte_suspendu" };
  const token = randomToken(32);
  const firstOrg = await env.DB.prepare("SELECT org_id FROM memberships WHERE user_id = ? AND status = 'active' ORDER BY created_at LIMIT 1").bind(userId).first();
  await env.DB.prepare("INSERT INTO sessions (id_hash, user_id, created_at, auth_at, last_seen_at, expires_at, active_org_id, user_agent) VALUES (?,?,?,?,?,?,?,?)")
    .bind(await sha256(token), userId, now, now, now, now + SESSION_TTL, firstOrg?.org_id || null, clip(request.headers.get("user-agent"), 200)).run();
  const path = user.status === "deactivated" ? `${ACCOUNT_PAGE}#profil` : safeNext(req.next_path);
  return { kind: "session", path, cookie: cookie(SESSION_COOKIE, token, { path: "/", maxAge: SESSION_TTL / 1000, sameSite: "Lax" }) };
}

/* ===================== Code par courriel ===================== */
// Sans mot de passe : un code à 6 chiffres, valable 10 minutes, 5 essais, utilisable une seule fois,
// et lié au navigateur qui l'a demandé (témoin). Le compte est identifié par l'adresse ainsi vérifiée
// (fournisseur « email ») ; il n'est jamais fusionné avec un compte Google ou Apple de même adresse.
const EMAIL_CODE_TTL = 10 * 60e3;
const EMAIL_CODE_TRIES = 5;
const EMAIL_COOKIE = "__Secure-lq_ecode";
const EMAIL_RE = /^[^\s@<>"',;()]{1,64}@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*\.[a-z]{2,}$/;
export const normEmail = (e) => String(e || "").trim().toLowerCase();
const emailSender = (env) => env.AUTH_EMAIL || env.ALERT_EMAIL || null;
// Protection anti-robots (Cloudflare Turnstile). La clé de site est publique ; la vérification ne s'active
// que lorsque le secret TURNSTILE_SECRET est ajouté au relais. Sans lui, rien ne change.
const TURNSTILE_SITEKEY = "0x4AAAAAAFeXR1_bJkXdINQm";
const turnstileOn = (env) => !!env.TURNSTILE_SECRET;
export const providers = (env) => ({ ...providersStatus(env), email: !!emailSender(env), memberLink: memberLinkOn(env), turnstile: turnstileOn(env) ? (env.TURNSTILE_SITEKEY || TURNSTILE_SITEKEY) : null });
// Association d'une adresse courriel par les Membres : désactivée pour l'instant (activer en production
// avec la variable MEMBER_EMAIL_LINK = "on"). Les administrateurs et propriétaires gardent cette option.
const memberLinkOn = (env) => String(env.MEMBER_EMAIL_LINK || "").toLowerCase() === "on";
async function canLinkEmail(ctx, user) {
  if (memberLinkOn(ctx.env) || user.platform_admin) return true;
  return !!(await ctx.env.DB.prepare("SELECT 1 FROM memberships WHERE user_id = ? AND status = 'active' AND role IN ('owner','admin') LIMIT 1").bind(user.id).first());
}
async function checkHuman(ctx, token) {
  if (!turnstileOn(ctx.env)) return;
  const bad = () => { throw new HttpError(400, "La vérification anti-robots n'a pas abouti. Patientez un instant, puis réessayez.", "robot"); };
  if (!token || typeof token !== "string" || token.length > 2048) bad();
  let out = {};
  try {
    const r = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ secret: ctx.env.TURNSTILE_SECRET, response: token, remoteip: ctx.request.headers.get("cf-connecting-ip") || undefined }),
    });
    out = await r.json();
  } catch (e) { console.error("turnstile", e && e.message); throw new HttpError(503, "La vérification anti-robots est momentanément indisponible. Réessayez dans un instant.", "robot_unavailable"); }
  // Secret mal saisi dans Cloudflare : on ne bloque pas tout le monde (les autres limites restent actives) ; on le signale.
  const errs = Array.isArray(out["error-codes"]) ? out["error-codes"] : [];
  if (!out.success && errs.some((e) => e === "invalid-input-secret" || e === "missing-input-secret")) { console.error("turnstile: secret invalide", errs.join(",")); return; }
  // Jeton valide, à usage unique, émis pour ce site
  if (!out.success || (out.hostname && out.hostname !== new URL(ctx.origin).hostname)) bad();
}

function sixDigits() {
  const a = new Uint32Array(1);
  for (;;) { crypto.getRandomValues(a); if (a[0] < 4294000000) return String(a[0] % 1000000).padStart(6, "0"); } // sans biais
}

async function emailStart(ctx) {
  csrf(ctx);
  const { env, now } = ctx;
  if (!emailSender(env)) throw new HttpError(503, "La connexion par courriel n'est pas encore configurée.", "fournisseur_non_configure");
  const b = await body(ctx);
  const email = normEmail(b.email);
  if (!EMAIL_RE.test(email) || email.length > 254) throw new HttpError(400, "Adresse courriel invalide.", "courriel_invalide");
  const mode = ["login", "link", "recovery"].includes(b.mode) ? b.mode : "login";
  let linkUserId = null, recoveryId = null;
  if (mode === "link") {
    const s = await readSession(ctx);
    if (!s || s.expired || s.user.status !== "active") throw new HttpError(401, "Connectez-vous d'abord.", "connexion_requise");
    if (!(await canLinkEmail(ctx, s.user))) throw new HttpError(403, "L'association d'une adresse courriel n'est pas encore offerte aux membres.", "link_disabled");
    if (now - s.session.auth_at > REAUTH_WINDOW && (await identityCount(ctx, s.user.id)) > 0) throw new HttpError(403, "Par sécurité, reconnectez-vous avant d'associer un nouveau moyen de connexion.", "reauth");
    linkUserId = s.user.id;
  }
  if (mode === "recovery") {
    const rec = await env.DB.prepare("SELECT * FROM recovery_links WHERE token_hash = ?").bind(await sha256(String(b.token || ""))).first();
    if (!rec || rec.used_at || rec.expires_at < now) throw new HttpError(400, "Ce lien de récupération est invalide, expiré ou déjà utilisé.", "recuperation_invalide");
    if (rec.email !== email) throw new HttpError(400, "Utilisez l'adresse indiquée par l'administrateur dans le lien de récupération.", "recuperation_courriel");
    recoveryId = rec.id;
  }
  // Anti-robots avant tout envoi (l'association depuis Mon profil exige déjà une session)
  if (mode !== "link") await checkHuman(ctx, b.turnstile);
  // Limites : contre l'envoi massif et le harcèlement d'une boîte courriel.
  const ip = ctx.request.headers.get("cf-connecting-ip") || "?";
  await rateLimit(ctx, "ecode:mail:" + email, 5, 3600e3);
  await rateLimit(ctx, "ecode:ip:" + ip, 20, 3600e3);
  const token = randomToken(32), code = sixDigits();
  const idHash = await sha256(token);
  await env.DB.batch([
    env.DB.prepare("DELETE FROM email_codes WHERE email = ? OR expires_at < ?").bind(email, now), // un seul code valide à la fois
    env.DB.prepare("INSERT INTO email_codes (id_hash, email, code_hash, mode, next_path, link_user_id, recovery_id, created_at, expires_at) VALUES (?,?,?,?,?,?,?,?,?)")
      .bind(idHash, email, await sha256(token + ":" + code), mode, safeNext(b.next), linkUserId, recoveryId, now, now + EMAIL_CODE_TTL),
  ]);
  try { await sendCodeEmail(env, email, code, mode); }
  catch (e) {
    console.error("email code", e && (e.code || e.message));
    await env.DB.prepare("DELETE FROM email_codes WHERE id_hash = ?").bind(idHash).run();
    throw new HttpError(502, "Le courriel n'a pas pu être envoyé. Vérifiez l'adresse ou réessayez dans un instant.", "envoi_impossible");
  }
  // Même réponse que l'adresse ait un compte ou non : rien n'est révélé.
  return json(200, { ok: true, emailHint: maskEmail(email), expiresAt: now + EMAIL_CODE_TTL },
    { "set-cookie": cookie(EMAIL_COOKIE, token, { path: "/auth/email/", maxAge: EMAIL_CODE_TTL / 1000, sameSite: "Strict" }) });
}

async function emailVerify(ctx) {
  csrf(ctx);
  const { env, now } = ctx;
  const clear = clearCookie(EMAIL_COOKIE, "/auth/email/", "Strict");
  const fail = (status, code, error, { keep = false, ...extra } = {}) => json(status, { error, code, ...extra }, keep ? {} : { "set-cookie": clear });
  const token = readCookie(ctx.request, EMAIL_COOKIE);
  if (!token) return fail(400, "code_expire", "Ce code n'est plus valide. Demandez-en un nouveau.");
  const idHash = await sha256(token);
  const row = await env.DB.prepare("SELECT * FROM email_codes WHERE id_hash = ?").bind(idHash).first();
  if (!row || row.expires_at < now) {
    if (row) await env.DB.prepare("DELETE FROM email_codes WHERE id_hash = ?").bind(idHash).run();
    return fail(400, "code_expire", "Ce code a expiré. Demandez-en un nouveau.");
  }
  const b = await body(ctx);
  const code = String(b.code || "").replace(/\D/g, "");
  // L'essai est compté AVANT la comparaison (mise à jour conditionnelle) : impossible de dépasser la limite en parallèle.
  const tick = await env.DB.prepare("UPDATE email_codes SET attempts = attempts + 1 WHERE id_hash = ? AND attempts < ?").bind(idHash, EMAIL_CODE_TRIES).run();
  if (!changes(tick)) {
    await env.DB.prepare("DELETE FROM email_codes WHERE id_hash = ?").bind(idHash).run();
    return fail(429, "trop_essais", "Trop d'essais. Demandez un nouveau code.");
  }
  if (code.length !== 6 || !timingSafeEqual(await sha256(token + ":" + code), row.code_hash)) {
    const left = EMAIL_CODE_TRIES - row.attempts - 1;
    if (left <= 0) { await env.DB.prepare("DELETE FROM email_codes WHERE id_hash = ?").bind(idHash).run(); return fail(429, "trop_essais", "Trop d'essais. Demandez un nouveau code."); }
    return fail(400, "code_incorrect", `Code incorrect. Il vous reste ${left} essai${left > 1 ? "s" : ""}.`, { remaining: left, keep: true });
  }
  // Usage unique : seule la première suppression réussit.
  const del = await env.DB.prepare("DELETE FROM email_codes WHERE id_hash = ?").bind(idHash).run();
  if (!changes(del)) return fail(400, "code_expire", "Ce code n'est plus valide. Demandez-en un nouveau.");
  const info = { subject: row.email, email: row.email, emailVerified: true, isPrivateEmail: false, givenName: null, familyName: null, picture: null };
  const out = await finishAuth(ctx, "email", info, row);
  if (out.kind === "error") return fail(400, out.code, "La connexion a échoué.");
  const h = new Headers({ "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  h.append("set-cookie", clear);
  if (out.kind === "session") h.append("set-cookie", out.cookie);
  return new Response(JSON.stringify({ ok: true, next: out.path }), { status: 200, headers: h });
}

async function sendCodeEmail(env, to, code, mode) {
  const what = mode === "link" ? "associer cette adresse à votre compte La Qualia" : mode === "recovery" ? "récupérer l'accès à votre compte La Qualia" : "vous connecter à La Qualia";
  const text = `Votre code : ${code}\n\nEntrez ce code pour ${what}. Il est valable 10 minutes et ne peut servir qu'une fois.\n\nVous n'avez rien demandé ? Ignorez ce courriel : personne ne peut se connecter sans ce code.\nNe communiquez jamais ce code, même à l'équipe de La Qualia.\n\nLa Qualia · laqualia.com`;
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;max-width:480px;margin:0 auto;padding:24px;color:#101010">
<p style="font-size:15px;margin:0 0 16px">Entrez ce code pour ${what} :</p>
<p style="font-size:34px;font-weight:700;letter-spacing:8px;margin:0 0 16px;font-family:Consolas,Menlo,monospace">${code}</p>
<p style="font-size:14px;color:#55565d;margin:0 0 12px">Il est valable 10 minutes et ne peut servir qu'une fois.</p>
<p style="font-size:14px;color:#55565d;margin:0 0 12px">Vous n'avez rien demandé ? Ignorez ce courriel : personne ne peut se connecter sans ce code. Ne communiquez jamais ce code, même à l'équipe de La Qualia.</p>
<p style="font-size:13px;color:#8a8a90;margin:24px 0 0">La Qualia · laqualia.com</p></div>`;
  await emailSender(env).send({ to, from: { email: env.AUTH_FROM || "connexion@notif.laqualia.com", name: "La Qualia" }, subject: `${code} est votre code La Qualia`, text, html });
}

/* ===================== Session ===================== */
async function readSession(ctx) {
  const token = readCookie(ctx.request, SESSION_COOKIE);
  if (!token) return null;
  const idHash = await sha256(token);
  const session = await ctx.env.DB.prepare("SELECT * FROM sessions WHERE id_hash = ?").bind(idHash).first();
  if (!session) return null;
  if (session.expires_at < ctx.now || session.last_seen_at < ctx.now - idleFor(session)) {
    await ctx.env.DB.prepare("DELETE FROM sessions WHERE id_hash = ?").bind(idHash).run();
    return { expired: true };
  }
  const user = await ctx.env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(session.user_id).first();
  if (!user || user.status === "suspended") { await ctx.env.DB.prepare("DELETE FROM sessions WHERE user_id = ?").bind(session.user_id).run(); return null; }
  if (ctx.now - session.last_seen_at > 5 * 60e3) await ctx.env.DB.prepare("UPDATE sessions SET last_seen_at = ? WHERE id_hash = ?").bind(ctx.now, idHash).run();
  return { idHash, session, user };
}
async function requireUser(ctx, { allowDeactivated = false } = {}) {
  const s = await readSession(ctx);
  if (!s || s.expired) throw new HttpError(401, s?.expired ? "Votre session a expiré. Reconnectez-vous." : "Connexion requise.", s?.expired ? "session_expired" : "unauthenticated");
  if (s.user.status === "deactivated" && !allowDeactivated) throw new HttpError(403, "Votre compte est désactivé.", "account_deactivated");
  return s;
}

// Contexte d'établissement : vérifié à chaque requête. L'identifiant de l'URL ne donne aucun accès en soi.
async function orgContext(ctx, user, orgId) {
  const org = await ctx.env.DB.prepare("SELECT * FROM organizations WHERE id = ?").bind(orgId).first();
  const membership = org ? await ctx.env.DB.prepare("SELECT * FROM memberships WHERE org_id = ? AND user_id = ?").bind(orgId, user.id).first() : null;
  if (user.platform_admin) {
    if (!org) throw new HttpError(404, "Établissement introuvable.", "not_found");
    return { org, membership, level: "platform" };
  }
  // Même réponse que l'établissement existe ou non : on ne révèle rien hors de ses établissements.
  if (!org || !membership || org.status !== "active") throw new HttpError(404, "Établissement introuvable.", "not_found");
  if (membership.status !== "active") throw new HttpError(403, "Votre accès à cet établissement a été désactivé.", "membership_disabled");
  return { org, membership, level: membership.role };
}
function need(oc, action) { if (!can(oc.level, action)) throw new HttpError(403, "Vous n'avez pas la permission requise pour cette action.", "forbidden"); }

/* ===================== API ===================== */
async function routeApi(ctx) {
  const { url, request } = ctx;
  const M = request.method, p = url.pathname;
  let m;
  if (p === "/api/permissions" && M === "GET") return json(200, { matrix: MATRIX, roles: ROLES, roleLabels: ROLE_LABELS, functions: FUNCTIONS });
  if (p === "/api/me" && M === "GET") return getMe(ctx);
  if (p === "/api/me" && M === "PATCH") return patchMe(ctx);
  if ((m = p.match(/^\/api\/me\/identities\/([\w-]+)$/)) && M === "DELETE") return unlinkIdentity(ctx, m[1]);
  if (p === "/api/me/deactivate" && M === "POST") return deactivateMe(ctx);
  if (p === "/api/me/reactivate" && M === "POST") return reactivateMe(ctx);
  if (p === "/api/me/delete" && M === "POST") return deleteMe(ctx);
  if (p === "/api/session/org" && M === "POST") return selectOrg(ctx);
  if ((m = p.match(/^\/api\/invitations\/([\w-]{20,})$/)) && M === "GET") return previewInvitation(ctx, m[1]);
  if ((m = p.match(/^\/api\/invitations\/([\w-]{20,})\/accept$/)) && M === "POST") return acceptInvitation(ctx, m[1]);
  if ((m = p.match(/^\/api\/orgs\/([\w-]+)$/))) { if (M === "GET") return getOrg(ctx, m[1]); if (M === "PATCH") return patchOrg(ctx, m[1]); }
  if ((m = p.match(/^\/api\/orgs\/([\w-]+)\/members$/)) && M === "GET") return listMembers(ctx, m[1]);
  if ((m = p.match(/^\/api\/orgs\/([\w-]+)\/members\/([\w-]+)$/))) { if (M === "PATCH") return patchMember(ctx, m[1], m[2]); if (M === "DELETE") return removeMember(ctx, m[1], m[2]); }
  if ((m = p.match(/^\/api\/orgs\/([\w-]+)\/leave$/)) && M === "POST") return leaveOrg(ctx, m[1]);
  if ((m = p.match(/^\/api\/orgs\/([\w-]+)\/transfer$/)) && M === "POST") return transferOwnership(ctx, m[1]);
  if ((m = p.match(/^\/api\/orgs\/([\w-]+)\/invitations$/))) { if (M === "GET") return listInvitations(ctx, m[1]); if (M === "POST") return createInvitation(ctx, m[1]); }
  if ((m = p.match(/^\/api\/orgs\/([\w-]+)\/invitations\/([\w-]+)$/)) && M === "DELETE") return revokeInvitation(ctx, m[1], m[2]);
  if ((m = p.match(/^\/api\/orgs\/([\w-]+)\/audit$/)) && M === "GET") return listAudit(ctx, m[1]);
  if (p === "/api/access/status" && M === "GET") return accessStatus(ctx);
  if (p === "/api/access/redeem" && M === "POST") return redeemAccessCode(ctx);
  if ((m = p.match(/^\/api\/orgs\/([\w-]+)\/access-codes$/))) { if (M === "GET") return listAccessCodes(ctx, m[1]); if (M === "POST") return createAccessCode(ctx, m[1]); }
  if ((m = p.match(/^\/api\/orgs\/([\w-]+)\/access-codes\/([\w-]+)\/renew$/)) && M === "POST") return renewAccessCode(ctx, m[1], m[2]);
  if ((m = p.match(/^\/api\/orgs\/([\w-]+)\/access-codes\/([\w-]+)$/)) && M === "DELETE") return revokeAccessCode(ctx, m[1], m[2]);
  if (p === "/api/favorites") { if (M === "GET") return listFavorites(ctx); if (M === "POST") return addFavorite(ctx); }
  if ((m = p.match(/^\/api\/favorites\/([\w-]+)$/))) { if (M === "GET") return getFavorite(ctx, m[1]); if (M === "DELETE") return removeFavorite(ctx, m[1]); }
  if (p === "/api/platform/bootstrap" && M === "POST") return bootstrapPlatform(ctx);
  if (p === "/api/platform/orgs") { if (M === "GET") return platformOrgs(ctx); if (M === "POST") return createOrg(ctx); }
  if (p === "/api/platform/users" && M === "GET") return platformUsers(ctx);
  if ((m = p.match(/^\/api\/platform\/users\/([\w-]+)\/status$/)) && M === "POST") return platformUserStatus(ctx, m[1]);
  if ((m = p.match(/^\/api\/platform\/users\/([\w-]+)\/recovery$/)) && M === "POST") return createRecovery(ctx, m[1]);
  return json(404, { error: "Introuvable.", code: "not_found" });
}

/* ----- Mon profil ----- */
async function getMe(ctx) {
  const { user, session } = await requireUser(ctx, { allowDeactivated: true });
  const db = ctx.env.DB;
  const ids = (await db.prepare("SELECT id, provider, email, email_verified, is_private_email, created_at, last_login_at FROM identities WHERE user_id = ? ORDER BY created_at").bind(user.id).all()).results;
  const mem = (await db.prepare("SELECT m.id, m.org_id, m.role, m.function, m.status, o.name AS org_name, o.city AS org_city, o.logo AS org_logo FROM memberships m JOIN organizations o ON o.id = m.org_id WHERE m.user_id = ? AND o.status = 'active' ORDER BY o.name").bind(user.id).all()).results;
  const platformHasAdmin = !!(await db.prepare("SELECT 1 FROM users WHERE platform_admin = 1 LIMIT 1").first());
  return json(200, {
    user: publicUser(user), identities: ids.map((i) => ({ ...i, email_verified: !!i.email_verified, is_private_email: !!i.is_private_email })),
    memberships: mem.map((x) => ({ ...x, permissions: x.status === "active" ? permissionsFor(user.platform_admin ? "platform" : x.role) : [] })),
    activeOrgId: (mem.some((x) => x.org_id === session.active_org_id && x.status === "active") || (user.platform_admin && session.active_org_id)) ? session.active_org_id : (mem.find((x) => x.status === "active")?.org_id || null),
    session: { expiresAt: Math.min(session.expires_at, session.last_seen_at + idleFor(session)), authAt: session.auth_at, kind: session.kind || "auth", idleHours: idleFor(session) / 3600e3 },
    providers: providers(ctx.env), canLinkEmail: await canLinkEmail(ctx, user), platform: { isAdmin: !!user.platform_admin, canBootstrap: !platformHasAdmin && !!ctx.env.ADMIN_CODE },
  });
}
const publicUser = (u) => ({ id: u.id, contact_email: u.contact_email || null, signup: u.signup || null, first_name: u.first_name, last_name: u.last_name, photo: u.photo, locale: u.locale, job_title: u.job_title, notif_prefs: safeJson(u.notif_prefs, {}), status: u.status, platform_admin: !!u.platform_admin, created_at: u.created_at });

async function patchMe(ctx) {
  const { user } = await requireUser(ctx);
  const b = await body(ctx);
  const f = {};
  if ("first_name" in b) f.first_name = clip(b.first_name, 60);
  if ("last_name" in b) f.last_name = clip(b.last_name, 60);
  if ("job_title" in b) f.job_title = clip(b.job_title, 80);
  if ("contact_email" in b) {
    const e = normEmail(b.contact_email);
    if (e && (!EMAIL_RE.test(e) || e.length > 254)) throw new HttpError(400, "Adresse courriel invalide.", "invalid");
    f.contact_email = e || null; // coordonnée non vérifiée : jamais utilisée pour se connecter
  }
  if ("locale" in b) { if (!["fr-CA", "en-CA"].includes(b.locale)) throw new HttpError(400, "Langue non prise en charge.", "invalid"); f.locale = b.locale; }
  if ("photo" in b) f.photo = validImage(b.photo);
  if ("notif_prefs" in b) {
    const n = b.notif_prefs || {};
    f.notif_prefs = JSON.stringify({ invitations: !!n.invitations, roleChanges: !!n.roleChanges, product: !!n.product });
  }
  const keys = Object.keys(f);
  if (!keys.length) throw new HttpError(400, "Aucune modification reçue.", "invalid");
  await ctx.env.DB.prepare(`UPDATE users SET ${keys.map((k) => `${k} = ?`).join(", ")}, updated_at = ? WHERE id = ?`).bind(...keys.map((k) => f[k]), ctx.now, user.id).run();
  return getMe(ctx);
}

async function unlinkIdentity(ctx, id) {
  const { user } = await requireUser(ctx);
  const n = (await ctx.env.DB.prepare("SELECT COUNT(*) AS n FROM identities WHERE user_id = ?").bind(user.id).first()).n;
  if (n <= 1) throw new HttpError(409, "Gardez au moins un moyen de connexion : associez-en un autre avant de retirer celui-ci.", "last_identity");
  const r = await ctx.env.DB.prepare("DELETE FROM identities WHERE id = ? AND user_id = ?").bind(id, user.id).run();
  if (!changes(r)) throw new HttpError(404, "Moyen de connexion introuvable.", "not_found");
  await audit(ctx, { actor: user.id, action: "identity.unlinked", target: user.id });
  return getMe(ctx);
}

async function soleOwnerOrgs(ctx, userId) {
  return (await ctx.env.DB.prepare(`SELECT o.name FROM memberships m JOIN organizations o ON o.id = m.org_id
    WHERE m.user_id = ? AND m.role = 'owner' AND m.status = 'active' AND o.status = 'active'
    AND (SELECT COUNT(*) FROM memberships x WHERE x.org_id = m.org_id AND x.role = 'owner' AND x.status = 'active') = 1`).bind(userId).all()).results.map((r) => r.name);
}

async function deactivateMe(ctx) {
  const { user } = await requireUser(ctx);
  const b = await body(ctx);
  if (b.confirm !== true) throw new HttpError(400, "Confirmation requise.", "confirm");
  const orgs = await soleOwnerOrgs(ctx, user.id);
  if (orgs.length) throw new HttpError(409, `Vous êtes le seul propriétaire de : ${orgs.join(", ")}. Transférez d'abord la propriété.`, "last_owner", { orgs });
  await ctx.env.DB.batch([
    ctx.env.DB.prepare("UPDATE users SET status = 'deactivated', updated_at = ? WHERE id = ?").bind(ctx.now, user.id),
    ctx.env.DB.prepare("DELETE FROM sessions WHERE user_id = ?").bind(user.id),
  ]);
  await audit(ctx, { actor: user.id, action: "account.deactivated", target: user.id });
  return json(200, { ok: true }, { "set-cookie": clearCookie(SESSION_COOKIE, "/") });
}
async function reactivateMe(ctx) {
  const { user } = await requireUser(ctx, { allowDeactivated: true });
  if (user.status !== "deactivated") return getMe(ctx);
  await ctx.env.DB.prepare("UPDATE users SET status = 'active', updated_at = ? WHERE id = ?").bind(ctx.now, user.id).run();
  await audit(ctx, { actor: user.id, action: "account.reactivated", target: user.id });
  return getMe(ctx);
}
// Suppression : traitée immédiatement après confirmation explicite.
async function deleteMe(ctx) {
  const { user } = await requireUser(ctx, { allowDeactivated: true });
  const b = await body(ctx);
  if (String(b.confirm || "").trim().toUpperCase() !== "SUPPRIMER") throw new HttpError(400, "Tapez SUPPRIMER pour confirmer.", "confirm");
  const orgs = await soleOwnerOrgs(ctx, user.id);
  if (orgs.length) throw new HttpError(409, `Vous êtes le seul propriétaire de : ${orgs.join(", ")}. Transférez d'abord la propriété.`, "last_owner", { orgs });
  const db = ctx.env.DB;
  const orgIds = (await db.prepare("SELECT org_id FROM memberships WHERE user_id = ?").bind(user.id).all()).results.map((r) => r.org_id);
  // Profil, photo, moyens de connexion, sessions, appartenances et liens de récupération : supprimés (cascade).
  await db.batch([
    db.prepare("DELETE FROM sessions WHERE user_id = ?").bind(user.id),
    db.prepare("DELETE FROM favorites WHERE user_id = ?").bind(user.id),
    db.prepare("DELETE FROM identities WHERE user_id = ?").bind(user.id),
    db.prepare("DELETE FROM memberships WHERE user_id = ?").bind(user.id),
    db.prepare("DELETE FROM recovery_links WHERE user_id = ?").bind(user.id),
    db.prepare("DELETE FROM users WHERE id = ?").bind(user.id),
  ]);
  // Journal des établissements : on garde l'événement (identifiant interne seulement, aucune donnée personnelle).
  for (const o of orgIds) await audit(ctx, { org: o, actor: user.id, action: "account.deleted", target: user.id });
  return json(200, { ok: true }, { "set-cookie": clearCookie(SESSION_COOKIE, "/") });
}

async function selectOrg(ctx) {
  const { user, idHash } = await requireUser(ctx);
  const b = await body(ctx);
  await orgContext(ctx, user, String(b.orgId || ""));
  await ctx.env.DB.prepare("UPDATE sessions SET active_org_id = ? WHERE id_hash = ?").bind(String(b.orgId), idHash).run();
  return json(200, { ok: true, activeOrgId: String(b.orgId) });
}

/* ----- Établissement ----- */
async function getOrg(ctx, orgId) {
  const { user } = await requireUser(ctx);
  const oc = await orgContext(ctx, user, orgId);
  const counts = can(oc.level, "members.read") ? await ctx.env.DB.prepare(`SELECT
      (SELECT COUNT(*) FROM memberships WHERE org_id = ?1 AND status = 'active') AS active,
      (SELECT COUNT(*) FROM memberships WHERE org_id = ?1 AND status = 'disabled') AS disabled,
      (SELECT COUNT(*) FROM invitations WHERE org_id = ?1 AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > ?2) AS invited`).bind(orgId, ctx.now).first() : null;
  return json(200, { org: oc.org, membership: oc.membership, level: oc.level, permissions: permissionsFor(oc.level), counts });
}
async function patchOrg(ctx, orgId) {
  const { user } = await requireUser(ctx);
  const oc = await orgContext(ctx, user, orgId); need(oc, "org.update");
  const b = await body(ctx);
  const name = "name" in b ? clip(b.name, 120) : oc.org.name;
  if (!name) throw new HttpError(400, "Le nom de l'établissement est obligatoire.", "invalid");
  const city = "city" in b ? clip(b.city, 80) : oc.org.city;
  const logo = "logo" in b ? validImage(b.logo) : oc.org.logo;
  await ctx.env.DB.prepare("UPDATE organizations SET name = ?, city = ?, logo = ?, updated_at = ? WHERE id = ?").bind(name, city, logo, ctx.now, orgId).run();
  await audit(ctx, { org: orgId, actor: user.id, action: "org.updated", details: { fields: Object.keys(b).filter((k) => ["name", "city", "logo"].includes(k)) } });
  return getOrg(ctx, orgId);
}

/* ----- Membres ----- */
async function memberRows(ctx, orgId) {
  return (await ctx.env.DB.prepare(`SELECT m.id, m.user_id, m.role, m.function, m.status, m.created_at, m.updated_at, u.first_name, u.last_name, u.photo, u.job_title, u.status AS user_status,
      COALESCE((SELECT i.email FROM identities i WHERE i.user_id = m.user_id ORDER BY i.is_private_email, i.created_at LIMIT 1), u.contact_email) AS email,
      NOT EXISTS (SELECT 1 FROM identities i WHERE i.user_id = m.user_id) AS email_unverified, u.signup AS signup,
      (SELECT MAX(s.last_seen_at) FROM sessions s WHERE s.user_id = m.user_id) AS last_seen_at
    FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.org_id = ? ORDER BY u.first_name, u.last_name`).bind(orgId).all()).results;
}
async function listMembers(ctx, orgId) {
  const { user } = await requireUser(ctx);
  const oc = await orgContext(ctx, user, orgId); need(oc, "members.read");
  const q = (ctx.url.searchParams.get("q") || "").trim().toLowerCase();
  const fStatus = ctx.url.searchParams.get("status"), fRole = ctx.url.searchParams.get("role"), fFn = ctx.url.searchParams.get("function");
  let rows = (await memberRows(ctx, orgId)).map((r) => ({ type: "member", ...r, self: r.user_id === user.id }));
  if (can(oc.level, "invitations.read")) {
    const inv = (await ctx.env.DB.prepare("SELECT id, email, role, function, created_at, expires_at FROM invitations WHERE org_id = ? AND accepted_at IS NULL AND revoked_at IS NULL ORDER BY created_at DESC").bind(orgId).all()).results;
    rows = rows.concat(inv.map((i) => ({ type: "invitation", id: i.id, email: i.email, role: i.role, function: i.function, status: i.expires_at > ctx.now ? "invited" : "expired", created_at: i.created_at, expires_at: i.expires_at })));
  }
  rows = rows.filter((r) =>
    (!fStatus || r.status === fStatus) && (!fRole || r.role === fRole) && (!fFn || r.function === fFn) &&
    (!q || [r.first_name, r.last_name, r.email, r.job_title].filter(Boolean).join(" ").toLowerCase().includes(q)));
  return json(200, { members: rows, level: oc.level, permissions: permissionsFor(oc.level) });
}
async function targetMember(ctx, orgId, memberId) {
  // Toujours filtré par établissement : un identifiant d'un autre établissement ne correspond à rien.
  return ctx.env.DB.prepare("SELECT * FROM memberships WHERE id = ? AND org_id = ?").bind(memberId, orgId).first();
}
async function activeOwners(ctx, orgId) {
  return (await ctx.env.DB.prepare("SELECT COUNT(*) AS n FROM memberships WHERE org_id = ? AND role = 'owner' AND status = 'active'").bind(orgId).first()).n;
}
async function patchMember(ctx, orgId, memberId) {
  const { user } = await requireUser(ctx);
  const oc = await orgContext(ctx, user, orgId);
  const t = await targetMember(ctx, orgId, memberId);
  const b = await body(ctx);
  const newRole = b.role, newFn = b.function, newStatus = b.status;
  if (newRole !== undefined) need(oc, "members.update_role");
  if (newFn !== undefined) need(oc, "members.update_function");
  if (newStatus !== undefined) need(oc, "members.disable");
  const err = checkTarget(oc.level, user.id, t, newRole);
  if (err) throw new HttpError(t ? 403 : 404, err, t ? "forbidden" : "not_found");
  if (newFn !== undefined && !(newFn in FUNCTIONS)) throw new HttpError(400, "Fonction inconnue.", "invalid");
  if (newStatus !== undefined && !["active", "disabled"].includes(newStatus)) throw new HttpError(400, "Statut inconnu.", "invalid");
  if (newStatus !== undefined && t.user_id === user.id) throw new HttpError(409, "Vous ne pouvez pas désactiver votre propre accès. Utilisez « Quitter l'établissement ».", "self");
  const losesOwner = t.role === "owner" && t.status === "active" && ((newRole !== undefined && newRole !== "owner") || newStatus === "disabled");
  if (losesOwner && (await activeOwners(ctx, orgId)) <= 1) throw new HttpError(409, "C'est le dernier propriétaire : transférez d'abord la propriété à un autre membre.", "last_owner");
  const f = {};
  if (newRole !== undefined && newRole !== t.role) f.role = newRole;
  if (newFn !== undefined && newFn !== t.function) f.function = newFn;
  if (newStatus !== undefined && newStatus !== t.status) f.status = newStatus;
  const keys = Object.keys(f);
  if (keys.length) {
    await ctx.env.DB.prepare(`UPDATE memberships SET ${keys.map((k) => `${k} = ?`).join(", ")}, updated_at = ? WHERE id = ? AND org_id = ?`).bind(...keys.map((k) => f[k]), ctx.now, memberId, orgId).run();
    if (f.role) await audit(ctx, { org: orgId, actor: user.id, action: "member.role_changed", target: t.user_id, details: { from: t.role, to: f.role } });
    if (f.function) await audit(ctx, { org: orgId, actor: user.id, action: "member.function_changed", target: t.user_id, details: { from: t.function, to: f.function } });
    if (f.status) await audit(ctx, { org: orgId, actor: user.id, action: f.status === "disabled" ? "member.disabled" : "member.enabled", target: t.user_id });
  }
  return json(200, { ok: true, member: await targetMember(ctx, orgId, memberId) });
}
async function removeMember(ctx, orgId, memberId) {
  const { user } = await requireUser(ctx);
  const oc = await orgContext(ctx, user, orgId); need(oc, "members.remove");
  const t = await targetMember(ctx, orgId, memberId);
  const err = checkTarget(oc.level, user.id, t);
  if (err) throw new HttpError(t ? 403 : 404, err, t ? "forbidden" : "not_found");
  if (t.user_id === user.id) throw new HttpError(409, "Pour vous retirer vous-même, utilisez « Quitter l'établissement ».", "self");
  if (t.role === "owner" && t.status === "active" && (await activeOwners(ctx, orgId)) <= 1) throw new HttpError(409, "C'est le dernier propriétaire : transférez d'abord la propriété.", "last_owner");
  await ctx.env.DB.batch([
    ctx.env.DB.prepare("DELETE FROM memberships WHERE id = ? AND org_id = ?").bind(memberId, orgId),
    ctx.env.DB.prepare("UPDATE sessions SET active_org_id = NULL WHERE user_id = ? AND active_org_id = ?").bind(t.user_id, orgId),
    ctx.env.DB.prepare("DELETE FROM favorites WHERE user_id = ? AND org_id = ?").bind(t.user_id, orgId),
  ]);
  await audit(ctx, { org: orgId, actor: user.id, action: "member.removed", target: t.user_id, details: { role: t.role } });
  return json(200, { ok: true });
}
async function leaveOrg(ctx, orgId) {
  const { user } = await requireUser(ctx);
  const oc = await orgContext(ctx, user, orgId);
  if (!oc.membership) throw new HttpError(404, "Vous n'êtes pas membre de cet établissement.", "not_found");
  if (oc.membership.role === "owner" && (await activeOwners(ctx, orgId)) <= 1) throw new HttpError(409, "Vous êtes le dernier propriétaire : transférez d'abord la propriété avant de quitter.", "last_owner");
  await ctx.env.DB.batch([
    ctx.env.DB.prepare("DELETE FROM memberships WHERE id = ? AND org_id = ?").bind(oc.membership.id, orgId),
    ctx.env.DB.prepare("DELETE FROM favorites WHERE user_id = ? AND org_id = ?").bind(user.id, orgId),
  ]);
  await audit(ctx, { org: orgId, actor: user.id, action: "member.left", target: user.id });
  return json(200, { ok: true });
}
async function transferOwnership(ctx, orgId) {
  const { user } = await requireUser(ctx);
  const oc = await orgContext(ctx, user, orgId); need(oc, "ownership.transfer");
  const b = await body(ctx);
  const t = await targetMember(ctx, orgId, String(b.memberId || ""));
  if (!t) throw new HttpError(404, "Membre introuvable dans cet établissement.", "not_found");
  if (t.status !== "active") throw new HttpError(409, "Le nouveau propriétaire doit avoir un accès actif.", "inactive");
  if (t.user_id === user.id) throw new HttpError(409, "Choisissez une autre personne.", "self");
  const stmts = [ctx.env.DB.prepare("UPDATE memberships SET role = 'owner', updated_at = ? WHERE id = ? AND org_id = ?").bind(ctx.now, t.id, orgId)];
  const keep = b.keepMyOwnership === true;
  if (oc.membership && oc.membership.role === "owner" && !keep) stmts.push(ctx.env.DB.prepare("UPDATE memberships SET role = 'admin', updated_at = ? WHERE id = ? AND org_id = ?").bind(ctx.now, oc.membership.id, orgId));
  await ctx.env.DB.batch(stmts);
  await audit(ctx, { org: orgId, actor: user.id, action: "ownership.transferred", target: t.user_id, details: { previousRole: t.role, actorKeepsOwnership: keep } });
  return json(200, { ok: true });
}

/* ----- Invitations ----- */
async function listInvitations(ctx, orgId) {
  const { user } = await requireUser(ctx);
  const oc = await orgContext(ctx, user, orgId); need(oc, "invitations.read");
  const rows = (await ctx.env.DB.prepare("SELECT id, email, role, function, created_at, expires_at, accepted_at, revoked_at FROM invitations WHERE org_id = ? ORDER BY created_at DESC LIMIT 200").bind(orgId).all()).results;
  return json(200, { invitations: rows.map((i) => ({ ...i, state: i.accepted_at ? "accepted" : i.revoked_at ? "revoked" : i.expires_at < ctx.now ? "expired" : "pending" })) });
}
async function createInvitation(ctx, orgId) {
  const { user } = await requireUser(ctx);
  const oc = await orgContext(ctx, user, orgId); need(oc, "members.invite");
  const b = await body(ctx);
  const email = String(b.email || "").trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) || email.length > 200) throw new HttpError(400, "Adresse courriel invalide.", "invalid");
  const role = b.role || "member";
  if (!ROLES.includes(role)) throw new HttpError(400, "Rôle inconnu.", "invalid");
  if (role === "owner") need(oc, "members.invite_owner");
  const fn = b.function || "other";
  if (!(fn in FUNCTIONS)) throw new HttpError(400, "Fonction inconnue.", "invalid");
  const dup = await ctx.env.DB.prepare("SELECT id FROM invitations WHERE org_id = ? AND email = ? AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > ?").bind(orgId, email, ctx.now).first();
  if (dup) throw new HttpError(409, "Une invitation est déjà en attente pour cette adresse. Révoquez-la pour en créer une nouvelle.", "duplicate");
  const token = randomToken(32), id = uid();
  await ctx.env.DB.prepare("INSERT INTO invitations (id, org_id, email, role, function, token_hash, invited_by, created_at, expires_at) VALUES (?,?,?,?,?,?,?,?,?)")
    .bind(id, orgId, email, role, fn, await sha256(token), user.id, ctx.now, ctx.now + INVITE_TTL).run();
  await audit(ctx, { org: orgId, actor: user.id, action: "invitation.created", details: { invitationId: id, email: maskEmail(email), role, function: fn } });
  // Le lien n'est montré qu'une fois. Aucun courriel n'est envoyé automatiquement : le responsable le transmet lui-même.
  return json(201, { invitation: { id, email, role, function: fn, expires_at: ctx.now + INVITE_TTL }, link: `${ctx.origin}/agent/invitation.html#${token}` });
}
async function revokeInvitation(ctx, orgId, invId) {
  const { user } = await requireUser(ctx);
  const oc = await orgContext(ctx, user, orgId); need(oc, "invitations.revoke");
  const inv = await ctx.env.DB.prepare("SELECT * FROM invitations WHERE id = ? AND org_id = ?").bind(invId, orgId).first();
  if (!inv) throw new HttpError(404, "Invitation introuvable.", "not_found");
  if (inv.role === "owner") need(oc, "members.invite_owner");
  const r = await ctx.env.DB.prepare("UPDATE invitations SET revoked_at = ?, revoked_by = ? WHERE id = ? AND org_id = ? AND accepted_at IS NULL AND revoked_at IS NULL").bind(ctx.now, user.id, invId, orgId).run();
  if (!changes(r)) throw new HttpError(409, "Cette invitation a déjà été utilisée ou révoquée.", "not_pending");
  await audit(ctx, { org: orgId, actor: user.id, action: "invitation.revoked", details: { invitationId: invId, email: maskEmail(inv.email) } });
  return json(200, { ok: true });
}
async function invitationByToken(ctx, token) {
  return ctx.env.DB.prepare("SELECT i.*, o.name AS org_name, o.status AS org_status FROM invitations i JOIN organizations o ON o.id = i.org_id WHERE i.token_hash = ?").bind(await sha256(token)).first();
}
const invState = (i, now) => (!i || i.org_status !== "active" ? "invalid" : i.accepted_at ? "used" : i.revoked_at ? "revoked" : i.expires_at < now ? "expired" : "pending");
async function previewInvitation(ctx, token) {
  const i = await invitationByToken(ctx, token);
  const state = invState(i, ctx.now);
  if (state === "invalid") return json(404, { state, error: "Invitation introuvable." });
  return json(200, { state, orgName: i.org_name, role: i.role, roleLabel: ROLE_LABELS[i.role], function: i.function, emailHint: maskEmail(i.email), expiresAt: i.expires_at });
}
async function acceptInvitation(ctx, token) {
  const { user } = await requireUser(ctx);
  const i = await invitationByToken(ctx, token);
  const state = invState(i, ctx.now);
  const msg = { invalid: "Invitation introuvable.", used: "Cette invitation a déjà été utilisée.", revoked: "Cette invitation a été révoquée.", expired: "Cette invitation a expiré. Demandez-en une nouvelle." };
  if (state !== "pending") throw new HttpError(state === "invalid" ? 404 : 410, msg[state], "invitation_" + state);
  // Vérification du destinataire : une adresse vérifiée par le fournisseur doit correspondre exactement.
  const ids = (await ctx.env.DB.prepare("SELECT email, email_verified, is_private_email, provider FROM identities WHERE user_id = ?").bind(user.id).all()).results;
  const ok = ids.some((x) => x.email_verified && x.email && x.email.toLowerCase() === i.email);
  if (!ok) throw new HttpError(403, `Cette invitation est destinée à ${maskEmail(i.email)}. Connectez-vous avec un moyen de connexion qui utilise cette adresse, ou demandez une invitation à l'adresse de votre compte.`, "email_mismatch",
    { yourEmails: ids.map((x) => ({ provider: x.provider, email: x.email, private: !!x.is_private_email })) });
  const existing = await ctx.env.DB.prepare("SELECT * FROM memberships WHERE org_id = ? AND user_id = ?").bind(i.org_id, user.id).first();
  if (existing && existing.status === "active") throw new HttpError(409, "Vous êtes déjà membre de cet établissement.", "already_member");
  if (existing && existing.status === "disabled") throw new HttpError(409, "Votre accès à cet établissement est désactivé. Un responsable doit le réactiver.", "membership_disabled");
  // Usage unique, même en cas de double clic : la mise à jour conditionnelle ne réussit qu'une fois.
  const r = await ctx.env.DB.prepare("UPDATE invitations SET accepted_at = ?, accepted_by = ? WHERE id = ? AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > ?").bind(ctx.now, user.id, i.id, ctx.now).run();
  if (!changes(r)) throw new HttpError(410, "Cette invitation n'est plus valide.", "invitation_used");
  await ctx.env.DB.prepare("INSERT INTO memberships (id, org_id, user_id, role, function, status, created_at, updated_at) VALUES (?,?,?,?,?,'active',?,?)").bind(uid(), i.org_id, user.id, i.role, i.function, ctx.now, ctx.now).run();
  await audit(ctx, { org: i.org_id, actor: user.id, action: "invitation.accepted", target: user.id, details: { invitationId: i.id, role: i.role } });
  return json(200, { ok: true, orgId: i.org_id, orgName: i.org_name });
}

/* ----- Codes d'accès d'établissement ----- */
// Un administrateur génère un code et le transmet lui-même. Une personne connectée le saisit une seule fois
// et devient Membre (jamais davantage). Le code n'apparaît jamais dans une URL ni dans le journal.
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // sans I, L, O, 0, 1 (confusions)
const CODE_LEN = 12;
export const normAccessCode = (c) => String(c || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
function newAccessCode() {
  const out = []; const buf = new Uint8Array(32);
  while (out.length < CODE_LEN) {
    crypto.getRandomValues(buf);
    for (const b of buf) { if (b < 248 && out.length < CODE_LEN) out.push(CODE_ALPHABET[b % 31]); } // 248 = 8 × 31 : sans biais
  }
  return out.join("").replace(/(.{4})(?=.)/g, "$1-");
}
const accessHash = (code) => sha256("lq-access:" + normAccessCode(code));
async function codeKey(env) {
  const secret = env.ACCESS_CODE_KEY || env.ADMIN_CODE;
  if (!secret) return null;
  const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(String(secret)), "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt: new TextEncoder().encode("laqualia-access-codes"), info: new TextEncoder().encode("v1") }, base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}
const b64 = (u8) => btoa(String.fromCharCode(...u8));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
async function sealCode(env, code, aad) {
  const key = await codeKey(env); if (!key) return "";
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: new TextEncoder().encode(aad) }, key, new TextEncoder().encode(code)));
  return "v1." + b64(iv) + "." + b64(ct);
}
async function openCode(env, sealed, aad) {
  try {
    const [v, iv, ct] = String(sealed || "").split(".");
    if (v !== "v1") return null;
    const key = await codeKey(env); if (!key) return null;
    return new TextDecoder().decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(iv), additionalData: new TextEncoder().encode(aad) }, key, unb64(ct)));
  } catch { return null; }
}
const codeState = (c, now) => (c.revoked_at ? "revoked" : c.expires_at <= now ? "expired" : c.max_uses != null && c.uses >= c.max_uses ? "exhausted" : "active");
async function accessCodeView(ctx, c) {
  const state = codeState(c, ctx.now);
  // Le code en clair n'est renvoyé qu'à un administrateur, et seulement tant qu'il est utilisable.
  const code = state === "active" ? await openCode(ctx.env, c.code_enc, c.id + ":" + c.org_id) : null;
  return { id: c.id, label: c.label, state, code, hint: c.code_hint, maxUses: c.max_uses, uses: c.uses, expiresAt: c.expires_at, createdAt: c.created_at, lastUsedAt: c.last_used_at, revokedAt: c.revoked_at,
    createdBy: [c.cb_first, c.cb_last].filter(Boolean).join(" ") || null, unreadable: state === "active" && !code };
}
async function listAccessCodes(ctx, orgId) {
  const { user } = await requireUser(ctx);
  const oc = await orgContext(ctx, user, orgId); need(oc, "access_codes.read");
  const rows = (await ctx.env.DB.prepare(`SELECT c.*, u.first_name AS cb_first, u.last_name AS cb_last FROM access_codes c LEFT JOIN users u ON u.id = c.created_by
    WHERE c.org_id = ? ORDER BY c.created_at DESC LIMIT 100`).bind(orgId).all()).results;
  return json(200, { codes: await Promise.all(rows.map((c) => accessCodeView(ctx, c))), keyReady: !!(ctx.env.ACCESS_CODE_KEY || ctx.env.ADMIN_CODE) });
}
// Durée de validité choisie par l'administrateur, en heures (1 à 720, soit 30 jours). Par défaut : 24 h, usage unique.
const CODE_HOURS_MAX = 720;
function codeSettings(b) {
  const hours = b.expiresInHours === undefined || b.expiresInHours === null || b.expiresInHours === "" ? 24 : Number(b.expiresInHours);
  if (!Number.isInteger(hours) || hours < 1 || hours > CODE_HOURS_MAX) throw new HttpError(400, `La durée de validité doit être un nombre entier d'heures, entre 1 et ${CODE_HOURS_MAX}.`, "invalid");
  let maxUses = b.maxUses === undefined ? 1 : b.maxUses === null || b.maxUses === "" ? null : Math.round(Number(b.maxUses));
  if (maxUses !== null && !(maxUses >= 1 && maxUses <= 10000)) throw new HttpError(400, "Le nombre maximal d'utilisations doit être entre 1 et 10 000 (ou illimité).", "invalid");
  return { hours, maxUses, label: clip(b.label, 60) };
}
async function insertAccessCode(ctx, orgId, userId, { hours, maxUses, label }) {
  const active = (await ctx.env.DB.prepare("SELECT COUNT(*) AS n FROM access_codes WHERE org_id = ? AND revoked_at IS NULL AND expires_at > ?").bind(orgId, ctx.now).first()).n;
  if (active >= 20) throw new HttpError(409, "Cet établissement a déjà 20 codes actifs. Révoquez-en un avant d'en créer un autre.", "too_many");
  const id = uid(), code = newAccessCode();
  await ctx.env.DB.prepare("INSERT INTO access_codes (id, org_id, label, code_hash, code_enc, code_hint, max_uses, expires_at, created_by, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)")
    .bind(id, orgId, label, await accessHash(code), await sealCode(ctx.env, code, id + ":" + orgId), "••••-••••-" + code.slice(-4), maxUses, ctx.now + hours * 3600e3, userId, ctx.now).run();
  return { id, code };
}
async function createAccessCode(ctx, orgId) {
  const { user } = await requireUser(ctx);
  const oc = await orgContext(ctx, user, orgId); need(oc, "access_codes.manage");
  const st = codeSettings(await body(ctx));
  const { id, code } = await insertAccessCode(ctx, orgId, user.id, st);
  await audit(ctx, { org: orgId, actor: user.id, action: "access_code.created", details: { codeId: id, label: st.label, hours: st.hours, maxUses: st.maxUses } });
  const row = await ctx.env.DB.prepare("SELECT * FROM access_codes WHERE id = ?").bind(id).first();
  return json(201, { code: { ...(await accessCodeView(ctx, row)), code } });
}
async function getOrgCode(ctx, orgId, codeId) {
  const c = await ctx.env.DB.prepare("SELECT * FROM access_codes WHERE id = ? AND org_id = ?").bind(codeId, orgId).first();
  if (!c) throw new HttpError(404, "Code introuvable.", "not_found");
  return c;
}
async function revokeAccessCode(ctx, orgId, codeId) {
  const { user } = await requireUser(ctx);
  const oc = await orgContext(ctx, user, orgId); need(oc, "access_codes.manage");
  const c = await getOrgCode(ctx, orgId, codeId);
  const r = await ctx.env.DB.prepare("UPDATE access_codes SET revoked_at = ?, revoked_by = ? WHERE id = ? AND org_id = ? AND revoked_at IS NULL").bind(ctx.now, user.id, codeId, orgId).run();
  if (!changes(r)) throw new HttpError(409, "Ce code est déjà révoqué.", "already_revoked");
  await audit(ctx, { org: orgId, actor: user.id, action: "access_code.revoked", details: { codeId, label: c.label } });
  return json(200, { ok: true });
}
// Renouveler : l'ancien code est révoqué et remplacé par un nouveau, avec les mêmes réglages.
async function renewAccessCode(ctx, orgId, codeId) {
  const { user } = await requireUser(ctx);
  const oc = await orgContext(ctx, user, orgId); need(oc, "access_codes.manage");
  const old = await getOrgCode(ctx, orgId, codeId);
  const b = await body(ctx);
  // Même durée que l'ancien code (bornée), sauf si une autre est demandée
  const oldHours = Math.min(CODE_HOURS_MAX, Math.max(1, Math.round((old.expires_at - old.created_at) / 3600e3)));
  const st = codeSettings({ expiresInHours: "expiresInHours" in b ? b.expiresInHours : oldHours, maxUses: "maxUses" in b ? b.maxUses : old.max_uses, label: "label" in b ? b.label : old.label });
  await ctx.env.DB.prepare("UPDATE access_codes SET revoked_at = COALESCE(revoked_at, ?), revoked_by = COALESCE(revoked_by, ?) WHERE id = ?").bind(ctx.now, user.id, codeId).run();
  const { id, code } = await insertAccessCode(ctx, orgId, user.id, st);
  await ctx.env.DB.prepare("UPDATE access_codes SET replaced_by = ? WHERE id = ?").bind(id, codeId).run();
  await audit(ctx, { org: orgId, actor: user.id, action: "access_code.renewed", details: { oldCodeId: codeId, codeId: id, label: st.label } });
  const row = await ctx.env.DB.prepare("SELECT * FROM access_codes WHERE id = ?").bind(id).first();
  return json(201, { code: { ...(await accessCodeView(ctx, row)), code } });
}

const CODE_MSG = {
  invalid: "Ce code n'est pas valide. Vérifiez-le auprès de l'administrateur de votre établissement.",
  revoked: "Ce code a été révoqué. Demandez un nouveau code à l'administrateur de votre établissement.",
  expired: "Ce code a expiré. Demandez un nouveau code à l'administrateur de votre établissement.",
  exhausted: "Ce code a déjà été utilisé. Demandez un nouveau code à l'administrateur de votre établissement.",
};
const codeFail = (state) => { throw new HttpError(state === "invalid" ? 404 : 410, CODE_MSG[state], "code_" + state, { field: "code" }); };
// Vérifie un code côté serveur (empreinte, établissement actif, révocation, expiration, utilisations).
async function findActiveCode(ctx, raw) {
  const n = normAccessCode(raw);
  if (n.length !== CODE_LEN) codeFail("invalid");
  const c = await ctx.env.DB.prepare("SELECT c.*, o.name AS org_name, o.status AS org_status FROM access_codes c JOIN organizations o ON o.id = c.org_id WHERE c.code_hash = ?").bind(await accessHash(n)).first();
  if (!c || c.org_status !== "active") codeFail("invalid");
  const state = codeState(c, ctx.now);
  if (state !== "active") codeFail(state);
  return c;
}
// Utilisation comptée de façon atomique : la limite et l'expiration sont revérifiées dans la même requête.
async function consumeCode(ctx, c) {
  const r = await ctx.env.DB.prepare("UPDATE access_codes SET uses = uses + 1, last_used_at = ? WHERE id = ? AND revoked_at IS NULL AND expires_at > ? AND (max_uses IS NULL OR uses < max_uses)").bind(ctx.now, c.id, ctx.now).run();
  if (!changes(r)) { const now = codeState(await ctx.env.DB.prepare("SELECT * FROM access_codes WHERE id = ?").bind(c.id).first(), ctx.now); codeFail(now === "active" ? "invalid" : now); }
}
const giveBackCode = (ctx, c) => ctx.env.DB.prepare("UPDATE access_codes SET uses = MAX(uses - 1, 0) WHERE id = ?").bind(c.id).run();
const identityCount = async (ctx, userId) => (await ctx.env.DB.prepare("SELECT COUNT(*) AS n FROM identities WHERE user_id = ?").bind(userId).first()).n;

// Premier accès : prénom + courriel (non vérifié) + code d'invitation. Crée un nouveau compte Membre et ouvre une session.
// Le courriel ne retrouve jamais un compte existant et ne déclenche aucune fusion : chaque premier accès crée un compte distinct.
async function inviteSignup(ctx) {
  csrf(ctx);
  const ip = ctx.request.headers.get("cf-connecting-ip") || "?";
  await rateLimit(ctx, "invite:ip:" + ip, 10, 15 * 60e3);
  await rateLimit(ctx, "invite:ipday:" + ip, 40, 24 * 3600e3);
  const b = await body(ctx);
  const first = clip(String(b.first_name || "").replace(/[<>]/g, ""), 60);
  if (!first) throw new HttpError(400, "Entrez votre prénom.", "prenom_requis", { field: "first_name" });
  const email = normEmail(b.email);
  if (!EMAIL_RE.test(email) || email.length > 254) throw new HttpError(400, "Entrez une adresse courriel valide.", "courriel_invalide", { field: "email" });
  await checkHuman(ctx, b.turnstile);
  const c = await findActiveCode(ctx, b.code);
  await consumeCode(ctx, c);
  const { env, now } = ctx;
  const userId = uid(), token = randomToken(32);
  try {
    await env.DB.batch([
      env.DB.prepare("INSERT INTO users (id, first_name, contact_email, signup, locale, created_at, updated_at) VALUES (?,?,?,'invite','fr-CA',?,?)").bind(userId, first, email, now, now),
      env.DB.prepare("INSERT INTO memberships (id, org_id, user_id, role, function, status, joined_via, created_at, updated_at) VALUES (?,?,?,'member','other','active',?,?,?)").bind(uid(), c.org_id, userId, "code:" + c.id, now, now),
      env.DB.prepare("INSERT INTO sessions (id_hash, user_id, created_at, auth_at, last_seen_at, expires_at, active_org_id, user_agent, kind) VALUES (?,?,?,?,?,?,?,?,'invite')")
        .bind(await sha256(token), userId, now, now, now, now + FIRST_TTL, c.org_id, clip(ctx.request.headers.get("user-agent"), 200)),
    ]);
  } catch (e) { await giveBackCode(ctx, c); throw e; }
  // Une éventuelle session précédente dans ce navigateur est fermée : un seul compte actif par appareil.
  const prev = readCookie(ctx.request, SESSION_COOKIE);
  if (prev) await env.DB.prepare("DELETE FROM sessions WHERE id_hash = ?").bind(await sha256(prev)).run();
  await audit(ctx, { actor: userId, action: "account.created", target: userId, details: { provider: "invite" } });
  await audit(ctx, { org: c.org_id, actor: userId, action: "access_code.redeemed", target: userId, details: { codeId: c.id, label: c.label, firstAccess: true } });
  return json(200, { ok: true, next: "/agent/", orgName: c.org_name },
    { "set-cookie": cookie(SESSION_COOKIE, token, { path: "/", maxAge: FIRST_TTL / 1000, sameSite: "Lax" }) });
}

async function redeemAccessCode(ctx) {
  const { user, idHash } = await requireUser(ctx);
  // Limites : par compte et par adresse IP, comptées avant toute vérification.
  await rateLimit(ctx, "redeem:u:" + user.id, 8, 15 * 60e3);
  await rateLimit(ctx, "redeem:ip:" + (ctx.request.headers.get("cf-connecting-ip") || "?"), 30, 3600e3);
  const b = await body(ctx);
  const c = await findActiveCode(ctx, b.code);
  const existing = await ctx.env.DB.prepare("SELECT * FROM memberships WHERE org_id = ? AND user_id = ?").bind(c.org_id, user.id).first();
  if (existing && existing.status === "disabled")
    throw new HttpError(403, `Votre accès à ${c.org_name} a été retiré par un administrateur. Le code ne permet pas de le rétablir : communiquez avec l'administrateur.`, "membership_disabled");
  if (!existing) {
    await consumeCode(ctx, c);
    try {
      await ctx.env.DB.prepare("INSERT INTO memberships (id, org_id, user_id, role, function, status, joined_via, created_at, updated_at) VALUES (?,?,?,'member','other','active',?,?,?)")
        .bind(uid(), c.org_id, user.id, "code:" + c.id, ctx.now, ctx.now).run();
    } catch (e) {
      // Double envoi simultané : l'appartenance existe déjà, on rend l'utilisation comptée en trop.
      await giveBackCode(ctx, c);
    }
    await audit(ctx, { org: c.org_id, actor: user.id, action: "access_code.redeemed", target: user.id, details: { codeId: c.id, label: c.label } });
  }
  await ctx.env.DB.prepare("UPDATE sessions SET active_org_id = ? WHERE id_hash = ?").bind(c.org_id, idHash).run();
  return json(200, { ok: true, orgId: c.org_id, orgName: c.org_name, already: !!existing });
}

/* ----- Accès au portail (/agent) ----- */
// Vérifié à chaque requête : session valide, compte actif, appartenance active à un établissement actif.
export async function portalAccess(request, env) {
  if (!env.DB) return { ok: false, status: 503, code: "no_db", error: "Le module Comptes n'est pas activé." };
  const ctx = { request, env, url: new URL(request.url), origin: env.ACCOUNT_ORIGIN || new URL(request.url).origin, now: Date.now() };
  const s = await readSession(ctx);
  if (!s || s.expired) return { ok: false, status: 401, code: s?.expired ? "session_expired" : "unauthenticated", error: s?.expired ? "Votre session a expiré. Reconnectez-vous." : "Connexion requise." };
  if (s.user.status !== "active") return { ok: false, status: 403, code: "account_deactivated", error: "Votre compte est désactivé." };
  const mem = (await env.DB.prepare("SELECT m.*, o.name AS org_name, o.logo AS org_logo FROM memberships m JOIN organizations o ON o.id = m.org_id WHERE m.user_id = ? AND o.status = 'active' ORDER BY m.created_at").bind(s.user.id).all()).results;
  const active = mem.filter((m) => m.status === "active");
  let m = active.find((x) => x.org_id === s.session.active_org_id) || active[0] || null;
  if (m && m.org_id !== s.session.active_org_id) await env.DB.prepare("UPDATE sessions SET active_org_id = ? WHERE id_hash = ?").bind(m.org_id, s.idHash).run();
  const platform = !!s.user.platform_admin;
  if (!m && !platform) {
    const off = mem.filter((x) => x.status === "disabled").map((x) => x.org_name);
    return { ok: false, status: 403, code: off.length ? "membership_disabled" : "no_access", disabledOrgs: off, who: { first_name: s.user.first_name || "" },
      error: off.length ? `Votre accès à ${off.join(", ")} a été retiré. Entrez un code d'un autre établissement ou communiquez avec l'administrateur.` : "Entrez le code d'accès de votre établissement pour continuer." };
  }
  const noIdentity = (await identityCount(ctx, s.user.id)) === 0;
  const canLink = await canLinkEmail(ctx, s.user);
  return { ok: true, user: s.user, platform, noIdentity, canLinkEmail: canLink, needsProfile: (noIdentity && canLink) || !s.user.last_name, org: m ? { id: m.org_id, name: m.org_name, logo: m.org_logo || null } : null, role: platform ? "platform" : m.role,
    orgs: active.map((x) => ({ id: x.org_id, name: x.org_name, role: x.role })) };
}
async function accessStatus(ctx) {
  const a = await portalAccess(ctx.request, ctx.env);
  if (!a.ok) return json(a.status, { access: false, code: a.code, error: a.error, disabledOrgs: a.disabledOrgs || [], user: a.who || null });
  return json(200, { access: true, org: a.org, role: a.role, platform: a.platform, orgs: a.orgs, user: { first_name: a.user.first_name, last_name: a.user.last_name } });
}

/* ----- Favoris -----
   Personnels : chaque personne ne voit que les siens, dans l'établissement actif.
   La réponse est une copie figée au moment de l'ajout ; un favori n'est pas une validation. */
export const FAV = { MAX: 300, Q: 8000, A: 60000, SRC: 12, CONTEXTS: ["reception", "tsa", "nutrition"] };
export const favKey = (context, question, answer) => sha256(`lq-fav\n${context}\n${question}\n${answer}`);
async function favOwner(ctx) {
  const a = await portalAccess(ctx.request, ctx.env);
  if (!a.ok) throw new HttpError(a.status, a.error, a.code);
  const org = a.org?.id || (a.platform ? "_plateforme" : null);
  if (!org) throw new HttpError(403, "Aucun établissement actif.", "no_access");
  return { user: a.user, org };
}
const favOut = (r, full) => ({ id: r.id, fkey: r.fkey, context: r.context, created_at: r.created_at,
  question: full ? r.question : r.question.slice(0, 600),
  ...(full ? { answer: r.answer, sources: safeJson(r.sources, []) } : { excerpt: r.answer.slice(0, 600) }) });
async function listFavorites(ctx) {
  const { user, org } = await favOwner(ctx);
  const rows = (await ctx.env.DB.prepare("SELECT id, fkey, context, question, substr(answer, 1, 600) AS answer, created_at FROM favorites WHERE user_id = ? AND org_id = ? ORDER BY created_at DESC LIMIT ?")
    .bind(user.id, org, FAV.MAX).all()).results;
  return json(200, { favorites: rows.map((r) => favOut(r, false)), max: FAV.MAX });
}
async function getFavorite(ctx, id) {
  const { user, org } = await favOwner(ctx);
  const r = await ctx.env.DB.prepare("SELECT * FROM favorites WHERE id = ? AND user_id = ? AND org_id = ?").bind(id, user.id, org).first();
  if (!r) throw new HttpError(404, "Favori introuvable.", "not_found");
  return json(200, { favorite: favOut(r, true) });
}
async function addFavorite(ctx) {
  const { user, org } = await favOwner(ctx);
  await rateLimit(ctx, `fav:${user.id}`, 120, 10 * 60e3);
  const b = await body(ctx);
  const context = String(b.context || "");
  if (!FAV.CONTEXTS.includes(context)) throw new HttpError(400, "Contexte invalide.", "invalid");
  if (typeof b.question !== "string" || typeof b.answer !== "string" || !b.question.trim() || !b.answer.trim()) throw new HttpError(400, "Question et réponse requises.", "invalid");
  if (b.question.length > FAV.Q || b.answer.length > FAV.A) throw new HttpError(413, "Cet échange est trop long pour être enregistré.", "too_long");
  // Sources : fiches web (https seulement) ou documents de la clinique (titre seul).
  const sources = (Array.isArray(b.sources) ? b.sources : []).slice(0, FAV.SRC).map((x) => {
    if (typeof x === "string") x = /^[a-z][\w+.-]*:/i.test(x) ? { url: x } : { title: x };
    if (!x || typeof x !== "object") return null;
    const o = {};
    if (x.url !== undefined) { if (typeof x.url !== "string" || x.url.length > 1000 || !/^https:\/\/[^\s]+$/.test(x.url)) return null; o.url = x.url; }
    const t = clip(x.title, 300); if (t) o.title = t;
    const d = clip(x.date, 40); if (d) o.date = d;
    return o.url || o.title ? o : null;
  }).filter(Boolean);
  const fkey = await favKey(context, b.question, b.answer);
  const db = ctx.env.DB;
  const existing = await db.prepare("SELECT * FROM favorites WHERE user_id = ? AND org_id = ? AND fkey = ?").bind(user.id, org, fkey).first();
  if (existing) return json(200, { favorite: favOut(existing, false) });
  const n = (await db.prepare("SELECT COUNT(*) AS n FROM favorites WHERE user_id = ? AND org_id = ?").bind(user.id, org).first()).n;
  if (n >= FAV.MAX) throw new HttpError(409, `Vous avez atteint ${FAV.MAX} favoris. Retirez-en quelques-uns pour en ajouter.`, "limit");
  const row = { id: uid(), user_id: user.id, org_id: org, fkey, context, question: b.question, answer: b.answer, sources: JSON.stringify(sources), created_at: ctx.now };
  await db.prepare("INSERT OR IGNORE INTO favorites (id, user_id, org_id, fkey, context, question, answer, sources, created_at) VALUES (?,?,?,?,?,?,?,?,?)")
    .bind(row.id, row.user_id, row.org_id, row.fkey, row.context, row.question, row.answer, row.sources, row.created_at).run();
  const saved = await db.prepare("SELECT * FROM favorites WHERE user_id = ? AND org_id = ? AND fkey = ?").bind(user.id, org, fkey).first();
  return json(201, { favorite: favOut(saved, false) });
}
async function removeFavorite(ctx, id) {
  const { user, org } = await favOwner(ctx);
  const r = await ctx.env.DB.prepare("DELETE FROM favorites WHERE id = ? AND user_id = ? AND org_id = ?").bind(id, user.id, org).run();
  if (!changes(r)) throw new HttpError(404, "Favori introuvable.", "not_found");
  return json(200, { ok: true });
}

/* ----- Journal ----- */
async function listAudit(ctx, orgId) {
  const { user } = await requireUser(ctx);
  const oc = await orgContext(ctx, user, orgId); need(oc, "audit.read");
  const rows = (await ctx.env.DB.prepare(`SELECT a.id, a.action, a.details, a.created_at, a.actor_user_id, a.target_user_id,
      ua.first_name AS actor_first, ua.last_name AS actor_last, ut.first_name AS target_first, ut.last_name AS target_last
    FROM audit_log a LEFT JOIN users ua ON ua.id = a.actor_user_id LEFT JOIN users ut ON ut.id = a.target_user_id
    WHERE a.org_id = ? ORDER BY a.created_at DESC LIMIT 100`).bind(orgId).all()).results;
  return json(200, { entries: rows.map((r) => ({ ...r, details: safeJson(r.details, null) })) });
}

/* ----- Plateforme ----- */
async function requirePlatform(ctx) {
  const s = await requireUser(ctx);
  if (!s.user.platform_admin) throw new HttpError(403, "Réservé à l'administrateur de la plateforme.", "forbidden");
  return s;
}
async function bootstrapPlatform(ctx) {
  const { user } = await requireUser(ctx);
  if (!ctx.env.ADMIN_CODE) throw new HttpError(503, "Code d'administration non configuré.", "no_admin_code");
  if (await ctx.env.DB.prepare("SELECT 1 FROM users WHERE platform_admin = 1 LIMIT 1").first()) throw new HttpError(409, "Un administrateur de la plateforme existe déjà.", "exists");
  await rateLimit(ctx, "boot:" + user.id, 5, 3600e3);
  const b = await body(ctx);
  if (!timingSafeEqual(String(b.code || "").trim(), String(ctx.env.ADMIN_CODE).trim())) throw new HttpError(403, "Code d'administration invalide.", "bad_code");
  await ctx.env.DB.prepare("UPDATE users SET platform_admin = 1, updated_at = ? WHERE id = ?").bind(ctx.now, user.id).run();
  await audit(ctx, { actor: user.id, action: "platform_admin.granted", target: user.id });
  return getMe(ctx);
}
async function platformOrgs(ctx) {
  await requirePlatform(ctx);
  const rows = (await ctx.env.DB.prepare(`SELECT o.*, (SELECT COUNT(*) FROM memberships m WHERE m.org_id = o.id AND m.status = 'active') AS members FROM organizations o ORDER BY o.name`).all()).results;
  return json(200, { orgs: rows });
}
async function createOrg(ctx) {
  const { user } = await requirePlatform(ctx);
  const b = await body(ctx);
  const name = clip(b.name, 120);
  if (!name) throw new HttpError(400, "Le nom de l'établissement est obligatoire.", "invalid");
  const id = uid();
  const stmts = [ctx.env.DB.prepare("INSERT INTO organizations (id, name, city, created_at, updated_at) VALUES (?,?,?,?,?)").bind(id, name, clip(b.city, 80), ctx.now, ctx.now)];
  if (b.iAmOwner) stmts.push(ctx.env.DB.prepare("INSERT INTO memberships (id, org_id, user_id, role, function, created_at, updated_at) VALUES (?,?,?,'owner','manager',?,?)").bind(uid(), id, user.id, ctx.now, ctx.now));
  await ctx.env.DB.batch(stmts);
  await audit(ctx, { org: id, actor: user.id, action: "org.created", details: { iAmOwner: !!b.iAmOwner } });
  let invite = null;
  if (b.ownerEmail) {
    const r = await createInvitation({ ...ctx, request: new Request(ctx.url, { method: "POST", headers: ctx.request.headers, body: JSON.stringify({ email: b.ownerEmail, role: "owner", function: "manager" }) }) }, id);
    invite = await r.json();
    if (r.status >= 400) throw new HttpError(r.status, invite.error, invite.code);
  }
  return json(201, { org: { id, name }, invite });
}
async function platformUsers(ctx) {
  await requirePlatform(ctx);
  const q = (ctx.url.searchParams.get("q") || "").trim().toLowerCase();
  const rows = (await ctx.env.DB.prepare(`SELECT u.id, u.first_name, u.last_name, u.status, u.platform_admin, u.created_at,
      (SELECT GROUP_CONCAT(i.provider || ':' || COALESCE(i.email, '?'), ', ') FROM identities i WHERE i.user_id = u.id) AS logins
    FROM users u ORDER BY u.created_at DESC LIMIT 300`).all()).results;
  return json(200, { users: rows.filter((r) => !q || [r.first_name, r.last_name, r.logins].filter(Boolean).join(" ").toLowerCase().includes(q)) });
}
async function platformUserStatus(ctx, userId) {
  const { user } = await requirePlatform(ctx);
  const b = await body(ctx);
  if (!["active", "suspended"].includes(b.status)) throw new HttpError(400, "Statut inconnu.", "invalid");
  if (userId === user.id) throw new HttpError(409, "Vous ne pouvez pas suspendre votre propre compte.", "self");
  const stmts = [ctx.env.DB.prepare("UPDATE users SET status = ?, updated_at = ? WHERE id = ?").bind(b.status, ctx.now, userId)];
  if (b.status === "suspended") stmts.push(ctx.env.DB.prepare("DELETE FROM sessions WHERE user_id = ?").bind(userId));
  await ctx.env.DB.batch(stmts);
  await audit(ctx, { actor: user.id, action: b.status === "suspended" ? "account.suspended" : "account.unsuspended", target: userId });
  return json(200, { ok: true });
}
async function createRecovery(ctx, userId) {
  const { user } = await requirePlatform(ctx);
  const b = await body(ctx);
  const email = String(b.email || "").trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) throw new HttpError(400, "Adresse courriel invalide.", "invalid");
  if (!(await ctx.env.DB.prepare("SELECT 1 FROM users WHERE id = ?").bind(userId).first())) throw new HttpError(404, "Utilisateur introuvable.", "not_found");
  const token = randomToken(32);
  await ctx.env.DB.prepare("INSERT INTO recovery_links (id, user_id, email, token_hash, created_by, created_at, expires_at) VALUES (?,?,?,?,?,?,?)").bind(uid(), userId, email, await sha256(token), user.id, ctx.now, ctx.now + RECOVERY_TTL).run();
  await audit(ctx, { actor: user.id, action: "recovery.created", target: userId, details: { email: maskEmail(email) } });
  return json(201, { link: `${ctx.origin}${LOGIN_PAGE}#recuperation=${token}`, expiresAt: ctx.now + RECOVERY_TTL });
}

/* ===================== Utilitaires ===================== */
class HttpError extends Error { constructor(status, message, code, extra) { super(message); this.status = status; this.code = code; this.extra = extra; } }
async function audit(ctx, { org = null, actor = null, action, target = null, details = null }) {
  await ctx.env.DB.prepare("INSERT INTO audit_log (id, org_id, actor_user_id, action, target_user_id, details, created_at) VALUES (?,?,?,?,?,?,?)")
    .bind(uid(), org, actor, action, target, details ? JSON.stringify(details) : null, ctx.now).run();
}
async function rateLimit(ctx, key, max, windowMs) {
  const row = await ctx.env.DB.prepare("SELECT * FROM rate_limits WHERE key = ?").bind(key).first();
  if (!row || row.reset_at < ctx.now) { await ctx.env.DB.prepare("INSERT OR REPLACE INTO rate_limits (key, count, reset_at) VALUES (?,1,?)").bind(key, ctx.now + windowMs).run(); return; }
  if (row.count >= max) throw new HttpError(429, "Trop d'essais. Réessayez plus tard.", "rate_limited");
  await ctx.env.DB.prepare("UPDATE rate_limits SET count = count + 1 WHERE key = ?").bind(key).run();
}
async function body(ctx) { try { const b = await ctx.request.json(); return b && typeof b === "object" ? b : {}; } catch { return {}; } }
const changes = (r) => (r && r.meta ? r.meta.changes : 0);
const uid = () => crypto.randomUUID();
const clip = (s, n) => { const v = String(s ?? "").replace(/[\u0000-\u001f]/g, " ").trim(); return v ? v.slice(0, n) : null; };
const safeJson = (s, d) => { try { return s ? JSON.parse(s) : d; } catch { return d; } };
function validImage(v) {
  if (v === null || v === "") return null;
  const s = String(v);
  if (/^https:\/\/[^\s"'<>]{1,500}$/.test(s)) return s;
  if (/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(s) && s.length <= 110000) return s;
  throw new HttpError(400, "Image invalide ou trop lourde (80 Ko maximum).", "invalid");
}
export function maskEmail(e) {
  const [u, d] = String(e || "").split("@");
  if (!d) return "";
  return (u.length <= 2 ? u[0] + "•" : u.slice(0, 2) + "•".repeat(Math.min(6, u.length - 2))) + "@" + d;
}
function timingSafeEqual(a, b) {
  a = String(a); b = String(b);
  let d = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) d |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return d === 0;
}
function json(status, data, headers = {}) {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff", ...headers } });
}
function redirect(location, headers = {}) { return new Response(null, { status: 302, headers: { location, "cache-control": "no-store", ...headers } }); }
function withHeaders(res, extra) { const h = new Headers(res.headers); for (const [k, v] of Object.entries(extra)) h.append(k, v); return new Response(res.body, { status: res.status, headers: h }); }
function cookie(name, value, { path = "/", maxAge, sameSite = "Lax" }) {
  return `${name}=${value}; Path=${path}; Max-Age=${Math.floor(maxAge)}; HttpOnly; Secure; SameSite=${sameSite}`;
}
function clearCookie(name, path, sameSite = "Lax") { return `${name}=; Path=${path}; Max-Age=0; HttpOnly; Secure; SameSite=${sameSite}`; }
function readCookie(request, name) {
  const c = request.headers.get("cookie") || "";
  for (const part of c.split(/;\s*/)) { const i = part.indexOf("="); if (i > 0 && part.slice(0, i) === name) return part.slice(i + 1); }
  return null;
}
