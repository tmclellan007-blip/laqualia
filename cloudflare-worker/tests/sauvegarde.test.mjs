// Sauvegarde de la configuration des agents (KV) : lecture seule, réservée à l'administrateur de la plateforme.
import test from "node:test";
import assert from "node:assert/strict";
import { makeEnv, Browser } from "./harness.mjs";

const G = (sub, email) => ({ sub, email, email_verified: true, given_name: "P" + sub, family_name: "Nom" });

test("export de la configuration : complet, en lecture seule, réservé à l'administrateur de la plateforme", async () => {
  const env = await makeEnv();
  const kv = env.AGENT_KV;
  await kv.put("cfg:shared", JSON.stringify({ etablissement: "Vet Québec", dailyLimit: 300 }));
  await kv.put("cfg:reception", JSON.stringify({ instructions: "Instructions Réception" }));
  await kv.put("cfg:tsa", JSON.stringify({ instructions: "Instructions TSA" }));
  await kv.put("docs:tsa", JSON.stringify([{ id: "abc123def", title: "Protocole", chars: 9 }]));
  await kv.put("doc:tsa:abc123def", "Protocole");
  await kv.put("use:2026-10-21", "12"); await kv.put("fail:1.2.3.4", "2");
  const before = JSON.stringify([...kv.m]);
  const plat = new Browser(env);
  await plat.login("google", G("plat", "plateforme@laqualia.com"));
  await plat.api("/api/platform/bootstrap", { method: "POST", body: { code: env.ADMIN_CODE } });
  const r = await plat.raw("/api/agent", { method: "POST", headers: { "x-agent-mode": "admin" }, body: { action: "export" } });
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.format, "laqualia-kv-export");
  assert.deepEqual(Object.keys(j.keys).sort(), ["cfg:reception", "cfg:shared", "cfg:tsa", "doc:tsa:abc123def", "docs:tsa"]);
  assert.equal(j.keys["doc:tsa:abc123def"], "Protocole");
  assert.equal(JSON.stringify([...kv.m]), before, "rien n'est modifié");
  // Un propriétaire d'établissement ou un membre : refusé
  const o = (await plat.api("/api/platform/orgs", { method: "POST", body: { name: "Clinique A", ownerEmail: "p@a.ca" } })).data;
  const owner = new Browser(env); await owner.loginEmail("p@a.ca");
  await owner.api(`/api/invitations/${o.invite.link.split("#")[1]}/accept`, { method: "POST" });
  assert.equal((await owner.raw("/api/agent", { method: "POST", headers: { "x-agent-mode": "admin" }, body: { action: "export" } })).status, 403);
});
