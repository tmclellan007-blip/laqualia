// Relais sécurisé de l'Assistant La Qualia — Cloudflare Worker.
// Le site (GitHub Pages) est statique : ce Worker garde la clé API Anthropic
// côté serveur et n'accepte que les requêtes venant des adresses autorisées.
//
// À coller dans Cloudflare > Workers & Pages > Create > Worker (voir LISEZMOI.md).
// Variables du Worker (Settings > Variables and Secrets) :
//   ANTHROPIC_API_KEY  (obligatoire, type « Secret »)
//   AGENT_CODE         (recommandé, type « Secret ») code d'accès de l'équipe
//   SITE_URL           adresse du site, ex. https://tmclellan007-blip.github.io/nc
//   ALLOWED_ORIGINS    origines autorisées séparées par des virgules,
//                      ex. https://tmclellan007-blip.github.io,https://www.laqualia.com
//   AGENT_MODEL        (facultatif) remplace le modèle choisi dans agent/config.json

const MODELS = { quick: "claude-haiku-5-5", default: "claude-sonnet-5-5", complex: "claude-opus-5-5" };
const AUD = {
  telephonistes: "des téléphonistes et réceptionnistes sans formation clinique (langage simple, phrases prêtes à dire)",
  proprietaires: "des propriétaires d'animaux (vulgarise, évite le jargon)",
  techniciens: "des techniciens en santé animale (vocabulaire technique accepté)",
  veterinaires: "des vétérinaires (réponse technique et concise)",
};
const MAX_QUESTION = 2000;
const MAX_TURN = 6000;
const MAX_HISTORY = 8;
const CTX_BUDGET = 60000;
// Plafonds par requête (réflexion incluse) : bornent le coût maximal d'une question
const MAX_TOKENS = { quick: 3000, default: 5000, complex: 8000 };
const EFFORT = { quick: "low", default: "medium", complex: "high" };
// Garde-fous anti-requête figée
const TOTAL_TIMEOUT_MS = 120000; // durée maximale d'une réponse
const IDLE_TIMEOUT_MS = 45000;   // silence maximal du service (réflexion comprise)
// Limite d'usage par adresse (par instance du relais)
const RATE_WINDOW_MS = 5 * 60 * 1000;
const RATE_MAX = 25;
const hits = new Map();
function rateLimited(ip) {
  const now = Date.now();
  const list = (hits.get(ip) || []).filter((t) => now - t < RATE_WINDOW_MS);
  list.push(now); hits.set(ip, list);
  if (hits.size > 2000) hits.clear();
  return list.length > RATE_MAX;
}

let cache = null; // { at, config, chunks }

export default {
  async fetch(request, env) {
    const cors = corsHeaders(request, env);
    if (request.method === "OPTIONS") return new Response(null, { status: cors ? 204 : 403, headers: cors || {} });
    if (!cors) return json(403, { error: "Origine non autorisée." }, {});
    if (request.method === "GET") return json(200, { ready: !!env.ANTHROPIC_API_KEY, needsCode: !!env.AGENT_CODE }, cors);
    if (request.method === "POST") return handlePost(request, env, cors);
    return json(405, { error: "Méthode non permise." }, cors);
  },
};

function corsHeaders(request, env) {
  const origin = request.headers.get("origin") || "";
  const allowed = String(env.ALLOWED_ORIGINS || "").split(",").map((s) => s.trim().replace(/\/$/, "")).filter(Boolean);
  if (!origin || !allowed.includes(origin)) return null;
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "content-type, x-agent-code",
    "access-control-expose-headers": "x-agent-sources, x-agent-model",
    "access-control-max-age": "86400",
    vary: "origin",
  };
}

async function handlePost(request, env, cors) {
  if (!env.ANTHROPIC_API_KEY) return json(503, { error: "L'assistant n'est pas encore configuré : la clé API est manquante." }, cors);
  if (env.AGENT_CODE && request.headers.get("x-agent-code") !== env.AGENT_CODE) {
    return json(401, { error: "Code d'accès invalide." }, cors);
  }

  if (rateLimited(request.headers.get("cf-connecting-ip") || "?")) {
    return json(429, { error: "Beaucoup de questions en peu de temps. Attendez quelques minutes, puis réessayez." }, cors);
  }

  let body;
  try { body = await request.json(); } catch { return json(400, { error: "Requête invalide." }, cors); }
  const question = String(body?.question || "").trim().slice(0, MAX_QUESTION);
  if (!question) return json(400, { error: "La question est vide." }, cors);
  const history = cleanHistory(body?.history);

  const { config, chunks } = await loadKnowledge(request, env);
  const ctx = retrieve(chunks, question);
  // Sans extrait pertinent, on n'évoque pas la documentation (sinon l'agent le signale dans sa réponse)
  const ctxText = ctx.length ? ctx.map((c) => `### [${c.title}]\n${c.text}`).join("\n\n") : "";
  const prenom = String(body?.prenom || "").replace(/[^\p{L}\p{M}' -]/gu, "").replace(/\s+/g, " ").trim().slice(0, 30);
  const who = prenom
    ? `\nTu parles à ${prenom}, membre de l'équipe d'accueil. Utilise son prénom de façon naturelle et chaleureuse : au début de la partie [APPRENTISSAGE] et, au besoin, pour l'encourager en mise en situation. Ne mets pas son prénom dans [EN DIRECT] et ne le répète pas à chaque phrase.`
    : "";
  const system = `${config.instructions}\n\nPublic visé : ${AUD[config.audience] || AUD.telephonistes}.${who}\nÉcris en Markdown simple (titres ###, listes, gras). Pas de tableaux.`;
  const userContent = ctxText
    ? `EXTRAITS DES PROCÉDURES DE LA CLINIQUE (à appliquer en priorité)\n\n${ctxText}\n\n---\nQUESTION\n${question}`
    : question;
  const messages = [...history, { role: "user", content: userContent }];
  // Modèle : celui choisi dans l'interface s'il est permis par la configuration, sinon celui par défaut
  const allowed = Array.isArray(config.modelesProposes) && config.modelesProposes.length ? config.modelesProposes.filter((t) => MODELS[t]) : Object.keys(MODELS);
  const asked = String(body?.tier || "");
  const tier = allowed.includes(asked) ? asked : (MODELS[config.tier] ? config.tier : "default");
  const model = env.AGENT_MODEL || MODELS[tier];

  // Mise en situation (quiz) : une seule demande, format libre.
  // Question normale : deux demandes en parallèle, l'une pour « En direct » (courte, plafonnée),
  // l'autre pour « Apprentissage » ; le relais les assemble dans cet ordre. Le vert ne peut pas s'emballer.
  const isScene = /^(mets-moi en situation|résultats du quiz)/i.test(question) || /format mise en situation/i.test(question);
  const abort = new AbortController();
  const total = setTimeout(() => abort.abort("total"), TOTAL_TIMEOUT_MS);
  request.signal?.addEventListener?.("abort", () => abort.abort("client"));

  const LIVE_TASK = "\n\nTÂCHE POUR CETTE RÉPONSE : écris UNIQUEMENT le contenu de la partie [EN DIRECT], sans le marqueur, sans titre, sans liste numérotée. Analyse d'abord toute la situation, puis donne la meilleure réponse en 2 à 4 phrases au total : la phrase exacte à dire au client entre guillemets, puis l'action concrète à faire maintenant. 80 mots maximum.";
  const LEARN_TASK = "\n\nTÂCHE POUR CETTE RÉPONSE : écris UNIQUEMENT le contenu de la partie [APPRENTISSAGE], sans le marqueur. La réponse courte « En direct » est déjà donnée à la personne séparément : ne la recopie pas, explique-la et approfondis (étapes, pourquoi, pièges, variantes de formulation, schéma si utile, ligne « À retenir »).";

  const call = (sys, maxTokens, withThinking) => fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    signal: abort.signal,
    headers: { "content-type": "application/json", "x-api-key": env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
    body: JSON.stringify(withThinking
      ? { model, max_tokens: maxTokens, system: sys, messages, stream: true, thinking: { type: "adaptive" }, output_config: { effort: EFFORT[tier] || "medium" } }
      : { model, max_tokens: Math.min(maxTokens, 2000), system: sys, messages, stream: true }),
  });
  // Un seul nouvel essai, sans réflexion, si le modèle refuse ce réglage ; jamais de boucle
  const callSafe = async (sys, maxTokens) => {
    const think = env.AGENT_THINKING !== "off";
    let r = await call(sys, maxTokens, think);
    if (r.status === 400 && think) r = await call(sys, maxTokens, false);
    return r;
  };

  const cap = MAX_TOKENS[tier] || 5000;
  let parts;
  try {
    parts = isScene
      ? [await callSafe(system, cap)]
      : await Promise.all([callSafe(system + LIVE_TASK, Math.min(cap, 3000)), callSafe(system + LEARN_TASK, cap)]);
  } catch {
    clearTimeout(total);
    return json(504, { error: "Le service a mis trop de temps à répondre. Réessayez." }, cors);
  }
  const bad = parts.find((r) => !r.ok || !r.body);
  if (bad) {
    parts.forEach((r) => { try { r.body?.cancel().catch(() => {}); } catch {} });
    clearTimeout(total);
    const status = bad.status;
    const msg = status === 401 ? "La clé API est invalide. Vérifiez ANTHROPIC_API_KEY dans Cloudflare."
      : status === 429 ? "Trop de questions en même temps. Réessayez dans une minute."
      : status === 400 ? "La demande a été refusée par le service. Raccourcissez la question ou commencez une nouvelle conversation."
      : "Le service est momentanément indisponible. Réessayez.";
    return json(status === 401 ? 502 : status, { error: msg }, cors);
  }

  const segments = isScene
    ? [{ body: parts[0].body }]
    : [{ prefix: "[EN DIRECT]\n", body: parts[0].body }, { prefix: "\n\n[APPRENTISSAGE]\n", body: parts[1].body }];
  const sources = [...new Set(ctx.map((c) => c.title))];
  return new Response(streamSegments(segments, abort, total), {
    headers: {
      ...cors,
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
      "x-agent-sources": encodeURIComponent(JSON.stringify(sources)),
      "x-agent-model": model,
    },
  });
}

/* ---------- helpers ---------- */
function json(status, data, cors) {
  return new Response(JSON.stringify(data), { status, headers: { ...cors, "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
}

function cleanHistory(h) {
  if (!Array.isArray(h)) return [];
  const turns = h
    .filter((t) => t && (t.role === "user" || t.role === "assistant") && typeof t.content === "string" && t.content.trim())
    .map((t) => ({ role: t.role, content: t.content.slice(0, MAX_TURN) }))
    .slice(-MAX_HISTORY);
  while (turns.length && turns[0].role !== "user") turns.shift();
  const out = [];
  for (const t of turns) { if (out.length && out[out.length - 1].role === t.role) out[out.length - 1] = t; else out.push(t); }
  if (out.length && out[out.length - 1].role === "user") out.pop(); // la nouvelle question est ajoutée ensuite
  return out;
}

// Lit les flux de Claude l'un après l'autre (le 2e est déjà en route pendant le 1er) et n'en garde que le texte.
function streamSegments(segments, abort, total) {
  const enc = new TextEncoder();
  let idle = null;
  let out = null;
  let done = false;
  const finish = (msg) => {
    if (done) return; done = true;
    clearTimeout(idle); clearTimeout(total);
    try { if (msg) out.enqueue(enc.encode(msg)); out.close(); } catch {}
    segments.forEach((sg) => { try { (sg.reader || sg.body).cancel().catch(() => {}); } catch {} });
    abort.abort("stop");
  };
  const arm = () => { clearTimeout(idle); idle = setTimeout(() => finish("\n\n_(Délai dépassé : la réponse a été arrêtée pour protéger vos crédits. Réessayez ou posez une question plus précise.)_"), IDLE_TIMEOUT_MS); };
  abort.signal.addEventListener("abort", () => {
    if (abort.signal.reason === "total") finish("\n\n_(Réponse trop longue : arrêtée après 2 minutes pour protéger vos crédits.)_");
  });
  return new ReadableStream({
    async start(c) {
      out = c;
      arm();
      const dec = new TextDecoder();
      try {
        for (const sg of segments) {
          if (done) return;
          if (sg.prefix) c.enqueue(enc.encode(sg.prefix));
          const reader = sg.reader = sg.body.getReader();
          let buf = "";
          for (;;) {
            const { value, done: end } = await reader.read();
            if (end || done) break;
            arm();
            buf += dec.decode(value, { stream: true });
            const lines = buf.split("\n");
            buf = lines.pop();
            for (const line of lines) {
              if (!line.startsWith("data:")) continue;
              let ev;
              try { ev = JSON.parse(line.slice(5).trim()); } catch { continue; }
              if (ev.type === "content_block_delta" && ev.delta?.type === "text_delta") c.enqueue(enc.encode(ev.delta.text));
              else if (ev.type === "message_delta" && ev.delta?.stop_reason === "max_tokens") c.enqueue(enc.encode("\n\n_(Réponse coupée : demandez la suite.)_"));
              else if (ev.type === "error") c.enqueue(enc.encode("\n\n_(La réponse a été interrompue. Réessayez.)_"));
            }
          }
        }
        finish("");
      } catch {
        finish("");
      }
    },
    cancel() { finish(""); },
  });
}

async function asset(request, env, path) {
  const base = String(env.SITE_URL || "").replace(/\/$/, "");
  const res = await fetch(base + path, { cf: { cacheTtl: 30 } });
  if (!res.ok) throw new Error(path);
  return res;
}

async function loadKnowledge(request, env) {
  if (cache && Date.now() - cache.at < 60 * 1000) return cache;
  let config = {};
  try { config = await (await asset(request, env, "/agent/config.json")).json(); } catch {}
  if (!config.instructions) config.instructions = "Tu es un assistant pour l'équipe d'accueil d'un établissement vétérinaire. Réponds en français.";
  let files = [];
  try { files = await (await asset(request, env, "/agent/docs/index.json")).json(); } catch {}
  const chunks = [];
  for (const f of Array.isArray(files) ? files : []) {
    const file = typeof f === "string" ? f : f.file;
    const title = (typeof f === "object" && f.title) || String(file).replace(/\.[^.]+$/, "");
    if (!file || /[\/\\]|\.\./.test(file)) continue;
    try {
      const text = (await (await asset(request, env, "/agent/docs/" + encodeURIComponent(file))).text()).replace(/\r/g, "");
      for (let i = 0; i < text.length; i += 1400) {
        const piece = text.slice(i, i + 1600);
        chunks.push({ title, text: piece, tf: countTerms(piece + " " + title) });
      }
    } catch {}
  }
  cache = { at: Date.now(), config, chunks };
  return cache;
}

const STOP = new Set("les des une un du de la le et ou en au aux pour par sur dans avec sans que qui quoi est sont pas plus mon ma mes ton ta tes son sa ses notre nos votre vos leur leurs ce cet cette ces il elle ils elles on nous vous je tu me te se lui y a ai as avait avoir etre etait faire fait peut peux doit dois quel quelle quels quelles comment quand pourquoi combien tres bien aussi alors donc mais si ne qu".split(" "));
const norm = (s) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
const terms = (s) => norm(s).split(/[^a-z0-9]+/).filter((w) => w.length > 2 && !STOP.has(w)).map((w) => (w.length > 5 ? w.replace(/(s|x)$/, "") : w));
function countTerms(s) { const m = new Map(); for (const t of terms(s)) m.set(t, (m.get(t) || 0) + 1); return m; }

function retrieve(chunks, question) {
  const all = chunks.reduce((a, c) => a + c.text.length, 0);
  if (all <= CTX_BUDGET) return chunks.slice();
  const q = [...new Set(terms(question))];
  const N = chunks.length;
  const df = new Map(q.map((t) => [t, chunks.filter((c) => c.tf.has(t)).length]));
  const scored = chunks
    .map((c) => { let s = 0; for (const t of q) { const f = c.tf.get(t); if (f) s += (1 + Math.log(f)) * Math.log(1 + N / (df.get(t) || 1)); } return { c, s }; })
    .filter((x) => x.s > 0).sort((a, b) => b.s - a.s);
  const out = []; let used = 0;
  for (const { c } of scored) { if (used + c.text.length > CTX_BUDGET) break; out.push(c); used += c.text.length; }
  return out;
}
