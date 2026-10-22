// Assistant La Qualia — interface application (site Web, sans dépendance à Claude.ai)
(() => {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch {} },
    del(k) { try { localStorage.removeItem(k); } catch {} },
  };
  // Visage de l'agent : une assistante à la Réception, un assistant côté TSA
  let tsaFace = true; // devient faux si l'image TSA est absente
  const avatarSrc = () => (document.body.classList.contains("tsa") && tsaFace ? "avatar-tsa.webp" : "avatar.webp");
  const SVG_COPY = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h8"/></svg>';

  const SCENARIOS = [
    "un client en colère au sujet d'une facture", "un propriétaire inquiet dont le chien vomit depuis ce matin",
    "un client qui veut annuler une chirurgie le matin même", "un client en deuil qui appelle pour l'incinération",
    "un client qui demande une dose de médicament", "un nouveau client qui veut un rendez-vous rapidement",
    "un appel où l'animal a peut-être avalé un toxique", "un client qui conteste un dépôt pour chirurgie",
    "un technicien qui te demande de rappeler un client pour des résultats", "un client pressé qui veut parler au vétérinaire tout de suite",
    "un client qui trouve les prix trop élevés", "un client âgé qui a du mal à comprendre les consignes préopératoires",
  ];
  const TAGS = [
    [/urgen|vomit|toxique|chocolat|litière|signes/i, "Triage"],
    [/veut dire|signifie|qu'est-ce|différence|«/i, "Lexique"],
    [/vétérinaire|technicien|message|interrompre/i, "Équipe clinique"],
    [/deuil|euthanasie|pleure|décès/i, "Moment délicat"],
    [/.*/, "Client"],
  ];
  const TAGS_TSA = [
    [/urgen|alerter|immédiat|intoxic|transfusion/i, "Sécurité"],
    [/transmission|sbar|transmettre/i, "Transmission"],
    [/veut dire|signifie|qu'est-ce|différence|«/i, "Lexique clinique"],
    [/surveill|paramètre|réveil|fluido|perfusion|calcul|douleur/i, "Surveillance"],
    [/client/i, "Explication au client"],
    [/.*/, "Procédure"],
  ];
  const SCENARIOS_TSA = [
    "un chat hospitalisé dont la fréquence respiratoire augmente pendant la nuit",
    "un chien au réveil d'une anesthésie qui reste hypotherme",
    "un patient sous fluidothérapie dont le cathéter semble infiltré",
    "un vétérinaire qui te demande une transmission rapide avant sa chirurgie",
    "un client qui comprend mal les consignes post-opératoires déjà validées",
    "une ordonnance où une donnée manque pour vérifier un débit de perfusion",
    "un chien admis pour vomissements dont l'anamnèse est incomplète",
    "un patient diabétique hospitalisé avec une glycémie inattendue",
    "la préparation d'une salle pour un nettoyage dentaire sous anesthésie",
    "un collègue qui veut donner un médicament sans ordonnance écrite",
  ];
  let role = "reception";
  const isTsa = () => role === "tsa";
  const RP = () => (isTsa() ? cfg.tsa || {} : cfg);
  const isNarrow = () => matchMedia("(max-width: 520px)").matches;
  const basePH = () => (isTsa() ? (isNarrow() ? "Le cas ou la tâche…" : "Décrivez le cas ou la tâche…") : (isNarrow() ? "Votre question…" : "Posez votre question ici…"));
  const tagFor = (t) => (isTsa() ? TAGS_TSA : TAGS).find(([re]) => re.test(t))[1];

  let cfg = { name: "Assistant La Qualia", examples: [] };
  let turns = [];
  let inScenario = false;
  let running = Promise.resolve();
  const MODEL_LABELS = { quick: ["Rapide", "Haiku"], default: ["Standard", "Sonnet"], complex: ["Approfondi", "Opus"] };
  let tier = store.get("lq-tier") || "";
  let ctl = null;
  let code = store.get("lq-agent-code") || "";
  let prenom = store.get("lq-prenom") || "";
  let needsCode = true;
  // Portail par compte (laqualia.com) : session + établissement validé remplacent les codes d'équipe, TSA et Admin.
  // Ailleurs (miroir GitHub Pages, essais locaux), l'ancien accès par code reste en place.
  const ACCOUNT_HOST = /(^|\.)laqualia\.(com|test)$/i.test(location.hostname);
  let accountMode = false, account = null;
  function leavePortal(status, why) {
    const dest = status === 401
      ? "acces.html"
      : why === "account_deactivated" ? "compte.html#profil" : "acces.html" + (why === "membership_disabled" ? "?raison=retire" : "");
    location.replace(dest);
  }
  // Tous les appels au relais passent ici. En mode compte : témoin de session, en-tête anti-CSRF, aucun code.
  function apiFetch(opts = {}) {
    if (!accountMode) return fetch(cfg.apiUrl, opts);
    const h = { ...(opts.headers || {}) };
    delete h["x-agent-code"]; delete h["x-tsa-code"];
    if ((opts.method || "GET") !== "GET") h["x-lq-csrf"] = "1";
    return fetch(cfg.apiUrl, { ...opts, headers: h, credentials: "same-origin" }).then(async (r) => {
      if (r.status === 401 || r.status === 403) {
        let d = {}; try { d = await r.clone().json(); } catch {}
        // Accès retiré ou session terminée pendant la navigation : on quitte le portail aussitôt.
        if (r.status === 401 || ["no_access", "membership_disabled", "account_deactivated"].includes(d.code)) leavePortal(r.status, d.code);
      }
      return r;
    });
  }
  const cleanName = (v) => String(v || "").replace(/[^\p{L}\p{M}' -]/gu, "").replace(/\s+/g, " ").trim().slice(0, 30);
  function showName() {
    $("helloName").textContent = prenom ? " " + prenom : "";
    $("userName").textContent = prenom || "Invité";
    try { renderHistory(); } catch {}
  }
  let shown = new Set();
  try { shown = new Set(JSON.parse(store.get("lq-shown") || "[]")); } catch {}

  /* ---------- exemples qui tournent ---------- */
  function pool() { const ex = RP().examples || []; return (Array.isArray(ex) ? ex : String(ex).split("\n")).map((s) => String(s).trim()).filter(Boolean); }
  function pickExamples(n, filter) {
    const all = filter ? pool().filter(filter) : pool();
    let fresh = all.filter((t) => !shown.has(t));
    if (fresh.length < n) { all.forEach((t) => shown.delete(t)); fresh = all.slice(); }
    for (let i = fresh.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [fresh[i], fresh[j]] = [fresh[j], fresh[i]]; }
    const out = fresh.slice(0, n);
    out.forEach((t) => shown.add(t));
    store.set("lq-shown", JSON.stringify([...shown]));
    return out;
  }
  const TSA_TOOLS = [
    ["Transmission au vétérinaire", "Structurer un SBAR clair", '<path d="M4 5h16v11H8l-4 4z"/><path d="M8 9h8M8 12h5"/>',
      "Aide-moi à préparer une transmission au vétérinaire (format SBAR).\nPatient (fictif ou dépersonnalisé) : \nSituation : \nContexte et antécédents connus : \nObservations et signes vitaux : \nCe que je demande au vétérinaire : "],
    ["Note clinique", "Faits, dossier, à confirmer", '<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6M8 13h8M8 17h5"/>',
      "Aide-moi à structurer une note clinique à faire valider.\nType de note (admission, soins, surveillance, congé) : \nFaits observés : \nDonnées du dossier : \nÉléments à confirmer : "],
    ["Consultation d'un protocole", "Ce que prévoit l'établissement", '<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20V3H6.5A2.5 2.5 0 0 0 4 5.5z"/><path d="M9 7h7M9 11h5"/>',
      "Que prévoit le protocole de l'établissement pour : "],
    ["Surveillance et observations", "Liste de vérification", '<path d="M3 12h4l3-8 4 16 3-8h4"/>',
      "Prépare une liste de surveillance à partir des protocoles approuvés.\nType de patient ou procédure : \nConsignes et fréquence demandées par le vétérinaire : "],
    ["Explication au client", "Consignes déjà validées", '<path d="M21 12a8 8 0 0 1-11.6 7.1L4 20.5l1.4-4.9A8 8 0 1 1 21 12z"/>',
      "Aide-moi à expliquer au client des consignes déjà validées par le vétérinaire.\nConsignes validées : \nContexte du client : "],
    ["Formation et simulation", "Cas fictif avec quiz", '<path d="M22 10 12 5 2 10l10 5 10-5z"/><path d="M6 12v5c3 2 9 2 12 0v-5"/>', null],
  ];
  function renderWelcomeCards() {
    const el = $("examples"); el.textContent = "";
    if (isTsa()) {
      // Première tuile : outil Nutrition (couleur propre), qui active le mode Nutrition dans la conversation
      const nt = document.createElement("button"); nt.type = "button"; nt.className = "card tool nutri-tool"; nt.setAttribute("data-open-nutri", ""); nt.setAttribute("aria-pressed", "false");
      nt.innerHTML = '<span class="tl-ico"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 11h18a9 9 0 0 1-18 0Z"/><path d="M8 7c0-1.5 1-2 1-3.5M12 7c0-1.5 1-2 1-3.5M16 7c0-1.5 1-2 1-3.5"/></svg></span><span class="tl-t"><b>Nutrition &amp; produits</b></span>';
      el.append(nt);
      try { window.LQNutrition && window.LQNutrition.syncTile(); } catch {}
      TSA_TOOLS.forEach(([t, sub, ico, tpl]) => {
        const b = document.createElement("button"); b.type = "button"; b.className = "card tool";
        b.innerHTML = `<span class="tl-ico"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ico}</svg></span><span class="tl-t"><b>${esc(t)}</b><small>${esc(sub)}</small></span>`;
        b.onclick = () => {
          if (!tpl) { startScenario(); return; }
          hideCarry();
          const q = $("q"); q.value = tpl; autosize(); q.focus();
          const firstBlank = tpl.indexOf(" : \n"); const pos = firstBlank > 0 ? firstBlank + 3 : tpl.length;
          try { q.setSelectionRange(pos, pos); } catch {}
        };
        el.append(b);
      });
      return;
    }
    const t = document.createElement("button");
    t.type = "button"; t.className = "card train";
    t.innerHTML = '<span class="tag">Entraînement</span>Me mettre en situation d\'appel';
    t.onclick = startScenario; el.append(t);
    // Toujours une question de lexique parmi les suggestions, à une place qui varie
    const isLex = (q) => tagFor(q) === "Lexique";
    const picks = [...pickExamples(1, isLex), ...pickExamples(2, (q) => !isLex(q))];
    const at = Math.floor(Math.random() * 3);
    picks.splice(at, 0, picks.shift());
    picks.forEach((q) => {
      const b = document.createElement("button");
      b.type = "button"; b.className = "card";
      const tag = document.createElement("span"); tag.className = "tag"; tag.textContent = tagFor(q);
      b.append(tag, document.createTextNode(q));
      b.onclick = () => send(q);
      el.append(b);
    });
  }
  function renderSideList() {
    const el = $("sideExamples"); el.textContent = "";
    pickExamples(6).forEach((q) => {
      const b = document.createElement("button");
      b.type = "button"; b.className = "side-item";
      b.innerHTML = '<span class="bullet"></span>';
      b.append(document.createTextNode(q));
      b.onclick = () => { closeMenu(); send(q); };
      el.append(b);
    });
  }
  function chipsInto(el, list) {
    list.forEach((t) => {
      const b = document.createElement("button");
      b.className = "chip"; b.type = "button"; b.textContent = t;
      b.onclick = () => send(t);
      el.append(b);
    });
  }
  const SCENE_FORMAT = "\n\n(Format MISE EN SITUATION : contexte en 2-3 phrases, réplique du client entre guillemets, puis un bloc ```quiz en JSON valide avec 2 ou 3 questions de type \"choix\" ou \"vraifaux\", chacune avec \"bonne\" et \"explication\". N'utilise pas [EN DIRECT] ni [APPRENTISSAGE].)";
  const SCENE_FORMAT_TSA = "\n\n(Format MISE EN SITUATION TSA : commence par « Cas fictif », donne les données fournies par le scénario en liste courte, puis la demande du vétérinaire, du client ou du collègue. Ne donne pas les informations que l'apprenant devrait demander. Termine par un bloc ```quiz en JSON valide avec 2 ou 3 questions de type \"choix\" ou \"vraifaux\", chacune avec \"bonne\" et \"explication\" ; signale dans les explications ce qui exige le vétérinaire. N'utilise ni [EN DIRECT], ni [APPRENTISSAGE], ni le format en trois sections.)";
  const sceneFormat = () => (isTsa() ? SCENE_FORMAT_TSA : SCENE_FORMAT);
  function startScenario() {
    closeMenu();
    hideCarry();
    inScenario = true;
    const list = RP().scenarios?.length ? RP().scenarios : isTsa() ? SCENARIOS_TSA : SCENARIOS;
    const sc = list[Math.floor(Math.random() * list.length)];
    const label = isTsa() ? `Mets-moi en situation : je suis TSA et je gère ${sc}.` : `Mets-moi en situation : je suis à la réception et je reçois un appel de ${sc}.`;
    send(label + sceneFormat(), label);
  }

  /* ---------- config ---------- */
  // Monogramme de l'établissement (sans logo) : initiales des mots distinctifs du nom
  const MONO_SKIP = new Set(["clinique", "hopital", "hôpital", "veterinaire", "vétérinaire", "vet", "centre", "de", "du", "des", "la", "le", "les", "et", "l", "d", "animalier", "animaux"]);
  function monogram(name) {
    const words = String(name || "").split(/[\s\-’']+/).filter(Boolean);
    const keep = words.filter((w) => !MONO_SKIP.has(w.toLowerCase()));
    const src = (keep.length ? keep : words).slice(0, 2);
    return src.map((w) => w[0]).join("").toUpperCase() || "?";
  }
  // Ajout du logo : proposé seulement à qui peut le modifier
  function setLogoEdit(href) {
    const m = $("orgMono");
    if (href) { m.href = href; m.classList.add("can-edit"); m.title = "Ajouter le logo de l'établissement"; m.setAttribute("aria-label", "Ajouter le logo de l'établissement"); m.removeAttribute("aria-hidden"); m.tabIndex = 0; }
    else { m.removeAttribute("href"); m.classList.remove("can-edit"); m.removeAttribute("title"); m.setAttribute("aria-hidden", "true"); m.tabIndex = -1; }
  }
  function applyCfg() {
    $("agentName").textContent = cfg.name || "Assistant La Qualia";
    $("orgName").textContent = cfg.etablissement || "Nom de votre établissement";
    $("orgMonoTxt").textContent = monogram(cfg.etablissement);
    // Logo de l'établissement (si l'image ne se charge pas, on garde l'icône)
    const lg = $("orgLogo"), lb = $("orgLogoBox");
    if (cfg.logo && lg.getAttribute("src") !== cfg.logo) {
      lg.onload = () => { lb.hidden = false; document.body.classList.add("has-logo"); };
      lg.onerror = () => { lb.hidden = true; document.body.classList.remove("has-logo"); };
      lg.alt = "Logo " + (cfg.etablissement || "");
      lg.src = cfg.logo;
    } else if (!cfg.logo) { lb.hidden = true; document.body.classList.remove("has-logo"); }
    $("agentTag").textContent = cfg.tag || "";
    $("disclaimerText").textContent = RP().disclaimer || cfg.disclaimer || "";
    $("disclaimer").hidden = !$("disclaimerText").textContent;
    if (cfg.name) document.title = isTsa() ? (RP().name || cfg.name) : cfg.name;
    renderWelcomeCards();
    renderSideList();
    renderModels();
  }
  function allowedTiers() {
    const src = Array.isArray(RP().modelesProposes) && RP().modelesProposes.length ? RP().modelesProposes : cfg.modelesProposes;
    const list = Array.isArray(src) ? src.filter((t) => MODEL_LABELS[t]) : [];
    const def = RP().tier || cfg.tier;
    return list.length ? list : [MODEL_LABELS[def] ? def : "default"];
  }
  function renderModels() {
    const list = allowedTiers();
    if (!list.includes(tier)) tier = list.includes(cfg.tier) ? cfg.tier : list[0];
    const seg = $("modelSeg"); seg.textContent = ""; seg.style.setProperty("--n", list.length);
    list.forEach((t) => {
      const b = document.createElement("button");
      b.type = "button"; b.className = "model-opt"; b.setAttribute("role", "radio");
      b.setAttribute("aria-checked", String(t === tier));
      b.innerHTML = `<b>${MODEL_LABELS[t][0]}</b><span>${MODEL_LABELS[t][1]}</span>`;
      b.onclick = () => { tier = t; store.set("lq-tier", t); renderModels(); };
      seg.append(b);
    });
    $("modelWrap").hidden = true; // le choix du modèle reste dans le menu en haut à droite
    const badge = $("modelBadge");
    badge.hidden = list.length < 2;
    badge.innerHTML = `<span class="mb-l">Réponse :</span> ${MODEL_LABELS[tier][0]}`;
    badge.setAttribute("aria-label", `Modèle de réponse : ${MODEL_LABELS[tier][0]} (${MODEL_LABELS[tier][1]}). Changer`);
    const pop = $("modelPop"); pop.textContent = "";
    const lab = document.createElement("div"); lab.className = "mp-lab"; lab.textContent = "Modèle de réponse"; pop.append(lab);
    const DESC = { quick: "Le plus vif, idéal pendant un appel", default: "Équilibre vitesse et profondeur", complex: "Le plus réfléchi, un peu plus lent" };
    list.forEach((t) => {
      const o = document.createElement("button"); o.type = "button"; o.className = "mp-opt"; o.setAttribute("role", "menuitemradio");
      o.setAttribute("aria-checked", String(t === tier));
      o.innerHTML = `<span class="mp-t"><b>${MODEL_LABELS[t][0]} · ${MODEL_LABELS[t][1]}</b><small>${DESC[t]}</small></span><span class="mp-ck" aria-hidden="true"></span>`;
      o.onclick = () => { tier = t; store.set("lq-tier", t); renderModels(); closePop(); $("modelBadge").focus(); };
      pop.append(o);
    });
  }
  function setStatus(kind, text) {
    $("status").className = "status " + kind;
    $("kbInfo").textContent = text;
  }

  /* ---------- réponse en deux parties : En direct + Apprentissage ---------- */
  // Marqueurs tolérants : [EN DIRECT], **EN DIRECT**, ### En direct :, 🟩 EN DIRECT…, seuls sur leur ligne
  const MARK = (w) => new RegExp("^[ \\t>#*_\\[(\\-–—🟩🟪⚡📘]*" + w + "[ \\t\\]*_):—–-]*$", "im");
  const LIVE_RE = MARK("en\\s+direct");
  const LEARN_RE = MARK("apprentissage");
  const SVG_BOLT = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M13 2 4 14h7l-1 8 9-12h-7z"/></svg>';
  const SVG_PHONE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2"/></svg>';
  const SVG_BOOK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20V3H6.5A2.5 2.5 0 0 0 4 5.5z"/><path d="M4 19.5A2.5 2.5 0 0 0 6.5 22H20v-5"/></svg>';
  // Phrases qui parlent de la documentation ou renvoient au responsable « par défaut » : jamais dans le vert
  const DOC_RE = /\bdocument(ation)?s?\b|consignes? internes?|procédures? (interne|de la clinique|de l'établissement)|politique (interne|de la clinique)|règles? (précise|interne)|aucune? (consigne|procédure|information|politique|directive|règle)|repères? généra|conseils? généra|en cas de doute|vérifie[rz]? avec (votre|le|la|vos)\s+(responsable|gestionnaire|superviseur|supérieur|vétérinaire)|^\s*(\*\*)?à noter\b/i;
  const isHeadingOnly = (p) => /^\s*(#{1,4}\s+.*|\*\*[^*]+\*\*\s*:?)\s*$/.test(p.trim());
  function cleanLive(live, learn) {
    const notes = [];
    const kept = [];
    for (const para of live.split(/\n\s*\n/)) {
      // Retire aussi un marqueur répété par le modèle ([EN DIRECT], [APPRENTISSAGE]) qui n'a rien à faire à l'écran
      const lines = para.split("\n").filter((l) => !/^\s*#{1,4}\s+/.test(l) && !LIVE_RE.test(l) && !LEARN_RE.test(l));
      const keptLines = [];
      for (const line of lines) {
        if (!line.trim()) continue;
        const sentences = line.split(/(?<=[.!?…»])\s+(?=\S)/);
        sentences.filter((x) => DOC_RE.test(x)).forEach((x) => notes.push(x.trim()));
        const ok = sentences.filter((x) => !DOC_RE.test(x)).join(" ").trim();
        if (ok && !/^\s*([-*•]|\d+[.)])\s*$/.test(ok)) keptLines.push(ok);
      }
      if (keptLines.length) kept.push(keptLines.join("\n"));
    }
    let out = kept.join("\n\n");
    let l = learn;
    // Si le vert est vide après nettoyage, on reprend l'essentiel du début de l'Apprentissage
    if (!out && l) {
      const first = l.split(/\n\s*\n/).map((x) => x.replace(/^\s*#{1,4}\s+/gm, "").trim()).find((x) => x && !DOC_RE.test(x));
      if (first) out = first.split("\n").slice(0, 3).join("\n");
    }
    if (notes.length && l !== null) l = (l ? l + "\n\n" : "") + "_Note : " + notes.join(" ").replace(/\*\*/g, "").replace(/^à noter\s*:\s*/i, "") + "_";
    return { live: out, learn: l };
  }
  function splitAnswer(text, done) {
    const m = text.match(LIVE_RE);
    let r;
    if (!m) {
      // un marqueur est peut-être en train d'arriver : on attend un peu avant d'afficher
      if (!done && text.trim().length < 40 && !/\n/.test(text.trim())) return { pending: true };
      if (inScenario && !LEARN_RE.test(text)) return { plain: text };
      const lm = text.match(LEARN_RE);
      if (lm) r = { live: text.slice(0, lm.index).trim(), learn: text.slice(lm.index + lm[0].length).trim() };
      else {
        // filet de sécurité : 1er vrai paragraphe (ni titre, ni mention de la documentation) = En direct
        const parts = text.trim().split(/\n\s*\n/);
        const skipped = [];
        while (parts.length > 1 && (isHeadingOnly(parts[0]) || DOC_RE.test(parts[0]))) skipped.push(parts.shift());
        if (parts.length < 2 && done) return { plain: text };
        r = { live: parts[0] || "", learn: parts.length > 1 ? parts.slice(1).join("\n\n") : (done ? "" : null) };
        const docNotes = skipped.filter((x) => DOC_RE.test(x)).map((x) => x.replace(/^\s*#{1,4}.*\n?/gm, "").trim()).filter(Boolean);
        if (docNotes.length && r.learn !== null) r.learn = (r.learn ? r.learn + "\n\n" : "") + "_Note : " + docNotes.join(" ") + "_";
      }
    } else {
      const after = text.slice(m.index + m[0].length);
      const lm = after.match(LEARN_RE);
      r = lm ? { live: after.slice(0, lm.index).trim(), learn: after.slice(lm.index + lm[0].length).trim() } : { live: after.trim(), learn: null };
    }
    if (r.learn) r.learn = r.learn.split("\n").filter((l) => !LIVE_RE.test(l) && !LEARN_RE.test(l)).join("\n").trim();
    const out = cleanLive(r.live, r.learn);
    // Hors périmètre ou question de clarification : pas de réponse complète
    if (out.learn !== null && /^\s*\[?\s*SANS APPRENTISSAGE\s*\]?/i.test(out.learn)) { out.learn = null; out.noLearn = true; }
    else if (out.learn && out.learn.trim().length < 22 && "[SANS APPRENTISSAGE]".startsWith(out.learn.trim().toUpperCase())) { out.learn = ""; if (done) { out.learn = null; out.noLearn = true; } }
    return out;
  }


  function renderAnswer(body, text, done) {
    mdDone = !!done;
    renderAnswerInner(body, text, done);
    if (done) hydrateQuizzes(body);
    fitPreview(body);
  }
  // Aperçu de l'Apprentissage : on montre le début, la suite se déroule sur demande
  function fitPreview(body) {
    const sec = body.querySelector(".box-learn:not(.waiting)"); if (!sec) return;
    const bd = sec.querySelector(".box-body"); const more = sec.querySelector(".more"); if (!bd || !more) return;
    const long = sec.classList.contains("is-open") || bd.scrollHeight > bd.clientHeight + 8;
    more.hidden = !long;
    sec.classList.toggle("is-short", !long);
  }
  const SVG_STETH = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 3v6a4 4 0 0 0 8 0V3"/><path d="M10 13v3a5 5 0 0 0 10 0v-2"/><circle cx="20" cy="12" r="2"/></svg>';
  // Réponse TSA : un seul encadré, sections et statuts documentaires mis en évidence
  function tsaHtml(text) {
    let h = md(text)
      .replace(/<li>\[\s?\]\s*/g, '<li class="task">')
      .replace(/<strong>\s*(Vérifié dans la source)\s*<\/strong>/gi, '<span class="st st-ok">$1</span>')
      .replace(/<strong>\s*(Général)\s*<\/strong>/g, '<span class="st st-gen">$1</span>')
      .replace(/<strong>\s*(À confirmer)\s*<\/strong>/g, '<span class="st st-check">$1</span>')
      .replace(/<strong>\s*(Validation vétérinaire requise)\s*<\/strong>/gi, "$1")
      .replace(/Validation vétérinaire requise/g, '<span class="st st-vet">Validation vétérinaire requise</span>')
      .replace(/<h3>([^<]*(vérifier|validation)[^<]*)<\/h3>/i, '<h3 class="h-check">$1</h3>')
      .replace(/<h3>([^<]*sources?[^<]*)<\/h3>/i, '<h3 class="h-src">$1</h3>');
    return enhance(h);
  }
  function renderAnswerInner(body, text, done) {
    if (isTsa() && !inScenario) {
      body.dataset.live = "";
      body.innerHTML = `<section class="box-tsa" aria-label="Soutien clinique"><div class="box-head">${SVG_STETH}Soutien clinique<span class="bh-note">À valider par l'équipe vétérinaire</span></div><div class="box-body">${text.trim() ? tsaHtml(text) : '<span class="skel"></span><span class="skel short"></span>'}</div></section>`;
      return;
    }
    const p = splitAnswer(text, done);
    if (p.pending) return;
    if (p.plain !== undefined) {
      body.dataset.live = "";
      body.innerHTML = inScenario
        ? `<section class="box-learn box-scene"><div class="box-head">${isTsa() ? SVG_STETH : SVG_PHONE}Mise en situation${isTsa() ? " · cas fictif" : ""}</div><div class="box-body">${md(p.plain)}</div></section>`
        : md(p.plain);
      return;
    }
    body.dataset.live = p.live;
    const open = body.dataset.open === "1";
    const skel = '<span class="skel"></span><span class="skel short"></span>';
    const liveHtml = p.live ? enhance(md(p.live)) : skel;
    const copyBtn = done && p.live ? `<button type="button" class="bh-act" data-act="copy-live">${SVG_COPY}<span>Copier</span></button>` : "";
    let html = `<section class="box-live" aria-label="Réponse courte"><div class="box-head"><span class="bh-l">${SVG_BOLT}Réponse courte</span><span class="bh-hint">À dire maintenant</span>${copyBtn}</div><div class="box-body">${liveHtml}</div></section>`;
    if (p.noLearn || p.pendingFlag) { body.innerHTML = html.replace('<span class="bh-hint">À dire maintenant</span>', ""); body.classList.add("scope-only"); return; }
    if (p.learn !== null && (p.learn || !done)) {
      const words = (p.learn || "").split(/\s+/).filter(Boolean).length;
      const meta = done && words ? `≈ ${Math.max(1, Math.round(words / 200))} min de lecture` : (p.learn ? "Rédaction…" : "En préparation…");
      html += `<section class="box-learn pv${open ? " is-open" : ""}" aria-label="Réponse complète (apprentissage)"><button type="button" class="box-head bh-toggle" data-act="toggle-learn" aria-expanded="${open}"><span class="bh-l">${SVG_BOOK}Réponse complète <span class="bh-sub">(apprentissage)</span></span><span class="bh-meta">${meta}</span><svg class="bh-chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg></button><div class="box-body">${p.learn ? enhance(md(p.learn)) : skel + skel}</div><button type="button" class="more" data-act="toggle-learn" hidden><span>${open ? "Réduire" : "Lire la réponse complète"}</span><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg></button></section>`;
    } else if (!done) {
      html += `<section class="box-learn waiting"><div class="box-head"><span class="bh-l">${SVG_BOOK}Réponse complète <span class="bh-sub">(apprentissage)</span></span><span class="bh-meta">En préparation…</span></div><div class="box-body">${skel}${skel}</div></section>`;
    }
    body.innerHTML = html;
  }
  // Mise en valeur : phrases à dire (« … ») et ligne « À retenir »
  function enhance(html) {
    return html
      .replace(/«([^»<]{3,400})»/g, '<q class="say">«$1»</q>')
      .replace(/<p>(<strong>)?\s*À retenir\s*(<\/strong>)?\s*:?\s*/g, '<p class="keep"><span class="keep-l">À retenir</span> ')
      .replace(/<p><em>Note : /g, '<p class="note"><em>Note : ');
  }

  /* ---------- mini-quiz (mises en situation seulement) ---------- */
  const QUIZZES = [];
  let mdDone = true;
  const unesc = (s) => s.replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
  function quizHtml(raw, closed) {
    if (!closed || !mdDone) return '<div class="quiz quiz-wait"><span class="typing"><i></i><i></i><i></i></span> Préparation du quiz…</div>';
    let data = null;
    try { data = JSON.parse(unesc(raw)); } catch {}
    const qs = Array.isArray(data?.questions) ? data.questions.filter((q) => q && q.question) : [];
    if (!qs.length) return "";
    QUIZZES.push(qs);
    return `<div class="quiz" data-quiz="${QUIZZES.length - 1}"></div>`;
  }
  function hydrateQuizzes(root) {
    root.querySelectorAll(".quiz[data-quiz]").forEach((el) => {
      const qs = QUIZZES[+el.dataset.quiz]; if (!qs) return;
      el.removeAttribute("data-quiz");
      const results = new Array(qs.length).fill(null);
      const head = document.createElement("div"); head.className = "qz-head";
      head.innerHTML = `<b>Quiz</b><span>${qs.length} question${qs.length > 1 ? "s" : ""} · réponse immédiate</span>`;
      el.append(head);
      qs.forEach((q, i) => {
        const vf = q.type === "vraifaux" || typeof q.bonne === "boolean";
        const opts = vf ? ["Vrai", "Faux"] : (Array.isArray(q.options) ? q.options.map(String) : []);
        const good = vf ? (q.bonne === true || q.bonne === "true" ? 0 : 1) : Number(q.bonne);
        const item = document.createElement("div"); item.className = "qz-item";
        const tag = document.createElement("span"); tag.className = "qz-tag"; tag.textContent = vf ? "Vrai ou faux" : "Choix de réponse";
        const qq = document.createElement("p"); qq.className = "qz-q"; qq.textContent = `${i + 1}. ${q.question}`;
        const box = document.createElement("div"); box.className = "qz-opts" + (vf ? " vf" : "");
        const fb = document.createElement("div"); fb.className = "qz-fb"; fb.hidden = true;
        opts.forEach((o, k) => {
          const b = document.createElement("button"); b.type = "button"; b.className = "qz-opt";
          b.innerHTML = vf ? "" : `<i>${String.fromCharCode(65 + k)}</i>`;
          b.append(document.createTextNode(o));
          b.onclick = () => {
            const ok = k === good;
            results[i] = ok;
            box.querySelectorAll("button").forEach((x, j) => { x.disabled = true; if (j === good) x.classList.add("good"); });
            if (!ok) b.classList.add("bad");
            item.classList.add(ok ? "is-good" : "is-bad");
            fb.hidden = false;
            fb.innerHTML = `<b>${ok ? "✓ Bonne réponse." : "✗ Pas tout à fait."}</b> `;
            fb.append(document.createTextNode(String(q.explication || "")));
            if (results.every((r) => r !== null)) finish();
          };
          box.append(b);
        });
        item.append(tag, qq, box, fb);
        el.append(item);
      });
      const foot = document.createElement("div"); foot.className = "qz-foot"; foot.hidden = true;
      el.append(foot);
      function finish() {
        const n = results.filter(Boolean).length;
        foot.hidden = false;
        foot.innerHTML = `<div class="qz-score"><b>${n} / ${results.length}</b><span>${n === results.length ? "Parfait, bravo !" : n ? "Bon travail, continuez !" : "On révise et on recommence !"}</span></div>`;
        const go = document.createElement("button"); go.type = "button"; go.className = "qz-next"; go.textContent = "Continuer l'appel";
        go.onclick = () => {
          const detail = qs.map((q, i) => `Q${i + 1} ${results[i] ? "réussie" : "manquée"}`).join(", ");
          send(`Résultats du quiz : ${n}/${results.length} (${detail}). Continue la mise en situation.` + sceneFormat(), `Continuer l'appel · ${n}/${results.length}`);
        };
        const nw = document.createElement("button"); nw.type = "button"; nw.className = "qz-new"; nw.textContent = "Nouvelle mise en situation";
        nw.onclick = startScenario;
        foot.append(go, nw);
        foot.scrollIntoView({ block: "nearest", behavior: "smooth" });
      }
    });
  }

  // Accès contrôlé pour les modules d'appoint (outil Nutrition de l'espace TSA)
  window.LQAgent = {
    md: (t) => md(t), esc: (t) => esc(String(t ?? "")),
    post: (body, signal) => apiFetch({ method: "POST", headers: authHeaders(), body: JSON.stringify(body), signal }),
    prenom: () => prenom, tier: () => tier, isTsa: () => isTsa(), ready: () => !!cfg.apiUrl,
    // Fil de conversation partagé : l'outil Nutrition répond dans la même conversation, sans autre fenêtre
    chat: {
      addQuestion: (t) => addQuestion(t), addAnswer: () => addAnswer(), toTopOf: (el) => toTopOf(el),
      remember: (q, a, extra) => remember(q, q, a, [], extra), autosize: () => autosize(),
      favAttach: (acts, item) => favAttach(acts, item),
      begin: async () => {
        if (ctl) { ctl.abort(); await running; }
        ctl = new AbortController(); const my = ctl;
        let release; running = new Promise((r) => (release = r));
        busy(true);
        return { signal: my.signal, end: () => { if (ctl === my) ctl = null; busy(false); release(); } };
      },
    },
  };

  /* ---------- markdown ---------- */
  function md(src) {
    const lines = esc(src).split("\n"); const out = []; let list = null;
    const inline = (s) => s.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>").replace(/(^|[^*])\*(?!\s)(.+?)\*/g, "$1<em>$2</em>").replace(/(^|\W)_(?!\s)(.+?)_(?=\W|$)/g, "$1<em>$2</em>").replace(/`([^`]+)`/g, "<code>$1</code>");
    const close = () => { if (list) { out.push(`</${list}>`); list = null; } };
    let fence = null, fenceLang = "";
    const flush = (closed) => {
      if (fenceLang === "quiz" || /^\s*\{\s*&quot;questions&quot;/.test(fence.join(""))) {
        out.push(quizHtml(fence.join("\n"), closed));
      } else {
        const body = fence.join("\n").replace(/→|-&gt;/g, '<b class="arr">→</b>');
        out.push(`<figure class="schema"><figcaption>Schéma</figcaption><pre>${body}</pre></figure>`);
      }
      fence = null;
    };
    for (const l of lines) {
      let m;
      if (/^\s*```/.test(l)) { if (fence) flush(true); else { close(); fence = []; fenceLang = l.trim().slice(3).trim().toLowerCase(); } continue; }
      if (fence) { fence.push(l); continue; }
      if ((m = l.match(/^#{1,4}\s+(.*)/))) { close(); out.push(`<h3>${inline(m[1])}</h3>`); }
      else if ((m = l.match(/^\s*[-*•]\s+(.*)/))) { if (list !== "ul") { close(); out.push("<ul>"); list = "ul"; } out.push(`<li>${inline(m[1])}</li>`); }
      else if ((m = l.match(/^\s*\d+[.)]\s+(.*)/))) { if (list !== "ol") { close(); out.push("<ol>"); list = "ol"; } out.push(`<li>${inline(m[1])}</li>`); }
      else if (!l.trim()) close();
      else { close(); out.push(`<p>${inline(l)}</p>`); }
    }
    if (fence) flush(false);
    close();
    return out.join("");
  }

  /* ---------- messages ---------- */
  const scroller = $("scroller");
  const nearBottom = () => scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 140;
  const toBottom = () => { scroller.scrollTop = scroller.scrollHeight; };
  // Une fois la réponse terminée, on remonte au début de la réponse
  const toTopOf = (el) => {
    const z = parseFloat(getComputedStyle(document.body).zoom) || 1; // zoom grand écran
    const top = (el.getBoundingClientRect().top - scroller.getBoundingClientRect().top) / z + scroller.scrollTop - 12;
    scroller.scrollTo({ top: Math.max(0, top), behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
  };

  function addQuestion(text) {
    $("empty").hidden = true;
    const m = document.createElement("div"); m.className = "msg q";
    const b = document.createElement("div"); b.className = "qbub"; b.textContent = text;
    m.append(b); $("thread").append(m); toBottom();
    return m;
  }
  function addAnswer() {
    const m = document.createElement("div"); m.className = "msg a";
    const av = document.createElement("div"); av.className = "av"; av.innerHTML = `<img src="${avatarSrc()}" alt="">`;
    const col = document.createElement("div"); col.className = "a-col";
    const who = document.createElement("div"); who.className = "who";
    who.innerHTML = `<span></span><time>${new Date().toLocaleTimeString("fr-CA", { hour: "2-digit", minute: "2-digit" })}</time>`;
    who.firstChild.textContent = cfg.name || "Assistant";
    const body = document.createElement("div"); body.className = "body";
    body.innerHTML = '<span class="thinking-line"><span class="typing" aria-hidden="true"><i></i><i></i><i></i></span>Analyse de la situation…</span>';
    col.append(who, body); m.append(av, col); $("thread").append(m); toBottom();
    return { m, col, body };
  }

  async function send(text, display) {
    const q = String(text ?? $("q").value).trim();
    if (!q) return;
    try { dictCancel(); } catch {}
    // Changement d'idée : on arrête la réponse en cours et on passe à la nouvelle question
    if (ctl) { ctl.abort(); await running; }
    if (/^(mets-moi en situation|résultats du quiz)/i.test(q) || /mise en situation/i.test(q)) inScenario = true;
    $("q").value = ""; autosize();
    hideCarry();
    const qm = addQuestion(display || q);
    const { m, col, body } = addAnswer();
    if (!cfg.apiUrl) { body.innerHTML = '<p class="err">L\'assistant n\'est pas encore activé.</p>'; return; }
    ctl = new AbortController();
    let release; running = new Promise((r) => (release = r));
    busy(true);
    let answer = "";
    // Garde-fou : si plus rien n'arrive pendant 60 s, ou au-delà de 150 s, on coupe (aucune requête figée)
    let timedOut = false;
    const myCtl = ctl;
    const cut = () => { timedOut = true; myCtl.abort(); };
    const totalTimer = setTimeout(cut, 150000);
    let idleTimer = setTimeout(cut, 60000);
    const alive = () => { clearTimeout(idleTimer); idleTimer = setTimeout(cut, 60000); };
    try {
      const res = await apiFetch({
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ question: q, history: turns.slice(-8), tier, prenom, role }),
        signal: ctl.signal,
      });
      if (!res.ok) {
        let msg = "La réponse a échoué. Réessayez.";
        try { msg = (await res.json()).error || msg; } catch {}
        if (res.status === 403 && isTsa()) { tsaDenied(msg); body.innerHTML = `<p class="err">${esc(msg)}</p>`; return; }
        if (res.status === 401) {
          qm.remove(); m.remove();
          if (!$("thread").children.length) $("empty").hidden = false;
          $("q").value = q; autosize(); askCode(true); return;
        }
        if (res.status === 429) {
          const lock = /bloqu/i.test(msg), day = /quotidienne/i.test(msg);
          const ico = lock ? '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>' : '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>';
          const title = lock ? "Accès temporairement bloqué" : day ? "Limite quotidienne atteinte" : "Un instant";
          body.innerHTML = `<div class="alert-card ${lock ? "lock" : ""}"><span class="ac-i"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ico}</svg></span><div><b>${title}</b><p>${esc(msg)}</p></div></div>`;
          return;
        }
        body.innerHTML = `<p class="err">${esc(msg)}</p>`;
        return;
      }
      const reader = res.body.getReader(); const dec = new TextDecoder();
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        alive();
        const first = !answer;
        answer += dec.decode(value, { stream: true });
        renderAnswer(body, answer, false);
        if (first) toTopOf(m); // on montre le début de la réponse, sans faire défiler tout le texte
      }
      renderAnswer(body, answer, true);
      if (!answer.trim()) { body.innerHTML = '<p class="err">Aucune réponse reçue. Réessayez.</p>'; return; }
      turns.push({ role: "user", content: q }, { role: "assistant", content: answer });
      let srcs = []; try { srcs = JSON.parse(decodeURIComponent(res.headers.get("x-agent-sources") || "[]")); } catch {}
      remember(q, display || q, answer, srcs);
      finishAnswer(srcs, col, answer, display || q);
      requestAnimationFrame(() => toTopOf(m));
    } catch (e) {
      if (e.name === "AbortError" && timedOut) {
        if (answer) renderAnswer(body, answer, true); else body.textContent = "";
        body.insertAdjacentHTML("beforeend", '<p class="err">Délai dépassé : la réponse a été arrêtée. Réessayez ou posez une question plus précise.</p>');
        if (answer) { turns.push({ role: "user", content: q }, { role: "assistant", content: answer }); remember(q, display || q, answer, []); }
      } else if (e.name === "AbortError") {
        if (answer) { renderAnswer(body, answer, true); body.insertAdjacentHTML("beforeend", '<p class="stopped">Réponse arrêtée.</p>'); turns.push({ role: "user", content: q }, { role: "assistant", content: answer }); remember(q, display || q, answer, []); }
        else body.innerHTML = '<p class="stopped">Réflexion arrêtée.</p>';
      } else { if (answer) renderAnswer(body, answer, true); else body.textContent = ""; body.insertAdjacentHTML("beforeend", '<p class="err">La connexion a été interrompue. Vérifiez Internet et réessayez.</p>'); }
    } finally {
      clearTimeout(totalTimer); clearTimeout(idleTimer);
      ctl = null; busy(false); release();
    }
  }

  function finishAnswer(sources, col, answer, question) {
    sources = Array.isArray(sources) ? sources : [];
    const cited = sources.filter((t) => typeof t === "string" && answer.includes(t));
    if (cited.length) {
      const s = document.createElement("div"); s.className = "srcs"; s.textContent = "Sources de la clinique : ";
      cited.forEach((t) => { const c = document.createElement("span"); c.className = "src"; c.textContent = t; s.append(c); });
      (col.querySelector(".box-learn") || col).append(s);
    }
    const acts = document.createElement("div"); acts.className = "actions";
    const cp = document.createElement("button"); cp.type = "button"; cp.className = "act";
    cp.innerHTML = SVG_COPY + "<span>Copier toute la réponse</span>";
    cp.onclick = async () => {
      const txt = col.querySelector(".body")?.innerText || answer;
      try { await navigator.clipboard.writeText(txt); cp.querySelector("span").textContent = "Copié ✓"; }
      catch { cp.querySelector("span").textContent = "Copie impossible"; }
      setTimeout(() => { cp.querySelector("span").textContent = "Copier toute la réponse"; }, 2000);
    };
    acts.append(cp); col.append(acts);
    if (question) favAttach(acts, { context: favCtxNow(), question: String(question), answer, sources: cited });

    document.querySelectorAll(".next").forEach((n) => n.remove());
    const nx = document.createElement("div"); nx.className = "next";
    const lab = document.createElement("div"); lab.className = "who"; lab.textContent = "Pour continuer à vous former";
    const ch = document.createElement("div"); ch.className = "chips"; chipsInto(ch, pickExamples(2));
    const tb = document.createElement("button"); tb.className = "chip train"; tb.type = "button"; tb.textContent = "Nouvelle mise en situation"; tb.onclick = startScenario; ch.append(tb);
    nx.append(lab, ch); $("thread").append(nx);
  }

  // Pendant une réponse : bouton Arrêter visible ; si on tape une nouvelle question, Envoyer réapparaît et la remplace
  function busy(on) { updateSend(); }
  function updateSend() {
    const has = !!$("q").value.trim() && !$("q").disabled;
    $("stop").hidden = !ctl;
    $("send").hidden = !!ctl && !has;
    $("send").disabled = !has;
    $("send").title = ctl && has ? "Arrêter et envoyer cette question" : "Envoyer";
  }

  function resetConversation() {
    try { hideCarry(); } catch {}
    if (sim.on) { stopSim(true); closeMenu(); return; }
    ctl?.abort(); turns = []; inScenario = false;
    convId = null; convMsgs = []; renderHistory();
    $("thread").textContent = "";
    $("empty").hidden = false;
    renderWelcomeCards(); renderSideList();
    scroller.scrollTop = 0;
    closeMenu();
    $("q").focus();
  }

  /* ---------- code d'accès ---------- */
  function askCode(invalid, nameOnly) {
    if (accountMode && invalid) return; // en mode compte, un refus mène à la connexion ou à la page d'accès
    $("codebox").hidden = false;
    $("codeErr").hidden = !invalid;
    if (invalid) { code = ""; store.del("lq-agent-code"); }
    const onlyName = nameOnly || (!needsCode) || (!!code && !invalid);
    $("code").hidden = onlyName;
    $("codeIntro").textContent = onlyName
      ? "Comment vous appelez-vous ? Votre prénom sera retenu sur cet appareil pour personnaliser les réponses."
      : "Entrez votre prénom et le code d'accès fourni par votre gestionnaire. Ils seront retenus sur cet appareil.";
    $("prenom").value = prenom;
    setTimeout(() => (prenom && !onlyName ? $("code") : $("prenom")).focus(), 50);
  }
  $("codeForm").addEventListener("submit", (e) => {
    e.preventDefault();
    const n = cleanName($("prenom").value);
    if (!n) { $("prenom").focus(); return; }
    if (!$("code").hidden) {
      const v = $("code").value.trim(); if (!v) { $("code").focus(); return; }
      code = v; store.set("lq-agent-code", code);
    }
    prenom = n; store.set("lq-prenom", prenom); showName();
    $("codebox").hidden = true; $("code").value = "";
    if (!accountMode && fav.loaded) { fav.loaded = false; favInit(); } // mode test : favoris propres au prénom
    if ($("q").value.trim()) send();
    else $("q").focus();
  });
  $("changeName").onclick = () => { closeMenu(); askCode(false, true); };

  /* ---------- menu (téléphone) ---------- */
  function openMenu() { $("app").classList.add("open"); }
  function closeMenu() { $("app").classList.remove("open"); }
  $("menuBtn").onclick = openMenu;
  function openPop() { $("modelPop").hidden = false; $("modelBadge").setAttribute("aria-expanded", "true"); $("modelPop").querySelector('[aria-checked="true"]')?.focus(); }
  function closePop() { $("modelPop").hidden = true; $("modelBadge").setAttribute("aria-expanded", "false"); }
  $("modelBadge").onclick = (e) => { e.stopPropagation(); $("modelPop").hidden ? openPop() : closePop(); };
  document.addEventListener("click", (e) => { if (!e.target.closest(".mp-wrap")) closePop(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !$("modelPop").hidden) { closePop(); $("modelBadge").focus(); } });
  $("closeMenu").onclick = closeMenu;
  $("scrim").onclick = closeMenu;
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") { if ($("app").classList.contains("open")) closeMenu(); else if (sim.ringing) declineCall(); else ctl?.abort(); } });

  /* ---------- branchements ---------- */
  function autosize() { const t = $("q"); t.style.height = "auto"; t.style.height = Math.min(t.scrollHeight, 180) + "px"; updateSend(); }
  $("q").addEventListener("input", autosize);
  // En mode Nutrition (TSA), la question part vers l'outil Nutrition, dans la même conversation
  const submitQ = () => (sim.on ? simReply() : window.LQNutrition && window.LQNutrition.active() ? window.LQNutrition.send() : send());
  $("q").addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); submitQ(); } });
  $("form").addEventListener("submit", (e) => { e.preventDefault(); submitQ(); });
  $("stop").onclick = () => ctl?.abort();
  $("sideTrain").onclick = startScenario;

  /* =====================================================================
     HISTORIQUE (« Récents ») — conservé dans ce navigateur, par prénom.
     Rien n'est envoyé ailleurs ; « Effacer l'historique » le supprime.
     ===================================================================== */
  let convId = null, convMsgs = [];
  const HIST_MAX = 40, HIST_MSGS = 30;
  const histKey = () => "lq-hist-" + (isTsa() ? "tsa-" : "") + (String(prenom || "invite").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-") || "invite");
  function histLoad() {
    try { const a = JSON.parse(localStorage.getItem(histKey()) || "[]"); return Array.isArray(a) ? a.filter((c) => c && c.id && Array.isArray(c.m)) : []; } catch { return []; }
  }
  function histSave(list) {
    let l = list.slice(0, HIST_MAX);
    // Si l'espace du navigateur est plein, on retire les plus anciennes conversations
    for (;;) {
      try { localStorage.setItem(histKey(), JSON.stringify(l)); return; }
      catch { if (l.length <= 1) return; l = l.slice(0, Math.ceil(l.length * 0.7)); }
    }
  }
  function remember(q, d, a, s, extra) {
    if (!a || !String(a).trim()) return;
    if (!convId) convId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const entry = { q: String(q).slice(0, 4000), d: String(d).slice(0, 600), a: String(a).slice(0, 30000), s: Array.isArray(s) ? s.slice(0, 6) : [] };
    if (extra && extra.k === "nutrition" && String(extra.na || "").length <= 30000) Object.assign(entry, { k: "nutrition", nq: String(extra.nq || "").slice(0, 4000), na: String(extra.na || ""), ns: Array.isArray(extra.ns) ? extra.ns.slice(0, 12) : [] });
    convMsgs.push(entry);
    if (convMsgs.length > HIST_MSGS) convMsgs = convMsgs.slice(-HIST_MSGS);
    const list = histLoad().filter((c) => c.id !== convId);
    const title = convMsgs[0].d.replace(/\s+/g, " ").trim();
    list.unshift({ id: convId, t: Date.now(), title: title.length > 90 ? title.slice(0, 88) + "…" : title, sc: inScenario, m: convMsgs });
    histSave(list);
    renderHistory();
  }
  function whenLabel(t) {
    const d = new Date(t), now = new Date();
    const day = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
    const diff = Math.round((day(now) - day(d)) / 86400000);
    return diff <= 0 ? "Aujourd'hui" : diff === 1 ? "Hier" : diff < 7 ? "7 derniers jours" : diff < 30 ? "30 derniers jours" : "Plus ancien";
  }
  function whenShort(t) {
    const d = new Date(t), diff = Math.round((Date.now() - t) / 86400000);
    return diff < 1 && d.getDate() === new Date().getDate() ? d.toLocaleTimeString("fr-CA", { hour: "2-digit", minute: "2-digit" })
      : d.toLocaleDateString("fr-CA", { day: "numeric", month: "short" });
  }
  const SVG_TRASH = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3"/></svg>';
  function renderHistory() {
    try { syncHistNav(); } catch {}
    const el = $("sideHistory"); if (!el) return;
    const list = histLoad();
    el.textContent = "";
    $("histCount").hidden = !list.length;
    $("histCount").textContent = list.length > 99 ? "99+" : String(list.length);
    $("histFoot").hidden = !list.length || $("tabRecent").getAttribute("aria-selected") !== "true";
    if (!list.length) {
      const e = document.createElement("p"); e.className = "hist-empty";
      e.textContent = "Vos questions apparaîtront ici pour y revenir plus tard. Elles restent seulement dans ce navigateur.";
      el.append(e); return;
    }
    let last = "";
    list.forEach((c) => {
      const g = whenLabel(c.t);
      if (g !== last) { const h = document.createElement("div"); h.className = "hist-group"; h.textContent = g; el.append(h); last = g; }
      const row = document.createElement("div"); row.className = "hist-row" + (c.id === convId ? " on" : "");
      const open = document.createElement("button"); open.type = "button"; open.className = "hist-open";
      if (c.id === convId) open.setAttribute("aria-current", "true");
      const b = document.createElement("b"); b.textContent = c.title || "Conversation";
      const sm = document.createElement("small");
      sm.textContent = `${whenShort(c.t)} · ${c.m.length} question${c.m.length > 1 ? "s" : ""}${c.sc ? " · mise en situation" : ""}`;
      open.append(b, sm);
      open.onclick = () => openConversation(c.id);
      const del = document.createElement("button"); del.type = "button"; del.className = "hist-del";
      del.innerHTML = SVG_TRASH; del.setAttribute("aria-label", `Supprimer « ${c.title} »`); del.title = "Supprimer cette conversation";
      del.onclick = () => deleteConversation(c.id);
      row.append(open, del); el.append(row);
    });
  }
  function openConversation(id) {
    const c = histLoad().find((x) => x.id === id);
    if (!c) { renderHistory(); return; }
    if (sim.on) setLearn(false);
    ctl?.abort();
    turns = []; inScenario = !!c.sc;
    convId = c.id; convMsgs = c.m.slice();
    $("thread").textContent = "";
    $("empty").hidden = true;
    const stamp = new Date(c.t).toLocaleString("fr-CA", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
    let lastQ = null;
    c.m.forEach((x) => {
      lastQ = addQuestion(x.d || x.q);
      const { m, col, body } = addAnswer();
      const tm = col.querySelector(".who time"); if (tm) tm.textContent = stamp;
      if (x.k === "nutrition" && window.LQNutrition && window.LQNutrition.renderSaved) {
        m.classList.add("nutri-msg");
        window.LQNutrition.renderSaved(body, x.na, x.ns);
        window.LQNutrition.addActions(col, body, { context: "nutrition", question: x.nq, answer: x.na, sources: x.ns });
      } else {
        renderAnswer(body, x.a, true);
        finishAnswer(x.s, col, x.a, x.d || x.q);
      }
      turns.push({ role: "user", content: x.q }, { role: "assistant", content: x.a });
    });
    closeMenu();
    renderHistory();
    requestAnimationFrame(() => { if (lastQ) toTopOf(lastQ); });
  }
  function deleteConversation(id) {
    histSave(histLoad().filter((c) => c.id !== id));
    if (id === convId) resetConversation(); else renderHistory();
  }
  let clearTimer = null;
  $("histClear").onclick = () => {
    const btn = $("histClear");
    if (!btn.classList.contains("confirm")) {
      btn.classList.add("confirm"); btn.querySelector("span").textContent = "Confirmer : tout effacer";
      clearTimer = setTimeout(() => { btn.classList.remove("confirm"); btn.querySelector("span").textContent = "Effacer l'historique"; }, 4000);
      return;
    }
    clearTimeout(clearTimer);
    btn.classList.remove("confirm"); btn.querySelector("span").textContent = "Effacer l'historique";
    try { localStorage.removeItem(histKey()); } catch {}
    resetConversation();
  };
  function setSideTab(tab) {
    const recent = tab === "recent";
    $("tabRecent").setAttribute("aria-selected", String(recent));
    $("tabFaq").setAttribute("aria-selected", String(!recent));
    $("sideHistory").hidden = !recent;
    $("sideExamples").hidden = recent;
    $("faqFoot").hidden = recent;
    store.set("lq-side-tab", tab);
    renderHistory();
  }
  $("tabRecent").onclick = () => setSideTab("recent");
  $("tabFaq").onclick = () => setSideTab("faq");
  // Flèches gauche/droite entre les onglets (accessibilité)
  $("tabRecent").parentElement.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    const next = document.activeElement === $("tabRecent") ? "faq" : "recent";
    setSideTab(next); $(next === "recent" ? "tabRecent" : "tabFaq").focus();
  });
  setSideTab(store.get("lq-side-tab") || (histLoad().length ? "recent" : "faq"));

  /* =====================================================================
     PAGE « HISTORIQUE » — conversations de ce navigateur et questions
     fréquentes ; un clic rouvre la conversation complète dans le fil.
     ===================================================================== */
  const hp = { tab: "conv", q: "" };
  const hpNorm = (t) => String(t || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
  const hpExcerpt = (a) => String(a || "").replace(/```[\s\S]*?```/g, " ").replace(/\[(EN DIRECT|APPRENTISSAGE)\]/g, " ")
    .replace(/[#*_>`|]+/g, " ").replace(/\[([^\]]+)\]\([^)]+\)/g, "$1").replace(/\s+/g, " ").trim().slice(0, 220);
  const histOpen = () => document.body.classList.contains("histv");
  function renderHistPage() {
    const page = $("histPage"); if (!page) return;
    const list = histLoad(), faq = pool();
    page.innerHTML = `<div class="hpg-in">
      <header class="hpg-head"><h1 id="hpTitle">Historique</h1><p>Revoyez une réponse en un clic, ou reprenez une question fréquente.</p></header>
      <div class="hpg-bar">
        <label class="hpg-search"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg><input id="hpSearch" type="search" placeholder="Rechercher une question ou une réponse" aria-label="Rechercher dans l'historique" autocomplete="off"></label>
        <div class="hpg-seg" role="tablist" aria-label="Contenu de l'historique">
          <button type="button" role="tab" id="hpTabConv" aria-selected="${hp.tab === "conv"}">Mes conversations<span class="n">${list.length}</span></button>
          <button type="button" role="tab" id="hpTabFaq" aria-selected="${hp.tab === "faq"}">Questions fréquentes</button>
        </div>
      </div>
      <div id="hpBody" role="tabpanel"></div>
    </div>`;
    const inp = $("hpSearch"); inp.value = hp.q;
    inp.oninput = () => { hp.q = inp.value; fill(); };
    $("hpTabConv").onclick = () => { hp.tab = "conv"; renderHistPage(); $("hpTabConv").focus(); };
    $("hpTabFaq").onclick = () => { hp.tab = "faq"; renderHistPage(); $("hpTabFaq").focus(); };
    fill();
    function fill() {
      const body = $("hpBody"); body.textContent = "";
      const q = hpNorm(hp.q.trim());
      if (hp.tab === "faq") {
        const items = faq.filter((t) => !q || hpNorm(t).includes(q));
        if (!items.length) { body.innerHTML = `<p class="hpg-empty">${q ? "Aucune question fréquente ne correspond à cette recherche." : "Aucune question fréquente pour cet espace."}</p>`; return; }
        const g = document.createElement("div"); g.className = "hpg-faq";
        items.forEach((t) => {
          const b = document.createElement("button"); b.type = "button"; b.className = "hpg-q";
          const tag = document.createElement("span"); tag.className = "tag"; tag.textContent = tagFor(t);
          b.append(tag, document.createTextNode(t));
          b.onclick = () => { closeHistPage(); resetConversation(); send(t); };
          g.append(b);
        });
        body.append(g); return;
      }
      const items = list.filter((c) => !q || hpNorm(c.title + " " + c.m.map((x) => (x.d || x.q) + " " + x.a).join(" ")).includes(q));
      if (!items.length) {
        body.innerHTML = `<p class="hpg-empty">${q ? "Aucune conversation ne correspond à cette recherche." : "Vos conversations apparaîtront ici. Elles restent seulement dans ce navigateur."}</p>`;
        return;
      }
      let last = "", wrap = null;
      items.forEach((c) => {
        const gname = whenLabel(c.t);
        if (gname !== last) {
          const h = document.createElement("h2"); h.className = "hpg-group"; h.textContent = gname; body.append(h);
          wrap = document.createElement("div"); wrap.className = "hpg-list"; body.append(wrap); last = gname;
        }
        const row = document.createElement("div"); row.className = "hpg-row";
        const open = document.createElement("button"); open.type = "button"; open.className = "hpg-open";
        const b = document.createElement("b"); b.textContent = c.title || "Conversation";
        const ex = document.createElement("span"); ex.className = "ex"; ex.textContent = hpExcerpt(c.m[0]?.a);
        const meta = document.createElement("span"); meta.className = "meta";
        meta.textContent = `${whenShort(c.t)} · ${c.m.length} question${c.m.length > 1 ? "s" : ""}${c.sc ? " · mise en situation" : ""}`;
        if (c.id === convId) { const n = document.createElement("span"); n.className = "now"; n.textContent = "En cours"; meta.prepend(n); }
        open.append(b, ex, meta);
        open.onclick = () => { closeHistPage(); openConversation(c.id); };
        const del = document.createElement("button"); del.type = "button"; del.className = "hpg-del";
        del.innerHTML = SVG_TRASH; del.setAttribute("aria-label", `Supprimer « ${c.title} »`); del.title = "Supprimer cette conversation";
        del.onclick = () => { deleteConversation(c.id); renderHistPage(); };
        row.append(open, del); wrap.append(row);
      });
      const foot = document.createElement("div"); foot.className = "hpg-foot";
      foot.innerHTML = `<span>Conservé seulement dans ce navigateur.</span>`;
      const clr = document.createElement("button"); clr.type = "button"; clr.className = "hpg-clear"; clr.textContent = "Effacer l'historique";
      let t = null;
      clr.onclick = () => {
        if (!clr.classList.contains("confirm")) { clr.classList.add("confirm"); clr.textContent = "Confirmer : tout effacer"; t = setTimeout(() => { clr.classList.remove("confirm"); clr.textContent = "Effacer l'historique"; }, 4000); return; }
        clearTimeout(t);
        try { localStorage.removeItem(histKey()); } catch {}
        resetConversation(); openHistPage();
      };
      foot.append(clr); body.append(foot);
    }
  }
  function syncHistNav() {
    const n = histLoad().length, el = $("histNavCount");
    if (el) { el.hidden = !n; el.textContent = n > 99 ? "99+" : String(n); }
    if (histOpen()) renderHistPage();
  }
  function openHistPage() {
    if (sim.on) setLearn(false);
    try { closeFavPage(); } catch {}
    if (!histOpen()) { hp.tab = "conv"; hp.q = ""; }
    document.body.classList.add("histv");
    $("histPage").hidden = false;
    $("sideHist").setAttribute("aria-pressed", "true");
    closeMenu();
    renderHistPage();
    $("histPage").scrollTop = 0;
    $("histPage").focus({ preventScroll: true });
  }
  function closeHistPage() {
    if (!histOpen()) return;
    document.body.classList.remove("histv");
    $("histPage").hidden = true;
    $("sideHist").setAttribute("aria-pressed", "false");
  }
  $("sideHist").onclick = () => (histOpen() ? closeHistPage() : openHistPage());
  // Toute autre navigation (menu, nouvelle conversation, logo) ferme la page
  document.querySelector(".side").addEventListener("click", (e) => {
    const b = e.target.closest("button, a, [role=button], li");
    if (b && b.id !== "sideHist" && b.id !== "railHist" && b.id !== "sideCollapse") closeHistPage();
  }, true);
  ["clear", "homeLogo"].forEach((id) => $(id)?.addEventListener("click", closeHistPage, true));
  addEventListener("keydown", (e) => { if (e.key === "Escape" && histOpen() && !e.defaultPrevented) closeHistPage(); });
  // Changement Réception ↔ TSA : l'historique suit l'espace actif
  let hpTsa = isTsa();
  new MutationObserver(() => { const t = isTsa(); if (t !== hpTsa) { hpTsa = t; syncHistNav(); } })
    .observe(document.body, { attributes: true, attributeFilter: ["class"] });
  syncHistNav();

  /* =====================================================================
     FAVORIS — échanges (question + réponse) gardés par la personne, dans
     son compte et pour l'établissement actif. Copie figée au moment de
     l'ajout ; un favori est personnel, ce n'est pas une validation.
     Offert seulement en mode compte (portail laqualia.com).
     ===================================================================== */
  const SVG_HEART = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20.5s-7.5-4.6-9.3-9.4C1.4 7.6 3.6 4 7.2 4c2 0 3.5 1.1 4.8 2.8C13.3 5.1 14.8 4 16.8 4c3.6 0 5.8 3.6 4.5 7.1-1.8 4.8-9.3 9.4-9.3 9.4Z"/></svg>';
  const FAV_CTX = { reception: "Réception", tsa: "TSA", nutrition: "Nutrition & produits" };
  const fav = { on: false, map: new Map(), list: [], loaded: false, tab: "all", q: "", detail: null };
  const favCtxNow = () => (isTsa() ? "tsa" : "reception");
  async function favKeyOf(c, q, a) {
    const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`lq-fav\n${c}\n${q}\n${a}`));
    return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
  }
  // Mode test (code d'équipe, sans compte) : mêmes favoris, gardés seulement dans ce navigateur, par prénom.
  const FAV_LOCAL_MAX = 100;
  const favLocalKey = () => "lq-fav-" + (String(prenom || "invite").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "-") || "invite");
  const favLocalLoad = () => { try { const a = JSON.parse(localStorage.getItem(favLocalKey()) || "[]"); return Array.isArray(a) ? a.filter((x) => x && x.id && x.fkey) : []; } catch { return []; } };
  const favPreview = (x) => ({ id: x.id, fkey: x.fkey, context: x.context, created_at: x.created_at, question: x.question.slice(0, 600), excerpt: x.answer.slice(0, 600) });
  async function favLocal(path, method, data) {
    const list = favLocalLoad(), id = decodeURIComponent((path.match(/^\/api\/favorites\/(.+)$/) || [])[1] || "");
    const save = (l) => { try { localStorage.setItem(favLocalKey(), JSON.stringify(l)); } catch { throw new Error("L'espace de ce navigateur est plein : retirez quelques favoris."); } };
    if (method === "GET" && !id) return { favorites: list.map(favPreview), max: FAV_LOCAL_MAX };
    if (method === "GET") { const x = list.find((f) => f.id === id); if (!x) throw new Error("Favori introuvable."); return { favorite: x }; }
    if (method === "DELETE") { save(list.filter((f) => f.id !== id)); return { ok: true }; }
    const fkey = await favKeyOf(data.context, data.question, data.answer);
    const ex = list.find((f) => f.fkey === fkey); if (ex) return { favorite: favPreview(ex) };
    if (list.length >= FAV_LOCAL_MAX) throw new Error(`Vous avez atteint ${FAV_LOCAL_MAX} favoris. Retirez-en quelques-uns pour en ajouter.`);
    const x = { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 8), fkey, context: data.context, question: data.question, answer: data.answer,
      sources: (data.sources || []).slice(0, 12).map((v) => (typeof v === "string" ? { title: v } : v)), created_at: Date.now() };
    save([x, ...list]);
    return { favorite: favPreview(x) };
  }
  async function favApi(path, method = "GET", data) {
    if (!accountMode) return favLocal(path, method, data);
    const r = await fetch(path, { method, credentials: "same-origin", cache: "no-store",
      headers: method === "GET" ? {} : { "content-type": "application/json", "x-lq-csrf": "1" }, body: data ? JSON.stringify(data) : undefined });
    let d = null; try { d = await r.json(); } catch {}
    if (r.status === 401) { leavePortal(401, d && d.code); throw new Error("session"); }
    if (!r.ok) throw new Error((d && d.error) || "Le serveur n'a pas répondu. Réessayez.");
    return d;
  }
  let toastT = null;
  function favToast(html) {
    const t = $("favToast"); t.innerHTML = html; t.hidden = false;
    clearTimeout(toastT); toastT = setTimeout(() => { t.hidden = true; }, 3200);
  }
  function favPaint(b) {
    const on = fav.map.has(b.dataset.fkey);
    b.setAttribute("aria-pressed", String(on));
    b.setAttribute("aria-label", on ? "Retirer des favoris" : "Ajouter aux favoris");
    b.title = on ? "Retirer de Mes favoris" : "Ajouter à Mes favoris (favori personnel)";
  }
  function favPaintAll() { document.querySelectorAll(".fav-btn[data-fkey]").forEach(favPaint); }
  // Cœur sous une réponse : item = { context, question, answer, sources }
  function favButton(item) {
    if ((!fav.on && ACCOUNT_HOST) || !item || !String(item.answer || "").trim() || !String(item.question || "").trim()) return null;
    const b = document.createElement("button"); b.type = "button"; b.className = "act fav-btn";
    b.innerHTML = SVG_HEART; b.setAttribute("aria-pressed", "false"); b.setAttribute("aria-label", "Ajouter aux favoris");
    b.disabled = true;
    favKeyOf(item.context, item.question, item.answer).then((k) => { b.dataset.fkey = k; b.disabled = false; favPaint(b); });
    b.onclick = () => favToggle(b, item);
    return b;
  }
  async function favToggle(b, item) {
    const k = b.dataset.fkey; if (!k || b.dataset.busy) return;
    b.dataset.busy = "1";
    const id = fav.map.get(k);
    try {
      if (id) {
        fav.map.delete(k); favPaintAll();
        await favApi(`/api/favorites/${encodeURIComponent(id)}`, "DELETE");
        fav.list = fav.list.filter((x) => x.id !== id);
        favToast("Retiré de Mes favoris");
      } else {
        fav.map.set(k, "…"); favPaintAll();
        b.classList.add("pop"); setTimeout(() => b.classList.remove("pop"), 180);
        const d = await favApi("/api/favorites", "POST", { context: item.context, question: item.question, answer: item.answer, sources: item.sources || [] });
        fav.map.set(k, d.favorite.id);
        fav.list = [d.favorite, ...fav.list.filter((x) => x.id !== d.favorite.id)];
        favToast("Ajouté à Mes favoris<small>Favori personnel : il ne confirme pas l'exactitude de la réponse.</small>");
      }
    } catch (e) {
      if (id) fav.map.set(k, id); else fav.map.delete(k);
      if (e.message !== "session") favToast(esc(e.message));
    } finally {
      delete b.dataset.busy; favPaintAll(); favSyncNav();
    }
  }
  function favSyncNav() {
    const n = fav.list.length, el = $("favNavCount");
    if (el) { el.hidden = !n; el.textContent = n > 99 ? "99+" : String(n); }
    if (favOpen() && !fav.detail) renderFavPage();
  }
  async function favInit() {
    if (fav.loaded) return;
    fav.loaded = true; fav.on = true;
    $("sideFav").hidden = false;
    try {
      const d = await favApi("/api/favorites");
      fav.list = d.favorites || [];
      fav.map = new Map(fav.list.map((x) => [x.fkey, x.id]));
    } catch {}
    // Réponses déjà affichées : on ajoute le cœur
    document.querySelectorAll("#thread .msg.a .actions").forEach((acts) => {
      if (acts.querySelector(".fav-btn") || !acts._favItem) return;
      const b = favButton(acts._favItem); if (b) acts.prepend(b);
    });
    favPaintAll(); favSyncNav();
  }
  // Ajoute le cœur aux actions d'une réponse (créé plus tard si le compte n'est pas encore chargé)
  function favAttach(acts, item) {
    acts._favItem = item;
    const b = favButton(item); if (b) acts.prepend(b);
  }

  /* ---------- page « Mes favoris » ---------- */
  const favOpen = () => document.body.classList.contains("favv");
  const fmtDay = (t) => new Date(t).toLocaleDateString("fr-CA", { day: "numeric", month: "long", year: "numeric" });
  const fmtWhen = (t) => new Date(t).toLocaleString("fr-CA", { day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit" });
  const tagHtml = (c) => `<span class="fp-tag ${esc(c)}">${esc(FAV_CTX[c] || c)}</span>`;
  const NOTE_TXT = "Un favori est personnel : il garde la réponse telle qu'elle était au moment de l'ajout et ne confirme pas son exactitude.";
  const noteHtml = () => `<p class="fp-note">${SVG_HEART}<span>${NOTE_TXT}${accountMode ? "" : " <b>Mode test :</b> vos favoris sont gardés seulement dans ce navigateur."}</span></p>`;
  function renderFavPage() {
    const page = $("favPage"); if (!page) return;
    if (fav.detail) return renderFavDetail();
    const counts = { all: fav.list.length }; fav.list.forEach((x) => { counts[x.context] = (counts[x.context] || 0) + 1; });
    const tabs = [["all", "Tous"], ["reception", "Réception"], ["tsa", "TSA"], ["nutrition", "Nutrition"]];
    page.innerHTML = `<div class="hpg-in">
      <header class="hpg-head"><h1 id="fpTitle">Mes favoris</h1><p>Les échanges que vous avez gardés, pour les retrouver facilement.</p></header>
      ${noteHtml()}
      <div class="hpg-bar">
        <label class="hpg-search"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg><input id="fpSearch" type="search" placeholder="Rechercher un favori" aria-label="Rechercher dans mes favoris" autocomplete="off"></label>
        <div class="hpg-seg" role="tablist" aria-label="Contexte">${tabs.map(([k, l]) => `<button type="button" role="tab" data-fp-tab="${k}" aria-selected="${fav.tab === k}">${l}${counts[k] ? `<span class="n">${counts[k]}</span>` : ""}</button>`).join("")}</div>
      </div>
      <div id="fpBody" class="fp-body"></div>
    </div>`;
    const inp = $("fpSearch"); inp.value = fav.q;
    inp.oninput = () => { fav.q = inp.value; fill(); };
    page.querySelectorAll("[data-fp-tab]").forEach((b) => (b.onclick = () => { fav.tab = b.dataset.fpTab; renderFavPage(); page.querySelector(`[data-fp-tab="${fav.tab}"]`).focus(); }));
    fill();
    function fill() {
      const body = $("fpBody"); body.textContent = "";
      if (!fav.list.length) {
        body.innerHTML = `<div class="hpg-empty fp-empty">${SVG_HEART}<b>Aucun favori pour l'instant</b><span>Touchez le cœur sous une réponse de l'agent pour la retrouver ici.</span></div>`;
        return;
      }
      const q = hpNorm(fav.q.trim());
      const items = fav.list.filter((x) => (fav.tab === "all" || x.context === fav.tab) && (!q || hpNorm(x.question + " " + (x.excerpt || "")).includes(q)));
      if (!items.length) { body.innerHTML = `<p class="hpg-empty">${q ? "Aucun favori ne correspond à cette recherche." : "Aucun favori dans ce contexte."}</p>`; return; }
      const wrap = document.createElement("div"); wrap.className = "hpg-list";
      items.forEach((x) => {
        const row = document.createElement("div"); row.className = "hpg-row";
        const open = document.createElement("button"); open.type = "button"; open.className = "hpg-open";
        const b = document.createElement("b"); const qt = x.question.replace(/\s+/g, " ").trim(); b.textContent = qt.length > 160 ? qt.slice(0, 158) + "…" : qt;
        const ex = document.createElement("span"); ex.className = "ex"; ex.textContent = hpExcerpt(String(x.excerpt || "").replace(/```comparaison[\s\S]*?(```|$)/g, ""));
        const meta = document.createElement("span"); meta.className = "meta"; meta.innerHTML = `${tagHtml(x.context)}<span>${esc(fmtDay(x.created_at))}</span>`;
        open.append(b, ex, meta);
        open.onclick = () => openFavDetail(x.id);
        const del = document.createElement("button"); del.type = "button"; del.className = "hpg-del";
        del.innerHTML = SVG_HEART; del.setAttribute("aria-label", `Retirer « ${b.textContent} » des favoris`); del.title = "Retirer des favoris";
        del.style.color = "#e11d48"; del.querySelector("svg").style.fill = "currentColor";
        del.onclick = () => favRemove(x.id);
        row.append(open, del); wrap.append(row);
      });
      body.append(wrap);
    }
  }
  async function favRemove(id) {
    const x = fav.list.find((f) => f.id === id); if (!x) return;
    try {
      await favApi(`/api/favorites/${encodeURIComponent(id)}`, "DELETE");
      fav.list = fav.list.filter((f) => f.id !== id); fav.map.delete(x.fkey);
      favToast("Retiré de Mes favoris");
    } catch (e) { if (e.message !== "session") favToast(esc(e.message)); return; }
    fav.detail = null; favPaintAll(); favSyncNav(); renderFavPage();
  }
  async function openFavDetail(id) {
    fav.detail = { id, loading: true };
    renderFavDetail();
    try { fav.detail = (await favApi(`/api/favorites/${encodeURIComponent(id)}`)).favorite; }
    catch (e) { fav.detail = { id, error: e.message }; }
    if (favOpen() && fav.detail && fav.detail.id === id) renderFavDetail();
    $("favPage").scrollTop = 0;
  }
  // Affiche une réponse enregistrée avec la mise en forme de son contexte d'origine (sans toucher à la conversation en cours)
  function renderStored(body, text, context) {
    const r = role, sc = inScenario;
    role = context === "tsa" ? "tsa" : "reception"; inScenario = false;
    try { renderAnswer(body, text, true); } finally { role = r; inScenario = sc; }
  }
  function renderFavDetail() {
    const page = $("favPage"), f = fav.detail;
    const back = `<button type="button" class="fp-back" id="fpBack"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 18l-6-6 6-6"/></svg>Mes favoris</button>`;
    if (f.loading || f.error) {
      page.innerHTML = `<div class="hpg-in">${back}<p class="hpg-empty">${f.error ? esc(f.error) : "Chargement…"}</p></div>`;
      $("fpBack").onclick = favBackToList; return;
    }
    page.innerHTML = `<div class="hpg-in fp-detail">${back}
      <div class="fp-meta">${tagHtml(f.context)}<span>Enregistré le ${esc(fmtWhen(f.created_at))}</span></div>
      <h1 id="fpTitle" class="fp-q"><small>Question</small></h1>
      <section class="fp-a" aria-label="Réponse enregistrée"><small>Réponse enregistrée</small><div class="body" id="fpAnswer"></div></section>
      <div id="fpSources"></div>
      ${noteHtml()}
      <div class="fp-actions">
        <button type="button" class="fp-btn" id="fpCopy">${SVG_COPY}<span>Copier la question et la réponse</span></button>
        <button type="button" class="fp-btn rm" id="fpRemove">${SVG_HEART}<span>Retirer des favoris</span></button>
      </div></div>`;
    $("fpTitle").append(document.createTextNode(f.question));
    const ans = $("fpAnswer"), srcs = Array.isArray(f.sources) ? f.sources : [];
    if (f.context === "nutrition" && window.LQNutrition && window.LQNutrition.renderSaved) {
      ans.closest(".fp-a").classList.add("nutri-msg");
      window.LQNutrition.renderSaved(ans, f.answer, srcs);
    } else {
      renderStored(ans, f.answer, f.context);
      if (srcs.length) {
        const box = document.createElement("div"); box.className = "fp-src";
        box.innerHTML = "<h3>Sources</h3><ul></ul>";
        const ul = box.querySelector("ul");
        srcs.forEach((x) => {
          const li = document.createElement("li");
          if (x.url) { const a = document.createElement("a"); a.href = x.url; a.target = "_blank"; a.rel = "noopener noreferrer"; a.textContent = x.title || x.url; li.append(a); }
          else li.textContent = x.title;
          ul.append(li);
        });
        $("fpSources").append(box);
      }
    }
    $("fpBack").onclick = favBackToList;
    $("fpRemove").onclick = () => favRemove(f.id);
    $("fpCopy").onclick = async () => {
      const sp = $("fpCopy").querySelector("span");
      try { await navigator.clipboard.writeText(`Question : ${f.question}\n\nRéponse :\n${ans.innerText}`); sp.textContent = "Copié ✓"; }
      catch { sp.textContent = "Copie impossible"; }
      setTimeout(() => { sp.textContent = "Copier la question et la réponse"; }, 2000);
    };
  }
  function favBackToList() { fav.detail = null; renderFavPage(); $("favPage").focus({ preventScroll: true }); }
  function openFavPage() {
    if (sim.on) setLearn(false);
    closeHistPage();
    if (!favOpen()) { fav.tab = "all"; fav.q = ""; fav.detail = null; }
    document.body.classList.add("favv");
    $("favPage").hidden = false;
    $("sideFav").setAttribute("aria-pressed", "true");
    closeMenu();
    renderFavPage();
    $("favPage").scrollTop = 0;
    $("favPage").focus({ preventScroll: true });
  }
  function closeFavPage() {
    if (!favOpen()) return;
    document.body.classList.remove("favv");
    $("favPage").hidden = true; fav.detail = null;
    $("sideFav").setAttribute("aria-pressed", "false");
  }
  $("sideFav").onclick = () => (favOpen() && !fav.detail ? closeFavPage() : openFavPage());
  document.querySelector(".side").addEventListener("click", (e) => {
    const b = e.target.closest("button, a, [role=button], li");
    if (b && b.id !== "sideFav" && b.id !== "sideCollapse") closeFavPage();
  }, true);
  ["clear", "homeLogo"].forEach((id) => $(id)?.addEventListener("click", closeFavPage, true));
  if (!ACCOUNT_HOST) setTimeout(() => { try { favInit(); } catch {} }, 0); // mode test : favoris du navigateur, dès le chargement
  addEventListener("keydown", (e) => {
    if (e.key !== "Escape" || !favOpen() || e.defaultPrevented) return;
    if (fav.detail) favBackToList(); else closeFavPage();
  });


  /* =====================================================================
     ESPACES DE TRAVAIL : Réception / Équipe technique — TSA
     L'onglet adapte l'interface ; l'accès TSA est vérifié par le relais
     (code TSA), jamais seulement par l'onglet choisi dans la page.
     ===================================================================== */
  let tsaCode = store.get("lq-tsa-code") || "";
  let tsaEnabled = false, tsaVerified = false;
  function authHeaders() {
    const h = { "content-type": "application/json", "x-agent-code": code };
    if (isTsa() && tsaCode) h["x-tsa-code"] = tsaCode;
    return h;
  }
  function hideCarry() { $("carry").hidden = true; }
  function applyRole() {
    document.body.classList.toggle("tsa", isTsa());
    $("roleRec").setAttribute("aria-selected", String(!isTsa()));
    $("roleTsa").setAttribute("aria-selected", String(isTsa()));
    $("tsaLock").hidden = tsaVerified;
    const hv = document.querySelector(".hello2-av");
    if (hv) { hv.onerror = () => { tsaFace = false; hv.onerror = null; hv.src = "avatar.webp"; }; hv.src = avatarSrc(); }
    document.querySelector(".mc-ico").innerHTML = $(isTsa() ? "roleTsa" : "roleRec").querySelector(".rt-ico").innerHTML;
    $("atMid").textContent = isTsa() ? "Soutien clinique" : "Formation";
    $("atEnd").textContent = isTsa() ? "Équipe technique TSA" : "Équipe d'accueil vétérinaire";
    $("helloSub").textContent = isTsa() ? "Sur quel cas ou quelle tâche travaillez-vous" : "Comment puis-je vous aider aujourd'hui";
    $("askTitle").textContent = isTsa() ? "Décrivez le cas ou la tâche" : "Posez votre question ici";
    $("askHint").textContent = isTsa() ? "Données fictives ou dépersonnalisées seulement : aucun nom de client ni numéro de dossier." : "Écrivez ou dictez avec le bouton Voix, comme à une collègue d'expérience, puis appuyez sur Entrée.";
    $("q").placeholder = basePH();
    $("q").setAttribute("aria-label", $("askTitle").textContent);
    $("sideTrainSub").textContent = isTsa() ? "Un cas fictif, avec quiz" : "Un appel court, avec quiz";
    $("learnToggleSub").textContent = sim.on ? "Cliquer pour revenir au mode habituel" : (isTsa() ? "Échange fictif avec sonnerie" : "Appel fictif avec sonnerie");
    $("lbRole").textContent = isTsa() ? "Équipe technique — TSA" : "Réception";
    $("callWho").textContent = isTsa() ? "Interlocuteur fictif" : "Client fictif";
    document.querySelector(".under-lab").textContent = isTsa() ? "Outils de l'équipe technique" : "Suggestions";
    const lead = document.querySelector(".sim-lead");
    if (lead) lead.textContent = isTsa()
      ? "Un vétérinaire, un client ou un collègue fictif vous appelle. Il parle en premier ; vous répondez une réplique à la fois. Rétroaction clinique à la fin."
      : "Un client fictif vous appelle. Il parle en premier ; vous répondez une réplique à la fois, au clavier ou à voix haute. Rétroaction à la fin.";
    applyCfg();
    loadThemes(); renderThemes();
    renderHistory();
    setConvTitle();
  }
  function switchRole(target, opts = {}) {
    if (target === role) { closeMenu(); return; }
    if (target === "tsa" && !tsaVerified) { openTsaBox(); return; }
    // On ne réutilise pas la conversation dans l'autre espace : elle reste dans les Récents de son espace
    const prevLabel = isTsa() ? "Équipe technique — TSA" : "Réception";
    const prev = convMsgs.map((m) => m.d).filter(Boolean).slice(-5);
    if (sim.on) setLearn(false);
    resetConversation();
    role = target;
    store.set("lq-role", role);
    try { window.LQNutrition && window.LQNutrition.exit(); } catch {}
    applyRole();
    closeMenu();
    // Chaque espace repart à neuf ; la conversation précédente reste dans les Récents de son espace
    if (opts.silent || !prev.length || true) return;
    $("carryTitle").textContent = `Votre conversation de l'espace ${prevLabel} n'a pas été transférée ici`;
    $("carryText").textContent = prev.length
      ? `Elle reste dans l'historique de l'espace ${prevLabel}. Pour continuer sur le même sujet ici, reprenez-en un résumé : il s'affichera dans la zone de saisie pour que vous le vérifiiez avant l'envoi.`
      : `Outils, suggestions et règles de l'agent : espace ${isTsa() ? "Équipe technique — TSA" : "Réception"}.`;
    $("carrySum").hidden = true;
    $("carryUse").hidden = !prev.length;
    $("carryUse").onclick = () => {
      const q = $("q");
      q.value = `Contexte repris de l'espace ${prevLabel} (à confirmer) :\n${prev.map((x) => "- " + x.replace(/\s+/g, " ").slice(0, 160)).join("\n")}\n\nMa demande : `;
      autosize(); hideCarry(); q.focus(); try { q.setSelectionRange(q.value.length, q.value.length); } catch {}
    };
    $("carry").hidden = false;
  }
  $("carryNo").onclick = hideCarry;
  $("roleRec").onclick = () => switchRole("reception");
  $("roleTsa").onclick = () => switchRole("tsa");
  $("roleRec").parentElement.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    const next = document.activeElement === $("roleRec") ? "roleTsa" : "roleRec";
    $(next).focus();
  });

  function openTsaBox(message) {
    const box = $("tsabox");
    const err = $("tsaErr");
    $("tsaCode").hidden = !tsaEnabled; $("tsaGo").hidden = !tsaEnabled;
    $("tsaIntro").textContent = tsaEnabled
      ? "Cet espace est réservé au personnel technique. Entrez le code TSA fourni par le responsable vétérinaire. Il sera retenu sur cet appareil."
      : "L'espace Équipe technique — TSA n'est pas encore activé. Le responsable doit ajouter le code secret TSA_CODE dans le relais Cloudflare.";
    err.hidden = !message; err.textContent = message || "";
    $("tsaCode").value = "";
    box.hidden = false;
    setTimeout(() => (tsaEnabled ? $("tsaCode") : $("tsaCancel")).focus(), 30);
  }
  function closeTsaBox() { $("tsabox").hidden = true; }
  $("tsaCancel").onclick = closeTsaBox;
  $("tsabox").addEventListener("keydown", (e) => { if (e.key === "Escape") closeTsaBox(); });
  async function checkTsa(candidate) {
    if (!cfg.apiUrl) return { tsa: false, tsaOk: false };
    const h = { "x-agent-code": code }; if (candidate) h["x-tsa-code"] = candidate;
    const r = await apiFetch({ headers: h });
    return r.ok ? r.json() : { tsa: false, tsaOk: false };
  }
  $("tsaForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const v = $("tsaCode").value.trim();
    if (!v) return;
    $("tsaGo").disabled = true;
    try {
      const st = await checkTsa(v);
      if (st.tsaOk) {
        tsaCode = v; store.set("lq-tsa-code", v); tsaVerified = true;
        closeTsaBox(); switchRole("tsa");
      } else { $("tsaErr").hidden = false; $("tsaErr").textContent = "Code TSA invalide. Vérifiez-le avec le responsable vétérinaire."; }
    } catch { $("tsaErr").hidden = false; $("tsaErr").textContent = "Vérification impossible pour le moment. Réessayez."; }
    finally { $("tsaGo").disabled = false; }
  });
  // Le relais a refusé l'accès TSA : on retire l'accès local et on revient à la Réception
  function tsaDenied(msg) {
    tsaVerified = false; tsaCode = ""; store.del("lq-tsa-code");
    switchRole("reception", { silent: true });
    openTsaBox(msg);
  }


  /* ---------- avis de confidentialité (Loi 25) : à lire et accepter une fois par appareil ---------- */
  let privacyText = "";
  const fnv1 = (t) => { let h = 2166136261; for (let i = 0; i < t.length; i++) { h ^= t.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; } return h.toString(16); };
  function showPrivacy() { if (!privacyText) return; $("privText").textContent = privacyText; $("privbox").hidden = false; setTimeout(() => $("privOk").focus(), 30); }
  function setPrivacy(text) {
    privacyText = String(text || "").trim();
    if (!privacyText || store.get("lq-privacy-ok") === fnv1(privacyText)) return;
    // Après la fenêtre du prénom et du code, si elle est ouverte
    if (!$("codebox").hidden) { const mo = new MutationObserver(() => { if ($("codebox").hidden) { mo.disconnect(); showPrivacy(); } }); mo.observe($("codebox"), { attributes: true, attributeFilter: ["hidden"] }); }
    else showPrivacy();
  }
  $("privOk").onclick = () => { store.set("lq-privacy-ok", fnv1(privacyText)); $("privbox").hidden = true; $("q").focus(); };
  $("privLink").onclick = () => { closeMenu(); showPrivacy(); };
  $("sideNew").onclick = resetConversation;
  // Menu réduit (ordinateur) : icônes seulement, choix mémorisé
  function setSideMini(on) {
    document.body.classList.toggle("side-mini", on);
    const b = $("sideCollapse");
    b.setAttribute("aria-expanded", String(!on));
    b.setAttribute("aria-label", on ? "Agrandir le menu" : "Réduire le menu");
    b.title = on ? "Agrandir le menu" : "Réduire le menu";
    store.set("lq-side-mini", on ? "1" : "0");
  }
  $("sideCollapse").onclick = () => setSideMini(!document.body.classList.contains("side-mini"));
  $("railHist").onclick = () => openHistPage();
  setSideMini(store.get("lq-side-mini") === "1");
  // Logo : retour à l'interface de départ (quitte la simulation au besoin)
  $("homeLogo").onclick = () => { if (sim.on) setLearn(false); resetConversation(); };
  $("clear").onclick = resetConversation;
  $("shuffleBtn").onclick = () => { renderSideList(); if (!$("empty").hidden) renderWelcomeCards(); };


  /* =====================================================================
     MODE APPRENTISSAGE — simulateur d'appels (tout est fictif : aucun vrai
     appel, aucun dossier modifié, aucun message envoyé à l'équipe)
     ===================================================================== */
  const SIM_TYPES_TSA = [
    ["Transmission au vétérinaire", "le médecin vétérinaire reçoit la transmission de l'apprenant au sujet d'un patient hospitalisé fictif ; tu joues le vétérinaire et tu poses des questions précises"],
    ["Surveillance hospitalisation", "le vétérinaire demande un point de surveillance sur un patient fictif dont les paramètres se dégradent légèrement ; tu joues le vétérinaire"],
    ["Préparation de procédure", "le vétérinaire vérifie que tout est prêt avant une anesthésie ou une chirurgie fictive ; tu joues le vétérinaire"],
    ["Consignes au client", "un client appelle après le congé de son animal pour comprendre des consignes déjà validées par le vétérinaire ; tu joues le client"],
    ["Client inquiet post-op", "un client signale des signes après une chirurgie, dont certains peuvent exiger le vétérinaire ; tu joues le client"],
    ["Urgence en hospitalisation", "un collègue signale qu'un patient hospitalisé fictif se dégrade rapidement ; tu joues le collègue"],
  ];
  const simTypes = () => (RP().simTypes?.length ? RP().simTypes : isTsa() ? SIM_TYPES_TSA : SIM_TYPES);
  const themesKey = () => (isTsa() ? "lq-themes-tsa" : "lq-themes");
  function loadThemes() { try { themes = JSON.parse(store.get(themesKey()) || "[]").filter((k) => simTypes().some(([n]) => n === k)); } catch { themes = []; } }
  const SIM_TYPES = [
    ["Rendez-vous", "prise ou changement de rendez-vous ; horaire chargé, client pressé ou exigeant"],
    ["Facturation", "question ou contestation d'une facture, d'un dépôt ou d'un estimé"],
    ["Plainte", "plainte sur un service, une attente ou un membre de l'équipe"],
    ["Client inquiet", "propriétaire inquiet pour un symptôme léger à modéré de son animal"],
    ["Deuil", "fin de vie, euthanasie à planifier ou décès récent d'un animal"],
    ["Urgence potentielle", "symptômes qui cachent une vraie urgence, que le client minimise au début"],
  ];
  const ICON_PERSON = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="12" cy="8" r="4"/><path d="M4 21c0-4.4 3.6-7 8-7s8 2.6 8 7z"/></svg>';
  const sim = { on: false, active: false, ended: false, turns: [], log: [], type: null, ctl: null, timer: null, start: 0, ringing: false, ringTimeout: null };
  let muted = store.get("lq-mute") === "1";
  const LEVEL_NAMES = { debutant: "Débutant", intermediaire: "Intermédiaire", expert: "Expert" };
  let level = LEVEL_NAMES[store.get("lq-level")] ? store.get("lq-level") : "intermediaire";
  // Thématiques : aucune choisie = aléatoire parmi toutes
  let themes = []; loadThemes();
  function renderThemes() {
    const box = $("themeChips"); box.textContent = "";
    const rand = document.createElement("button"); rand.type = "button"; rand.textContent = "Aléatoire";
    rand.setAttribute("aria-pressed", String(!themes.length));
    rand.onclick = () => { themes = []; saveThemes(); };
    box.append(rand);
    simTypes().forEach(([name]) => {
      const b = document.createElement("button"); b.type = "button"; b.textContent = name;
      b.setAttribute("aria-pressed", String(themes.includes(name)));
      b.onclick = () => { themes = themes.includes(name) ? themes.filter((x) => x !== name) : [...themes, name]; saveThemes(); };
      box.append(b);
    });
    $("themeHint").textContent = !themes.length ? `Un thème au hasard parmi les ${simTypes().length}, sans répéter le précédent.`
      : themes.length === 1 ? `Tous les appels porteront sur : ${themes[0]}.`
      : `Un thème au hasard parmi vos ${themes.length} choix.`;
  }
  function saveThemes() { store.set(themesKey(), JSON.stringify(themes)); renderThemes(); }
  function renderLevel() {
    document.querySelectorAll("#levelSeg button").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.level === level)));
  }
  document.querySelectorAll("#levelSeg button").forEach((b) => { b.onclick = () => { if (sim.active) return; level = b.dataset.level; store.set("lq-level", level); renderLevel(); }; });
  let audio = null, ringLoop = null;

  function muteLabel() {
    $("muteBtn").setAttribute("aria-checked", String(!muted));
    $("muteBtn").title = muted ? "Sonnerie coupée : signal visuel seulement" : "Sonnerie activée";
    $("ringMute").textContent = muted ? "🔇 Son coupé — réactiver" : "🔔 Couper le son";
    $("ringMute").setAttribute("aria-pressed", String(muted));
  }
  function toggleMute() {
    muted = !muted; store.set("lq-mute", muted ? "1" : "0"); muteLabel();
    if (sim.ringing) { if (muted) stopSound(); else startSound(); }
  }

  // Sonnerie générée (deux tons 440 + 480 Hz, 2 s sur 4 s), aucun fichier externe
  function ringOnce() {
    if (!audio) return;
    const t = audio.currentTime;
    const g = audio.createGain(); g.gain.value = 0; g.connect(audio.destination);
    [440, 480].forEach((f) => { const o = audio.createOscillator(); o.frequency.value = f; o.connect(g); o.start(t); o.stop(t + 2.05); });
    g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(0.12, t + 0.03);
    g.gain.setValueAtTime(0.12, t + 1.95); g.gain.linearRampToValueAtTime(0, t + 2.05);
  }
  function startSound() {
    stopSound();
    try { audio = new (window.AudioContext || window.webkitAudioContext)(); audio.resume?.(); ringOnce(); ringLoop = setInterval(ringOnce, 4000); } catch { audio = null; }
  }
  function stopSound() {
    clearInterval(ringLoop); ringLoop = null;
    try { audio?.close(); } catch {}
    audio = null;
  }

  function setLearn(on) {
    if (on) { try { window.LQNutrition && window.LQNutrition.exit(); } catch {} }
    sim.on = on;
    document.body.classList.toggle("learn", on);
    $("learnToggle").setAttribute("aria-pressed", String(on));
    $("learnToggleText").textContent = on ? "Simulation complète" : "Simulation complète";
    $("learnToggleSub").textContent = on ? "Cliquer pour revenir au mode habituel" : (isTsa() ? "Échange fictif avec sonnerie" : "Appel fictif avec sonnerie");
    $("learnToggle").title = on ? "Quitter la simulation complète" : "Lancer la simulation complète";
    store.set("lq-learn", on ? "1" : "0");
    closeMenu();
    if (on) {
      ctl?.abort();
      $("simHome").hidden = false;
      $("q").placeholder = "Recevez un appel pour commencer…";
      updateSimComposer();
    } else {
      stopSim(true);
      $("q").placeholder = basePH();
      $("q").disabled = false;
    }
    scroller.scrollTop = 0;
  }

  function updateSimComposer() {
    if (!sim.on) return;
    const can = sim.active && !sim.ended;
    $("q").disabled = !can;
    $("q").placeholder = can ? "Répondez au client…" : "Recevez un appel pour commencer…";
    updateSend();
  }

  function ringIn() {
    if (sim.ringing || sim.active) return;
    sim.ringing = true;
    $("simCall").disabled = true;
    $("ringPanel").hidden = false;
    $("ringSub").textContent = isTsa() ? "Interlocuteur fictif · simulation TSA" : "Client fictif · numéro de simulation";
    if (!muted) startSound();
    setTimeout(() => $("ringAnswer").focus(), 50);
    // Sans réponse après 40 s : appel manqué, la sonnerie s'arrête
    sim.ringTimeout = setTimeout(() => { stopRing(); simNote("Appel manqué : personne n'a décroché. Recevez un autre appel quand vous êtes prêt."); }, 40000);
  }
  function stopRing() {
    sim.ringing = false;
    clearTimeout(sim.ringTimeout);
    stopSound();
    $("ringPanel").hidden = true;
    $("simCall").disabled = false;
  }
  function declineCall() {
    stopRing();
    simNote("Appel refusé. Aucune simulation n'a été lancée.");
  }

  function simNote(text) {
    $("simThread").hidden = false;
    const n = document.createElement("div"); n.className = "sim-note"; n.textContent = text;
    $("simThread").append(n); toBottom();
  }
  function clientBubble() {
    const m = document.createElement("div"); m.className = "msg a sim-c";
    const av = document.createElement("div"); av.className = "c-av"; av.innerHTML = ICON_PERSON;
    const col = document.createElement("div"); col.className = "a-col";
    const who = document.createElement("div"); who.className = "who"; who.textContent = isTsa() ? "Interlocuteur (fictif)" : "Client (fictif)";
    const b = document.createElement("div"); b.className = "c-bub";
    b.innerHTML = '<span class="thinking-line"><span class="typing" aria-hidden="true"><i></i><i></i><i></i></span>Le client parle…</span>';
    col.append(who, b); m.append(av, col); $("simThread").append(m); toBottom();
    return b;
  }
  function learnerBubble(text) {
    const m = document.createElement("div"); m.className = "msg q";
    const b = document.createElement("div"); b.className = "qbub"; b.textContent = text;
    m.append(b); $("simThread").append(m); toBottom();
  }

  function answerCall() {
    stopRing();
    const pool = themes.length ? simTypes().filter(([k]) => themes.includes(k)) : simTypes();
    const pick = pool.length > 1 ? pool.filter(([k]) => k !== store.get("lq-last-sim")) : pool;
    sim.type = pick[Math.floor(Math.random() * pick.length)];
    store.set("lq-last-sim", sim.type[0]);
    sim.active = true; sim.ended = false; sim.turns = []; sim.log = [];
    $("simHome").hidden = true;
    $("simThread").textContent = ""; $("simThread").hidden = false;
    $("callBar").hidden = false;
    document.body.classList.add("in-call");
    $("callLevel").textContent = LEVEL_NAMES[level];
    sim.level = level;
    voiceStartCall();
    sim.start = Date.now();
    const tick = () => { const s = Math.floor((Date.now() - sim.start) / 1000); $("callTimer").textContent = `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`; };
    tick(); sim.timer = setInterval(tick, 1000);
    simNote(sim.voice ? (vc.micOK ? "Vous avez décroché. Écoutez le client, puis répondez à voix haute : le micro s'ouvre quand il a fini de parler et votre réponse part après une courte pause."
      : "Vous avez décroché. Le client parle à voix haute ; ce navigateur n'offre pas la dictée, répondez au clavier (Chrome, Edge ou Safari permettent de répondre à la voix).")
      : isTsa() ? "Vous avez décroché. Votre interlocuteur parle en premier ; répondez comme en situation réelle. Cas entièrement fictif."
      : "Vous avez décroché. Le client parle en premier ; répondez-lui comme au téléphone.");
    updateSimComposer();
    simTurn("L'appel commence : la réceptionniste vient de décrocher. Dis ta première réplique de client.");
  }

  async function simAsk(payload, onText, signal) {
    if (!cfg.apiUrl) throw new Error("L'assistant n'est pas encore activé.");
    const res = await apiFetch({
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ ...payload, role, mode: "simulation", tier, prenom, level, voix: sim.voice || undefined, genre: sim.voice && sim.genre ? sim.genre : undefined }),
      signal,
    });
    if (!res.ok) {
      let msg = "La simulation n'a pas pu continuer. Réessayez.";
      try { msg = (await res.json()).error || msg; } catch {}
      if (res.status === 401) askCode(true);
      if (res.status === 403 && isTsa()) tsaDenied(msg);
      throw new Error(msg);
    }
    const reader = res.body.getReader(); const dec = new TextDecoder();
    let text = "";
    let idle = setTimeout(() => sim.ctl?.abort(), 60000);
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        clearTimeout(idle); idle = setTimeout(() => sim.ctl?.abort(), 60000);
        text += dec.decode(value, { stream: true });
        onText(text);
      }
    } finally { clearTimeout(idle); }
    return text;
  }

  // Ce que dit le client : sans le bloc de choix ni le signal de fin d'appel
  const speech = (t) => t.replace(/```[\s\S]*?(```|$)/g, "").replace(/\{\s*"options"[\s\S]*$/, "").replace(/\[\s*FIN D['’]APPEL\s*\]/gi, "").trim();
  function parseChoices(raw) {
    const m = raw.match(/```\s*choix\s*([\s\S]*?)```/i) || raw.match(/(\{\s*"options"[\s\S]*\})/);
    if (!m) return [];
    try { const o = JSON.parse(m[1]); return Array.isArray(o.options) ? o.options.map(String).filter(Boolean).slice(0, 4) : []; } catch { return []; }
  }
  function showChoices(bubble, options) {
    document.querySelectorAll(".sim-choices").forEach((x) => x.querySelectorAll("button").forEach((y) => (y.disabled = true)));
    const box = document.createElement("div"); box.className = "sim-choices";
    const lab = document.createElement("div"); lab.className = "sim-choices-lab"; lab.textContent = "Choisissez votre réponse (ou écrivez la vôtre)";
    box.append(lab);
    options.forEach((o, k) => {
      const btn = document.createElement("button"); btn.type = "button"; btn.className = "sim-choice";
      btn.innerHTML = `<i>${String.fromCharCode(65 + k)}</i>`; btn.append(document.createTextNode(o));
      btn.onclick = () => {
        box.querySelectorAll("button").forEach((y) => (y.disabled = true)); btn.classList.add("picked");
        $("q").value = o; simReply();
      };
      box.append(btn);
    });
    bubble.parentElement.append(box); toBottom();
  }

  async function simTurn(learnerText) {
    if (!sim.active || sim.ended) return;
    sim.ctl?.abort();
    sim.ctl = new AbortController();
    const myCtl = sim.ctl;
    const b = clientBubble();
    const histForCall = sim.turns.slice(-16);
    try {
      const raw = await simAsk({ phase: "client", scenario: `${sim.type[0]} — ${sim.type[1]}`, question: learnerText, history: histForCall },
        (t) => { const clean = speech(t); if (clean) { b.textContent = clean; voiceFeed(clean, false); } if (nearBottom()) toBottom(); }, myCtl.signal);
      if (myCtl !== sim.ctl) return;
      const hungUp = /\[\s*FIN D['’]APPEL\s*\]/i.test(raw);
      const clean = speech(raw);
      const choices = hungUp ? [] : parseChoices(raw);
      b.textContent = clean || "…";
      sim.turns.push({ role: "user", content: learnerText }, { role: "assistant", content: clean });
      sim.log.push({ who: isTsa() ? "Interlocuteur" : "Client", text: clean });
      if (sim.voice) {
        voiceFeed(clean, true);
        // Le client finit sa phrase avant de raccrocher ; sinon le micro s'ouvre quand il a fini
        voiceAfterSpeech(() => {
          if (myCtl !== sim.ctl && sim.ctl) return;
          if (hungUp) { simNote("Le client a raccroché."); endCall(); }
          else voiceListen();
        });
        if (!hungUp && choices.length) showChoices(b, choices);
      }
      else if (hungUp) { simNote("Le client a raccroché."); endCall(); }
      else if (choices.length) showChoices(b, choices);
    } catch (e) {
      if (myCtl !== sim.ctl) return;
      b.textContent = e.name === "AbortError" ? "(le client n'a pas répondu à temps)" : e.message;
      b.classList.add("err");
    } finally {
      if (myCtl === sim.ctl) sim.ctl = null;
      updateSimComposer();
      if (sim.active && !sim.ended && !sim.voice) $("q").focus();
    }
  }

  function simReply() {
    const t = $("q").value.trim();
    if (!t || !sim.active || sim.ended) return;
    voiceStopListening();
    try { dictCancel(); } catch {}
    $("q").value = ""; autosize();
    document.querySelectorAll(".sim-choices button").forEach((y) => (y.disabled = true));
    learnerBubble(t);
    sim.log.push({ who: "Apprenant", text: t });
    simTurn(t);
  }

  function endCall() {
    if (!sim.active || sim.ended) return;
    sim.ended = true;
    voiceHalt();
    sim.ctl?.abort(); sim.ctl = null;
    clearInterval(sim.timer); $("callBar").hidden = true;
    document.body.classList.remove("in-call");
    updateSimComposer();
    const answered = sim.log.some((l) => l.who === "Apprenant");
    if (!answered) { simNote("Appel terminé avant votre première réponse : pas de rétroaction cette fois."); simEndActions(); return; }
    simFeedback();
  }

  async function simFeedback() {
    const m = document.createElement("div"); m.className = "msg a";
    const av = document.createElement("div"); av.className = "av"; av.innerHTML = `<img src="${avatarSrc()}" alt="">`;
    const col = document.createElement("div"); col.className = "a-col";
    const who = document.createElement("div"); who.className = "who"; who.textContent = "Rétroaction";
    const box = document.createElement("section"); box.className = "box-learn";
    box.innerHTML = `<div class="box-head">${SVG_BOOK}Rétroaction · scénario « ${esc(sim.type[0])} »</div><div class="box-body"><span class="thinking-line"><span class="typing" aria-hidden="true"><i></i><i></i><i></i></span>Analyse de votre appel…</span></div>`;
    col.append(who, box); m.append(av, col); $("simThread").append(m); toBottom();
    const body = box.querySelector(".box-body");
    const transcript = `Scénario : ${sim.type[0]} (${sim.type[1]})\nNiveau : ${LEVEL_NAMES[sim.level || level]}\n${sim.voice && vc.micOK ? "Mode : appel à la voix ; les réponses de l'apprenant sont une transcription automatique de sa voix. N'évalue ni l'orthographe ni la ponctuation, et ignore les petites erreurs de transcription.\n" : ""}\n` + sim.log.map((l) => `${l.who} : ${l.text}`).join("\n");
    sim.ctl = new AbortController();
    const myCtl = sim.ctl;
    try {
      const t = await simAsk({ phase: "bilan", question: transcript }, (x) => { body.innerHTML = md(x); }, myCtl.signal);
      body.innerHTML = md(t);
      body.querySelectorAll("p").forEach((p) => { if (/⚠️/.test(p.textContent)) p.classList.add("fb-alert"); });
      body.querySelectorAll("h3").forEach((h) => {
        const x = h.textContent.toLowerCase();
        h.classList.add(/fort/.test(x) ? "fb-good" : /amélior/.test(x) ? "fb-improve" : /modèle/.test(x) ? "fb-model" : "fb");
      });
    } catch (e) {
      if (myCtl === sim.ctl) body.innerHTML = `<p class="err">${esc(e.name === "AbortError" ? "Rétroaction interrompue." : e.message)}</p>`;
    } finally {
      if (myCtl === sim.ctl) { sim.ctl = null; simEndActions(); requestAnimationFrame(() => toTopOf(m)); }
    }
  }

  function simEndActions() {
    sim.active = false;
    const a = document.createElement("div"); a.className = "sim-end-actions";
    const again = document.createElement("button"); again.type = "button"; again.className = "qz-next"; again.textContent = "Recevoir un autre appel";
    again.onclick = () => { a.remove(); ringIn(); };
    const setup = document.createElement("button"); setup.type = "button"; setup.className = "ghost"; setup.textContent = "Changer le niveau ou le type d'appel";
    setup.onclick = () => stopSim(true);
    const quit = document.createElement("button"); quit.type = "button"; quit.className = "ghost"; quit.textContent = "Quitter la simulation";
    quit.onclick = () => setLearn(false);
    a.append(again, setup, quit); $("simThread").append(a);
    updateSimComposer();
  }

  // Arrête tout : sonnerie, requête en cours, minuterie, conversation fictive
  function stopSim(clear) {
    stopRing();
    voiceHalt();
    sim.ctl?.abort(); sim.ctl = null;
    clearInterval(sim.timer);
    sim.active = false; sim.ended = false; sim.turns = []; sim.log = [];
    $("callBar").hidden = true;
    document.body.classList.remove("in-call");
    if (clear) { $("simThread").textContent = ""; $("simThread").hidden = true; $("simHome").hidden = false; }
  }


  /* =====================================================================
     SIMULATION À LA VOIX — le client parle, la réceptionniste répond à voix haute.
     • Si le relais a une clé Microsoft Azure Speech : voix neuronales québécoises
       et dictée Azure, identiques dans tous les navigateurs.
     • Sinon : voix et dictée du navigateur (repli automatique).
     Rien n'est conservé : l'audio sert seulement à produire la voix et le texte.
     ===================================================================== */
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  const TTS = "speechSynthesis" in window ? window.speechSynthesis : null;
  const AC = window.AudioContext || window.webkitAudioContext;
  const AZ_VOICES = [["sylvie", "Sylvie", "f"], ["antoine", "Antoine", "m"], ["jean", "Jean", "m"], ["thierry", "Thierry", "m"]];
  const vc = {
    azure: false, ttsOK: false, micOK: false, denied: false,
    voice: null, azVoice: "sylvie", spoken: 0, pending: 0, utts: [], after: null,
    gen: 0, chain: Promise.resolve(), playing: null, ttsAbort: new AbortController(),
    rec: null, recStop: null, listening: false, transcribing: false, want: false, silence: null, base: "", restarts: 0,
    ctx: null, stream: null, sttAbort: null,
  };
  function caps() {
    vc.ttsOK = vc.azure ? !!AC : !!TTS;
    vc.micOK = vc.azure ? !!(AC && navigator.mediaDevices?.getUserMedia) : !!SR;
  }
  caps();
  function setVoiceService(on) { vc.azure = !!on && !!AC; caps(); renderInput(); try { dictUI(); } catch {} }
  let inputMode = store.get("lq-input") === "voix" ? "voix" : "clavier";
  try { TTS?.getVoices(); TTS?.addEventListener?.("voiceschanged", () => TTS.getVoices()); } catch {}

  function renderInput() {
    try { renderVoiceSel(); } catch {}
    document.querySelectorAll("#inputSeg button").forEach((b) => {
      b.setAttribute("aria-checked", String(b.dataset.input === inputMode && (b.dataset.input !== "voix" || vc.ttsOK)));
      if (b.dataset.input === "voix") { b.disabled = !vc.ttsOK; b.title = vc.ttsOK ? "" : "Non disponible dans ce navigateur"; }
    });
    if (inputMode === "voix" && !vc.ttsOK) document.querySelector('#inputSeg [data-input="clavier"]')?.setAttribute("aria-checked", "true");
    $("inputHint").textContent = !vc.ttsOK ? "La voix n'est pas disponible dans ce navigateur."
      : inputMode === "clavier" ? "Vous lisez le client et tapez vos réponses."
      : vc.azure ? "Voix québécoises naturelles. Le navigateur vous demandera l'accès au micro ; des écouteurs évitent l'écho. Rien n'est conservé."
      : vc.micOK ? "Le navigateur vous demandera l'accès au micro. Utilisez des écouteurs si possible ; rien n'est enregistré."
      : "Le client parlera, mais ce navigateur n'offre pas la dictée : vous répondrez au clavier.";
  }
  document.querySelectorAll("#inputSeg button").forEach((b) => {
    b.onclick = () => { if (sim.active || b.disabled) return; inputMode = b.dataset.input; store.set("lq-input", inputMode); renderInput(); };
  });

  // ---- voix du navigateur (repli) : classement des plus naturelles aux plus « robot »
  function voiceScore(v) {
    const n = v.name;
    let sc = 0;
    if (/natural|neural/i.test(n)) sc += 60;
    else if (/online/i.test(n)) sc += 45;
    if (/premium|enhanced|amélior|siri/i.test(n)) sc += 40;
    if (/google/i.test(n)) sc += 20;
    if (/CA/i.test(v.lang)) sc += 15;
    if (/espeak|compact|eloquence|robot|novelty|grandma|grandpa|rocko|shelley|flo|eddy|reed|sandy/i.test(n)) sc -= 50;
    if (!v.localService) sc += 5;
    return sc;
  }
  function frVoices() {
    return (TTS?.getVoices() || []).filter((v) => /^fr/i.test(v.lang)).sort((a, b) => voiceScore(b) - voiceScore(a));
  }
  function voiceLabel(v) {
    const sc = voiceScore(v);
    const nm = v.name.replace(/^(Microsoft|Google)\s+/i, "").replace(/\s*-\s*French.*$/i, "").replace(/\s*\((Natural|Online)\)/gi, "").replace(/\s+Online/i, "").trim();
    const reg = /CA/i.test(v.lang) ? "Québec" : /FR/i.test(v.lang) ? "France" : /BE/i.test(v.lang) ? "Belgique" : /CH/i.test(v.lang) ? "Suisse" : v.lang;
    return `${nm} · ${reg}${sc >= 55 ? " · très naturelle" : sc >= 35 ? " · naturelle" : ""}`;
  }
  function pickBrowserVoice() {
    const all = frVoices();
    if (!all.length) return null;
    const chosen = store.get("lq-voice-name");
    if (chosen) { const v = all.find((x) => x.name === chosen); if (v) return v; }
    const top = voiceScore(all[0]);
    const best = all.filter((v) => voiceScore(v) >= top - 10);
    return best[Math.floor(Math.random() * best.length)];
  }
  function pickAzVoice() {
    const chosen = store.get("lq-az-voice");
    const v = AZ_VOICES.find(([k]) => k === chosen);
    if (v) return v;
    // Automatique : femme ou homme à parts égales, pour varier les clients
    return Math.random() < 0.5 ? AZ_VOICES[0] : AZ_VOICES[1 + Math.floor(Math.random() * 3)];
  }
  function renderVoiceSel() {
    const box = $("voicePick"), sel = $("voiceSel");
    box.hidden = inputMode !== "voix" || !vc.ttsOK;
    sel.textContent = "";
    if (vc.azure) {
      sel.append(new Option("Automatique · une voix différente à chaque appel", ""));
      AZ_VOICES.forEach(([k, n, g]) => sel.append(new Option(`${n} · ${g === "f" ? "femme" : "homme"} · Québec`, k)));
      const cur = store.get("lq-az-voice") || "";
      sel.value = AZ_VOICES.some(([k]) => k === cur) ? cur : "";
      $("voiceTip").hidden = true;
      return;
    }
    const all = frVoices();
    const cur = store.get("lq-voice-name") || "";
    sel.append(new Option(all.length ? "Automatique · la plus naturelle disponible" : "Voix française par défaut", ""));
    all.forEach((v) => sel.append(new Option(voiceLabel(v), v.name)));
    sel.value = all.some((v) => v.name === cur) ? cur : "";
    $("voiceTip").hidden = (all[0] ? voiceScore(all[0]) : 0) >= 55;
  }
  $("voiceSel").onchange = () => { store.set(vc.azure ? "lq-az-voice" : "lq-voice-name", $("voiceSel").value); };
  const SAMPLE = { f: "Oui, bonjour! Je vous appelle pour mon chien, Max. Il boite depuis hier, pis là je commence à être pas mal inquiète.",
    m: "Oui, bonjour! Je vous appelle pour mon chien, Max. Il boite depuis hier, pis là je commence à être pas mal inquiet." };
  $("voiceTest").onclick = () => {
    hushSpeech();
    ensureCtx();
    if (vc.azure) { const v = pickAzVoice(); vc.azVoice = v[0]; sayRaw(SAMPLE[v[2]], true); }
    else { vc.voice = pickBrowserVoice(); sayRaw(SAMPLE.f, true); }
  };
  try { TTS?.addEventListener?.("voiceschanged", () => { if (!vc.azure) renderVoiceSel(); }); } catch {}

  // Contexte audio créé dans un geste (Répondre / Écouter) : exigé par Safari et iOS
  function ensureCtx() {
    if (!AC) return null;
    if (!vc.ctx || vc.ctx.state === "closed") { try { vc.ctx = new AC(); } catch { vc.ctx = null; } }
    try { vc.ctx?.resume?.(); } catch {}
    return vc.ctx;
  }
  async function getMic() {
    if (vc.stream && vc.stream.getTracks().some((t) => t.readyState === "live")) return vc.stream;
    vc.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 } });
    return vc.stream;
  }
  function micDenied(e) {
    if (vc.denied) return;
    vc.denied = true; micUI();
    simNote(e && e.name === "NotFoundError" ? "Aucun micro détecté : le client parlera, vous répondrez au clavier."
      : "Accès au micro refusé : le client parlera, vous répondrez au clavier. Pour répondre à la voix, autorisez le micro pour ce site (icône à gauche de l'adresse).");
  }

  function voiceStartCall() {
    sim.voice = inputMode === "voix" && vc.ttsOK;
    document.body.classList.toggle("voice-call", sim.voice);
    $("callVoice").hidden = !sim.voice;
    hushSpeech();
    vc.spoken = 0; vc.restarts = 0;
    sim.genre = "";
    if (!sim.voice) { micUI(); return; }
    ensureCtx();
    if (vc.azure) {
      const v = pickAzVoice(); vc.azVoice = v[0]; sim.genre = v[2];
    } else {
      vc.voice = pickBrowserVoice();
      try { TTS.cancel(); const u = new SpeechSynthesisUtterance(" "); u.volume = 0; TTS.speak(u); } catch {}
    }
    // Accès au micro demandé tout de suite, pendant le geste « Répondre »
    if (vc.micOK && !vc.denied && navigator.mediaDevices?.getUserMedia) {
      getMic().then((st) => { if (!vc.azure) { st.getTracks().forEach((t) => t.stop()); vc.stream = null; } })
        .catch((e) => { if (e && /NotAllowed|NotFound|Security/.test(e.name)) micDenied(e); });
    }
    micUI();
  }

  // Ce qui se lit à voix haute : sans indications de jeu, emojis ni guillemets
  const forTTS = (t) => t.replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}️]/gu, "").replace(/\.{3,}/g, "…").replace(/\s+-\s+/g, ", ").replace(/\([^)]*\)/g, " ").replace(/\*[^*]*\*/g, " ").replace(/[«»"“”_#>]/g, " ").replace(/\s+/g, " ").replace(/\s+([.,!?…])/g, "$1").trim();

  // Lit la réplique d'un seul souffle ; une très longue réplique commence plus tôt
  function voiceFeed(clean, final) {
    if (!sim.voice || !sim.active || sim.ended) return;
    if (vc.spoken === -1) vc.spoken = 0;
    const rest = clean.slice(vc.spoken);
    let cut = 0;
    if (final) cut = rest.length;
    else if (rest.length > 180) { const re = /[.!?…]+[»")]?\s+/g; let m; while ((m = re.exec(rest))) cut = m.index + m[0].length; }
    if (!cut) return;
    vc.spoken += cut;
    say(rest.slice(0, cut));
    if (final) vc.spoken = -1;
  }
  function say(text) { sayRaw(text, false); }
  // Les morceaux se téléchargent en parallèle mais se lisent dans l'ordre
  function sayRaw(text, preview) {
    const t = forTTS(text);
    if (!t) return;
    if (!preview) voiceStopListening();
    vc.pending++; if (!preview) talking(true);
    const gen = vc.gen;
    const bufP = vc.azure ? fetchTTS(t, vc.azVoice).catch(() => null) : Promise.resolve(null);
    vc.chain = vc.chain.then(async () => {
      if (gen !== vc.gen) return;
      const buf = await bufP;
      if (gen !== vc.gen) return;
      if (buf) await playBuf(buf);
      else if (TTS) await browserSay(t); // repli si Azure ne répond pas
    }).catch(() => {}).then(() => {
      if (gen !== vc.gen) return;
      vc.pending = Math.max(0, vc.pending - 1);
      if (!vc.pending) { talking(false); const f = vc.after; vc.after = null; f?.(); }
    });
  }
  async function fetchTTS(text, voice) {
    const r = await apiFetch({
      method: "POST", signal: vc.ttsAbort.signal,
      headers: { "content-type": "application/json", "x-agent-code": code, "x-agent-mode": "tts" },
      body: JSON.stringify({ text, voice }),
    });
    if (!r.ok) throw new Error("tts");
    const data = await r.arrayBuffer();
    const ctx = ensureCtx();
    return await new Promise((res, rej) => ctx.decodeAudioData(data, res, rej));
  }
  function playBuf(buf) {
    return new Promise((res) => {
      const ctx = ensureCtx();
      let src;
      try { src = ctx.createBufferSource(); src.buffer = buf; src.connect(ctx.destination); } catch { return res(); }
      vc.playing = src;
      const fin = () => { if (vc.playing === src) vc.playing = null; res(); };
      src.onended = fin;
      setTimeout(fin, buf.duration * 1000 + 2500);
      try { src.start(); } catch { fin(); }
    });
  }
  function browserSay(t) {
    return new Promise((res) => {
      const u = new SpeechSynthesisUtterance(t);
      if (vc.voice) { u.voice = vc.voice; u.lang = vc.voice.lang; } else u.lang = "fr-CA";
      u.rate = 1; u.pitch = 1;
      vc.utts.push(u); // garder une référence (sinon Chrome perd la fin)
      let ok = false;
      const end = () => { if (ok) return; ok = true; vc.utts = vc.utts.filter((x) => x !== u); res(); };
      u.onend = end; u.onerror = end;
      u.onstart = () => setTimeout(end, 4000 + t.length * 110);
      setTimeout(end, 20000 + t.length * 110);
      try { TTS.speak(u); } catch { end(); }
    });
  }
  // Coupe net la voix en cours et tout ce qui attendait
  function hushSpeech() {
    vc.gen++; vc.pending = 0; vc.after = null; vc.chain = Promise.resolve();
    try { vc.ttsAbort.abort(); } catch {}
    vc.ttsAbort = new AbortController();
    try { TTS?.cancel(); } catch {}
    try { vc.playing?.stop(); } catch {}
    vc.playing = null; vc.utts = [];
    talking(false);
  }
  function voiceAfterSpeech(f) { if (!vc.pending) f(); else vc.after = f; }
  function talking(on) {
    $("callBar").classList.toggle("talking", on);
    micUI();
  }

  function voiceListen() {
    if (!sim.voice || !vc.micOK || vc.denied || !sim.active || sim.ended || vc.listening || vc.transcribing) return;
    if (vc.pending) hushSpeech();
    vc.base = $("q").value.trim() ? $("q").value.trim() + " " : "";
    if (vc.azure) return azureListen();
    let r;
    try { r = new SR(); } catch { return; }
    r.lang = "fr-CA"; r.continuous = true; r.interimResults = true; r.maxAlternatives = 1;
    vc.rec = r; vc.listening = true; vc.want = true;
    r.onresult = (e) => {
      vc.restarts = 0;
      let fin = "", interim = "";
      for (let i = 0; i < e.results.length; i++) {
        const x = e.results[i];
        if (x.isFinal) fin += x[0].transcript + " "; else interim += x[0].transcript;
      }
      const txt = (vc.base + fin + interim).replace(/\s+/g, " ").trim();
      $("q").value = txt ? txt.charAt(0).toUpperCase() + txt.slice(1) : ""; autosize();
      clearTimeout(vc.silence);
      vc.silence = setTimeout(() => { if (vc.listening && $("q").value.trim()) simReply(); }, interim ? 2300 : 1500);
    };
    r.onerror = (e) => {
      if (e.error === "not-allowed" || e.error === "service-not-allowed" || e.error === "audio-capture") {
        vc.want = false; micDenied({ name: e.error === "audio-capture" ? "NotFoundError" : "NotAllowedError" });
      }
    };
    r.onend = () => {
      vc.listening = false; vc.rec = null;
      if (vc.want && sim.active && !sim.ended && !vc.denied && vc.restarts < 6) { vc.restarts++; setTimeout(voiceListen, 200); return; }
      vc.want = false; micUI();
    };
    try { r.start(); } catch { vc.listening = false; vc.rec = null; }
    micUI();
  }

  // Dictée Azure : enregistre la voix, détecte la fin de la réplique (silence), envoie le son au relais
  async function azureListen() {
    vc.listening = true; vc.want = true; micUI();
    let stream;
    try { stream = await getMic(); } catch (e) { vc.listening = false; vc.want = false; micDenied(e); return; }
    if (!vc.want || !sim.active || sim.ended) { vc.listening = false; micUI(); return; }
    const ctx = ensureCtx();
    const src = ctx.createMediaStreamSource(stream);
    const proc = ctx.createScriptProcessor(4096, 1, 1);
    const rate = ctx.sampleRate;
    const chunks = [], pre = [];
    const t0 = performance.now();
    let started = false, lastVoice = 0, noise = 0.006, ended = false;
    const finish = async (send) => {
      if (ended) return; ended = true;
      proc.onaudioprocess = null;
      try { src.disconnect(); proc.disconnect(); } catch {}
      vc.recStop = null; vc.listening = false;
      $("mic").style.removeProperty("--lvl");
      if (!send || !started || !vc.want) { vc.want = false; micUI(); return; }
      vc.want = false; vc.transcribing = true; micUI();
      const ctl = (vc.sttAbort = new AbortController());
      try {
        const r = await apiFetch({
          method: "POST", signal: ctl.signal,
          headers: { "content-type": "audio/wav", "x-agent-code": code, "x-agent-mode": "stt" },
          body: encodeWav(chunks, rate),
        });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(j.error || "Dictée momentanément indisponible.");
        vc.transcribing = false; micUI();
        if (!sim.active || sim.ended) return;
        const txt = String(j.text || "").trim();
        if (!txt) { $("simHint").textContent = "Je n'ai pas bien entendu : reprenez votre phrase."; return voiceListen(); }
        $("q").value = (vc.base + txt).trim(); autosize();
        simReply();
      } catch (e) {
        vc.transcribing = false; micUI();
        if (e.name !== "AbortError" && sim.active && !sim.ended) simNote(`${e.message} Répondez au clavier ou touchez le micro pour réessayer.`);
      }
    };
    proc.onaudioprocess = (e) => {
      if (ended) return;
      const d = new Float32Array(e.inputBuffer.getChannelData(0));
      let sum = 0; for (let i = 0; i < d.length; i++) sum += d[i] * d[i];
      const rms = Math.sqrt(sum / d.length);
      const now = performance.now();
      if (!started) { noise = noise * 0.9 + Math.min(rms, 0.05) * 0.1; pre.push(d); if (pre.length > 4) pre.shift(); }
      const thr = Math.max(0.012, noise * 2.8);
      if (rms > thr) { if (!started) { started = true; chunks.push(...pre); } lastVoice = now; }
      if (started) chunks.push(d);
      $("mic").style.setProperty("--lvl", Math.min(1, rms * 14).toFixed(2));
      if (started && now - lastVoice > 1300) finish(true);       // fin de la réplique
      else if (started && now - t0 > 55000) finish(true);        // 55 s au maximum
      else if (!started && now - t0 > 25000) finish(false);      // personne ne parle : on attend le micro
    };
    src.connect(proc); proc.connect(ctx.destination); // sortie muette, nécessaire pour que l'enregistrement tourne
    vc.recStop = finish;
    micUI();
  }
  // WAV PCM 16 bits, 16 kHz, mono (format attendu par la dictée Azure)
  function encodeWav(chunks, rate) {
    const total = chunks.reduce((n, c) => n + c.length, 0);
    const ratio = rate / 16000;
    const n = Math.floor(total / ratio);
    const flat = new Float32Array(total);
    let o = 0; for (const c of chunks) { flat.set(c, o); o += c.length; }
    const buf = new ArrayBuffer(44 + n * 2), v = new DataView(buf);
    const w = (p, s) => { for (let i = 0; i < s.length; i++) v.setUint8(p + i, s.charCodeAt(i)); };
    w(0, "RIFF"); v.setUint32(4, 36 + n * 2, true); w(8, "WAVE"); w(12, "fmt ");
    v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
    v.setUint32(24, 16000, true); v.setUint32(28, 32000, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
    w(36, "data"); v.setUint32(40, n * 2, true);
    for (let i = 0; i < n; i++) {
      const a = Math.floor(i * ratio), b = Math.min(total, Math.floor((i + 1) * ratio));
      let s = 0; for (let k = a; k < b; k++) s += flat[k];
      const x = Math.max(-1, Math.min(1, b > a ? s / (b - a) : flat[a] || 0));
      v.setInt16(44 + i * 2, x < 0 ? x * 0x8000 : x * 0x7fff, true);
    }
    return new Blob([buf], { type: "audio/wav" });
  }

  function voiceStopListening() {
    vc.want = false; clearTimeout(vc.silence);
    if (vc.rec) { try { vc.rec.abort(); } catch {} }
    vc.rec = null;
    vc.recStop?.(false);
    vc.listening = false;
    micUI();
  }
  function voiceHalt() {
    voiceStopListening();
    try { vc.sttAbort?.abort(); } catch {}
    vc.transcribing = false;
    hushSpeech();
    vc.spoken = 0;
    try { vc.stream?.getTracks().forEach((t) => t.stop()); } catch {}
    vc.stream = null;
    $("callBar").classList.remove("talking");
    document.body.classList.remove("voice-call");
    $("callVoice").hidden = true;
    micUI();
  }

  const SIM_HINT = $("simHint").textContent;
  function micUI() {
    const mic = $("mic"), hint = $("simHint");
    const show = !!(sim.voice && sim.active && !sim.ended && vc.micOK && !vc.denied);
    mic.hidden = !show;
    $("form").classList.toggle("listening", show && vc.listening);
    hint.classList.toggle("on", show && vc.listening);
    if (!sim.voice || !sim.active || sim.ended) { hint.textContent = SIM_HINT; return; }
    const state = vc.pending ? "speaking" : vc.transcribing ? "busy" : vc.listening ? "listening" : "idle";
    mic.dataset.state = state;
    mic.disabled = state === "busy";
    mic.setAttribute("aria-label", state === "listening" ? (vc.azure ? "J'ai fini de parler" : "Arrêter l'écoute") : state === "speaking" ? "Interrompre le client et parler" : state === "busy" ? "Transcription en cours" : "Parler");
    mic.title = mic.getAttribute("aria-label");
    hint.textContent = state === "speaking" ? "🔊 Le client parle… écoutez-le"
      : state === "busy" ? "✍️ Transcription de votre réponse…"
      : state === "listening" ? "🎙 À vous : parlez, la réponse part après une courte pause"
      : !show ? "Répondez au clavier"
      : "Touchez le micro pour parler, ou écrivez votre réponse";
  }
  $("mic").onclick = () => {
    if (vc.listening) {
      if (vc.azure && vc.recStop) { vc.recStop(true); return; } // envoie tout de suite ce qui a été dit
      voiceStopListening(); $("q").focus();
    } else { ensureCtx(); voiceListen(); }
  };
  // Si la réceptionniste se met à taper, on arrête la dictée pour ne pas écraser son texte
  $("q").addEventListener("keydown", (e) => { if (vc.listening && e.key !== "Enter") voiceStopListening(); });
  renderInput();

  /* ---------- dictée : poser sa question à la voix dans la zone de saisie principale ----------
     Le texte dicté s'écrit dans la zone ; la personne le relit, puis l'envoie elle-même. */
  const dict = { on: false, busy: false, rec: null, stop: null, silence: null, base: "" };
  const dictAvailable = () => !!SR || (vc.azure && !!AC && !!navigator.mediaDevices?.getUserMedia);
  function dictUI() {
    const b = $("dictBtn");
    const show = dictAvailable() && !document.body.classList.contains("voice-call") && !$("q").disabled;
    b.hidden = !show;
    b.dataset.state = dict.on ? "listening" : dict.busy ? "busy" : "idle";
    const lab = dict.on ? "Arrêter la dictée" : dict.busy ? "Transcription…" : "Dicter votre question";
    b.setAttribute("aria-label", lab); b.title = lab;
    b.querySelector(".dict-l").textContent = dict.on ? "Arrêter" : dict.busy ? "…" : "Voix";
    if (!document.body.classList.contains("voice-call")) $("form").classList.toggle("listening", dict.on);
  }
  function dictHint(t) {
    const q = $("q"); const keep = q.placeholder; q.placeholder = t;
    clearTimeout(dictHint.t); dictHint.t = setTimeout(() => { if (q.placeholder === t) q.placeholder = keep; }, 4000);
  }
  function dictWrite(txt) {
    const v = (dict.base + txt).replace(/\s+/g, " ").trimStart();
    $("q").value = v ? v.charAt(0).toUpperCase() + v.slice(1) : ""; autosize();
  }
  // Envoi de la question : on coupe la dictée sans laisser de texte arriver après coup
  function dictCancel() {
    if (!dict.on) return;
    clearTimeout(dict.silence);
    if (dict.rec) { dict.rec.onresult = null; try { dict.rec.abort(); } catch {} }
    dict.stop?.(false);
  }
  function dictStop() {
    clearTimeout(dict.silence);
    if (dict.rec) { try { dict.rec.stop(); } catch {} }
    dict.stop?.(true);
  }
  async function dictStart() {
    if (dict.on || dict.busy) return;
    const q = $("q");
    dict.base = q.value.trim() ? q.value.trim() + " " : "";
    if (SR) {
      let r; try { r = new SR(); } catch { return; }
      r.lang = "fr-CA"; r.continuous = true; r.interimResults = true;
      dict.rec = r; dict.on = true; dictUI();
      r.onresult = (e) => {
        let fin = "", interim = "";
        for (let i = 0; i < e.results.length; i++) { const x = e.results[i]; if (x.isFinal) fin += x[0].transcript + " "; else interim += x[0].transcript; }
        dictWrite(fin + interim);
        clearTimeout(dict.silence); dict.silence = setTimeout(dictStop, 2500); // pause = fin de la dictée
      };
      r.onerror = (e) => { if (/not-allowed|service-not-allowed|audio-capture/.test(e.error)) dictHint("Micro refusé : autorisez-le pour ce site, ou écrivez votre question."); };
      r.onend = () => { dict.on = false; dict.rec = null; dictUI(); q.focus(); };
      try { r.start(); } catch { dict.on = false; dict.rec = null; dictUI(); }
      dict.silence = setTimeout(dictStop, 8000); // personne ne parle
      return;
    }
    // Navigateurs sans dictée intégrée : enregistrement court transcrit par Azure, via le relais
    let stream;
    try { stream = await getMic(); } catch { dictHint("Micro refusé ou absent : écrivez votre question."); return; }
    const ctx = ensureCtx();
    const src = ctx.createMediaStreamSource(stream);
    const proc = ctx.createScriptProcessor(4096, 1, 1);
    const chunks = [], pre = []; const t0 = performance.now();
    let started = false, last = 0, noise = 0.006, ended = false;
    dict.on = true; dictUI();
    const finish = async (send) => {
      if (ended) return; ended = true;
      proc.onaudioprocess = null; try { src.disconnect(); proc.disconnect(); } catch {}
      try { stream.getTracks().forEach((t) => t.stop()); } catch {} vc.stream = null;
      dict.on = false; dict.stop = null; $("dictBtn").style.removeProperty("--lvl");
      if (!send || !started) { dictUI(); return; }
      dict.busy = true; dictUI();
      try {
        const r = await apiFetch({ method: "POST", headers: { "content-type": "audio/wav", "x-agent-code": code, "x-agent-mode": "stt" }, body: encodeWav(chunks, ctx.sampleRate) });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(j.error || "Dictée indisponible.");
        if (j.text) dictWrite(j.text); else dictHint("Je n'ai pas bien entendu. Réessayez.");
      } catch (e) { dictHint(e.message); }
      finally { dict.busy = false; dictUI(); q.focus(); }
    };
    dict.stop = finish;
    proc.onaudioprocess = (e) => {
      if (ended) return;
      const d = new Float32Array(e.inputBuffer.getChannelData(0));
      let sum = 0; for (let i = 0; i < d.length; i++) sum += d[i] * d[i];
      const rms = Math.sqrt(sum / d.length), now = performance.now();
      if (!started) { noise = noise * 0.9 + Math.min(rms, 0.05) * 0.1; pre.push(d); if (pre.length > 4) pre.shift(); }
      if (rms > Math.max(0.012, noise * 2.8)) { if (!started) { started = true; chunks.push(...pre); } last = now; }
      if (started) chunks.push(d);
      $("dictBtn").style.setProperty("--lvl", Math.min(1, rms * 14).toFixed(2));
      if ((started && now - last > 1800) || now - t0 > 60000) finish(true);
      else if (!started && now - t0 > 10000) finish(false);
    };
    src.connect(proc); proc.connect(ctx.destination);
  }
  $("dictBtn").onclick = () => { if (dict.on) dictStop(); else { ensureCtx(); dictStart(); } };
  $("q").addEventListener("keydown", (e) => { if (dict.on && e.key !== "Enter") dictStop(); });
  new MutationObserver(dictUI).observe(document.body, { attributes: true, attributeFilter: ["class"] });
  new MutationObserver(dictUI).observe($("q"), { attributes: true, attributeFilter: ["disabled"] });
  dictUI();

  $("learnToggle").onclick = () => setLearn(!sim.on);
  $("learnExit").onclick = () => setLearn(false);
  $("simCall").onclick = ringIn;
  $("ringAnswer").onclick = answerCall;
  $("ringDecline").onclick = declineCall;
  $("muteBtn").onclick = toggleMute;
  $("ringMute").onclick = toggleMute;
  $("hangup").onclick = () => { simNote("Vous avez terminé l'appel."); endCall(); };
  muteLabel();
  renderLevel();
  renderThemes();

  /* ---------- déconnexion : efface prénom, code d'équipe et réglages de cet appareil ---------- */
  let outTimer = null;
  $("logout").onclick = () => {
    const btn = $("logout");
    if (!btn.classList.contains("confirm")) {
      btn.classList.add("confirm"); btn.querySelector("span").textContent = "Confirmer la déconnexion";
      outTimer = setTimeout(() => { btn.classList.remove("confirm"); btn.querySelector("span").textContent = "Se déconnecter"; }, 4000);
      return;
    }
    clearTimeout(outTimer);
    ctl?.abort();
    try { stopSim(true); } catch {}
    try { Object.keys(localStorage).filter((k) => k.startsWith("lq-") && !k.startsWith("lq-hist-")).forEach((k) => localStorage.removeItem(k)); } catch {}
    try { sessionStorage.clear(); } catch {}
    location.reload();
  };

  /* ---------- actions dans les réponses ---------- */
  document.addEventListener("click", async (e) => {
    const t = e.target.closest("[data-act]");
    if (!t) return;
    const body = t.closest(".body");
    if (t.dataset.act === "toggle-learn" && body) {
      const sec = t.closest(".box-learn");
      const open = !sec.classList.contains("is-open");
      sec.classList.toggle("is-open", open);
      body.dataset.open = open ? "1" : "";
      sec.querySelectorAll('[data-act="toggle-learn"]').forEach((x) => x.setAttribute("aria-expanded", String(open)));
      const lbl = sec.querySelector(".more span"); if (lbl) lbl.textContent = open ? "Réduire" : "Lire la réponse complète";
      if (!open) toTopOf(sec);
      fitPreview(body);
    }
    if (t.dataset.act === "copy-live" && body) {
      const sp = t.querySelector("span");
      try { await navigator.clipboard.writeText(body.dataset.live || ""); sp.textContent = "Copié ✓"; t.classList.add("ok"); }
      catch { sp.textContent = "Copie impossible"; }
      setTimeout(() => { sp.textContent = "Copier"; t.classList.remove("ok"); }, 2000);
    }
  });

  /* ---------- en-tête : titre de la conversation et mode ---------- */
  function setConvTitle() {
    const learn = document.body.classList.contains("learn");
    $("modeLong").textContent = isTsa() ? (learn ? "Mode TSA — Simulation" : "Mode TSA — Soutien clinique") : (learn ? "Réception — Simulation" : "Réception — Assistant d'accueil");
    $("modeShort").textContent = isTsa() ? (learn ? "TSA · Simulation" : "Mode TSA") : (learn ? "Simulation" : "Réception");
    if (document.body.classList.contains("journey")) { $("convTitle").textContent = "Parcours de l'apprenant"; return; }
    if (document.body.classList.contains("histv")) { $("convTitle").textContent = "Historique"; return; }
    if (document.body.classList.contains("favv")) { $("convTitle").textContent = "Mes favoris"; return; }
    if (learn) { $("convTitle").textContent = isTsa() ? "Simulation complète · cas fictifs" : "Simulation complète · appels fictifs"; return; }
    const first = $("thread").querySelector(".msg.q .qbub");
    const t = first ? first.textContent.replace(/\s+/g, " ").trim() : "";
    $("convTitle").textContent = t ? (t.length > 70 ? t.slice(0, 68) + "…" : t) : "Nouvelle conversation";
  }
  new MutationObserver(setConvTitle).observe($("thread"), { childList: true });
  new MutationObserver(setConvTitle).observe(document.body, { attributes: true, attributeFilter: ["class"] });
  setConvTitle();

  /* ---------- état vide : accueil + saisie centrés, suggestions sous la saisie ---------- */
  const mainEl = document.querySelector(".main");
  function syncEmpty() { mainEl.classList.toggle("is-empty", !$("empty").hidden && !document.body.classList.contains("learn")); }
  new MutationObserver(syncEmpty).observe($("empty"), { attributes: true, attributeFilter: ["hidden"] });
  new MutationObserver(syncEmpty).observe(document.body, { attributes: true, attributeFilter: ["class"] });
  syncEmpty();

  // Exemples qui défilent dans la zone de saisie vide (s'arrêtent dès qu'on écrit ou qu'on clique)
  const PH_TSA = ["Décrivez le cas ou la tâche…", "Ex. : transmission SBAR pour un chat hospitalisé", "Ex. : que veut dire « CRT » ?", "Ex. : liste de surveillance post-anesthésie", "Ex. : expliquer au client des consignes validées"];
  const PH = ["Posez votre question ici…", "Ex. : un client conteste sa facture", "Ex. : que veut dire « NPO » ?", "Ex. : un chien a mangé du chocolat", "Ex. : comment annoncer un retard ?"];
  let phI = 0;
  setInterval(() => {
    const q = $("q");
    if (document.activeElement === q || q.value || q.disabled || document.body.classList.contains("learn") || document.body.classList.contains("nutri")) return;
    if (isNarrow()) { q.placeholder = basePH(); return; } // téléphone : texte court, pas de défilement d'exemples
    const L = isTsa() ? PH_TSA : PH; phI = (phI + 1) % L.length; q.placeholder = L[phI];
  }, 3500);
  $("q").placeholder = basePH();
  matchMedia("(max-width: 520px)").addEventListener?.("change", () => { if (!sim.on) $("q").placeholder = basePH(); });
  if (matchMedia("(min-width: 861px)").matches) setTimeout(() => { if (!$("codebox").hidden) return; $("q").focus(); }, 400);

  /* ---------- démarrage ---------- */
  showName();
  if (store.get("lq-learn") === "1") setLearn(true);
  fetch("config.json", { cache: "no-cache" })
    .then((r) => r.json())
    .then((c) => { cfg = { ...cfg, ...c }; })
    .catch(() => {})
    .then(() => {
      applyCfg();
      if (!cfg.apiUrl && !ACCOUNT_HOST) { setStatus("bad", "Assistant pas encore activé"); return; }
      const h0 = {}; if (tsaCode) h0["x-tsa-code"] = tsaCode;
      const statusP = ACCOUNT_HOST
        ? fetch("/api/agent", { credentials: "same-origin", cache: "no-store" }).then(async (r) => {
            let d = null; try { d = await r.json(); } catch {}
            if (r.status === 401 || r.status === 403) { leavePortal(r.status, d && d.code); return "stop"; }
            if (!r.ok || !d || !d.account) return null;
            accountMode = true; account = d.account; cfg.apiUrl = "/api/agent";
            return d;
          })
        : apiFetch({ headers: h0 }).then((r) => (r.ok ? r.json() : null));
      return statusP.then((s) => {
        if (s === "stop") return;
        if (ACCOUNT_HOST) document.documentElement.classList.remove("lq-gate");
        if (accountMode) applyAccount();
        if (!s) { setStatus("bad", "Service indisponible"); return; }
        if (!s.ready) { setStatus("bad", "Clé API manquante"); return; }
        setStatus("ok", "En ligne");
        setVoiceService(!!s.voice);
        tsaEnabled = !!s.tsa; tsaVerified = !!s.tsaOk;
        // Configuration enregistrée dans la page de configuration (prioritaire sur config.json)
        if (s.pub) {
          const pick = (o) => Object.fromEntries(Object.entries(o || {}).filter(([, v]) => v !== undefined && v !== null && v !== "" && !(Array.isArray(v) && !v.length)));
          cfg = { ...cfg, ...pick(s.pub.reception) };
          if (s.pub.etablissement) cfg.etablissement = s.pub.etablissement;
          if (s.pub.logo !== undefined) cfg.logo = s.pub.logo;
          cfg.tsa = { ...(cfg.tsa || {}), ...pick(s.pub.tsa) };
          applyCfg();
        }
        // Mode compte : nom (et logo, s'il est défini) de l'établissement de la personne connectée
        if (accountMode && account.org) {
          cfg.etablissement = account.org.name;
          if (account.org.logo) cfg.logo = account.org.logo;
          applyCfg();
        }
        $("adminLink").hidden = !s.admin;
        // Logo : en mode compte, les responsables de l'établissement le gèrent dans Mon établissement ; sinon, page Admin
        setLogoEdit(accountMode ? (account && ["owner", "admin", "platform"].includes(account.role) ? "compte.html#etablissement" : "") : (s.admin ? "admin.html" : ""));
        if (!tsaVerified && tsaCode) { tsaCode = ""; store.del("lq-tsa-code"); }
        $("tsaLock").hidden = tsaVerified;
        if (store.get("lq-role") === "tsa" && tsaVerified && !isTsa()) switchRole("tsa", { silent: true });
        needsCode = !!s.needsCode;
        if ((needsCode && !code) || !prenom) askCode(false);
        // Avis de confidentialité après la fenêtre du prénom (jamais les deux à la fois)
        if (s.pub && s.pub.privacy) setPrivacy(s.pub.privacy);
      }).catch(() => { document.documentElement.classList.remove("lq-gate"); setStatus("bad", "Service injoignable"); });
    });

  // Mode compte : prénom du compte, établissement affiché, déconnexion réelle de la session.
  function applyAccount() {
    tsaCode = ""; store.del("lq-tsa-code"); store.del("lq-agent-code"); code = "";
    try { favInit(); } catch {}
    // Le prénom du compte est celui utilisé partout dans le portail (salutation, réponses personnalisées).
    const fn = cleanName(account.first_name);
    if (fn && fn !== prenom) { prenom = fn; store.set("lq-prenom", prenom); showName(); }
    // « Changer de prénom » : se fait dans le profil, pour rester le même partout
    $("changeName").onclick = () => { location.href = "compte.html#profil"; };
    profilePrompt();
    const al = $("accountLink");
    if (al && account.org) { al.title = `Mon compte · ${account.org.name}`; const sp = al.querySelector("span"); if (sp) sp.textContent = account.org.name; }
    $("logout").onclick = async () => {
      const btn = $("logout");
      if (!btn.classList.contains("confirm")) {
        // Sans moyen de connexion associé, un nouveau code sera nécessaire pour revenir : on le dit clairement.
        btn.classList.add("confirm"); btn.querySelector("span").textContent = account.noIdentity ? "Confirmer (nouveau code requis)" : "Confirmer la déconnexion";
        if (account.noIdentity) btn.title = "Vous n'avez pas encore associé de moyen de connexion : pour revenir, il faudra un nouveau code d'invitation." + (account.canLinkEmail ? " Associez-en un dans Mon compte." : "");
        setTimeout(() => { btn.classList.remove("confirm"); btn.querySelector("span").textContent = "Se déconnecter"; }, 5000);
        return;
      }
      ctl?.abort(); try { stopSim(true); } catch {}
      try { await fetch("/auth/logout", { method: "POST", credentials: "same-origin", headers: { "x-lq-csrf": "1" } }); } catch {}
      location.replace("acces.html");
    };
  }

  // Invitation discrète à compléter le profil : ne bloque jamais l'utilisation du portail.
  function profilePrompt() {
    if (!account.needsProfile) return;
    const key = "lq-profil-plus-tard-" + account.uid;
    const later = Number(store.get(key) || 0);
    if (later && Date.now() - later < 7 * 864e5) return;
    if (document.getElementById("profPrompt")) return;
    const st = document.createElement("style");
    st.textContent = `.prof-prompt{position:fixed;z-index:60;right:20px;bottom:20px;width:min(380px,calc(100vw - 32px));background:#fff;color:#101010;border:1px solid #e4e3dd;border-radius:18px;box-shadow:0 18px 50px rgb(4 8 26/.18);padding:16px 18px;display:flex;flex-direction:column;gap:10px;font-size:14.5px;line-height:1.5;animation:ppIn .25s ease-out}
      .prof-prompt b{font-size:15.5px}.prof-prompt p{margin:0;color:#55565d}
      .prof-prompt .pp-row{display:flex;gap:8px;flex-wrap:wrap}
      .prof-prompt a,.prof-prompt button{display:inline-flex;align-items:center;justify-content:center;min-height:42px;padding:0 14px;border-radius:11px;font-weight:800;font-size:14.5px;text-decoration:none;cursor:pointer;border:1.5px solid transparent}
      .prof-prompt a{background:#401098;color:#fff}.prof-prompt button{background:#fff;color:#2b2a35;border-color:#d6d4cc}
      @keyframes ppIn{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}
      @media (prefers-reduced-motion:reduce){.prof-prompt{animation:none}}
      @media (max-width:640px){.prof-prompt{left:16px;right:16px;width:auto;top:calc(var(--tabs-h,44px) + 64px);bottom:auto}}`;
    document.head.append(st);
    const box = document.createElement("aside");
    box.id = "profPrompt"; box.className = "prof-prompt"; box.setAttribute("role", "status"); box.setAttribute("aria-label", "Compléter mon profil");
    box.innerHTML = `<b>Bienvenue${prenom ? " " + esc(prenom) : ""} !</b><p>${account.noIdentity && account.canLinkEmail
      ? "Complétez votre profil et associez une adresse courriel : vous pourrez ainsi vous reconnecter depuis un autre appareil."
      : "Ajoutez votre nom de famille et votre photo pour que votre équipe vous reconnaisse."}</p>
      <div class="pp-row"><a href="compte.html#profil" id="ppGo">Compléter mon profil</a><button type="button" id="ppLater">Plus tard</button></div>`;
    document.body.append(box);
    $("ppLater").onclick = () => { store.set(key, String(Date.now())); box.remove(); $("q").focus(); };
  }
})();
