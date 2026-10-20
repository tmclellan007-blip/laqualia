// Essais du module Comptes : node --test tests/
import test from "node:test";
import assert from "node:assert/strict";
import { makeEnv, Browser, providerLog } from "./harness.mjs";

const G = (sub, email, extra = {}) => ({ sub, email, email_verified: true, given_name: "Prénom" + sub, family_name: "Nom", ...extra });

async function setup() {
  const env = await makeEnv();
  const plat = new Browser(env);
  await plat.login("google", G("plat", "plateforme@laqualia.com"));
  const boot = await plat.api("/api/platform/bootstrap", { method: "POST", body: { code: env.ADMIN_CODE } });
  assert.equal(boot.status, 200, JSON.stringify(boot.data));
  return { env, plat };
}
async function invite(b, orgId, email, role = "member", fn = "reception") {
  const r = await b.api(`/api/orgs/${orgId}/invitations`, { method: "POST", body: { email, role, function: fn } });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  return r.data.link.split("#")[1];
}
async function join(b, token) { return b.api(`/api/invitations/${token}/accept`, { method: "POST" }); }
async function twoOrgs() {
  const s = await setup();
  const { plat } = s;
  const A = (await plat.api("/api/platform/orgs", { method: "POST", body: { name: "Clinique A", ownerEmail: "alice@a.ca" } })).data;
  const B = (await plat.api("/api/platform/orgs", { method: "POST", body: { name: "Clinique B", ownerEmail: "bob@b.ca" } })).data;
  const alice = new Browser(s.env), bob = new Browser(s.env);
  await alice.login("google", G("alice", "alice@a.ca"));
  await bob.login("google", G("bob", "bob@b.ca"));
  assert.equal((await join(alice, A.invite.link.split("#")[1])).status, 200);
  assert.equal((await join(bob, B.invite.link.split("#")[1])).status, 200);
  return { ...s, A: A.org.id, B: B.org.id, alice, bob };
}
const memberId = async (b, orgId, email) => (await b.api(`/api/orgs/${orgId}/members`)).data.members.find((m) => m.type === "member" && m.email === email).id;

test("connexion Google : compte créé, retrouvé par l'identifiant vérifié, jamais fusionné par courriel", async () => {
  const env = await makeEnv();
  const b1 = new Browser(env);
  const r = await b1.login("google", G("123", "marie@clinique.ca"));
  assert.equal(r.res.status, 302);
  assert.match(r.res.headers.getSetCookie().join("\n"), /__Host-lq_sess=.+; Path=\/; Max-Age=\d+; HttpOnly; Secure; SameSite=Lax/);
  assert.equal(r.authUrl.searchParams.get("code_challenge_method"), "S256");
  const me1 = await b1.api("/api/me");
  assert.equal(me1.status, 200);
  const b2 = new Browser(env);
  await b2.login("google", G("123", "marie@clinique.ca"));
  assert.equal((await b2.api("/api/me")).data.user.id, me1.data.user.id, "même identifiant vérifié = même compte");
  const b3 = new Browser(env);
  await b3.login("apple", { sub: "apple-999", email: "marie@clinique.ca", email_verified: "true" });
  assert.notEqual((await b3.api("/api/me")).data.user.id, me1.data.user.id, "même courriel via un autre fournisseur = compte distinct");
  assert.equal(env.DB.raw("SELECT COUNT(*) n FROM users")[0].n, 2);
  assert.ok(providerLog.some((x) => x.url.includes("apple") && x.body.client_secret.split(".").length === 3), "secret client Apple signé (JWT)");
});

test("connexion refusée : état falsifié, nonce invalide, audience erronée, jeton expiré", async () => {
  const env = await makeEnv();
  const b = new Browser(env);
  assert.match((await b.login("google", G("x", "x@x.ca"), { tamperState: true })).location, /erreur=etat_invalide/);
  assert.match((await b.login("google", { ...G("x", "x@x.ca"), nonce: "autre" })).location, /erreur=bad_nonce/);
  assert.match((await b.login("google", { ...G("x", "x@x.ca"), aud: "un-autre-client" })).location, /erreur=bad_id_token/);
  assert.match((await b.login("google", { ...G("x", "x@x.ca"), expOverride: "-5m" })).location, /erreur=bad_id_token/);
  assert.equal(env.DB.raw("SELECT COUNT(*) n FROM users")[0].n, 0);
  // L'état ne peut servir qu'une fois
  const b2 = new Browser(env);
  const start = await b2.raw("/auth/google/start");
  const state = new URL(start.headers.get("location")).searchParams.get("state");
  await b2.raw(`/auth/google/callback?code=c1&state=${state}`);
  const again = await b2.raw(`/auth/google/callback?code=c2&state=${state}`);
  assert.match(again.headers.get("location"), /erreur=etat_invalide|erreur=etat_expire/);
});

test("Apple : adresse masquée reconnue, nom reçu à la première autorisation", async () => {
  const env = await makeEnv();
  const b = new Browser(env);
  await b.login("apple", { sub: "a.1", email: "xyz123@privaterelay.appleid.com", email_verified: "true", is_private_email: "true", __user: { name: { firstName: "Julie", lastName: "Roy" } } });
  const me = (await b.api("/api/me")).data;
  assert.equal(me.user.first_name, "Julie");
  assert.equal(me.identities[0].is_private_email, true);
});

test("session : déconnexion, expiration absolue et par inactivité, CSRF", async () => {
  const env = await makeEnv();
  const b = new Browser(env);
  await b.login("google", G("s1", "s1@x.ca"));
  assert.equal((await b.api("/api/me", { method: "PATCH", body: { first_name: "A" }, csrf: false })).status, 403, "sans en-tête CSRF");
  assert.equal((await b.api("/api/me", { method: "PATCH", body: { first_name: "A" }, origin: "https://evil.example" })).status, 403, "autre origine");
  assert.equal((await b.api("/api/me", { method: "PATCH", body: { first_name: "A" } })).status, 200);
  env.DB.exec("UPDATE sessions SET last_seen_at = ?", Date.now() - 13 * 3600e3);
  const exp = await b.api("/api/me");
  assert.equal(exp.status, 401); assert.equal(exp.data.code, "session_expired");
  await b.login("google", G("s1", "s1@x.ca"));
  env.DB.exec("UPDATE sessions SET expires_at = ?", Date.now() - 1);
  assert.equal((await b.api("/api/me")).status, 401);
  await b.login("google", G("s1", "s1@x.ca"));
  assert.equal((await b.api("/auth/logout", { method: "POST" })).status, 200);
  assert.equal((await b.api("/api/me")).status, 401);
  assert.equal(env.DB.raw("SELECT COUNT(*) n FROM sessions")[0].n, 0);
});

test("administrateur de la plateforme : activation unique par code, essais limités", async () => {
  const env = await makeEnv();
  const a = new Browser(env), b = new Browser(env);
  await a.login("google", G("a", "a@x.ca")); await b.login("google", G("b", "b@x.ca"));
  for (let i = 0; i < 5; i++) assert.equal((await b.api("/api/platform/bootstrap", { method: "POST", body: { code: "faux" } })).status, 403);
  assert.equal((await b.api("/api/platform/bootstrap", { method: "POST", body: { code: env.ADMIN_CODE } })).status, 429, "bloqué après 5 essais");
  assert.equal((await a.api("/api/platform/bootstrap", { method: "POST", body: { code: env.ADMIN_CODE } })).status, 200);
  assert.equal((await b.api("/api/platform/orgs")).status, 403);
  const c = new Browser(env); await c.login("google", G("c", "c@x.ca"));
  assert.equal((await c.api("/api/platform/bootstrap", { method: "POST", body: { code: env.ADMIN_CODE } })).status, 409, "un seul amorçage");
});

test("invitations : destinataire vérifié, usage unique, expirée, révoquée", async () => {
  const { env, alice, A } = await twoOrgs();
  const t1 = await invite(alice, A, "carol@a.ca");
  const preview = await new Browser(env).api(`/api/invitations/${t1}`);
  assert.equal(preview.data.state, "pending"); assert.equal(preview.data.orgName, "Clinique A"); assert.ok(!JSON.stringify(preview.data).includes("carol@a.ca"), "adresse masquée dans l'aperçu");
  const intrus = new Browser(env); await intrus.login("google", G("intrus", "intrus@autre.ca"));
  const bad = await join(intrus, t1);
  assert.equal(bad.status, 403); assert.equal(bad.data.code, "email_mismatch");
  const nonVerif = new Browser(env); await nonVerif.login("google", { ...G("nv", "carol@a.ca"), email_verified: false });
  assert.equal((await join(nonVerif, t1)).data.code, "email_mismatch", "adresse non vérifiée refusée");
  const carol = new Browser(env); await carol.login("google", G("carol", "carol@a.ca"));
  assert.equal((await join(carol, t1)).status, 200);
  const reuse = await join(carol, t1);
  assert.equal(reuse.status, 410); assert.equal(reuse.data.code, "invitation_used");
  const t2 = await invite(alice, A, "dan@a.ca");
  env.DB.exec("UPDATE invitations SET expires_at = ? WHERE email = 'dan@a.ca'", Date.now() - 1);
  const dan = new Browser(env); await dan.login("google", G("dan", "dan@a.ca"));
  const expired = await join(dan, t2);
  assert.equal(expired.status, 410); assert.equal(expired.data.code, "invitation_expired");
  const t3 = await invite(alice, A, "dan@a.ca");
  const inv = (await alice.api(`/api/orgs/${A}/invitations`)).data.invitations.find((i) => i.state === "pending" && i.email === "dan@a.ca");
  assert.equal((await alice.api(`/api/orgs/${A}/invitations/${inv.id}`, { method: "DELETE" })).status, 200);
  assert.equal((await join(dan, t3)).data.code, "invitation_revoked");
  assert.equal(env.DB.raw("SELECT COUNT(*) n FROM invitations WHERE token_hash LIKE '%' || ? || '%'", t3)[0].n, 0, "jeton jamais stocké en clair");
  // Aucun rattachement par domaine : quelqu'un de @a.ca sans invitation n'a accès à rien
  const eve = new Browser(env); await eve.login("google", G("eve", "eve@a.ca"));
  assert.equal((await eve.api("/api/me")).data.memberships.length, 0);
  assert.equal((await eve.api(`/api/orgs/${A}`)).status, 404);
});

test("isolation stricte entre établissements", async () => {
  const { alice, bob, A, B } = await twoOrgs();
  const bobMember = await memberId(bob, B, "bob@b.ca");
  assert.equal((await alice.api(`/api/orgs/${B}`)).status, 404);
  assert.equal((await alice.api(`/api/orgs/${B}/members`)).status, 404);
  assert.equal((await alice.api(`/api/orgs/${B}/invitations`, { method: "POST", body: { email: "x@x.ca" } })).status, 404);
  assert.equal((await alice.api(`/api/orgs/${B}/audit`)).status, 404);
  assert.equal((await alice.api("/api/session/org", { method: "POST", body: { orgId: B } })).status, 404);
  // Identifiant d'un membre de B glissé dans une requête sur A : rien ne correspond
  assert.equal((await alice.api(`/api/orgs/${A}/members/${bobMember}`, { method: "PATCH", body: { role: "member" } })).status, 404);
  assert.equal((await alice.api(`/api/orgs/${A}/members/${bobMember}`, { method: "DELETE" })).status, 404);
  assert.equal((await alice.api(`/api/orgs/${A}/transfer`, { method: "POST", body: { memberId: bobMember } })).status, 404);
  const bInv = await invite(bob, B, "zed@b.ca");
  const bInvId = (await bob.api(`/api/orgs/${B}/invitations`)).data.invitations[0].id;
  assert.equal((await alice.api(`/api/orgs/${A}/invitations/${bInvId}`, { method: "DELETE" })).status, 404);
  assert.ok(bInv);
  const aliceList = (await alice.api(`/api/orgs/${A}/members`)).data.members;
  assert.ok(!aliceList.some((m) => m.email && m.email.endsWith("@b.ca")), "aucune donnée de B dans la liste de A");
  assert.equal((await alice.api(`/api/orgs/${A}`)).status, 200);
});

test("matrice des permissions appliquée côté serveur", async () => {
  const { env, alice, A } = await twoOrgs();
  const mem = new Browser(env); await mem.login("google", G("mem", "mem@a.ca"));
  await join(mem, await invite(alice, A, "mem@a.ca", "member"));
  const adm = new Browser(env); await adm.login("google", G("adm", "adm@a.ca"));
  await join(adm, await invite(alice, A, "adm@a.ca", "admin"));
  assert.equal((await mem.api(`/api/orgs/${A}`)).status, 200);
  assert.equal((await mem.api(`/api/orgs/${A}/members`)).status, 403);
  assert.equal((await mem.api(`/api/orgs/${A}/invitations`, { method: "POST", body: { email: "n@a.ca" } })).status, 403);
  assert.equal((await mem.api(`/api/orgs/${A}`, { method: "PATCH", body: { name: "Piraté" } })).status, 403);
  assert.equal((await adm.api(`/api/orgs/${A}/invitations`, { method: "POST", body: { email: "n@a.ca", role: "admin" } })).status, 201);
  assert.equal((await adm.api(`/api/orgs/${A}/invitations`, { method: "POST", body: { email: "o@a.ca", role: "owner" } })).status, 403, "un admin ne nomme pas de propriétaire");
  const aliceM = await memberId(alice, A, "alice@a.ca"), memM = await memberId(alice, A, "mem@a.ca");
  assert.equal((await adm.api(`/api/orgs/${A}/members/${aliceM}`, { method: "PATCH", body: { role: "member" } })).status, 403, "un admin ne touche pas au propriétaire");
  assert.equal((await adm.api(`/api/orgs/${A}/members/${memM}`, { method: "PATCH", body: { role: "owner" } })).status, 403, "pas d'escalade vers propriétaire");
  assert.equal((await adm.api(`/api/orgs/${A}/members/${memM}`, { method: "PATCH", body: { role: "admin", function: "tsa" } })).status, 200);
  assert.equal((await adm.api(`/api/orgs/${A}/transfer`, { method: "POST", body: { memberId: memM } })).status, 403);
  assert.equal((await adm.api(`/api/orgs/${A}/members/${aliceM}`, { method: "DELETE" })).status, 403);
  const roles = env.DB.raw("SELECT role, function FROM memberships WHERE id = ?", memM)[0];
  assert.deepEqual(roles, { role: "admin", function: "tsa" }, "fonction et rôle sont distincts");
});

test("dernier propriétaire protégé, transfert de propriété", async () => {
  const { env, plat, alice, A } = await twoOrgs();
  const aliceM = await memberId(alice, A, "alice@a.ca");
  assert.equal((await alice.api(`/api/orgs/${A}/members/${aliceM}`, { method: "PATCH", body: { role: "admin" } })).data.code, "last_owner");
  assert.equal((await alice.api(`/api/orgs/${A}/leave`, { method: "POST" })).data.code, "last_owner");
  assert.equal((await plat.api(`/api/orgs/${A}/members/${aliceM}`, { method: "DELETE" })).data.code, "last_owner", "même l'admin de la plateforme");
  assert.equal((await plat.api(`/api/orgs/${A}/members/${aliceM}`, { method: "PATCH", body: { status: "disabled" } })).data.code, "last_owner");
  assert.equal((await alice.api("/api/me/delete", { method: "POST", body: { confirm: "SUPPRIMER" } })).data.code, "last_owner");
  const fred = new Browser(env); await fred.login("google", G("fred", "fred@a.ca"));
  await join(fred, await invite(alice, A, "fred@a.ca"));
  const fredM = await memberId(alice, A, "fred@a.ca");
  assert.equal((await alice.api(`/api/orgs/${A}/transfer`, { method: "POST", body: { memberId: fredM } })).status, 200);
  assert.equal(env.DB.raw("SELECT role FROM memberships WHERE id = ?", fredM)[0].role, "owner");
  assert.equal(env.DB.raw("SELECT role FROM memberships WHERE id = ?", aliceM)[0].role, "admin");
  assert.equal((await alice.api(`/api/orgs/${A}/leave`, { method: "POST" })).status, 200);
});

test("désactivation : accès retiré immédiatement dans une session déjà ouverte", async () => {
  const { env, plat, alice, A } = await twoOrgs();
  const gil = new Browser(env); await gil.login("google", G("gil", "gil@a.ca"));
  await join(gil, await invite(alice, A, "gil@a.ca", "admin"));
  assert.equal((await gil.api(`/api/orgs/${A}/members`)).status, 200);
  const gilM = await memberId(alice, A, "gil@a.ca");
  assert.equal((await alice.api(`/api/orgs/${A}/members/${gilM}`, { method: "PATCH", body: { status: "disabled" } })).status, 200);
  const blocked = await gil.api(`/api/orgs/${A}/members`);
  assert.equal(blocked.status, 403); assert.equal(blocked.data.code, "membership_disabled");
  assert.equal((await gil.api(`/api/orgs/${A}/invitations`, { method: "POST", body: { email: "z@a.ca" } })).status, 403);
  await alice.api(`/api/orgs/${A}/members/${gilM}`, { method: "PATCH", body: { status: "active" } });
  assert.equal((await gil.api(`/api/orgs/${A}/members`)).status, 200);
  // Changement de rôle : effet immédiat
  await alice.api(`/api/orgs/${A}/members/${gilM}`, { method: "PATCH", body: { role: "member" } });
  assert.equal((await gil.api(`/api/orgs/${A}/members`)).status, 403);
  // Retrait : plus aucun accès
  await alice.api(`/api/orgs/${A}/members/${gilM}`, { method: "DELETE" });
  assert.equal((await gil.api(`/api/orgs/${A}`)).status, 404);
  // Suspension par la plateforme : session coupée
  const gilId = (await gil.api("/api/me")).data.user.id;
  assert.equal((await plat.api(`/api/platform/users/${gilId}/status`, { method: "POST", body: { status: "suspended" } })).status, 200);
  assert.equal((await gil.api("/api/me")).status, 401);
  const relog = await gil.login("google", G("gil", "gil@a.ca"));
  assert.match(relog.location, /erreur=compte_suspendu/);
});

test("journal : rôles, invitations, désactivations, transferts, sans secret", async () => {
  const { env, alice, A } = await twoOrgs();
  const h = new Browser(env); await h.login("google", G("h", "h@a.ca"));
  const tok = await invite(alice, A, "h@a.ca");
  await join(h, tok);
  const hM = await memberId(alice, A, "h@a.ca");
  await alice.api(`/api/orgs/${A}/members/${hM}`, { method: "PATCH", body: { role: "admin" } });
  await alice.api(`/api/orgs/${A}/members/${hM}`, { method: "PATCH", body: { status: "disabled" } });
  await alice.api(`/api/orgs/${A}/members/${hM}`, { method: "PATCH", body: { status: "active" } });
  await alice.api(`/api/orgs/${A}/transfer`, { method: "POST", body: { memberId: hM, keepMyOwnership: true } });
  const log = (await alice.api(`/api/orgs/${A}/audit`)).data.entries.map((e) => e.action);
  for (const a of ["invitation.created", "invitation.accepted", "member.role_changed", "member.disabled", "member.enabled", "ownership.transferred"]) assert.ok(log.includes(a), a);
  const all = JSON.stringify(env.DB.raw("SELECT * FROM audit_log"));
  assert.ok(!all.includes(tok), "aucun jeton d'invitation");
  assert.ok(!all.includes(env.ADMIN_CODE), "aucun code");
  assert.ok(!all.includes("h@a.ca"), "courriels masqués");
});

test("association et retrait d'un moyen de connexion, récupération d'accès", async () => {
  const { env, plat, alice } = await twoOrgs();
  const aliceId = (await alice.api("/api/me")).data.user.id;
  const linked = await alice.login("apple", { sub: "apple-alice", email: "ali@privaterelay.appleid.com", email_verified: "true", is_private_email: "true" }, { mode: "link" });
  assert.match(linked.location, /associe=apple/);
  assert.equal((await alice.api("/api/me")).data.identities.length, 2);
  // Identité déjà utilisée par un autre compte : jamais fusionnée
  const other = new Browser(env); await other.login("apple", { sub: "apple-other", email: "o@x.ca", email_verified: "true" });
  const steal = await alice.login("apple", { sub: "apple-other", email: "o@x.ca", email_verified: "true" }, { mode: "link" });
  assert.match(steal.location, /erreur=identite_deja_utilisee/);
  // Authentification récente exigée
  env.DB.exec("UPDATE sessions SET auth_at = ? WHERE user_id = ?", Date.now() - 3600e3, aliceId);
  assert.match((await alice.login("google", G("g2", "x@x.ca"), { mode: "link" })).location, /erreur=reauth/);
  // Retrait : jamais le dernier
  const ids = (await alice.api("/api/me")).data.identities;
  assert.equal((await alice.api(`/api/me/identities/${ids[1].id}`, { method: "DELETE" })).status, 200);
  assert.equal((await alice.api(`/api/me/identities/${ids[0].id}`, { method: "DELETE" })).data.code, "last_identity");
  // Récupération : lien de la plateforme + adresse vérifiée correspondante
  const rec = (await plat.api(`/api/platform/users/${aliceId}/recovery`, { method: "POST", body: { email: "alice.perso@gmail.com" } })).data;
  const token = rec.link.split("recuperation=")[1];
  const lost = new Browser(env);
  assert.match((await lost.login("google", G("alice-new", "pas.elle@gmail.com"), { mode: "recovery", token })).location, /erreur=recuperation_courriel/);
  const ok = await lost.login("google", G("alice-new2", "alice.perso@gmail.com"), { mode: "recovery", token });
  assert.ok(!ok.location.includes("erreur"), ok.location);
  assert.equal((await lost.api("/api/me")).data.user.id, aliceId);
  assert.match((await new Browser(env).login("google", G("z", "alice.perso@gmail.com"), { mode: "recovery", token })).location, /erreur=recuperation_invalide/, "usage unique");
});

test("profil, désactivation et suppression du compte", async () => {
  const { env, alice, A } = await twoOrgs();
  const k = new Browser(env); await k.login("google", G("k", "k@a.ca"));
  await join(k, await invite(alice, A, "k@a.ca"));
  const p = await k.api("/api/me", { method: "PATCH", body: { first_name: "Kim", last_name: "Lee", job_title: "Réceptionniste", locale: "en-CA", notif_prefs: { invitations: false, roleChanges: true } } });
  assert.equal(p.status, 200); assert.equal(p.data.user.locale, "en-CA"); assert.equal(p.data.user.notif_prefs.invitations, false);
  assert.equal((await k.api("/api/me", { method: "PATCH", body: { photo: "javascript:alert(1)" } })).status, 400);
  assert.equal((await k.api("/api/me", { method: "PATCH", body: { locale: "xx" } })).status, 400);
  // Désactivation volontaire puis réactivation
  assert.equal((await k.api("/api/me/deactivate", { method: "POST", body: { confirm: true } })).status, 200);
  assert.equal((await k.api("/api/me")).status, 401, "session fermée");
  await k.login("google", G("k", "k@a.ca"));
  assert.equal((await k.api(`/api/orgs/${A}`)).data.code, "account_deactivated");
  assert.equal((await k.api("/api/me/reactivate", { method: "POST" })).data.user.status, "active");
  // Suppression
  assert.equal((await k.api("/api/me/delete", { method: "POST", body: { confirm: "oui" } })).status, 400);
  const kid = (await k.api("/api/me")).data.user.id;
  assert.equal((await k.api("/api/me/delete", { method: "POST", body: { confirm: "SUPPRIMER" } })).status, 200);
  for (const t of ["users WHERE id", "identities WHERE user_id", "sessions WHERE user_id", "memberships WHERE user_id"])
    assert.equal(env.DB.raw(`SELECT COUNT(*) n FROM ${t} = ?`, kid)[0].n, 0, t);
  assert.ok(env.DB.raw("SELECT action FROM audit_log WHERE action = 'account.deleted'").length >= 1);
  await k.login("google", G("k", "k@a.ca"));
  const fresh = (await k.api("/api/me")).data;
  assert.notEqual(fresh.user.id, kid); assert.equal(fresh.memberships.length, 0, "nouveau compte vierge");
});

test("création de l'établissement réservée à la plateforme, invitation affichée une seule fois", async () => {
  const { alice, plat } = await twoOrgs();
  assert.equal((await alice.api("/api/platform/orgs", { method: "POST", body: { name: "X" } })).status, 403);
  const r = await plat.api("/api/platform/orgs", { method: "POST", body: { name: "Clinique C", iAmOwner: true } });
  assert.equal(r.status, 201);
  const list = (await plat.api(`/api/orgs/${r.data.org.id}/invitations`)).data.invitations;
  assert.ok(list.every((i) => !("token_hash" in i) && !("link" in i)), "le lien n'est jamais relisible");
});
