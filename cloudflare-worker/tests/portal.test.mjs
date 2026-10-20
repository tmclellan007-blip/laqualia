// Essais du parcours d'accès simplifié au portail : code d'établissement, rattachement Membre,
// accès au portail par session (sans codes d'équipe, TSA ni Admin), retrait d'accès.
// Aucun appel réel : modèle, fournisseurs et courriels simulés.
import test from "node:test";
import assert from "node:assert/strict";
import { makeEnv, Browser, modelLog } from "./harness.mjs";

const G = (sub, email) => ({ sub, email, email_verified: true, given_name: "Prénom" + sub, family_name: "Nom" });
const ask = (b, extra = {}) => b.raw("/api/agent", { method: "POST", body: { question: "Comment annoncer un retard ?", ...extra } });

async function world() {
  const env = await makeEnv();
  const plat = new Browser(env);
  await plat.login("google", G("plat", "plateforme@laqualia.com"));
  assert.equal((await plat.api("/api/platform/bootstrap", { method: "POST", body: { code: env.ADMIN_CODE } })).status, 200);
  const mk = async (name, email) => {
    const o = (await plat.api("/api/platform/orgs", { method: "POST", body: { name, ownerEmail: email } })).data;
    const owner = new Browser(env);
    await owner.loginEmail(email);
    assert.equal((await owner.api(`/api/invitations/${o.invite.link.split("#")[1]}/accept`, { method: "POST" })).status, 200);
    return { id: o.org.id, owner };
  };
  const A = await mk("Clinique A", "proprio@a.ca");
  const B = await mk("Clinique B", "proprio@b.ca");
  return { env, plat, A, B };
}
async function newCode(b, orgId, body = {}) {
  const r = await b.api(`/api/orgs/${orgId}/access-codes`, { method: "POST", body: { maxUses: 10, ...body } });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  return r.data.code;
}

test("parcours complet : compte, code, rattachement Membre, portail sans code, reconnexion", async () => {
  const { env, A } = await world();
  const c = await newCode(A.owner, A.id, { label: "Équipe de soir", maxUses: 5 });
  assert.match(c.code, /^[A-HJKMNP-Z2-9]{4}-[A-HJKMNP-Z2-9]{4}-[A-HJKMNP-Z2-9]{4}$/);

  // 1. Création du compte : aucun accès au portail tant que le code n'est pas validé.
  const julie = new Browser(env);
  await julie.loginEmail("julie@a.ca");
  assert.equal((await julie.api("/api/agent")).data.code, "no_access");
  assert.equal((await ask(julie)).status, 403);
  assert.equal((await julie.api("/api/access/status")).data.access, false);
  assert.equal(modelLog.length, 0, "aucune question transmise sans rattachement");

  // 2. Code erroné puis code valide (saisi en minuscules, avec espaces).
  assert.equal((await julie.api("/api/access/redeem", { method: "POST", body: { code: "ABCD-EFGH-JKMN" } })).data.code, "code_invalid");
  const ok = await julie.api("/api/access/redeem", { method: "POST", body: { code: " " + c.code.toLowerCase().replace(/-/g, " ") + " " } });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.equal(ok.data.orgId, A.id);

  // 3. Rattachée au bon établissement, avec le rôle Membre seulement.
  const st = (await julie.api("/api/agent")).data;
  assert.equal(st.account.org.id, A.id);
  assert.equal(st.account.role, "member");
  assert.equal(st.tsaOk, true); assert.equal(st.needsCode, false); assert.equal(st.admin, false);
  const me = (await julie.api("/api/me")).data;
  assert.deepEqual(me.memberships.map((m) => [m.org_id, m.role, m.status]), [[A.id, "member", "active"]]);

  // 4. Navigation : Réception et TSA sans aucun code d'équipe ni code TSA.
  const r1 = await ask(julie);
  assert.equal(r1.status, 200); assert.match(await r1.text(), /Réponse simulée/);
  const r2 = await ask(julie, { role: "tsa" });
  assert.equal(r2.status, 200); assert.equal(r2.headers.get("x-agent-role"), "tsa");
  assert.ok(!r1.headers.get("access-control-allow-origin"), "même site : aucun en-tête CORS");

  // 5. Reconnexion sur un autre appareil : aucune nouvelle saisie du code.
  const again = new Browser(env);
  await again.loginEmail("julie@a.ca");
  assert.equal((await again.api("/api/agent")).status, 200);
  assert.equal((await ask(again)).status, 200);
  // Ressaisir le code ne consomme pas une deuxième utilisation.
  assert.equal((await again.api("/api/access/redeem", { method: "POST", body: { code: c.code } })).data.already, true);
  const list = (await A.owner.api(`/api/orgs/${A.id}/access-codes`)).data.codes;
  assert.equal(list[0].uses, 1);
});

test("le code ne donne jamais de droits d'administration", async () => {
  const { env, A } = await world();
  const c = await newCode(A.owner, A.id);
  const m = new Browser(env);
  await m.loginEmail("membre@a.ca");
  await m.api("/api/access/redeem", { method: "POST", body: { code: c.code } });
  assert.equal((await m.api(`/api/orgs/${A.id}/access-codes`)).status, 403, "un Membre ne voit pas les codes");
  assert.equal((await m.api(`/api/orgs/${A.id}/access-codes`, { method: "POST", body: {} })).status, 403);
  assert.equal((await m.api(`/api/orgs/${A.id}/access-codes/${c.id}`, { method: "DELETE" })).status, 403);
  assert.equal((await m.api(`/api/orgs/${A.id}/access-codes/${c.id}/renew`, { method: "POST" })).status, 403);
  assert.equal((await m.api(`/api/orgs/${A.id}/members`)).status, 403);
  assert.equal((await m.api(`/api/orgs/${A.id}/invitations`, { method: "POST", body: { email: "x@a.ca", role: "admin" } })).status, 403);
  const adm = await m.raw("/api/agent", { method: "POST", headers: { "x-agent-mode": "admin" }, body: { action: "load" } });
  assert.equal(adm.status, 403, "configuration de l'agent refusée à un Membre");
  // Même un propriétaire d'établissement ne configure pas l'agent commun : réservé à la plateforme.
  assert.equal((await A.owner.raw("/api/agent", { method: "POST", headers: { "x-agent-mode": "admin" }, body: { action: "load" } })).status, 403);
});

test("gestion des codes : consulter, renouveler, révoquer, expiration, nombre d'utilisations, isolation", async () => {
  const { env, A, B } = await world();
  const c = await newCode(A.owner, A.id, { maxUses: 2, label: "Stagiaires" });
  const view = (await A.owner.api(`/api/orgs/${A.id}/access-codes`)).data.codes[0];
  assert.equal(view.code, c.code, "l'administrateur peut revoir et copier le code");
  assert.equal(view.state, "active"); assert.equal(view.maxUses, 2); assert.equal(view.label, "Stagiaires");

  // Nombre maximal d'utilisations
  for (const e of ["u1@a.ca", "u2@a.ca"]) { const b = new Browser(env); await b.loginEmail(e); assert.equal((await b.api("/api/access/redeem", { method: "POST", body: { code: c.code } })).status, 200); }
  const u3 = new Browser(env); await u3.loginEmail("u3@a.ca");
  const ex = await u3.api("/api/access/redeem", { method: "POST", body: { code: c.code } });
  assert.equal(ex.data.code, "code_exhausted"); assert.match(ex.data.error, /déjà été utilisé/);

  // Renouveler : l'ancien code est révoqué, le nouveau fonctionne avec les mêmes réglages
  const rn = await A.owner.api(`/api/orgs/${A.id}/access-codes/${c.id}/renew`, { method: "POST" });
  assert.equal(rn.status, 201);
  assert.notEqual(rn.data.code.code, c.code);
  assert.equal(rn.data.code.maxUses, 2); assert.equal(rn.data.code.label, "Stagiaires");
  const old = await u3.api("/api/access/redeem", { method: "POST", body: { code: c.code } });
  assert.equal(old.data.code, "code_revoked"); assert.match(old.data.error, /révoqué/);
  assert.equal((await u3.api("/api/access/redeem", { method: "POST", body: { code: rn.data.code.code } })).status, 200);
  const codes = (await A.owner.api(`/api/orgs/${A.id}/access-codes`)).data.codes;
  assert.equal(codes.find((x) => x.id === c.id).code, null, "un code révoqué n'est plus affiché en clair");

  // Révoquer bloque les nouvelles inscriptions, sans retirer les membres déjà inscrits
  const c2 = await newCode(A.owner, A.id);
  const early = new Browser(env); await early.loginEmail("tot@a.ca");
  await early.api("/api/access/redeem", { method: "POST", body: { code: c2.code } });
  assert.equal((await A.owner.api(`/api/orgs/${A.id}/access-codes/${c2.id}`, { method: "DELETE" })).status, 200);
  const late = new Browser(env); await late.loginEmail("tard@a.ca");
  assert.equal((await late.api("/api/access/redeem", { method: "POST", body: { code: c2.code } })).data.code, "code_revoked");
  assert.equal((await early.api("/api/agent")).status, 200, "révoquer le code ne retire pas l'accès des membres déjà inscrits");

  // Expiration
  const c3 = await newCode(A.owner, A.id);
  assert.ok(Math.abs(c3.expiresAt - (Date.now() + 24 * 3600e3)) < 60e3, "les codes expirent 24 heures après leur création");
  env.DB.exec("UPDATE access_codes SET expires_at = ? WHERE id = ?", Date.now() - 1, c3.id);
  const r3 = await late.api("/api/access/redeem", { method: "POST", body: { code: c3.code } });
  assert.equal(r3.data.code, "code_expired"); assert.match(r3.data.error, /expiré/);

  // Réglages invalides
  const def = await A.owner.api(`/api/orgs/${A.id}/access-codes`, { method: "POST", body: {} });
  assert.ok(Math.abs(def.data.code.expiresAt - (Date.now() + 24 * 3600e3)) < 60e3, "24 h par défaut");
  assert.equal(def.data.code.maxUses, 1, "usage unique par défaut");
  const h6 = await A.owner.api(`/api/orgs/${A.id}/access-codes`, { method: "POST", body: { expiresInHours: 6 } });
  assert.ok(Math.abs(h6.data.code.expiresAt - (Date.now() + 6 * 3600e3)) < 60e3, "durée choisie en heures");
  const rn6 = await A.owner.api(`/api/orgs/${A.id}/access-codes/${h6.data.code.id}/renew`, { method: "POST", body: {} });
  assert.ok(Math.abs(rn6.data.code.expiresAt - (Date.now() + 6 * 3600e3)) < 60e3, "le renouvellement garde la même durée");
  for (const bad of [0, 721, 2.5, "abc"]) assert.equal((await A.owner.api(`/api/orgs/${A.id}/access-codes`, { method: "POST", body: { expiresInHours: bad } })).status, 400, "durée refusée : " + bad);
  assert.equal((await A.owner.api(`/api/orgs/${A.id}/access-codes`, { method: "POST", body: { maxUses: 0 } })).status, 400);

  // Isolation : l'administrateur de B ne voit ni ne touche les codes de A ; un code de B rattache à B
  assert.equal((await B.owner.api(`/api/orgs/${A.id}/access-codes`)).status, 404);
  assert.equal((await B.owner.api(`/api/orgs/${B.id}/access-codes/${rn.data.code.id}`, { method: "DELETE" })).status, 404);
  assert.equal((await B.owner.api(`/api/orgs/${B.id}/access-codes/${rn.data.code.id}/renew`, { method: "POST" })).status, 404);
  const cb = await newCode(B.owner, B.id);
  const bob = new Browser(env); await bob.loginEmail("bob@b.ca");
  assert.equal((await bob.api("/api/access/redeem", { method: "POST", body: { code: cb.code } })).data.orgId, B.id);
  assert.equal((await bob.api("/api/agent")).data.account.org.id, B.id);
  assert.equal((await bob.api(`/api/orgs/${A.id}`)).status, 404);

  // Le code n'apparaît jamais en clair dans la base ni dans le journal
  const dump = JSON.stringify(env.DB.raw("SELECT * FROM access_codes")) + JSON.stringify(env.DB.raw("SELECT * FROM audit_log")) + JSON.stringify(env.DB.raw("SELECT * FROM memberships"));
  for (const k of [c.code, rn.data.code.code, c2.code, cb.code]) { assert.ok(!dump.includes(k)); assert.ok(!dump.includes(k.replace(/-/g, ""))); }
  const actions = env.DB.raw("SELECT action FROM audit_log WHERE org_id = ?", A.id).map((r) => r.action);
  for (const a of ["access_code.created", "access_code.redeemed", "access_code.renewed", "access_code.revoked"]) assert.ok(actions.includes(a), a);
});

test("retrait d'accès : effet immédiat, le code ne le rétablit pas", async () => {
  const { env, A } = await world();
  const c = await newCode(A.owner, A.id);
  const m = new Browser(env);
  await m.loginEmail("retrait@a.ca");
  await m.api("/api/access/redeem", { method: "POST", body: { code: c.code } });
  assert.equal((await ask(m)).status, 200);
  const mid = (await A.owner.api(`/api/orgs/${A.id}/members`)).data.members.find((x) => x.email === "retrait@a.ca").id;

  // Désactivation : la session déjà ouverte perd l'accès à la requête suivante
  assert.equal((await A.owner.api(`/api/orgs/${A.id}/members/${mid}`, { method: "PATCH", body: { status: "disabled" } })).status, 200);
  const g = await m.api("/api/agent");
  assert.equal(g.status, 403); assert.equal(g.data.code, "membership_disabled"); assert.match(g.data.error, /Clinique A/);
  assert.equal((await ask(m)).status, 403);
  // Ressaisir un code valide ne rétablit pas un accès retiré
  const back = await m.api("/api/access/redeem", { method: "POST", body: { code: c.code } });
  assert.equal(back.status, 403); assert.equal(back.data.code, "membership_disabled");
  // Réactivation par l'administrateur
  await A.owner.api(`/api/orgs/${A.id}/members/${mid}`, { method: "PATCH", body: { status: "active" } });
  assert.equal((await ask(m)).status, 200);

  // Retrait complet : plus d'accès ; un code encore actif permettrait de revenir (d'où le choix de la désactivation)
  assert.equal((await A.owner.api(`/api/orgs/${A.id}/members/${mid}`, { method: "DELETE" })).status, 200);
  assert.equal((await m.api("/api/agent")).data.code, "no_access");

  // Compte suspendu par la plateforme, déconnexion : plus d'accès
  const m2 = new Browser(env); await m2.loginEmail("deux@a.ca");
  await m2.api("/api/access/redeem", { method: "POST", body: { code: c.code } });
  await m2.api("/auth/logout", { method: "POST" });
  assert.equal((await m2.api("/api/agent")).status, 401);
});

test("sécurité : limite d'essais, CSRF, session obligatoire, configuration par la plateforme", async () => {
  const { env, plat, A } = await world();
  const c = await newCode(A.owner, A.id);
  const b = new Browser(env);
  await b.loginEmail("essais@a.ca");
  for (let i = 0; i < 8; i++) assert.equal((await b.api("/api/access/redeem", { method: "POST", body: { code: "ZZZZ-ZZZZ-ZZ" + String(i).padStart(2, "2") } })).status, 404);
  const blocked = await b.api("/api/access/redeem", { method: "POST", body: { code: c.code } });
  assert.equal(blocked.status, 429, "après 8 essais, même le bon code est refusé pour un temps");
  // Sans session
  const anon = new Browser(env);
  assert.equal((await anon.api("/api/access/redeem", { method: "POST", body: { code: c.code } })).status, 401);
  assert.equal((await anon.api("/api/agent")).status, 401);
  // CSRF sur le portail
  const m = new Browser(env); await m.loginEmail("csrf@a.ca");
  await m.api("/api/access/redeem", { method: "POST", body: { code: c.code } });
  assert.equal((await m.raw("/api/agent", { method: "POST", body: { question: "x" }, csrf: false })).status, 403);
  assert.equal((await m.raw("/api/agent", { method: "POST", body: { question: "x" }, origin: "https://pirate.example" })).status, 403);
  // Le code transmis n'est jamais dans une URL : l'échange se fait en POST JSON seulement
  assert.equal((await m.api(`/api/access/redeem?code=${c.code}`)).status, 404);
  // L'administrateur de la plateforme configure l'agent sans code Admin
  const cfg = await plat.raw("/api/agent", { method: "POST", headers: { "x-agent-mode": "admin" }, body: { action: "load", role: "reception" } });
  assert.equal(cfg.status, 200);
  assert.equal((await plat.api("/api/agent")).data.admin, true);
});
