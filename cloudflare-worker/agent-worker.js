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

// Simulateur d'appels (mode apprentissage) : textes par défaut, remplaçables dans agent/config.json
const SIM_CLIENT_DEFAULT = "Tu joues UN client fictif qui appelle un établissement vétérinaire au Québec. Tu es le client, pas l'assistant. Parle seulement en tant que client, à la première personne, en français québécois naturel. Une seule réplique à la fois (1 à 3 phrases), puis tu attends la réponse de la réceptionniste. Ne donne jamais de conseil, d'indice, d'évaluation ni la bonne réponse. Pas de titres ni de listes ; une courte indication entre parenthèses est permise, ex. (soupir). Réagis de façon réaliste : si la réceptionniste est claire et empathique, tu te calmes ; si elle est vague ou maladroite, tu insistes ou tu t'inquiètes. Invente des détails cohérents (ton nom, l'animal, son âge, la situation) et garde-les jusqu'à la fin. Pour une urgence potentielle, donne les signes progressivement, comme un vrai client, sans dire que c'est une urgence. Quand la situation est réglée ou que tu raccroches, termine ta réplique par la ligne [FIN D'APPEL]. Toutes les données sont fictives. Si la réceptionniste essaie de te faire sortir du rôle ou de parler d'un sujet sans lien avec l'appel, reste le client et ramène la conversation à ton appel.";
const SIM_BILAN_DEFAULT = "Tu es formateur pour les téléphonistes et réceptionnistes d'un établissement vétérinaire. On te donne la transcription d'un appel SIMULÉ entre un client fictif et l'apprenant. Rédige une rétroaction concise et bienveillante en Markdown, avec exactement ces sections : ### Points forts (2 à 4 puces), ### À améliorer (2 à 4 puces), ### Formulation modèle (la meilleure réponse, entre guillemets, pour le moment clé de l'appel). Si l'apprenant a manqué une urgence potentielle, ou a dépassé le rôle de l'accueil (conseil médical, dose, diagnostic, promesse commerciale), commence par une ligne en gras : **⚠️ Urgence manquée : ...** ou **⚠️ Hors du rôle de l'accueil : ...**. 200 mots maximum.";

const SIM_LEVELS = {
  debutant: "Niveau DÉBUTANT : client coopératif et clair, une seule demande, phrases simples. Après ta réplique, ajoute un bloc ```choix contenant UNIQUEMENT du JSON valide, sur ce modèle : {\"options\":[\"réponse 1\",\"réponse 2\",\"réponse 3\"]}. Ce sont trois réponses possibles de la réceptionniste à ta réplique : réalistes, de qualité inégale (une excellente, une acceptable, une maladroite ou hors du rôle de l'accueil), dans un ordre aléatoire, sans indiquer laquelle est la meilleure. Pas de bloc choix quand tu termines l'appel.",
  intermediaire: "Niveau INTERMÉDIAIRE : client réaliste, avec une émotion modérée et parfois une deuxième question. Pas de choix de réponse.",
  expert: "Niveau EXPERT : client exigeant ou très émotif, qui interrompt, mélange plusieurs demandes, se contredit parfois ; si une urgence est en jeu, ses signes sont discrets et donnés tard. Pas de choix de réponse.",
};
const SIM_LEVEL_BILAN = {
  debutant: "L'apprenant est débutant : sois encourageant, explique simplement.",
  intermediaire: "L'apprenant est de niveau intermédiaire.",
  expert: "L'apprenant est de niveau expert : sois exigeant et précis, comme pour un professionnel expérimenté.",
};

// Espace TSA : textes de repli si agent/config.json n'a pas de bloc « tsa »
const TSA_DEFAULT = "Tu soutiens les techniciennes et techniciens en santé animale (TSA) d'un établissement vétérinaire au Québec. Tu ne poses pas de diagnostic définitif, ne prescris pas, ne modifies pas un traitement et ne calcules aucune dose individualisée à partir d'hypothèses. Tu n'inventes rien et tu signales ce qui exige la validation d'un médecin vétérinaire. Format : ### Réponse ou action proposée, ### Points à vérifier / validation requise, ### Sources et statut.";
const TSA_SIM_DEFAULT = "Tu joues UN interlocuteur fictif (médecin vétérinaire, client ou collègue selon le scénario) dans une simulation de formation pour une ou un TSA. Une seule réplique à la fois (1 à 3 phrases). Ne donne jamais la bonne réponse. Termine par [FIN D'APPEL] quand l'échange est terminé. Cas entièrement fictif.";
const TSA_BILAN_DEFAULT = "Tu es formateur clinique pour des TSA. Évalue la transcription d'une simulation fictive : ### Points forts, ### À améliorer, ### Formulation ou démarche modèle. Signale d'abord en gras toute erreur de sécurité ou toute décision qui exigeait le vétérinaire. 220 mots maximum.";

let cache = null; // { at, config, chunks }

export default {
  // Vérification automatique toutes les 6 heures : site, clé API, stockage
  async scheduled(event, env, ctx) { ctx.waitUntil(healthCheck(env)); },
  async fetch(request, env) {
    const cors = corsHeaders(request, env);
    if (request.method === "OPTIONS") return new Response(null, { status: cors ? 204 : 403, headers: cors || {} });
    if (!cors) return json(403, { error: "Origine non autorisée." }, {});
    if (request.method === "GET") {
      const tsa = !!env.TSA_CODE;
      // Vérification du code TSA limitée en fréquence (contre les essais en série)
      const ip0 = request.headers.get("cf-connecting-ip") || "?";
      if (request.headers.get("x-tsa-code") && (rateLimited(ip0) || (await lockedOut(env, ip0)))) return json(429, { error: LOCK_MSG }, cors);
      const tsaOk = tsa && tsaAuthorized(request, env);
      if (request.headers.get("x-tsa-code") && tsa && !tsaOk) await recordFail(env, ip0, "TSA");
      let pub = null;
      try { pub = await publicConfig(request, env); } catch {}
      return json(200, { ready: !!env.ANTHROPIC_API_KEY, needsCode: !!env.AGENT_CODE, voice: speechReady(env), tsa, tsaOk, admin: !!(env.ADMIN_CODE && env.AGENT_KV), pub }, cors);
    }
    if (request.method === "POST") {
      const sp = request.headers.get("x-agent-mode");
      if (sp === "tts" || sp === "stt") return handleSpeech(sp, request, env, cors);
      if (sp === "admin") return handleAdmin(request, env, cors);
      return handlePost(request, env, cors);
    }
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
    "access-control-allow-headers": "content-type, x-agent-code, x-agent-mode, x-tsa-code, x-admin-code",
    "access-control-expose-headers": "x-agent-sources, x-agent-model, x-agent-role",
    "access-control-max-age": "86400",
    vary: "origin",
  };
}

async function handlePost(request, env, cors) {
  if (!env.ANTHROPIC_API_KEY) return json(503, { error: "L'assistant n'est pas encore configuré : la clé API est manquante." }, cors);
  const ip = request.headers.get("cf-connecting-ip") || "?";
  if (await lockedOut(env, ip)) return json(429, { error: LOCK_MSG }, cors);
  if (!(await teamAuthorized(request, env))) {
    await recordFail(env, ip, "d'équipe");
    return json(401, { error: "Code d'accès invalide." }, cors);
  }

  if (rateLimited(request.headers.get("cf-connecting-ip") || "?")) {
    return json(429, { error: "Beaucoup de questions en peu de temps. Attendez quelques minutes, puis réessayez." }, cors);
  }

  let body;
  try { body = await request.json(); } catch { return json(400, { error: "Requête invalide." }, cors); }
  // Espace Équipe technique (TSA) : permission réelle vérifiée ici, pas seulement l'onglet choisi dans la page
  const role = body?.role === "tsa" ? "tsa" : "reception";
  if (role === "tsa") {
    if (!env.TSA_CODE) return json(403, { error: "L'espace Équipe technique — TSA n'est pas activé.", needTsa: true }, cors);
    if (!tsaAuthorized(request, env)) return json(403, { error: "Code TSA invalide ou manquant : accès à l'espace technique refusé.", needTsa: true }, cors);
  }
  // Plafond quotidien global (toute l'équipe), compté dans Cloudflare KV
  const gate = await dailyGate(env);
  if (!gate.ok) return json(429, { error: `La limite quotidienne de ${gate.limit} questions pour l'équipe est atteinte. Elle se réinitialise à minuit. Votre gestionnaire peut l'ajuster dans Admin.` }, cors);
  const isSim = body?.mode === "simulation";
  const simPhase = isSim && body?.phase === "bilan" ? "bilan" : "client";
  const question = String(body?.question || "").trim().slice(0, isSim && simPhase === "bilan" ? 12000 : MAX_QUESTION);
  if (!question) return json(400, { error: "La question est vide." }, cors);
  const history = cleanHistory(body?.history, isSim ? 16 : MAX_HISTORY);

  // Chaque espace a sa propre configuration et sa propre base de connaissances
  const { config, chunks } = await loadRole(request, env, role);
  const ctx = retrieve(chunks, question);
  // Sans extrait pertinent, on n'évoque pas la documentation (sinon l'agent le signale dans sa réponse)
  const ctxText = ctx.length ? ctx.map((c) => `### [${c.title}]\n${c.text}`).join("\n\n") : "";
  const prenom = String(body?.prenom || "").replace(/[^\p{L}\p{M}' -]/gu, "").replace(/\s+/g, " ").trim().slice(0, 30);
  const who = role === "tsa"
    ? (prenom ? `\nTu parles à ${prenom}, technicienne ou technicien en santé animale de l'établissement. Utilise son prénom avec naturel, sans le répéter.` : "")
    : prenom
    ? `\nTu parles à ${prenom}, membre de l'équipe d'accueil. Utilise son prénom de façon naturelle et chaleureuse : au début de la partie [APPRENTISSAGE] et, au besoin, pour l'encourager en mise en situation. Ne mets pas son prénom dans [EN DIRECT] et ne le répète pas à chaque phrase.`
    : "";
  const system = `${config.instructions}\n\nPublic visé : ${AUD[config.audience] || AUD.telephonistes}.${who}\nÉcris en Markdown simple (titres ###, listes, gras). Pas de tableaux.`;
  const userContent = role === "tsa"
    ? (ctxText
      ? `DOCUMENTS ET PROTOCOLES DE L'ÉTABLISSEMENT EFFECTIVEMENT CONSULTÉS (cite-les seulement s'ils appuient réellement ta réponse)\n\n${ctxText}\n\n---\nDEMANDE\n${question}`
      : `AUCUN DOCUMENT NI PROTOCOLE INTERNE PERTINENT N'A ÉTÉ TROUVÉ pour cette demande. Dis-le dans « Sources et statut » (statut Général ou À confirmer) et n'invente aucune source.\n\n---\nDEMANDE\n${question}`)
    : ctxText
    ? `EXTRAITS DES PROCÉDURES DE LA CLINIQUE (à appliquer en priorité)\n\n${ctxText}\n\n---\nQUESTION\n${question}`
    : question;
  let messages = [...history, { role: "user", content: userContent }];
  let simSystem = "";
  if (isSim) {
    const scenario = String(body?.scenario || "").replace(/[\r\n]+/g, " ").slice(0, 300);
    const level = SIM_LEVELS[body?.level] ? body.level : "intermediaire";
    if (simPhase === "client") {
      const genre = body?.genre === "f" ? "\n\nTu es une FEMME (prénom féminin, accords au féminin) : ta voix au téléphone est féminine."
        : body?.genre === "m" ? "\n\nTu es un HOMME (prénom masculin, accords au masculin) : ta voix au téléphone est masculine." : "";
      const oral = body?.voix || body?.genre ? "\nL'appel est à la voix : écris comme on parle au téléphone (phrases courtes, ponctuation naturelle, hésitations légères permises comme « euh » ou « ben »), sans abréviations ni symboles." : "";
      simSystem = `${config.simulationClient || SIM_CLIENT_DEFAULT}\n\nScénario de cet appel : ${scenario || "au choix, réaliste"}.\n\n${SIM_LEVELS[level]}${genre}${oral}`;
      messages = [...history, { role: "user", content: question }];
    } else {
      const coach = prenom ? `\nL'apprenant s'appelle ${prenom} : adresse-toi à lui ou elle par son prénom au début.` : "";
      const proc = ctxText ? `\n\nProcédures de la clinique à respecter :\n${ctxText}` : "";
      simSystem = `${config.simulationBilan || SIM_BILAN_DEFAULT}\n${SIM_LEVEL_BILAN[level]}${coach}${proc}`;
      messages = [{ role: "user", content: `TRANSCRIPTION DE L'APPEL SIMULÉ\n\n${question}` }];
    }
  }
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

  const LIVE_TASK = "\n\nTÂCHE POUR CETTE RÉPONSE : vérifie d'abord le périmètre. Si la demande est hors périmètre, écris uniquement : « Je suis spécialisé dans l'accueil et la communication en établissement vétérinaire. Je peux vous aider dans ce cadre. » Si la demande est ambiguë ou trop vague, écris uniquement une question de clarification complète et polie : une phrase entière terminée par un point d'interrogation, qui propose au besoin deux ou trois précisions possibles. N'écris jamais les marqueurs [EN DIRECT] ou [APPRENTISSAGE]. Sinon, écris UNIQUEMENT le contenu de la partie [EN DIRECT], sans le marqueur, sans titre, sans liste numérotée. Analyse d'abord toute la situation, puis donne la meilleure réponse en 2 à 4 phrases au total : la phrase exacte à dire au client entre guillemets, puis l'action concrète à faire maintenant. 80 mots maximum.";
  const LEARN_TASK = "\n\nTÂCHE POUR CETTE RÉPONSE : vérifie d'abord le périmètre. Si la demande est hors périmètre, ou si le lien est ambigu au point de nécessiter une clarification, écris uniquement : [SANS APPRENTISSAGE] — et rien d'autre. Sinon, écris UNIQUEMENT le contenu de la partie [APPRENTISSAGE], sans le marqueur, en traitant seulement les éléments pertinents. La réponse courte « En direct » est déjà donnée à la personne séparément : ne la recopie pas, explique-la et approfondis (étapes, pourquoi, pièges, variantes de formulation, schéma si utile, ligne « À retenir »).";

  const effort = isSim && simPhase === "client" ? "low" : (EFFORT[tier] || "medium");
  const call = (sys, maxTokens, withThinking) => fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    signal: abort.signal,
    headers: { "content-type": "application/json", "x-api-key": env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
    body: JSON.stringify(withThinking
      ? { model, max_tokens: maxTokens, system: sys, messages, stream: true, thinking: { type: "adaptive" }, output_config: { effort } }
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
    parts = isSim
      ? [await callSafe(simSystem, simPhase === "client" ? 2000 : cap)]
      : isScene || role === "tsa"
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
    if (status === 401 || status === 403) await sendAlert(env, "apikey", "La clé API Anthropic est refusée", ["L'agent ne peut plus répondre : la clé ANTHROPIC_API_KEY est invalide, révoquée ou sans crédit.", "Vérifiez la clé et le solde dans https://console.anthropic.com, puis mettez à jour le secret dans Cloudflare."], 3 * 3600);
    else if (status === 429 || status >= 500) await sendAlert(env, "api" + (status === 429 ? "429" : "5xx"), status === 429 ? "Anthropic limite les demandes (429)" : `Anthropic indisponible (erreur ${status})`, [status === 429 ? "Le service refuse des demandes : limite de débit ou de dépenses atteinte dans la console Anthropic." : "Le service d'Anthropic a répondu par une erreur. C'est souvent passager.", "Si cela dure, vérifiez https://status.anthropic.com et les limites de votre compte."], 3600);
    const msg = status === 401 ? "La clé API est invalide. Vérifiez ANTHROPIC_API_KEY dans Cloudflare."
      : status === 429 ? "Trop de questions en même temps. Réessayez dans une minute."
      : status === 400 ? "La demande a été refusée par le service. Raccourcissez la question ou commencez une nouvelle conversation."
      : "Le service est momentanément indisponible. Réessayez.";
    return json(status === 401 ? 502 : status, { error: msg }, cors);
  }

  const segments = isScene || isSim || role === "tsa"
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
      "x-agent-role": role,
    },
  });
}

function tsaAuthorized(request, env) {
  const a = String(request.headers.get("x-tsa-code") || "");
  const b = String(env.TSA_CODE || "");
  if (!a || !b || a.length !== b.length) return false;
  let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

/* ---------- helpers ---------- */
function json(status, data, cors) {
  return new Response(JSON.stringify(data), { status, headers: { ...cors, "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
}

function cleanHistory(h, max = MAX_HISTORY) {
  if (!Array.isArray(h)) return [];
  const turns = h
    .filter((t) => t && (t.role === "user" || t.role === "assistant") && typeof t.content === "string" && t.content.trim())
    .map((t) => ({ role: t.role, content: t.content.slice(0, MAX_TURN) }))
    .slice(-max);
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
  const base = String(env.SITE_URL || "https://tmclellan007-blip.github.io/nc").replace(/\/$/, "");
  const res = await fetch(base + path, { cf: { cacheTtl: 30 }, headers: { "user-agent": "laqualia-agent (Cloudflare Worker)", accept: "*/*" } });
  if (!res.ok) throw new Error(path);
  return res;
}

// Fichiers du site (configuration de départ + anciens documents publics de la Réception)
async function loadKnowledge(request, env) {
  if (cache && Date.now() - cache.at < 60 * 1000) return cache;
  let config = {}, fileOk = false;
  for (let attempt = 0; attempt < 2 && !fileOk; attempt++) {
    try { config = await (await asset(request, env, "/agent/config.json")).json(); fileOk = !!config.instructions; } catch {}
  }
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
      chunks.push(...chunkText(title, text));
    } catch {}
  }
  // Lecture ratée : on ne garde pas ce résultat en mémoire, on réessaiera à la prochaine demande
  cache = { at: fileOk ? Date.now() : Date.now() - 55 * 1000, config, chunks, fileOk };
  return cache;
}
function chunkText(title, text) {
  const out = [];
  for (let i = 0; i < text.length; i += 1400) {
    const piece = text.slice(i, i + 1600);
    out.push({ title, text: piece, tf: countTerms(piece + " " + title) });
  }
  return out;
}

/* ---------- configuration privée par espace (Cloudflare KV) ---------- */
const fnv = (t) => { let h = 2166136261; t = String(t || "").trim(); for (let i = 0; i < t.length; i++) { h ^= t.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; } return h.toString(16); };
// Anciennes instructions d'origine, jamais modifiées par l'équipe : remplacées par la version à jour de config.json
const LEGACY_DEFAULTS = new Set(["3906c25b"]);
const ROLES = ["reception", "tsa"];
const SHARED_KEYS = ["apiUrl", "etablissement", "logo", "privacy", "modelesProposes", "tier", "audience"];
const EDITABLE = ["name", "disclaimer", "instructions", "examples", "scenarios", "simTypes", "simulationClient", "simulationBilan", "tier", "modelesProposes"];
const roleCache = {};
async function kvJson(env, key) {
  if (!env.AGENT_KV) return null;
  try { return await env.AGENT_KV.get(key, "json"); } catch { return null; }
}
// Configuration de départ d'un espace, tirée de agent/config.json
function fileRoleConfig(file, role) {
  if (role === "reception") { const { tsa, ...rest } = file; return rest; }
  const shared = {}; SHARED_KEYS.forEach((k) => { if (file[k] !== undefined) shared[k] = file[k]; });
  const T = file.tsa || {};
  return { ...shared, ...T, instructions: T.instructions || TSA_DEFAULT, simulationClient: T.simulationClient || TSA_SIM_DEFAULT, simulationBilan: T.simulationBilan || TSA_BILAN_DEFAULT };
}
async function loadRole(request, env, role) {
  const hit = roleCache[role];
  if (hit && Date.now() - hit.at < 60 * 1000) return hit;
  const base = await loadKnowledge(request, env);
  const kvCfg = (await kvJson(env, "cfg:" + role)) || {};
  if (kvCfg.instructions && LEGACY_DEFAULTS.has(fnv(kvCfg.instructions))) delete kvCfg.instructions;
  // Une copie abîmée (texte de remplacement) ne doit jamais remplacer de vraies instructions
  if (/^Tu es un assistant pour l'équipe d'accueil d'un établissement vétérinaire\. Réponds en français\.?\s*$/.test(String(kvCfg.instructions || "").trim())) delete kvCfg.instructions;
  const shared = (await kvJson(env, "cfg:shared")) || {};
  // Ancien nom par défaut, jamais choisi par l'équipe : on laisse le nom à jour de config.json
  if (["Hôpital vétérinaire du Ruisseau", "Clinique vétérinaire virtuelle au Québec"].includes(shared.etablissement)) delete shared.etablissement;
  if (/neovet/i.test(String(shared.logo || ""))) delete shared.logo;
  const config = { ...fileRoleConfig(base.config, role), ...shared, ...kvCfg };
  if (role === "tsa") config.audience = "techniciens";
  // Base de connaissances : documents privés de l'espace (+ anciens documents publics pour la Réception)
  const chunks = role === "reception" ? base.chunks.slice() : [];
  const index = (await kvJson(env, "docs:" + role)) || [];
  for (const d of Array.isArray(index) ? index : []) {
    try { const t = await env.AGENT_KV.get(`doc:${role}:${d.id}`); if (t) chunks.push(...chunkText(d.title || "Document", t)); } catch {}
  }
  roleCache[role] = { at: base.fileOk ? Date.now() : Date.now() - 55 * 1000, config, chunks, docs: index };
  return roleCache[role];
}
async function publicConfig(request, env) {
  const out = {};
  for (const role of ROLES) {
    const { config } = await loadRole(request, env, role);
    out[role] = { name: config.name, disclaimer: config.disclaimer, examples: config.examples, scenarios: config.scenarios, simTypes: config.simTypes, tier: config.tier, modelesProposes: config.modelesProposes };
  }
  const { config } = await loadRole(request, env, "reception");
  out.etablissement = config.etablissement;
  out.logo = config.logo || "";
  out.privacy = config.privacy || PRIVACY_DEFAULT;
  return out;
}

/* ---------- page de configuration (protégée par ADMIN_CODE) ---------- */
const adminFails = new Map();
function adminAuthorized(request, env) {
  const a = String(request.headers.get("x-admin-code") || ""), b = String(env.ADMIN_CODE || "");
  if (!a || !b || a.length !== b.length) return false;
  let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
const str = (v, max) => String(v ?? "").replace(/\r/g, "").slice(0, max);
const lines = (v, maxN, maxL) => (Array.isArray(v) ? v : String(v || "").split("\n")).map((x) => str(x, maxL).trim()).filter(Boolean).slice(0, maxN);
function cleanConfig(c) {
  const out = {};
  if (c.name !== undefined) out.name = str(c.name, 120).trim();
  if (c.disclaimer !== undefined) out.disclaimer = str(c.disclaimer, 600).trim();
  if (c.instructions !== undefined) out.instructions = str(c.instructions, 40000);
  if (c.simulationClient !== undefined) out.simulationClient = str(c.simulationClient, 8000);
  if (c.simulationBilan !== undefined) out.simulationBilan = str(c.simulationBilan, 8000);
  if (c.examples !== undefined) out.examples = lines(c.examples, 80, 300);
  if (c.scenarios !== undefined) out.scenarios = lines(c.scenarios, 60, 300);
  if (c.simTypes !== undefined) {
    out.simTypes = (Array.isArray(c.simTypes) ? c.simTypes : []).map((t) => [str(t?.[0], 60).trim(), str(t?.[1], 400).trim()]).filter((t) => t[0] && t[1]).slice(0, 12);
  }
  if (c.tier !== undefined && MODELS[c.tier]) out.tier = c.tier;
  if (c.modelesProposes !== undefined) out.modelesProposes = (Array.isArray(c.modelesProposes) ? c.modelesProposes : []).filter((t) => MODELS[t]);
  return out;
}
async function handleAdmin(request, env, cors) {
  if (!env.ADMIN_CODE) return json(503, { error: "La configuration n'est pas activée : ajoutez le secret ADMIN_CODE au relais." }, cors);
  if (!env.AGENT_KV) return json(503, { error: "Le stockage AGENT_KV n'est pas relié au relais." }, cors);
  const ip = request.headers.get("cf-connecting-ip") || "?";
  if (await lockedOut(env, ip)) return json(429, { error: LOCK_MSG }, cors);
  if (!adminAuthorized(request, env)) {
    await recordFail(env, ip, "Admin");
    return json(401, { error: "Code de configuration invalide." }, cors);
  }
  let body; try { body = await request.json(); } catch { return json(400, { error: "Requête invalide." }, cors); }
  const role = ROLES.includes(body?.role) ? body.role : "reception";
  const KV = env.AGENT_KV;
  const invalidate = () => { delete roleCache.reception; delete roleCache.tsa; };
  const idx = async () => (await kvJson(env, "docs:" + role)) || [];
  switch (body?.action) {
    case "load": {
      invalidate();
      const { config, docs } = await loadRole(request, env, role);
      const edit = {}; EDITABLE.forEach((k) => { if (config[k] !== undefined) edit[k] = config[k]; });
      return json(200, { role, config: edit, etablissement: config.etablissement || "", logo: config.logo || "", docs, customized: !!(await KV.get("cfg:" + role)), fileOk: !!cache?.fileOk, privacy: config.privacy || PRIVACY_DEFAULT, dailyLimit: await dailyLimit(env), usedToday: Number(await KV.get("use:" + torontoDate())) || 0, rotation: await rotationInfo(env), alerts: { ready: !!env.ALERT_EMAIL, to: ALERT_TO, lastError: (await KV.get("alert:lastError")) || "" } }, cors);
    }
    case "save": {
      await sendAlert(env, "cfg-" + role, `Configuration modifiée (${role === "tsa" ? "TSA" : "Réception"})`, [`Les réglages de l'espace ${role === "tsa" ? "Équipe technique — TSA" : "Réception"} ont été enregistrés depuis la page Admin.`, `Adresse IP : ${ip}`, "Si ce n'est pas vous, changez ADMIN_CODE dans Cloudflare."], 30 * 60);
      const clean = cleanConfig(body.config || {});
      const prev = (await kvJson(env, "cfg:" + role)) || {};
      await KV.put("cfg:" + role, JSON.stringify({ ...prev, ...clean, updated: new Date().toISOString() }));
      if (body.etablissement !== undefined || body.logo !== undefined || body.privacy !== undefined || body.dailyLimit !== undefined || body.rotate !== undefined) {
        const sh = (await kvJson(env, "cfg:shared")) || {};
        if (body.etablissement !== undefined) sh.etablissement = str(body.etablissement, 120).trim();
        if (body.logo !== undefined) { const u = str(body.logo, 500).trim(); sh.logo = /^https:\/\/[^\s"'<>]+$/.test(u) ? u : ""; }
        if (body.privacy !== undefined) sh.privacy = str(body.privacy, 6000).trim();
        if (body.rotate !== undefined) sh.rotate = !!body.rotate;
        if (body.dailyLimit !== undefined) { const n = Math.round(Number(body.dailyLimit)); if (n >= 10 && n <= 5000) sh.dailyLimit = n; }
        await KV.put("cfg:shared", JSON.stringify(sh));
      }
      invalidate();
      return json(200, { ok: true }, cors);
    }
    case "reset": {
      await KV.delete("cfg:" + role); invalidate();
      return json(200, { ok: true }, cors);
    }
    case "docGet": {
      const t = await KV.get(`doc:${role}:${str(body.id, 40)}`);
      return t === null ? json(404, { error: "Document introuvable." }, cors) : json(200, { text: t }, cors);
    }
    case "testAlert": {
      const r = await sendAlert(env, "test-" + Date.now(), "Courriel de test", ["Les alertes de l'agent fonctionnent : vous recevrez un courriel si quelque chose cloche."], 0, true);
      return json(r.ok ? 200 : 503, r.ok ? { ok: true } : { error: r.error }, cors);
    }
    case "docSave": {
      const title = str(body.title, 160).trim() || "Document sans titre";
      const text = str(body.text, 1500000);
      if (!text.trim()) return json(400, { error: "Le document est vide." }, cors);
      const list = await idx();
      if (list.length >= 200 && !body.id) return json(400, { error: "Limite de 200 documents atteinte." }, cors);
      const id = /^[a-z0-9]{6,40}$/.test(String(body.id || "")) ? body.id : Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
      await KV.put(`doc:${role}:${id}`, text);
      const entry = { id, title, chars: text.length, source: str(body.source, 160), updated: new Date().toISOString() };
      const next = [entry, ...list.filter((d) => d.id !== id)];
      await KV.put("docs:" + role, JSON.stringify(next));
      invalidate();
      return json(200, { ok: true, doc: entry }, cors);
    }
    case "docDelete": {
      const id = str(body.id, 40);
      await KV.delete(`doc:${role}:${id}`);
      await KV.put("docs:" + role, JSON.stringify((await idx()).filter((d) => d.id !== id)));
      invalidate();
      return json(200, { ok: true }, cors);
    }
  }
  return json(400, { error: "Action inconnue." }, cors);
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


/* =====================================================================
   VOIX (Microsoft Azure Speech) — voix neuronales québécoises et dictée,
   identiques dans tous les navigateurs. Variables du Worker :
     AZURE_SPEECH_KEY     (Secret) clé de la ressource Speech
     AZURE_SPEECH_REGION  (Text)   région, ex. canadacentral
   ===================================================================== */
const VOICES = {
  sylvie: "fr-CA-SylvieNeural",
  antoine: "fr-CA-AntoineNeural",
  jean: "fr-CA-JeanNeural",
  thierry: "fr-CA-ThierryNeural",
};
const SPEECH_MAX = 150; // requêtes de voix par 5 minutes et par adresse
const speechHits = new Map();
function speechReady(env) { return !!(env.AZURE_SPEECH_KEY && env.AZURE_SPEECH_REGION); }
function speechLimited(ip) {
  const now = Date.now();
  const list = (speechHits.get(ip) || []).filter((t) => now - t < RATE_WINDOW_MS);
  list.push(now); speechHits.set(ip, list);
  if (speechHits.size > 2000) speechHits.clear();
  return list.length > SPEECH_MAX;
}
const xml = (t) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");

async function handleSpeech(kind, request, env, cors) {
  const ipS = request.headers.get("cf-connecting-ip") || "?";
  if (await lockedOut(env, ipS)) return json(429, { error: LOCK_MSG }, cors);
  if (!(await teamAuthorized(request, env))) { await recordFail(env, ipS, "d'équipe (voix)"); return json(401, { error: "Code d'accès invalide." }, cors); }
  if (!speechReady(env)) return json(503, { error: "La voix Azure n'est pas configurée." }, cors);
  if (speechLimited(request.headers.get("cf-connecting-ip") || "?")) return json(429, { error: "Trop de requêtes de voix. Attendez un peu." }, cors);
  const region = String(env.AZURE_SPEECH_REGION).trim().toLowerCase().replace(/[^a-z0-9]/g, "");
  const key = env.AZURE_SPEECH_KEY;
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 20000);
  try {
    if (kind === "tts") {
      let body; try { body = await request.json(); } catch { return json(400, { error: "Requête invalide." }, cors); }
      const text = String(body?.text || "").replace(/\s+/g, " ").trim().slice(0, 1200);
      if (!text) return json(400, { error: "Texte vide." }, cors);
      const voice = VOICES[body?.voice] || VOICES.sylvie;
      const ssml = `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="fr-CA"><voice name="${voice}">${xml(text)}</voice></speak>`;
      const r = await fetch(`https://${region}.tts.speech.microsoft.com/cognitiveservices/v1`, {
        method: "POST", signal: ctl.signal,
        headers: {
          "Ocp-Apim-Subscription-Key": key,
          "Content-Type": "application/ssml+xml",
          "X-Microsoft-OutputFormat": "audio-24khz-48kbitrate-mono-mp3",
          "User-Agent": "laqualia-agent",
        },
        body: ssml,
      });
      if (!r.ok) return json(r.status === 401 || r.status === 403 ? 502 : 503, { error: r.status === 401 || r.status === 403 ? "Clé Azure invalide ou mauvaise région." : "Voix momentanément indisponible." }, cors);
      return new Response(r.body, { headers: { ...cors, "content-type": "audio/mpeg", "cache-control": "no-store" } });
    }
    // Dictée : audio WAV 16 kHz mono envoyé par la page, 60 s au maximum
    const len = Number(request.headers.get("content-length") || 0);
    if (len > 2_200_000) return json(413, { error: "Réplique trop longue (60 secondes maximum)." }, cors);
    const audio = await request.arrayBuffer();
    if (!audio.byteLength || audio.byteLength > 2_200_000) return json(400, { error: "Audio invalide." }, cors);
    const r = await fetch(`https://${region}.stt.speech.microsoft.com/speech/recognition/conversation/cognitiveservices/v1?language=fr-CA&format=simple&profanity=raw`, {
      method: "POST", signal: ctl.signal,
      headers: { "Ocp-Apim-Subscription-Key": key, "Content-Type": "audio/wav; codecs=audio/pcm; samplerate=16000", Accept: "application/json" },
      body: audio,
    });
    if (!r.ok) return json(r.status === 401 || r.status === 403 ? 502 : 503, { error: r.status === 401 || r.status === 403 ? "Clé Azure invalide ou mauvaise région." : "Dictée momentanément indisponible." }, cors);
    const out = await r.json().catch(() => ({}));
    return json(200, { text: out.RecognitionStatus === "Success" ? String(out.DisplayText || "") : "", status: out.RecognitionStatus || "" }, cors);
  } catch {
    return json(504, { error: "Le service de voix a mis trop de temps à répondre." }, cors);
  } finally {
    clearTimeout(t);
  }
}


/* ---------- plafond quotidien et avis de confidentialité ---------- */
const DAILY_DEFAULT = 300; // questions par jour pour toute l'équipe (modifiable dans Admin)
function torontoDate() {
  try { return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Toronto", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date()); }
  catch { return new Date().toISOString().slice(0, 10); }
}
async function dailyLimit(env) {
  const sh = (await kvJson(env, "cfg:shared")) || {};
  const n = Number(sh.dailyLimit || env.DAILY_LIMIT || DAILY_DEFAULT);
  return n >= 10 ? n : DAILY_DEFAULT;
}
async function dailyGate(env) {
  if (!env.AGENT_KV) return { ok: true };
  try {
    const key = "use:" + torontoDate();
    const limit = await dailyLimit(env);
    const used = Number(await env.AGENT_KV.get(key)) || 0;
    if (used >= limit) {
      await sendAlert(env, "limit", "Limite quotidienne de questions atteinte", [`L'équipe a utilisé les ${limit} questions permises aujourd'hui. L'agent refuse les nouvelles questions jusqu'à minuit.`, "Si c'est normal, augmentez la limite dans Admin › Sécurité et confidentialité. Sinon, un code a peut-être été partagé."], 20 * 3600);
      return { ok: false, limit };
    }
    if (used + 1 === Math.ceil(limit * 0.8)) await sendAlert(env, "limit80", "80 % de la limite quotidienne utilisée", [`${used + 1} questions sur ${limit} ont été utilisées aujourd'hui.`], 20 * 3600);
    await env.AGENT_KV.put(key, String(used + 1), { expirationTtl: 3 * 86400 });
    return { ok: true, limit, used: used + 1 };
  } catch { return { ok: true }; } // le stockage ne doit jamais bloquer l'agent par erreur
}
const PRIVACY_DEFAULT = `Avant de commencer, merci de lire ces quelques règles.

• N'inscrivez aucun renseignement permettant d'identifier une personne : nom de client, téléphone, adresse, courriel ou numéro de dossier. Utilisez des données fictives ou dépersonnalisées.
• Vos questions sont transmises à Anthropic, le fournisseur du modèle d'intelligence artificielle Claude, uniquement pour produire les réponses. Selon ses conditions commerciales, Anthropic n'utilise pas ces données pour entraîner ses modèles.
• La dictée vocale est traitée par le service de reconnaissance de votre navigateur (Google, Apple ou Microsoft) ou par Microsoft Azure.
• L'historique de vos conversations reste dans ce navigateur ; vous pouvez l'effacer en tout temps depuis le menu.
• Les réponses soutiennent la formation et le travail de l'équipe. Elles ne remplacent ni le jugement d'un médecin vétérinaire ni les procédures de l'établissement.

Responsable de la protection des renseignements personnels : [nom et courriel à compléter dans Admin].`;


/* ---------- blocage après plusieurs mauvais codes ---------- */
const LOCK_MSG = "Trop d'essais avec un mauvais code. Pour votre sécurité, l'accès est bloqué 15 minutes depuis cet appareil.";
const MAX_FAILS = 5, LOCK_SECONDS = 15 * 60;
const memFails = new Map(); // filet si le stockage n'est pas relié
async function lockedOut(env, ip) {
  if (!env.AGENT_KV) { const l = memFails.get(ip); return !!l && l.n >= MAX_FAILS && Date.now() - l.t < LOCK_SECONDS * 1000; }
  try { return !!(await env.AGENT_KV.get("lock:" + ip)); } catch { return false; }
}
async function recordFail(env, ip, kind = "") {
  if (!env.AGENT_KV) { const l = memFails.get(ip) || { n: 0, t: Date.now() }; if (Date.now() - l.t > LOCK_SECONDS * 1000) { l.n = 0; l.t = Date.now(); } l.n++; memFails.set(ip, l); return; }
  try {
    const n = (Number(await env.AGENT_KV.get("fail:" + ip)) || 0) + 1;
    if (n >= MAX_FAILS) {
      await env.AGENT_KV.put("lock:" + ip, "1", { expirationTtl: LOCK_SECONDS }); await env.AGENT_KV.delete("fail:" + ip);
      await sendAlert(env, "lock", `Blocage : ${MAX_FAILS} mauvais codes ${kind}`, [
        `Un appareil a entré ${MAX_FAILS} mauvais codes ${kind} de suite. Il est bloqué ${LOCK_SECONDS / 60} minutes.`,
        `Adresse IP : ${ip}`,
        kind === "Admin" ? "Il s'agit du code de configuration : si ce n'est pas vous, changez ADMIN_CODE dans Cloudflare." : "Si cela se répète, changez le code concerné (ou activez le code d'équipe mensuel dans Admin).",
      ], 15 * 60);
    }
    else await env.AGENT_KV.put("fail:" + ip, String(n), { expirationTtl: LOCK_SECONDS });
  } catch {}
}

/* ---------- code d'équipe mensuel (dérivé du secret AGENT_CODE) ---------- */
const WORDS = ["Lapin", "Chaton", "Moka", "Pomme", "Plume", "Cerise", "Biscuit", "Nuage", "Luna", "Maxou", "Praline", "Soleil", "Caramel", "Pistache", "Bambou", "Noisette", "Fleur", "Rocky", "Simba", "Bijou", "Galet", "Prune", "Kiwi", "Tulipe", "Sapin", "Erable", "Lilas", "Muscade", "Olive", "Perle", "Zebre", "Toutou"];
const normCode = (c) => String(c || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]/g, "");
async function monthCode(env, ym) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode("lq-rotation:" + env.AGENT_CODE), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const b = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(ym)));
  return `${WORDS[b[0] % WORDS.length]}-${WORDS[b[1] % WORDS.length]}-${String(((b[2] << 8) | b[3]) % 90 + 10)}`;
}
const ymOf = (y, m) => `${y}-${String(m).padStart(2, "0")}`;
function months() {
  const [y, m, d] = torontoDate().split("-").map(Number);
  const prev = m === 1 ? ymOf(y - 1, 12) : ymOf(y, m - 1);
  const next = m === 12 ? ymOf(y + 1, 1) : ymOf(y, m + 1);
  return { cur: ymOf(y, m), prev, next, day: d };
}
const GRACE_DAYS = 7; // l'ancien code reste accepté les 7 premiers jours du mois
async function rotationOn(env) { const sh = (await kvJson(env, "cfg:shared")) || {}; return !!sh.rotate; }
async function teamAuthorized(request, env) {
  if (!env.AGENT_CODE) return true;
  const given = request.headers.get("x-agent-code") || "";
  if (!(await rotationOn(env))) return given === env.AGENT_CODE;
  const M = months(), g = normCode(given);
  if (!g) return false;
  if (g === normCode(await monthCode(env, M.cur))) return true;
  if (M.day <= GRACE_DAYS && g === normCode(await monthCode(env, M.prev))) return true;
  return false;
}
async function rotationInfo(env) {
  if (!env.AGENT_CODE) return { available: false };
  const M = months();
  const [ny, nm] = M.next.split("-").map(Number);
  return {
    available: true, enabled: await rotationOn(env),
    current: await monthCode(env, M.cur), next: await monthCode(env, M.next),
    month: M.cur, changesOn: `${ny}-${String(nm).padStart(2, "0")}-01`, graceDays: GRACE_DAYS,
  };
}


/* ---------- alertes par courriel (Cloudflare Email Service) ---------- */
const ALERT_TO = "tmclellan007@gmail.com";
// Envoie au plus un courriel par type d'alerte et par période (throttle), pour ne jamais inonder la boîte
async function sendAlert(env, type, subject, lines, throttleSec = 3600, force = false) {
  if (!env.ALERT_EMAIL) return { ok: false, error: "La liaison ALERT_EMAIL n'est pas active : configurez Email Service dans Cloudflare." };
  try {
    if (!force && env.AGENT_KV && throttleSec > 0) {
      const k = "alert:" + type;
      if (await env.AGENT_KV.get(k)) return { ok: true, skipped: true };
      await env.AGENT_KV.put(k, "1", { expirationTtl: Math.max(60, throttleSec) });
    }
    const when = new Intl.DateTimeFormat("fr-CA", { timeZone: "America/Toronto", dateStyle: "long", timeStyle: "short" }).format(new Date());
    const text = `${lines.join("\n\n")}\n\n— ${when}\nAgent La Qualia · alerte automatique (relais Cloudflare laqualia-agent)`;
    await env.ALERT_EMAIL.send({ to: ALERT_TO, from: { email: env.ALERT_FROM || "alertes@notif.laqualia.com", name: "Agent La Qualia" }, subject: "⚠️ Agent La Qualia : " + subject, text });
    if (env.AGENT_KV) await env.AGENT_KV.delete("alert:lastError");
    return { ok: true };
  } catch (e) {
    const err = String(e?.message || e).slice(0, 300);
    try { if (env.AGENT_KV) await env.AGENT_KV.put("alert:lastError", err, { expirationTtl: 7 * 86400 }); } catch {}
    return { ok: false, error: "Envoi impossible : " + err };
  }
}
async function healthCheck(env) {
  const problems = [];
  try { const r = await asset(null, env, "/agent/config.json"); const c = await r.json(); if (!c.instructions) problems.push("Le fichier agent/config.json est lisible mais sans instructions."); }
  catch { problems.push("Le fichier agent/config.json du site est inaccessible (site GitHub Pages en panne ou SITE_URL incorrect)."); }
  if (!env.ANTHROPIC_API_KEY) problems.push("Le secret ANTHROPIC_API_KEY est absent.");
  else {
    try {
      const r = await fetch("https://api.anthropic.com/v1/models?limit=1", { headers: { "x-api-key": env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" } });
      if (r.status === 401 || r.status === 403) problems.push("La clé API Anthropic est refusée (invalide ou révoquée).");
      else if (!r.ok && r.status >= 500) problems.push(`Anthropic répond par une erreur ${r.status}.`);
    } catch { problems.push("Impossible de joindre l'API Anthropic."); }
  }
  if (env.AGENT_KV) { try { await env.AGENT_KV.get("cfg:shared"); } catch { problems.push("Le stockage AGENT_KV ne répond pas."); } }
  if (problems.length) await sendAlert(env, "health", "Problème détecté lors de la vérification automatique", problems, 6 * 3600);
}
