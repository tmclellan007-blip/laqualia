// Espace TSA — « Nutrition — Aide au conseil client ».
// L'agent recherche et consulte lui-même les fiches officielles canadiennes (Royal Canin, Hill's, Purina),
// avec les outils serveur web_search et web_fetch d'Anthropic, limités à ces seuls domaines.
// Le relais transmet à la page un flux NDJSON : étapes (recherche, consultation), texte, puis la liste
// des pages RÉELLEMENT consultées (succès ou échec), qui fait foi pour les sources affichées.

export const NUTRITION_START_URLS = [
  "https://www.royalcanin.com/ca/dogs/products/vet-products",
  "https://www.hillspet.ca/en-ca/dog-food",
  "https://www.purina.ca/purina-pro-plan-veterinary-diets/diets",
];
const SEARCH_DOMAINS = ["royalcanin.com/ca", "hillspet.ca", "purina.ca"]; // la recherche accepte un chemin
const FETCH_DOMAINS = ["royalcanin.com", "hillspet.ca", "purina.ca"];      // la consultation ne filtre que le domaine
const MANUFACTURER = (u) => (/royalcanin\.com/.test(u) ? "Royal Canin" : /hillspet\.ca/.test(u) ? "Hill's" : /purina\.ca/.test(u) ? "Purina" : "");
const MAX_CONTINUATIONS = 2;
const NO_TOOLS = "\n\nIMPORTANT : la consultation des fiches est indisponible pour cette réponse. N'affirme AUCUNE caractéristique de produit (composition, indications, formats, etc.). Réponds seulement sur la démarche, les questions à poser et ce qui doit être validé par le vétérinaire, puis propose de fournir la fiche du produit en PDF ou un document approuvé par la clinique. N'ajoute pas de bloc comparaison.";

export const NUTRITION_SYSTEM = `Tu es l'outil « Nutrition — Aide au conseil client » de l'espace Équipe technique (TSA) d'un établissement vétérinaire au Québec. Tu aides la ou le TSA à recueillir les informations pertinentes, à comparer des aliments documentés et à expliquer les options au client. Tu soutiens le conseil nutritionnel ; tu ne remplaces ni la prescription ni la validation du médecin vétérinaire. Français québécois professionnel, unités métriques.

PÉRIMÈTRE
Seulement la nutrition des chiens et des chats en contexte vétérinaire (aliments, textures, formats, transitions, refus de manger, budget, rupture de stock, explication au client). Pour toute autre demande, écris seulement : « Cet outil est réservé au conseil nutritionnel en établissement vétérinaire. »

URGENCE D'ABORD
Si la demande évoque une urgence possible (anorexie complète prolongée, surtout chez le chat ; vomissements répétés ou sang ; abdomen gonflé chez un grand chien ; chat mâle qui force sans uriner ; ingestion de toxique ; abattement marqué ; difficulté respiratoire ; convulsions), commence par : **Alertez le vétérinaire immédiatement**, puis les gestes prévus au protocole de l'établissement. Ne poursuis la discussion nutritionnelle qu'ensuite, brièvement.

SOURCES AUTORISÉES ET CONSULTATION
- Tu ne t'appuies que sur les sites officiels canadiens : Royal Canin Canada (royalcanin.com/ca/…), Hill's Canada (hillspet.ca), Purina Canada (purina.ca), ainsi que sur les extraits des protocoles de la clinique fournis dans le message.
- Les pages de départ fournies sont des pages de catégorie : elles ne suffisent JAMAIS à justifier une caractéristique. Avant d'affirmer quoi que ce soit sur un produit (indications, contre-indications, composition, nutriments, texture, taille de croquette, formats), trouve sa fiche précise avec web_search, puis consulte-la avec web_fetch.
- Privilégie la version française canadienne quand elle existe (ex. hillspet.ca/fr-ca, royalcanin.com/ca/fr, purina.ca/fr). Ne traduis jamais un nom commercial toi-même : reprends-le exactement tel qu'il figure sur la fiche consultée.
- Chez Hill's, distingue toujours Science Diet (gamme courante) de Prescription Diet (aliment thérapeutique vétérinaire). Fais de même pour les gammes vétérinaires des autres fabricants (Royal Canin Veterinary Diet, Purina Pro Plan Veterinary Diets).
- Si une consultation échoue, dis-le clairement (« La fiche … n'a pas pu être consultée ») et propose de fournir la fiche en PDF ou un document approuvé par la clinique. Ne prétends jamais avoir consulté une page inaccessible et n'utilise pas tes connaissances générales pour combler une fiche manquante.
- Économise les consultations : seulement les fiches utiles à la question (3 produits au plus). Si la question ne porte sur aucun produit précis (ex. comment expliquer une transition alimentaire), réponds sans recherche.

FIABILITÉ
- Chaque caractéristique produit vient d'une fiche réellement consultée : cite-la en lien Markdown sur le nom du produit, ex. [Nom exact du produit](lien exact de la fiche).
- N'invente jamais une composition, une indication, une contre-indication, une taille de croquette, un format, un prix ou un stock. Donnée absente de la fiche : écris « Non précisé dans la source ».
- Marque l'origine de l'information : [Fabricant] (déclaré sur la fiche), [Clinique] (extraits des protocoles fournis), [Vétérinaire] (doit être validé par le vétérinaire).
- Ne présente jamais deux produits comme équivalents sur le plan thérapeutique sur la seule base de leur catégorie ou de leur nom marketing. Un remplacement d'aliment thérapeutique se décide par le vétérinaire.
- Ne privilégie aucune marque sans justification documentée.
- Ne confonds pas « référencé au Canada » (présent sur le site canadien), « vendu par la clinique » et « en stock ». Aucune donnée de prix ni de stock n'est connectée : écris « Prix et disponibilité à confirmer auprès de la clinique ».

LIMITES CLINIQUES
- Une description vague (ex. « problème urinaire », « problème de reins », « allergie ») ne suffit pas pour choisir un aliment thérapeutique : demande les précisions déterminantes (type de problème confirmé par le vétérinaire, résultats, prescription en cours) ou rédige la question à poser au vétérinaire.
- Aucun diagnostic, aucune modification de prescription, aucun remplacement thérapeutique sans validation vétérinaire. Si plusieurs problèmes de santé sont mentionnés, souligne les arbitrages à faire valider.
- Calculs de coût ou de ration : uniquement avec des données explicites (poids, ration indiquée sur la fiche ou prescrite par le vétérinaire, prix fourni par la clinique). Montre la formule et les étapes, sinon demande la donnée manquante. Termine un calcul par « À faire vérifier avant de le communiquer au client. »

PRÉCISIONS
Ne transforme pas l'échange en questionnaire. Demande seulement les précisions vraiment nécessaires à cette question (3 au plus), et réponds déjà à ce qui peut l'être.

FORMAT (Markdown simple, sans tableau)
### Réponse
### À préciser (seulement si nécessaire)
### À valider par le vétérinaire (seulement si pertinent)
### Pour expliquer au client (seulement si utile : phrases simples, prêtes à dire)
Ne fais pas de section « Sources » : l'interface affiche elle-même la liste des fiches réellement consultées, avec la date.

COMPARATEUR
Quand on te demande de comparer des produits (2 ou 3), ajoute à la fin un bloc \`\`\`comparaison contenant UNIQUEMENT du JSON valide :
{"produits":[{"nom":"nom exact sur la fiche","fabricant":"Royal Canin|Hill's|Purina","gamme":"ex. Prescription Diet, Science Diet, Veterinary Diet","espece":"Chien|Chat","source":"lien exact de la fiche consultée","forme":"sec, humide…","indications":"…","contre_indications":"…","nutrition":"points clés déclarés","formats":"…","taille_croquette":"…"}],"notes":["arbitrages, limites, ce qui exige le vétérinaire"]}
Pour chaque champ sans information sur la fiche : "Non précisé dans la source". Un produit dont la fiche n'a pas pu être consultée : "source": "" et tous les champs à "Non précisé dans la source".`;

const clip = (v, n) => String(v ?? "").replace(/[\u0000-\u0008\u000b-\u001f]/g, " ").trim().slice(0, n);

// Message de l'utilisateur : question, contexte facultatif, produits à comparer, pages de départ, extraits de la clinique.
export function nutritionUserMessage(body, question, ctxText) {
  const n = body?.nutrition || {};
  const c = n.context || {};
  const LAB = { espece: "Espèce", age: "Âge", poids: "Poids", alimentation: "Alimentation actuelle", prescription: "Prescription ou diagnostic rapporté", preferences: "Préférences", budget: "Budget" };
  const ctxLines = Object.entries(LAB).map(([k, l]) => (clip(c[k], 300) ? `- ${l} : ${clip(c[k], 300)}` : "")).filter(Boolean);
  const prods = (Array.isArray(n.products) ? n.products : []).map((p) => clip(p, 200)).filter(Boolean).slice(0, 3);
  const parts = [`DEMANDE\n${question}`];
  if (ctxLines.length) parts.push(`CONTEXTE FOURNI PAR LA OU LE TSA (rapporté, non vérifié)\n${ctxLines.join("\n")}`);
  if (prods.length) parts.push(`PRODUITS À COMPARER (${prods.length})\n${prods.map((p, i) => `${i + 1}. ${p}`).join("\n")}\nTrouve et consulte la fiche officielle canadienne de chacun, puis ajoute le bloc comparaison.`);
  parts.push(ctxText
    ? `EXTRAITS DES PROTOCOLES DE LA CLINIQUE (cite-les [Clinique] seulement s'ils s'appliquent)\n${ctxText}`
    : "Aucun protocole de la clinique ne porte sur cette demande.");
  parts.push(`PAGES DE DÉPART OFFICIELLES (catégories ; consulte ensuite les fiches précises)\n${NUTRITION_START_URLS.join("\n")}`);
  return parts.join("\n\n");
}

export function nutritionTools() {
  return [
    { type: "web_search_20250305", name: "web_search", max_uses: 4, allowed_domains: SEARCH_DOMAINS, user_location: { type: "approximate", country: "CA", region: "Quebec", timezone: "America/Toronto" } },
    { type: "web_fetch_20250910", name: "web_fetch", max_uses: 6, allowed_domains: FETCH_DOMAINS, max_content_tokens: 14000 },
  ];
}

// Lecture du flux SSE d'Anthropic : reconstruit les blocs (pour une éventuelle reprise après pause_turn)
// et signale au fur et à mesure le texte, les recherches et les consultations.
async function readStream(res, on) {
  const reader = res.body.getReader(), dec = new TextDecoder();
  const blocks = []; let stop = null, buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split("\n"); buf = lines.pop();
    for (const line of lines) {
      if (!line.startsWith("data:")) continue;
      let ev; try { ev = JSON.parse(line.slice(5).trim()); } catch { continue; }
      if (ev.type === "content_block_start") {
        const b = JSON.parse(JSON.stringify(ev.content_block));
        if (b.type === "text") b.text = b.text || "";
        if (b.type === "server_tool_use" || b.type === "tool_use") { b._json = ""; }
        blocks[ev.index] = b;
        if (b.type === "web_fetch_tool_result" || b.type === "web_search_tool_result") on.result(b, blocks);
      } else if (ev.type === "content_block_delta") {
        const b = blocks[ev.index]; if (!b) continue;
        const d = ev.delta || {};
        if (d.type === "text_delta") { b.text += d.text; on.text(d.text); }
        else if (d.type === "input_json_delta") b._json += d.partial_json || "";
        else if (d.type === "thinking_delta") b.thinking = (b.thinking || "") + d.thinking;
        else if (d.type === "signature_delta") b.signature = d.signature;
        else if (d.type === "citations_delta") (b.citations = b.citations || []).push(d.citation);
      } else if (ev.type === "content_block_stop") {
        const b = blocks[ev.index];
        if (b && "_json" in b) { try { b.input = b._json ? JSON.parse(b._json) : (b.input || {}); } catch { b.input = b.input || {}; } delete b._json; if (b.type === "server_tool_use") on.toolUse(b); }
      } else if (ev.type === "message_delta") {
        if (ev.delta?.stop_reason) stop = ev.delta.stop_reason;
      } else if (ev.type === "error") {
        on.error(ev.error?.message || "erreur");
      }
    }
  }
  // Bloc d'outil resté ouvert (flux interrompu) : on termine proprement l'entrée, sans champ interne
  for (const b of blocks) if (b && "_json" in b) { try { b.input = b._json ? JSON.parse(b._json) : (b.input || {}); } catch { b.input = b.input || {}; } delete b._json; }
  return { blocks: blocks.filter(Boolean), stop };
}

// Flux NDJSON vers la page. Chaque ligne : {"t":"status"|"text"|"source"|"done"|"error", …}
export function nutritionStream({ env, model, maxTokens, effort, system, messages, signal, today, onEnd }) {
  const enc = new TextEncoder();
  return new ReadableStream({
    async start(c) {
      const send = (o) => { try { c.enqueue(enc.encode(JSON.stringify(o) + "\n")); } catch {} };
      const consulted = new Map(); // url -> {url, title, ok, error, retrieved_at, fabricant}
      const pendingFetch = new Map(); // tool_use_id -> url demandée
      let wrote = false;
      const on = {
        text: (t) => { wrote = true; send({ t: "text", d: t }); },
        toolUse: (b) => {
          if (b.name === "web_search") send({ t: "status", k: "search", d: clip(b.input?.query, 160) });
          if (b.name === "web_fetch") { pendingFetch.set(b.id, String(b.input?.url || "")); send({ t: "status", k: "fetch", d: clip(b.input?.url, 300) }); }
        },
        result: (b) => {
          if (b.type !== "web_fetch_tool_result") return;
          const r = b.content || {};
          if (r.type === "web_fetch_result") {
            const s = { url: r.url, title: clip(r.content?.title, 200), ok: true, retrieved_at: r.retrieved_at || null, fabricant: MANUFACTURER(r.url) };
            consulted.set(r.url, s); send({ t: "source", ...s });
          } else {
            const url = pendingFetch.get(b.tool_use_id) || "";
            const s = { url, ok: false, error: r.error_code || "erreur", fabricant: MANUFACTURER(url) };
            if (url && !consulted.has(url)) consulted.set(url, s);
            send({ t: "source", ...s });
          }
        },
        error: () => send({ t: "status", k: "warn", d: "Le service a signalé une erreur passagère." }),
      };
      const conv = messages.slice();
      try {
        for (let round = 0; round <= MAX_CONTINUATIONS; round++) {
          // Variantes en cas de refus (400) : sans réflexion, puis sans outils de consultation (réponse prudente, sans fiche).
          const call = (v) => fetch("https://api.anthropic.com/v1/messages", {
            method: "POST", signal,
            headers: { "content-type": "application/json", "x-api-key": env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
            body: JSON.stringify({ model, max_tokens: maxTokens, messages: conv, stream: true,
              system: v.tools ? system : system + NO_TOOLS,
              ...(v.tools ? { tools: nutritionTools() } : {}),
              ...(v.think ? { thinking: { type: "adaptive" }, output_config: { effort } } : {}) }),
          });
          let res = await call({ tools: true, think: true });
          if (res.status === 400 && round === 0) res = await call({ tools: true, think: false });
          if (res.status === 400 && round === 0) {
            try { console.error("nutrition tools refused", (await res.json())?.error?.message); } catch {}
            send({ t: "status", k: "warn", d: "La consultation des fiches officielles est indisponible pour le moment : réponse sans fiche produit." });
            res = await call({ tools: false, think: false });
          }
          if (!res.ok || !res.body) {
            let detail = ""; try { detail = (await res.json())?.error?.message || ""; } catch {}
            console.error("nutrition api", res.status, detail);
            send({ t: "error", d: res.status === 429 ? "Trop de demandes en même temps. Réessayez dans une minute." : res.status === 401 || res.status === 403 ? "La clé API est refusée. Prévenez l'administrateur." : "Le service n'a pas pu traiter la demande. Réessayez." });
            break;
          }
          const { blocks, stop } = await readStream(res, on);
          if (stop === "pause_turn" && round < MAX_CONTINUATIONS) {
            send({ t: "status", k: "wait", d: "Consultation des fiches en cours…" });
            conv.push({ role: "assistant", content: blocks });
            continue;
          }
          if (stop === "max_tokens") send({ t: "text", d: "\n\n_(Réponse coupée : précisez la question ou demandez la suite.)_" });
          break;
        }
        if (!wrote) send({ t: "empty" });
      } catch (e) {
        send({ t: "error", d: e?.name === "AbortError" ? "Délai dépassé : la recherche a été arrêtée. Réessayez avec une question plus précise." : "La connexion au service a été interrompue. Réessayez." });
      } finally {
        send({ t: "done", date: today, sources: [...consulted.values()] });
        try { c.close(); } catch {}
        try { onEnd && onEnd(); } catch {}
      }
    },
  });
}
