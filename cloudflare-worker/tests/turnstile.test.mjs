// Protection anti-robots (Turnstile simulé) : inactive sans secret, exigée dès que le secret est ajouté.
import test from "node:test";
import assert from "node:assert/strict";
import { makeEnv, Browser, turnstileLog } from "./harness.mjs";

async function world(withSecret) {
  const env = await makeEnv();
  const plat = new Browser(env);
  await plat.loginEmail("plateforme@laqualia.com");
  await plat.api("/api/platform/bootstrap", { method: "POST", body: { code: env.ADMIN_CODE } });
  const o = (await plat.api("/api/platform/orgs", { method: "POST", body: { name: "Clinique A", ownerEmail: "proprio@a.ca" } })).data;
  const owner = new Browser(env); await owner.loginEmail("proprio@a.ca");
  await owner.api(`/api/invitations/${o.invite.link.split("#")[1]}/accept`, { method: "POST" });
  if (withSecret) env.TURNSTILE_SECRET = "secret-turnstile-essai";
  return { env, owner, org: o.org.id, plat };
}
const newCode = async (w) => (await w.owner.api(`/api/orgs/${w.org}/access-codes`, { method: "POST", body: {} })).data.code.code;

test("sans secret : aucune vérification, la clé de site n'est pas annoncée", async () => {
  const w = await world(false);
  assert.equal((await new Browser(w.env).api("/auth/providers")).data.turnstile, null);
  const n = turnstileLog.length;
  assert.equal((await new Browser(w.env).api("/auth/invite", { method: "POST", body: { first_name: "A", email: "a@a.ca", code: await newCode(w) } })).status, 200);
  assert.equal(turnstileLog.length, n, "aucun appel à Turnstile");
});

test("avec secret : premier accès protégé, jeton exigé, jeton d'un autre site refusé", async () => {
  const w = await world(true);
  assert.equal((await new Browser(w.env).api("/auth/providers")).data.turnstile, "0x4AAAAAAFeXR1_bJkXdINQm");
  const code = await newCode(w);
  const users = () => w.env.DB.raw("SELECT COUNT(*) n FROM users")[0].n;
  const n0 = users();
  const b = new Browser(w.env);
  for (const t of [undefined, "robot", "humain-autre-site"]) {
    const r = await b.api("/auth/invite", { method: "POST", body: { first_name: "Julie", email: "j@a.ca", code, turnstile: t } });
    assert.equal(r.status, 400); assert.equal(r.data.code, "robot");
  }
  assert.equal(users(), n0, "aucun compte créé");
  assert.equal((await w.owner.api(`/api/orgs/${w.org}/access-codes`)).data.codes[0].uses, 0, "le code n'est pas consommé");
  const ok = await b.api("/auth/invite", { method: "POST", body: { first_name: "Julie", email: "j@a.ca", code, turnstile: "humain-1" } });
  assert.equal(ok.status, 200);
  assert.equal(turnstileLog.at(-1).secret, "secret-turnstile-essai");
});

test("avec secret : envoi du code par courriel protégé ; l'association depuis le profil n'en demande pas", async () => {
  const w = await world(true);
  const sent = w.env.AUTH_EMAIL.sent.length;
  const b = new Browser(w.env);
  assert.equal((await b.api("/auth/email/start", { method: "POST", body: { email: "x@a.ca" } })).data.code, "robot");
  assert.equal(w.env.AUTH_EMAIL.sent.length, sent, "aucun courriel envoyé à un robot");
  assert.equal((await b.api("/auth/email/start", { method: "POST", body: { email: "x@a.ca", turnstile: "humain-2" } })).status, 200);
  // Administrateur existant : la connexion fonctionne avec la vérification
  const adm = new Browser(w.env);
  const st = await adm.api("/auth/email/start", { method: "POST", body: { email: "plateforme@laqualia.com", turnstile: "humain-3" } });
  assert.equal(st.status, 200);
  const v = await adm.api("/auth/email/verify", { method: "POST", body: { code: w.env.AUTH_EMAIL.lastCodeFor("plateforme@laqualia.com") } });
  assert.equal(v.status, 200);
  assert.equal((await adm.api("/api/me")).data.user.platform_admin, true);
  // Association d'une adresse (session requise) : pas de vérification supplémentaire
  assert.equal((await w.owner.api("/auth/email/start", { method: "POST", body: { email: "autre@a.ca", mode: "link" } })).status, 200);
});

test("secret mal saisi : personne n'est bloqué (les limites habituelles restent)", async () => {
  const w = await world(true);
  w.env.TURNSTILE_SECRET = "secret-mal-copie";
  const r = await new Browser(w.env).api("/auth/invite", { method: "POST", body: { first_name: "A", email: "a@a.ca", code: await newCode(w), turnstile: "jeton-du-navigateur" } });
  assert.equal(r.status, 200);
});
