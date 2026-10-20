// Module Comptes : connexion (Google, Apple), profils, établissements, membres, invitations.
// Toutes les vérifications d'accès sont faites ici, côté serveur, à chaque requête.
import { providersStatus, authorizationUrl, exchangeAndVerify, OidcError, randomToken, sha256 } from "./oidc.js";
import { MATRIX, ROLES, ROLE_LABELS, FUNCTIONS, can, permissionsFor, checkTarget } from "./perms.js";

const SESSION_TTL = 14 * 24 * 3600e3;   // expiration absolue
const IDLE_TTL = 12 * 3600e3;           // inactivité
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
    env.DB.prepare("DELETE FROM sessions WHERE expires_at < ? OR last_seen_at < ?").bind(t, t - IDLE_TTL),
    env.DB.prepare("DELETE FROM auth_requests WHERE expires_at < ?").bind(t),
    env.DB.prepare("DELETE FROM rate_limits WHERE reset_at < ?").bind(t),
  ]);
}

/* ===================== Connexion ===================== */
async function routeAuth(ctx) {
  const { url, request } = ctx;
  const m = url.pathname.match(/^\/auth\/(google|apple)\/(start|callback)$/);
  if (m && m[2] === "start" && request.method === "GET") return authStart(ctx, m[1]);
  if (m && m[2] === "callback" && (request.method === "GET" || request.method === "POST")) return authCallback(ctx, m[1]);
  if (url.pathname === "/auth/providers" && request.method === "GET") return json(200, providersStatus(ctx.env));
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
    if (now - s.session.auth_at > REAUTH_WINDOW) return redirect(`${ctx.origin}${LOGIN_PAGE}?erreur=reauth&suite=${encodeURIComponent(ACCOUNT_PAGE + "#profil")}`);
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
  const existing = await env.DB.prepare("SELECT * FROM identities WHERE provider = ? AND subject = ?").bind(provider, info.subject).first();

  if (req.mode === "link") {
    const s = await readSession(ctx);
    if (!s || s.user.id !== req.link_user_id) return withHeaders(loginError(ctx, "connexion_requise"), clear);
    if (existing && existing.user_id !== s.user.id) return withHeaders(redirect(`${ctx.origin}${ACCOUNT_PAGE}?erreur=identite_deja_utilisee#profil`), clear);
    if (!existing) {
      await env.DB.prepare("INSERT INTO identities (id, user_id, provider, subject, email, email_verified, is_private_email, created_at, last_login_at) VALUES (?,?,?,?,?,?,?,?,?)")
        .bind(uid(), s.user.id, provider, info.subject, info.email, info.emailVerified ? 1 : 0, info.isPrivateEmail ? 1 : 0, now, now).run();
      await audit(ctx, { actor: s.user.id, action: "identity.linked", target: s.user.id, details: { provider } });
    }
    return withHeaders(redirect(`${ctx.origin}${ACCOUNT_PAGE}?associe=${provider}#profil`), clear);
  }

  let userId;
  if (req.mode === "recovery") {
    const rec = await env.DB.prepare("SELECT * FROM recovery_links WHERE id = ?").bind(req.recovery_id).first();
    if (!rec || rec.used_at || rec.expires_at < now) return withHeaders(loginError(ctx, "recuperation_invalide"), clear);
    if (!info.emailVerified || info.email !== rec.email) return withHeaders(loginError(ctx, "recuperation_courriel"), clear);
    if (existing && existing.user_id !== rec.user_id) return withHeaders(loginError(ctx, "identite_deja_utilisee"), clear);
    const used = await env.DB.prepare("UPDATE recovery_links SET used_at = ? WHERE id = ? AND used_at IS NULL").bind(now, rec.id).run();
    if (!changes(used)) return withHeaders(loginError(ctx, "recuperation_invalide"), clear);
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
        .bind(userId, clip(info.givenName, 60), clip(info.familyName, 60), info.picture, "fr-CA", now, now),
      env.DB.prepare("INSERT INTO identities (id, user_id, provider, subject, email, email_verified, is_private_email, created_at, last_login_at) VALUES (?,?,?,?,?,?,?,?,?)")
        .bind(uid(), userId, provider, info.subject, info.email, info.emailVerified ? 1 : 0, info.isPrivateEmail ? 1 : 0, now, now),
    ]);
  }
  const user = await env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(userId).first();
  if (!user || user.status === "suspended") return withHeaders(loginError(ctx, "compte_suspendu"), clear);
  const token = randomToken(32);
  const firstOrg = await env.DB.prepare("SELECT org_id FROM memberships WHERE user_id = ? AND status = 'active' ORDER BY created_at LIMIT 1").bind(userId).first();
  await env.DB.prepare("INSERT INTO sessions (id_hash, user_id, created_at, auth_at, last_seen_at, expires_at, active_org_id, user_agent) VALUES (?,?,?,?,?,?,?,?)")
    .bind(await sha256(token), userId, now, now, now, now + SESSION_TTL, firstOrg?.org_id || null, clip(request.headers.get("user-agent"), 200)).run();
  const dest = user.status === "deactivated" ? `${ACCOUNT_PAGE}#profil` : safeNext(req.next_path);
  const h = new Headers({ location: ctx.origin + dest, "cache-control": "no-store" });
  h.append("set-cookie", cookie(SESSION_COOKIE, token, { path: "/", maxAge: SESSION_TTL / 1000, sameSite: "Lax" }));
  h.append("set-cookie", clearCookie(OAUTH_COOKIE, "/auth/", "None"));
  return new Response(null, { status: 302, headers: h });
}

/* ===================== Session ===================== */
async function readSession(ctx) {
  const token = readCookie(ctx.request, SESSION_COOKIE);
  if (!token) return null;
  const idHash = await sha256(token);
  const session = await ctx.env.DB.prepare("SELECT * FROM sessions WHERE id_hash = ?").bind(idHash).first();
  if (!session) return null;
  if (session.expires_at < ctx.now || session.last_seen_at < ctx.now - IDLE_TTL) {
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
    session: { expiresAt: Math.min(session.expires_at, session.last_seen_at + IDLE_TTL), authAt: session.auth_at },
    providers: providersStatus(ctx.env), platform: { isAdmin: !!user.platform_admin, canBootstrap: !platformHasAdmin && !!ctx.env.ADMIN_CODE },
  });
}
const publicUser = (u) => ({ id: u.id, first_name: u.first_name, last_name: u.last_name, photo: u.photo, locale: u.locale, job_title: u.job_title, notif_prefs: safeJson(u.notif_prefs, {}), status: u.status, platform_admin: !!u.platform_admin, created_at: u.created_at });

async function patchMe(ctx) {
  const { user } = await requireUser(ctx);
  const b = await body(ctx);
  const f = {};
  if ("first_name" in b) f.first_name = clip(b.first_name, 60);
  if ("last_name" in b) f.last_name = clip(b.last_name, 60);
  if ("job_title" in b) f.job_title = clip(b.job_title, 80);
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
      (SELECT i.email FROM identities i WHERE i.user_id = m.user_id ORDER BY i.is_private_email, i.created_at LIMIT 1) AS email,
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
  ]);
  await audit(ctx, { org: orgId, actor: user.id, action: "member.removed", target: t.user_id, details: { role: t.role } });
  return json(200, { ok: true });
}
async function leaveOrg(ctx, orgId) {
  const { user } = await requireUser(ctx);
  const oc = await orgContext(ctx, user, orgId);
  if (!oc.membership) throw new HttpError(404, "Vous n'êtes pas membre de cet établissement.", "not_found");
  if (oc.membership.role === "owner" && (await activeOwners(ctx, orgId)) <= 1) throw new HttpError(409, "Vous êtes le dernier propriétaire : transférez d'abord la propriété avant de quitter.", "last_owner");
  await ctx.env.DB.prepare("DELETE FROM memberships WHERE id = ? AND org_id = ?").bind(oc.membership.id, orgId).run();
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
