// Outil TSA « Nutrition — Aide au conseil client » : autorisations, sources réellement consultées, reprise.
// Aucun appel réel : Anthropic et ses outils serveur sont simulés.
import test from "node:test";
import assert from "node:assert/strict";
import { makeEnv, Browser, modelLog, nutritionScript } from "./harness.mjs";

const RC = "https://www.royalcanin.com/ca/fr/cats/products/vet-products/urinary-so-3901";
const HP = "https://www.hillspet.ca/fr-ca/cat-food/prescription-diet-cd-multicare-feline";
const ev = {
  start: (i, b) => ({ type: "content_block_start", index: i, content_block: b }),
  json: (i, j) => ({ type: "content_block_delta", index: i, delta: { type: "input_json_delta", partial_json: j } }),
  text: (i, t) => ({ type: "content_block_delta", index: i, delta: { type: "text_delta", text: t } }),
  stop: (i) => ({ type: "content_block_stop", index: i }),
  end: (r = "end_turn") => ({ type: "message_delta", delta: { stop_reason: r } }),
};
const searchAndFetch = [
  ev.start(0, { type: "server_tool_use", id: "s1", name: "web_search", input: {} }), ev.json(0, '{"query":"Urinary S/O chat'), ev.json(0, ' royal canin"}'), ev.stop(0),
  ev.start(1, { type: "web_search_tool_result", tool_use_id: "s1", content: [{ type: "web_search_result", url: RC, title: "Urinary S/O", encrypted_content: "xyz" }] }), ev.stop(1),
  ev.start(2, { type: "server_tool_use", id: "f1", name: "web_fetch", input: {} }), ev.json(2, `{"url":"${RC}"}`), ev.stop(2),
  ev.start(3, { type: "web_fetch_tool_result", tool_use_id: "f1", content: { type: "web_fetch_result", url: RC, retrieved_at: "2026-10-21T22:00:00Z", content: { type: "document", title: "Urinary S/O", source: { type: "text", media_type: "text/plain", data: "..." } } } }), ev.stop(3),
  ev.start(4, { type: "server_tool_use", id: "f2", name: "web_fetch", input: {} }), ev.json(4, `{"url":"${HP}"}`), ev.stop(4),
  ev.start(5, { type: "web_fetch_tool_result", tool_use_id: "f2", content: { type: "web_fetch_tool_result_error", error_code: "url_not_accessible" } }), ev.stop(5),
];
const answer = (i) => [ev.start(i, { type: "text", text: "" }), ev.text(i, "### Réponse\nVoir [Urinary S/O]("), ev.text(i, RC + ").\n```comparaison\n{\"produits\":[]}\n```"), ev.stop(i)];

async function world() {
  const env = await makeEnv();
  const plat = new Browser(env);
  await plat.loginEmail("plateforme@laqualia.com");
  await plat.api("/api/platform/bootstrap", { method: "POST", body: { code: env.ADMIN_CODE } });
  const o = (await plat.api("/api/platform/orgs", { method: "POST", body: { name: "Clinique A", ownerEmail: "proprio@a.ca" } })).data;
  const owner = new Browser(env); await owner.loginEmail("proprio@a.ca");
  await owner.api(`/api/invitations/${o.invite.link.split("#")[1]}/accept`, { method: "POST" });
  const code = (await owner.api(`/api/orgs/${o.org.id}/access-codes`, { method: "POST", body: {} })).data.code.code;
  const tsa = new Browser(env);
  await tsa.api("/auth/invite", { method: "POST", body: { first_name: "Léa", email: "lea@a.ca", code } });
  return { env, plat, owner, tsa };
}
const lines = async (res) => (await res.text()).trim().split("\n").map((l) => JSON.parse(l));
const ask = (b, body = {}) => b.raw("/api/agent", { method: "POST", body: { mode: "nutrition", role: "tsa", question: "Compare ces deux aliments pour un chat", nutrition: { context: { espece: "Chat", poids: "4,2 kg" }, products: ["Urinary S/O", "c/d Multicare"] }, ...body } });

test("nutrition : recherche et consultation limitées aux sites officiels, sources réellement consultées transmises", async () => {
  const { tsa } = await world();
  nutritionScript.push({ events: [...searchAndFetch, ...answer(6), ev.end()] });
  const res = await ask(tsa);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /ndjson/);
  const L = await lines(res);
  assert.deepEqual(L.filter((x) => x.t === "status").map((x) => x.k), ["search", "fetch", "fetch"]);
  assert.equal(L.find((x) => x.k === "search").d, "Urinary S/O chat royal canin");
  const done = L.at(-1);
  assert.equal(done.t, "done");
  assert.match(done.date, /^\d{4}-\d{2}-\d{2}$/);
  assert.deepEqual(done.sources.map((s) => [s.url, s.ok, s.fabricant]), [[RC, true, "Royal Canin"], [HP, false, "Hill's"]]);
  assert.equal(done.sources[0].retrieved_at, "2026-10-21T22:00:00Z");
  assert.equal(done.sources[1].error, "url_not_accessible", "l'échec est signalé, jamais présenté comme consulté");
  assert.match(L.filter((x) => x.t === "text").map((x) => x.d).join(""), /```comparaison/);
  const req = modelLog.at(-1);
  const tools = Object.fromEntries(req.tools.map((t) => [t.name, t]));
  assert.deepEqual(tools.web_search.allowed_domains, ["royalcanin.com/ca", "hillspet.ca", "purina.ca"]);
  assert.deepEqual(tools.web_fetch.allowed_domains, ["royalcanin.com", "hillspet.ca", "purina.ca"]);
  assert.ok(tools.web_search.max_uses <= 4 && tools.web_fetch.max_uses <= 6, "consultations bornées (coût)");
  assert.match(req.system, /Non précisé dans la source/); assert.match(req.system, /Prix et disponibilité à confirmer auprès de la clinique/);
  assert.match(req.system, /Science Diet/); assert.match(req.system, /Alertez le vétérinaire immédiatement/);
  const um = req.messages.at(-1).content;
  assert.match(um, /Espèce : Chat/); assert.match(um, /Poids : 4,2 kg/); assert.match(um, /1\. Urinary S\/O/);
  assert.match(um, /royalcanin\.com\/ca\/dogs\/products\/vet-products/, "pages de départ dans le message (autorisées pour la consultation)");
  assert.ok(!/Âge :/.test(um), "les champs vides ne sont pas envoyés");
});

test("nutrition : reprise après pause_turn avec les blocs reconstitués", async () => {
  const { tsa } = await world();
  nutritionScript.push({ events: [...searchAndFetch.slice(0, 8), ev.end("pause_turn")] });
  nutritionScript.push({ events: [...answer(0), ev.end()] });
  const n0 = modelLog.length;
  const L = await lines(await ask(tsa));
  assert.equal(modelLog.length - n0, 2, "une reprise");
  const cont = modelLog.at(-1);
  const prev = cont.messages.at(-1);
  assert.equal(prev.role, "assistant");
  assert.equal(prev.content[0].type, "server_tool_use");
  assert.deepEqual(prev.content[0].input, { query: "Urinary S/O chat royal canin" });
  assert.ok(!prev.content.some((b) => "_json" in b), "aucun champ interne renvoyé à l'API");
  assert.equal(prev.content[1].content[0].encrypted_content, "xyz", "résultats de recherche conservés");
  assert.ok(cont.tools.length === 2, "mêmes outils dans la reprise");
  assert.ok(L.some((x) => x.k === "wait"));
  assert.equal(L.at(-1).sources.length, 0, "aucune fiche consultée : aucune source annoncée");
});

test("nutrition : réservée à l'espace TSA, session requise, aucun droit d'administration requis", async () => {
  const { env, tsa, plat } = await world();
  assert.equal((await ask(tsa, { role: "reception" })).status, 403);
  assert.equal((await ask(new Browser(env))).status, 401);
  // Administrateur existant : accès conservé
  nutritionScript.push({ events: [...answer(0), ev.end()] });
  assert.equal((await ask(plat)).status, 200);
  // Erreur du service : message clair, flux terminé proprement
  nutritionScript.push({ status: 500 });
  const L = await lines(await ask(tsa));
  assert.equal(L[0].t, "error"); assert.equal(L.at(-1).t, "done");
  // Aucune réponse : état « vide » explicite
  nutritionScript.push({ events: [ev.end()] });
  const E = await lines(await ask(tsa));
  assert.ok(E.some((x) => x.t === "empty"));
});

test("nutrition (ancien accès par codes) : le code TSA reste exigé", async () => {
  const env = { ...(await makeEnv()), TSA_CODE: "Code-TSA", ALLOWED_ORIGINS: "https://tmclellan007-blip.github.io" };
  const b = new Browser(env);
  const send = (h) => b.raw("/", { method: "POST", csrf: false, origin: "https://tmclellan007-blip.github.io", headers: h, body: { mode: "nutrition", role: "tsa", question: "Refus des croquettes ?" } });
  assert.equal((await send({})).status, 403);
  nutritionScript.push({ events: [...answer(0), ev.end()] });
  assert.equal((await send({ "x-tsa-code": "Code-TSA" })).status, 200);
});

test("nutrition : outils refusés par l'API → réponse prudente sans fiche, signalée", async () => {
  const { tsa } = await world();
  nutritionScript.push({ status: 400 }, { status: 400 });
  nutritionScript.push({ events: [ev.start(0, { type: "text", text: "" }), ev.text(0, "Démarche générale."), ev.stop(0), ev.end()] });
  // Le troisième appel est sans outils : le simulateur ne le reconnaît pas comme Nutrition, on le sert ici
  const n0 = modelLog.length;
  const L = await lines(await ask(tsa));
  const calls = modelLog.slice(n0);
  assert.equal(calls.length, 3);
  assert.ok(calls[0].tools && calls[0].thinking && calls[1].tools && !calls[1].thinking, "nouvel essai sans réflexion");
  assert.ok(!calls[2].tools && /consultation des fiches est indisponible/.test(calls[2].system), "dernier essai sans outils, consignes de prudence");
  assert.ok(L.some((x) => x.k === "warn"));
  assert.deepEqual(L.at(-1).sources, []);
});
