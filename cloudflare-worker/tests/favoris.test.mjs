// Essais des favoris : personnels, par établissement, copie figée de la réponse, retrait.
// Aucun appel réel : fournisseurs et courriels simulés.
import test from "node:test";
import assert from "node:assert/strict";
import { makeEnv, Browser } from "./harness.mjs";
import { favKey } from "../accounts/index.js";

const G = (sub, email) => ({ sub, email, email_verified: true, given_name: "Prénom" + sub, family_name: "Nom" });

async function world() {
  const env = await makeEnv();
  const plat = new Browser(env);
  await plat.login("google", G("plat", "plateforme@laqualia.com"));
  assert.equal((await plat.api("/api/platform/bootstrap", { method: "POST", body: { code: env.ADMIN_CODE } })).status, 200);
  const mk = async (name, email) => {
    const o = (await plat.api("/api/platform/orgs", { method: "POST", body: { name, ownerEmail: email } })).data;
    const owner = new Browser(env);
    await owner.loginEmail(email);
    await owner.api(`/api/invitations/${o.invite.link.split("#")[1]}/accept`, { method: "POST" });
    const code = (await owner.api(`/api/orgs/${o.org.id}/access-codes`, { method: "POST", body: { maxUses: 10 } })).data.code.code;
    return { id: o.org.id, owner, code };
  };
  const A = await mk("Clinique A", "proprio@a.ca");
  const B = await mk("Clinique B", "proprio@b.ca");
  const member = async (email, org) => { const b = new Browser(env); await b.loginEmail(email); assert.equal((await b.api("/api/access/redeem", { method: "POST", body: { code: org.code } })).status, 200); return b; };
  return { env, plat, A, B, member };
}
const FAV = { context: "tsa", question: "Comment préparer la salle ?", answer: "### Réponse\nÉtapes…", sources: [{ url: "https://exemple.ca/protocole", title: "Protocole" }, "javascript:alert(1)", { url: "http://non-securise.ca", title: "x" }, "Protocole anesthésie 2026"] };

test("favoris : ajout, liste, détail complet, doublon, retrait", async () => {
  const { member, A } = await world();
  const julie = await member("julie@a.ca", A);
  assert.deepEqual((await julie.api("/api/favorites")).data.favorites, []);
  const add = await julie.api("/api/favorites", { method: "POST", body: FAV });
  assert.equal(add.status, 201, JSON.stringify(add.data));
  const f = add.data.favorite;
  assert.equal(f.fkey, await favKey("tsa", FAV.question, FAV.answer), "empreinte calculable par le navigateur");
  assert.equal((await julie.api("/api/favorites", { method: "POST", body: FAV })).status, 200, "doublon : renvoie l'existant");
  const list = (await julie.api("/api/favorites")).data.favorites;
  assert.equal(list.length, 1); assert.equal(list[0].context, "tsa"); assert.ok(list[0].excerpt && !("answer" in list[0]));
  const full = (await julie.api(`/api/favorites/${f.id}`)).data.favorite;
  assert.equal(full.answer, FAV.answer, "réponse conservée telle quelle");
  assert.deepEqual(full.sources, [{ url: "https://exemple.ca/protocole", title: "Protocole" }, { title: "Protocole anesthésie 2026" }], "liens https et documents de la clinique seulement");
  assert.equal((await julie.api(`/api/favorites/${f.id}`, { method: "DELETE" })).status, 200);
  assert.equal((await julie.api(`/api/favorites/${f.id}`, { method: "DELETE" })).status, 404);
  assert.equal((await julie.api("/api/favorites")).data.favorites.length, 0);
});

test("favoris : chacun ne voit que les siens, dans son établissement ; validation et CSRF", async () => {
  const { member, A, B } = await world();
  const julie = await member("julie@a.ca", A), marc = await member("marc@a.ca", A);
  const f = (await julie.api("/api/favorites", { method: "POST", body: FAV })).data.favorite;
  assert.equal((await marc.api("/api/favorites")).data.favorites.length, 0, "un collègue ne voit pas les favoris");
  assert.equal((await marc.api(`/api/favorites/${f.id}`)).status, 404);
  assert.equal((await marc.api(`/api/favorites/${f.id}`, { method: "DELETE" })).status, 404, "ni ne peut les retirer");
  assert.equal((await A.owner.api(`/api/favorites/${f.id}`)).status, 404, "le propriétaire de l'établissement non plus");
  // Même personne, autre établissement : liste séparée
  assert.equal((await julie.api("/api/access/redeem", { method: "POST", body: { code: B.code } })).status, 200);
  assert.equal((await julie.api("/api/session/org", { method: "POST", body: { orgId: B.id } })).status, 200);
  assert.equal((await julie.api("/api/favorites")).data.favorites.length, 0, "favoris propres à l'établissement actif");
  await julie.api("/api/session/org", { method: "POST", body: { orgId: A.id } });
  assert.equal((await julie.api("/api/favorites")).data.favorites.length, 1);
  // Validation
  assert.equal((await julie.api("/api/favorites", { method: "POST", body: { ...FAV, context: "autre" } })).status, 400);
  assert.equal((await julie.api("/api/favorites", { method: "POST", body: { ...FAV, answer: " " } })).status, 400);
  assert.equal((await julie.api("/api/favorites", { method: "POST", body: { ...FAV, answer: "x".repeat(60001) } })).status, 413);
  assert.equal((await julie.api("/api/favorites", { method: "POST", body: FAV, csrf: false })).status, 403);
  // Sans session
  assert.equal((await new Browser(julie.env || (await makeEnv())).api("/api/favorites")).status, 401);
});

test("favoris : conservés entre les connexions ; supprimés en quittant l'établissement ou avec le compte", async () => {
  const { env, member, A } = await world();
  const julie = await member("julie@a.ca", A);
  await julie.api("/api/favorites", { method: "POST", body: FAV });
  const again = new Browser(env); await again.loginEmail("julie@a.ca");
  assert.equal((await again.api("/api/favorites")).data.favorites.length, 1, "nouvelle connexion : favoris retrouvés");
  assert.equal((await again.api(`/api/orgs/${A.id}/leave`, { method: "POST" })).status, 200);
  assert.equal(env.DB.raw("SELECT COUNT(*) n FROM favorites")[0].n, 0, "quitter l'établissement retire ses favoris");
  const marc = await member("marc@a.ca", A);
  await marc.api("/api/favorites", { method: "POST", body: FAV });
  assert.equal((await marc.api("/api/me/delete", { method: "POST", body: { confirm: "SUPPRIMER" } })).status, 200);
  assert.equal(env.DB.raw("SELECT COUNT(*) n FROM favorites")[0].n, 0, "supprimer son compte supprime ses favoris");
  const paul = await member("paul@a.ca", A);
  await paul.api("/api/favorites", { method: "POST", body: FAV });
  const mid = (await A.owner.api(`/api/orgs/${A.id}/members`)).data.members.find((x) => x.email === "paul@a.ca").id;
  assert.equal((await A.owner.api(`/api/orgs/${A.id}/members/${mid}`, { method: "DELETE" })).status, 200);
  assert.equal(env.DB.raw("SELECT COUNT(*) n FROM favorites")[0].n, 0, "retrait du membre : ses favoris de cet établissement sont supprimés");
});
