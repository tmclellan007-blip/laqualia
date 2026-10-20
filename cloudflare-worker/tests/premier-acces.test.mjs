// Essais du premier accès simplifié : prénom + courriel (non vérifié) + code d'invitation.
// Aucun appel réel : modèle, fournisseurs et courriels simulés.
import test from "node:test";
import assert from "node:assert/strict";
import { makeEnv, Browser } from "./harness.mjs";

async function world() {
  const env = await makeEnv();
  const plat = new Browser(env);
  await plat.loginEmail("plateforme@laqualia.com");
  assert.equal((await plat.api("/api/platform/bootstrap", { method: "POST", body: { code: env.ADMIN_CODE } })).status, 200);
  const mk = async (name, email) => {
    const o = (await plat.api("/api/platform/orgs", { method: "POST", body: { name, ownerEmail: email } })).data;
    const owner = new Browser(env);
    await owner.loginEmail(email);
    assert.equal((await owner.api(`/api/invitations/${o.invite.link.split("#")[1]}/accept`, { method: "POST" })).status, 200);
    return { id: o.org.id, owner };
  };
  return { env, plat, A: await mk("Clinique A", "proprio@a.ca"), B: await mk("Clinique B", "proprio@b.ca") };
}
const code = async (owner, orgId, body = {}) => (await owner.api(`/api/orgs/${orgId}/access-codes`, { method: "POST", body })).data.code;
const enter = (b, body) => b.api("/auth/invite", { method: "POST", body });
const users = (env) => env.DB.raw("SELECT COUNT(*) n FROM users")[0].n;

test("premier accès : profil minimal, rattachement Membre, session ouverte, aucun courriel envoyé", async () => {
  const { env, A } = await world();
  const c = await code(A.owner, A.id);
  assert.equal(c.maxUses, 1, "usage unique par défaut");
  const sent = env.AUTH_EMAIL.sent.length;
  const julie = new Browser(env);
  const r = await enter(julie, { first_name: " Julie ", email: " Julie.Roy@A.ca ", code: c.code.toLowerCase().replace(/-/g, " ") });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.next, "/agent/"); assert.equal(r.data.orgName, "Clinique A");
  assert.match(r.res.headers.getSetCookie().join("\n"), /__Host-lq_sess=.+; Path=\/; Max-Age=7776000; HttpOnly; Secure; SameSite=Lax/);
  assert.equal(env.AUTH_EMAIL.sent.length, sent, "aucun courriel de confirmation");
  const st = (await julie.api("/api/agent")).data;
  assert.equal(st.account.org.id, A.id); assert.equal(st.account.role, "member");
  assert.equal(st.account.needsProfile, true); assert.equal(st.account.noIdentity, true);
  assert.equal(st.admin, false);
  const me = (await julie.api("/api/me")).data;
  assert.equal(me.user.first_name, "Julie"); assert.equal(me.user.last_name, null);
  assert.equal(me.user.contact_email, "julie.roy@a.ca"); assert.equal(me.user.signup, "invite");
  assert.deepEqual(me.identities, [], "le courriel saisi n'est pas un moyen de connexion");
  assert.equal(me.session.kind, "invite");
  assert.equal((await julie.raw("/api/agent", { method: "POST", body: { question: "Bonjour ?" } })).status, 200);
  assert.equal((await julie.raw("/api/agent", { method: "POST", body: { question: "Cas ?", role: "tsa" } })).status, 200);
  // Les membres de l'établissement voient la personne, avec un courriel marqué non vérifié
  const row = (await A.owner.api(`/api/orgs/${A.id}/members`)).data.members.find((m) => m.email === "julie.roy@a.ca");
  assert.equal(row.role, "member"); assert.equal(row.email_unverified, 1);
});

test("codes : déjà utilisé, expiré, révoqué, invalide ; champs requis ; aucun compte créé en cas d'échec", async () => {
  const { env, A } = await world();
  const c = await code(A.owner, A.id);
  assert.equal((await enter(new Browser(env), { first_name: "Un", email: "un@a.ca", code: c.code })).status, 200);
  const n0 = users(env);
  const b = new Browser(env);
  const used = await enter(b, { first_name: "Deux", email: "deux@a.ca", code: c.code });
  assert.equal(used.status, 410); assert.equal(used.data.code, "code_exhausted"); assert.match(used.data.error, /déjà été utilisé/); assert.equal(used.data.field, "code");
  const c2 = await code(A.owner, A.id);
  env.DB.exec("UPDATE access_codes SET expires_at = ? WHERE id = ?", Date.now() - 1, c2.id);
  const exp = await enter(b, { first_name: "Deux", email: "deux@a.ca", code: c2.code });
  assert.equal(exp.data.code, "code_expired"); assert.match(exp.data.error, /expiré/);
  const c3 = await code(A.owner, A.id);
  await A.owner.api(`/api/orgs/${A.id}/access-codes/${c3.id}`, { method: "DELETE" });
  assert.match((await enter(b, { first_name: "Deux", email: "deux@a.ca", code: c3.code })).data.error, /révoqué/);
  assert.equal((await enter(b, { first_name: "Deux", email: "deux@a.ca", code: "ABCD-EFGH-JKMN" })).data.code, "code_invalid");
  const c4 = await code(A.owner, A.id);
  const noName = await enter(b, { first_name: "  ", email: "deux@a.ca", code: c4.code });
  assert.equal(noName.status, 400); assert.equal(noName.data.field, "first_name");
  const badMail = await enter(b, { first_name: "Deux", email: "pas-un-courriel", code: c4.code });
  assert.equal(badMail.status, 400); assert.equal(badMail.data.field, "email");
  assert.equal((await b.api("/auth/invite", { method: "POST", body: { first_name: "Deux", email: "deux@a.ca", code: c4.code }, csrf: false })).status, 403);
  assert.equal(users(env), n0, "aucun compte créé par une tentative refusée");
  assert.equal((await A.owner.api(`/api/orgs/${A.id}/access-codes`)).data.codes.find((x) => x.id === c4.id).uses, 0, "le code n'est pas consommé par une saisie refusée");
  assert.equal((await enter(b, { first_name: "Deux", email: "deux@a.ca", code: c4.code })).status, 200);
});

test("le courriel ne retrouve jamais un compte existant et ne fusionne rien ; aucun droit d'administration", async () => {
  const { env, A, B } = await world();
  const ownerA = (await A.owner.api("/api/me")).data.user.id;
  const c = await code(B.owner, B.id);
  // Quelqu'un saisit l'adresse du propriétaire de A avec un code de B
  const x = new Browser(env);
  assert.equal((await enter(x, { first_name: "Imposteur", email: "proprio@a.ca", code: c.code })).status, 200);
  const me = (await x.api("/api/me")).data;
  assert.notEqual(me.user.id, ownerA, "nouveau compte distinct");
  assert.deepEqual(me.memberships.map((m) => [m.org_id, m.role]), [[B.id, "member"]], "aucune appartenance du compte existant");
  assert.equal((await x.api(`/api/orgs/${A.id}`)).status, 404, "isolation : aucun accès à A");
  assert.equal((await x.api(`/api/orgs/${B.id}/members`)).status, 403, "Membre : pas la liste des membres");
  assert.equal((await x.api(`/api/orgs/${B.id}/access-codes`)).status, 403);
  assert.equal((await x.raw("/api/agent", { method: "POST", headers: { "x-agent-mode": "admin" }, body: { action: "load" } })).status, 403);
  assert.equal((await x.api("/api/platform/orgs")).status, 403);
  // Le compte d'origine est intact
  const o = (await A.owner.api("/api/me")).data;
  assert.equal(o.user.id, ownerA); assert.equal(o.memberships[0].role, "owner");
  // Deux premiers accès avec la même adresse : deux comptes distincts
  const c2 = await code(B.owner, B.id);
  const y = new Browser(env);
  await enter(y, { first_name: "Autre", email: "proprio@a.ca", code: c2.code });
  assert.notEqual((await y.api("/api/me")).data.user.id, me.user.id);
});

test("reconnexion : session conservée sur l'appareil ; sessions administrateur inchangées", async () => {
  const { env, plat, A } = await world();
  const c = await code(A.owner, A.id);
  const m = new Browser(env);
  await enter(m, { first_name: "Léa", email: "lea@a.ca", code: c.code });
  const uidM = (await m.api("/api/me")).data.user.id;
  // Retour le lendemain (13 h d'inactivité) : aucune nouvelle demande de code
  env.DB.exec("UPDATE sessions SET last_seen_at = ? WHERE user_id = ?", Date.now() - 13 * 3600e3, uidM);
  assert.equal((await m.api("/api/agent")).status, 200);
  // Après 31 jours sans utilisation, la session expire
  env.DB.exec("UPDATE sessions SET last_seen_at = ? WHERE user_id = ?", Date.now() - 31 * 24 * 3600e3, uidM);
  assert.equal((await m.api("/api/agent")).status, 401);
  // Les sessions administrateur gardent leur règle actuelle (12 h d'inactivité)
  const platId = (await plat.api("/api/me")).data.user.id;
  env.DB.exec("UPDATE sessions SET last_seen_at = ? WHERE user_id = ?", Date.now() - 13 * 3600e3, platId);
  assert.equal((await plat.api("/api/me")).status, 401);
  const again = new Browser(env);
  await again.loginEmail("plateforme@laqualia.com");
  const pm = (await again.api("/api/me")).data;
  assert.equal(pm.user.id, platId); assert.equal(pm.user.platform_admin, true); assert.equal(pm.session.kind, "auth");
  assert.equal((await again.raw("/api/agent", { method: "POST", headers: { "x-agent-mode": "admin" }, body: { action: "load" } })).status, 200, "Admin de l'agent toujours accessible");
});

test("compléter le profil : nom, courriel et moyen de connexion associés sans nouvelle vérification de session", async () => {
  const { env, A } = await world();
  env.MEMBER_EMAIL_LINK = "on"; // option qui sera activée en production
  const c = await code(A.owner, A.id);
  const m = new Browser(env);
  await enter(m, { first_name: "Noé", email: "noe@a.ca", code: c.code });
  env.DB.exec("UPDATE sessions SET auth_at = ?", Date.now() - 3 * 3600e3); // plus de 30 minutes après l'entrée
  const p = await m.api("/api/me", { method: "PATCH", body: { last_name: "Gagnon", contact_email: "noe.gagnon@a.ca" } });
  assert.equal(p.status, 200); assert.equal(p.data.user.contact_email, "noe.gagnon@a.ca");
  const link = await m.loginEmail("noe.gagnon@a.ca", { mode: "link" });
  assert.equal(link.verify.status, 200, JSON.stringify(link.start.data));
  const st = (await m.api("/api/agent")).data.account;
  assert.equal(st.noIdentity, false); assert.equal(st.needsProfile, false);
  // Désormais, la personne peut se reconnecter sur un autre appareil par la connexion existante
  const other = new Browser(env);
  await other.loginEmail("noe.gagnon@a.ca");
  assert.equal((await other.api("/api/me")).data.user.id, (await m.api("/api/me")).data.user.id);
  assert.equal((await other.api("/api/agent")).data.account.org.id, A.id);
});

test("appareil partagé, limite d'essais et retrait d'accès", async () => {
  const { env, A } = await world();
  const ca = await code(A.owner, A.id, { maxUses: 5 });
  const shared = new Browser(env);
  await enter(shared, { first_name: "Ana", email: "ana@a.ca", code: ca.code });
  const ana = (await shared.api("/api/me")).data.user.id;
  await enter(shared, { first_name: "Ben", email: "ben@a.ca", code: ca.code });
  assert.notEqual((await shared.api("/api/me")).data.user.id, ana, "la nouvelle personne a son propre compte");
  assert.equal(env.DB.raw("SELECT COUNT(*) n FROM sessions WHERE user_id = ?", ana)[0].n, 0, "la session précédente de cet appareil est fermée");
  // Retrait d'accès : immédiat
  const mid = (await A.owner.api(`/api/orgs/${A.id}/members`)).data.members.find((x) => x.email === "ben@a.ca").id;
  await A.owner.api(`/api/orgs/${A.id}/members/${mid}`, { method: "PATCH", body: { status: "disabled" } });
  assert.equal((await shared.api("/api/agent")).data.code, "membership_disabled");
  // Limite : 10 essais par adresse IP par 15 minutes
  const t = new Browser(env);
  for (let i = 0; i < 8; i++) await enter(t, { first_name: "X", email: "x@a.ca", code: "ZZZZ-ZZZZ-ZZZ" + (2 + i) });
  assert.equal((await enter(t, { first_name: "X", email: "x@a.ca", code: ca.code })).status, 429, "au-delà de 10 essais, même un bon code est refusé un moment");
});

test("pour l'instant : association d'une adresse refusée aux Membres, permise aux administrateurs", async () => {
  const { env, A, plat } = await world();
  const c = await code(A.owner, A.id);
  const m = new Browser(env);
  await enter(m, { first_name: "Zoé", email: "zoe@a.ca", code: c.code });
  const r = await m.api("/auth/email/start", { method: "POST", body: { email: "zoe@a.ca", mode: "link" } });
  assert.equal(r.status, 403); assert.equal(r.data.code, "link_disabled");
  const st = (await m.api("/api/agent")).data.account;
  assert.equal(st.canLinkEmail, false);
  assert.equal(st.needsProfile, true, "le nom de famille manque encore");
  await m.api("/api/me", { method: "PATCH", body: { last_name: "Côté" } });
  assert.equal((await m.api("/api/agent")).data.account.needsProfile, false, "sans association possible, le nom suffit");
  assert.equal((await m.api("/api/me")).data.canLinkEmail, false);
  // Propriétaire d'établissement et administrateur de la plateforme : toujours permis
  assert.equal((await A.owner.api("/auth/email/start", { method: "POST", body: { email: "autre-proprio@a.ca", mode: "link" } })).status, 200);
  assert.equal((await plat.api("/api/me")).data.canLinkEmail, true);
  // En production : MEMBER_EMAIL_LINK = "on"
  env.MEMBER_EMAIL_LINK = "on";
  assert.equal((await m.api("/auth/email/start", { method: "POST", body: { email: "zoe@a.ca", mode: "link" } })).status, 200);
});
