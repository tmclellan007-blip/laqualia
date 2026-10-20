// Essais de la connexion par code courriel : node --test tests/
// Aucun courriel réel : l'envoi est simulé (FakeMailer).
import test from "node:test";
import assert from "node:assert/strict";
import { makeEnv, Browser } from "./harness.mjs";

const G = (sub, email, extra = {}) => ({ sub, email, email_verified: true, given_name: "Prénom" + sub, family_name: "Nom", ...extra });

async function platform(env) {
  const plat = new Browser(env);
  await plat.login("google", G("plat", "plateforme@laqualia.com"));
  assert.equal((await plat.api("/api/platform/bootstrap", { method: "POST", body: { code: env.ADMIN_CODE } })).status, 200);
  return plat;
}

test("code courriel : création du compte, reconnexion au même compte, jamais fusionné avec Google", async () => {
  const env = await makeEnv();
  assert.equal((await new Browser(env).api("/auth/providers")).data.email, true);
  const b1 = new Browser(env);
  const r = await b1.loginEmail("  Julie@Clinique.CA ");
  assert.equal(r.start.status, 200);
  assert.equal(r.start.data.emailHint, "ju•••@clinique.ca");
  assert.match(r.start.res.headers.getSetCookie().join("\n"), /__Secure-lq_ecode=.+; Path=\/auth\/email\/; Max-Age=600; HttpOnly; Secure; SameSite=Strict/);
  const mail = env.AUTH_EMAIL.sent.at(-1);
  assert.equal(mail.to, "julie@clinique.ca");
  assert.equal(mail.from.email, "connexion@notif.laqualia.com");
  assert.match(mail.subject, /^\d{6} est votre code La Qualia$/);
  assert.equal(r.verify.status, 200, JSON.stringify(r.verify.data));
  assert.equal(r.verify.data.next, "/agent/compte.html");
  assert.match(r.verify.res.headers.getSetCookie().join("\n"), /__Host-lq_sess=.+; Path=\/; Max-Age=\d+; HttpOnly; Secure; SameSite=Lax/);
  const me = (await b1.api("/api/me")).data;
  assert.equal(me.identities[0].provider, "email");
  assert.equal(me.identities[0].email, "julie@clinique.ca");
  assert.equal(me.identities[0].email_verified, true);

  const b2 = new Browser(env);
  await b2.loginEmail("julie@clinique.ca");
  assert.equal((await b2.api("/api/me")).data.user.id, me.user.id, "même adresse vérifiée par code = même compte");
  const b3 = new Browser(env);
  await b3.login("google", G("g-julie", "julie@clinique.ca"));
  assert.notEqual((await b3.api("/api/me")).data.user.id, me.user.id, "Google avec la même adresse = compte distinct");
  // La base ne contient ni le code ni le jeton du navigateur.
  const raw = JSON.stringify(env.DB.raw("SELECT * FROM email_codes")) + JSON.stringify(env.DB.raw("SELECT * FROM audit_log"));
  assert.ok(!raw.includes(r.code));
});

test("code courriel : mauvais code, 5 essais au plus, usage unique, expiration, lié au navigateur", async () => {
  const env = await makeEnv();
  const b = new Browser(env);
  await b.api("/auth/email/start", { method: "POST", body: { email: "a@b.ca" } });
  const good = env.AUTH_EMAIL.lastCodeFor("a@b.ca");
  const bad = good === "000000" ? "111111" : "000000";
  // Un autre navigateur, sans le témoin, ne peut pas utiliser le code.
  const other = new Browser(env);
  assert.equal((await other.api("/auth/email/verify", { method: "POST", body: { code: good } })).data.code, "code_expire");
  for (let i = 4; i >= 1; i--) {
    const r = await b.api("/auth/email/verify", { method: "POST", body: { code: bad } });
    assert.equal(r.status, 400); assert.equal(r.data.remaining, i);
  }
  const last = await b.api("/auth/email/verify", { method: "POST", body: { code: bad } });
  assert.equal(last.status, 429);
  assert.equal((await b.api("/auth/email/verify", { method: "POST", body: { code: good } })).status, 400, "le bon code ne marche plus après 5 erreurs");
  assert.equal((await b.api("/api/me")).status, 401);

  // Usage unique : rejouer le même témoin et le même code échoue.
  const b2 = new Browser(env);
  await b2.api("/auth/email/start", { method: "POST", body: { email: "c@d.ca" } });
  const code = env.AUTH_EMAIL.lastCodeFor("c@d.ca"), jar = { ...b2.jar };
  assert.equal((await b2.api("/auth/email/verify", { method: "POST", body: { code } })).status, 200);
  const replay = new Browser(env); replay.jar = jar;
  assert.equal((await replay.api("/auth/email/verify", { method: "POST", body: { code } })).data.code, "code_expire");

  // Un nouveau code annule le précédent.
  const b3 = new Browser(env), b4 = new Browser(env);
  await b3.api("/auth/email/start", { method: "POST", body: { email: "e@f.ca" } });
  const first = env.AUTH_EMAIL.lastCodeFor("e@f.ca");
  await b4.api("/auth/email/start", { method: "POST", body: { email: "e@f.ca" } });
  assert.equal((await b3.api("/auth/email/verify", { method: "POST", body: { code: first } })).data.code, "code_expire");

  // Expiration après 10 minutes.
  const b5 = new Browser(env);
  await b5.api("/auth/email/start", { method: "POST", body: { email: "g@h.ca" } });
  env.DB.exec("UPDATE email_codes SET expires_at = ? WHERE email = ?", Date.now() - 1, "g@h.ca");
  assert.equal((await b5.api("/auth/email/verify", { method: "POST", body: { code: env.AUTH_EMAIL.lastCodeFor("g@h.ca") } })).data.code, "code_expire");
});

test("code courriel : limites d'envoi, CSRF, adresse invalide, envoi en échec, non configuré", async () => {
  const env = await makeEnv();
  const b = new Browser(env);
  for (let i = 0; i < 5; i++) assert.equal((await b.api("/auth/email/start", { method: "POST", body: { email: "spam@x.ca" } })).status, 200);
  assert.equal((await b.api("/auth/email/start", { method: "POST", body: { email: "spam@x.ca" } })).status, 429);
  assert.equal(env.AUTH_EMAIL.sent.filter((m) => m.to === "spam@x.ca").length, 5);
  assert.equal((await b.api("/auth/email/start", { method: "POST", body: { email: "a@b.ca" }, csrf: false })).status, 403);
  assert.equal((await b.api("/auth/email/start", { method: "POST", body: { email: "a@b.ca" }, origin: "https://pirate.example" })).status, 403);
  assert.equal((await b.api("/auth/email/start", { method: "POST", body: { email: "pas-une-adresse" } })).data.code, "courriel_invalide");
  env.AUTH_EMAIL.failNext = true;
  const f = await b.api("/auth/email/start", { method: "POST", body: { email: "rebond@x.ca" } });
  assert.equal(f.status, 502);
  assert.equal(env.DB.raw("SELECT COUNT(*) n FROM email_codes WHERE email = 'rebond@x.ca'")[0].n, 0);
  const env2 = await makeEnv(); delete env2.AUTH_EMAIL;
  const b2 = new Browser(env2);
  assert.equal((await b2.api("/auth/providers")).data.email, false);
  assert.equal((await b2.api("/auth/email/start", { method: "POST", body: { email: "a@b.ca" } })).status, 503);
});

test("code courriel : invitation acceptée, mauvais destinataire refusé, association et récupération", async () => {
  const env = await makeEnv();
  const plat = await platform(env);
  const A = (await plat.api("/api/platform/orgs", { method: "POST", body: { name: "Clinique A", ownerEmail: "proprio@a.ca" } })).data;
  const owner = new Browser(env);
  await owner.loginEmail("proprio@a.ca");
  assert.equal((await owner.api(`/api/invitations/${A.invite.link.split("#")[1]}/accept`, { method: "POST" })).status, 200);
  const inv = (await owner.api(`/api/orgs/${A.org.id}/invitations`, { method: "POST", body: { email: "tsa@a.ca", role: "member", function: "tsa" } })).data;
  const token = inv.link.split("#")[1];
  const wrong = new Browser(env);
  await wrong.loginEmail("autre@a.ca");
  assert.equal((await wrong.api(`/api/invitations/${token}/accept`, { method: "POST" })).data.code, "email_mismatch");

  // Association : le compte Apple à adresse masquée ajoute l'adresse invitée, prouvée par code.
  env.MEMBER_EMAIL_LINK = "on"; // option activée (production) pour cet essai
  const apple = new Browser(env);
  await apple.login("apple", { sub: "ap-1", email: "xyz@privaterelay.appleid.com", email_verified: "true", is_private_email: "true" });
  const link = await apple.loginEmail("tsa@a.ca", { mode: "link" });
  assert.equal(link.verify.status, 200);
  assert.match(link.verify.data.next, /associe=email#profil$/);
  assert.equal((await apple.api(`/api/invitations/${token}/accept`, { method: "POST" })).status, 200);
  const me = (await apple.api("/api/me")).data;
  assert.deepEqual(me.identities.map((i) => i.provider).sort(), ["apple", "email"]);
  // Une adresse déjà reliée à un autre compte ne peut pas être associée.
  const steal = await apple.loginEmail("proprio@a.ca", { mode: "link" });
  assert.match(steal.verify.data.next, /erreur=identite_deja_utilisee/);
  // Association sans session : refusée.
  assert.equal((await new Browser(env).api("/auth/email/start", { method: "POST", body: { email: "z@a.ca", mode: "link" } })).status, 401);
  // Association avec une authentification trop ancienne : reconnexion exigée.
  env.DB.exec("UPDATE sessions SET auth_at = ?", Date.now() - 3600e3);
  assert.equal((await apple.api("/auth/email/start", { method: "POST", body: { email: "z@a.ca", mode: "link" } })).data.code, "reauth");

  // Récupération : le lien de l'administrateur exige le code envoyé à l'adresse prévue.
  const lost = new Browser(env);
  await lost.loginEmail("perdu@a.ca");
  const lostId = (await lost.api("/api/me")).data.user.id;
  const rec = (await plat.api(`/api/platform/users/${lostId}/recovery`, { method: "POST", body: { email: "nouveau@a.ca" } })).data;
  const rtoken = rec.link.split("recuperation=")[1];
  const fresh = new Browser(env);
  assert.equal((await fresh.api("/auth/email/start", { method: "POST", body: { email: "intrus@a.ca", mode: "recovery", token: rtoken } })).data.code, "recuperation_courriel");
  const ok = await fresh.loginEmail("nouveau@a.ca", { mode: "recovery", token: rtoken });
  assert.equal(ok.verify.status, 200);
  assert.equal((await fresh.api("/api/me")).data.user.id, lostId);
  assert.equal((await new Browser(env).api("/auth/email/start", { method: "POST", body: { email: "nouveau@a.ca", mode: "recovery", token: rtoken } })).data.code, "recuperation_invalide", "lien à usage unique");
});

test("code courriel : compte suspendu refusé, suppression du compte libère l'adresse", async () => {
  const env = await makeEnv();
  const plat = await platform(env);
  const u = new Browser(env);
  await u.loginEmail("s@a.ca");
  const id = (await u.api("/api/me")).data.user.id;
  await plat.api(`/api/platform/users/${id}/status`, { method: "POST", body: { status: "suspended" } });
  const again = await new Browser(env).loginEmail("s@a.ca");
  assert.equal(again.verify.data.code, "compte_suspendu");
  await plat.api(`/api/platform/users/${id}/status`, { method: "POST", body: { status: "active" } });
  const u2 = new Browser(env);
  await u2.loginEmail("s@a.ca");
  assert.equal((await u2.api("/api/me/delete", { method: "POST", body: { confirm: "SUPPRIMER" } })).status, 200);
  const u3 = new Browser(env);
  await u3.loginEmail("s@a.ca");
  assert.notEqual((await u3.api("/api/me")).data.user.id, id, "nouveau compte, aucune donnée de l'ancien");
});
