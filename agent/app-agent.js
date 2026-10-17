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
  const ICON = "avatar.webp";
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
  const tagFor = (t) => TAGS.find(([re]) => re.test(t))[1];

  let cfg = { name: "Assistant La Qualia", examples: [] };
  let turns = [];
  let inScenario = false;
  const MODEL_LABELS = { quick: ["Rapide", "Haiku"], default: ["Standard", "Sonnet"], complex: ["Approfondi", "Opus"] };
  let tier = store.get("lq-tier") || "";
  let ctl = null;
  let code = store.get("lq-agent-code") || "";
  let prenom = store.get("lq-prenom") || "";
  let needsCode = true;
  const cleanName = (v) => String(v || "").replace(/[^\p{L}\p{M}' -]/gu, "").replace(/\s+/g, " ").trim().slice(0, 30);
  function showName() {
    $("helloName").textContent = prenom ? " " + prenom : "";
    $("changeName").hidden = !prenom;
    $("changeName").textContent = prenom ? `${prenom} · changer de prénom` : "";
  }
  let shown = new Set();
  try { shown = new Set(JSON.parse(store.get("lq-shown") || "[]")); } catch {}

  /* ---------- exemples qui tournent ---------- */
  function pool() { return (Array.isArray(cfg.examples) ? cfg.examples : String(cfg.examples || "").split("\n")).map((s) => String(s).trim()).filter(Boolean); }
  function pickExamples(n) {
    const all = pool();
    let fresh = all.filter((t) => !shown.has(t));
    if (fresh.length < n) { shown = new Set(); fresh = all.slice(); }
    for (let i = fresh.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [fresh[i], fresh[j]] = [fresh[j], fresh[i]]; }
    const out = fresh.slice(0, n);
    out.forEach((t) => shown.add(t));
    store.set("lq-shown", JSON.stringify([...shown]));
    return out;
  }
  function renderWelcomeCards() {
    const el = $("examples"); el.textContent = "";
    const t = document.createElement("button");
    t.type = "button"; t.className = "card train";
    t.innerHTML = '<span class="tag">Entraînement</span>Me mettre en situation d\'appel';
    t.onclick = startScenario; el.append(t);
    pickExamples(3).forEach((q) => {
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
  function startScenario() {
    closeMenu();
    inScenario = true;
    const sc = SCENARIOS[Math.floor(Math.random() * SCENARIOS.length)];
    const label = `Mets-moi en situation : je suis à la réception et je reçois un appel de ${sc}.`;
    send(label + SCENE_FORMAT, label);
  }

  /* ---------- config ---------- */
  function applyCfg() {
    $("agentName").textContent = cfg.name || "Assistant La Qualia";
    $("agentTag").textContent = cfg.tag || "";
    $("disclaimerText").textContent = cfg.disclaimer || "";
    $("disclaimer").hidden = !cfg.disclaimer;
    if (cfg.name) document.title = cfg.name;
    renderWelcomeCards();
    renderSideList();
    renderModels();
  }
  function allowedTiers() {
    const list = Array.isArray(cfg.modelesProposes) ? cfg.modelesProposes.filter((t) => MODEL_LABELS[t]) : [];
    return list.length ? list : [MODEL_LABELS[cfg.tier] ? cfg.tier : "default"];
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
    $("modelWrap").hidden = list.length < 2;
    const badge = $("modelBadge");
    badge.hidden = list.length < 2;
    badge.textContent = MODEL_LABELS[tier][1];
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
      const lines = para.split("\n").filter((l) => !/^\s*#{1,4}\s+/.test(l));
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
    // Le vert reste court : 1er paragraphe (max ~380 caractères) ; le surplus passe en tête de l'Apprentissage
    const LIVE_MAX = 380;
    if (out) {
      const paras = out.split(/\n\s*\n/);
      let head = paras[0].replace(/^\s*(\*\*[^*]+\*\*\s*:?\s*)$/m, "").trim() || paras[0];
      let rest = paras.slice(1);
      if (/^\s*([-*•]|\d+[.)])\s/m.test(head) && head.split("\n").length > 2) {
        const lines = head.split("\n"); head = lines.slice(0, 2).join("\n"); rest.unshift(lines.slice(2).join("\n"));
      }
      if (head.length > LIVE_MAX) {
        const cut = head.slice(0, LIVE_MAX).search(/[.!?»](?=[^.!?»]*$)/);
        if (cut > 80) { rest.unshift(head.slice(cut + 1).trim()); head = head.slice(0, cut + 1); }
      }
      // Le vert doit contenir la phrase à dire : si elle est plus bas, on la remonte
      if (!/«/.test(head)) {
        const all = rest.join("\n").split("\n");
        const k = all.findIndex((x) => /«[^»]{8,220}»/.test(x));
        if (k !== -1) {
          head += "\n\n" + all[k].replace(/^\s*([-*•]|\d+[.)])\s*/, "").trim();
          all.splice(k, 1);
          rest = [all.join("\n")];
        }
      }
      if (rest.join("").trim()) {
        out = head.trim();
        if (l !== null) l = rest.join("\n\n").trim() + (l ? "\n\n" + l : "");
        else l = rest.join("\n\n").trim();
      }
    }
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
    return cleanLive(r.live, r.learn);
  }


  function renderAnswer(body, text, done) {
    mdDone = !!done;
    renderAnswerInner(body, text, done);
    if (done) hydrateQuizzes(body);
  }
  function renderAnswerInner(body, text, done) {
    const p = splitAnswer(text, done);
    if (p.pending) return;
    if (p.plain !== undefined) {
      body.dataset.live = "";
      body.innerHTML = inScenario
        ? `<section class="box-learn box-scene"><div class="box-head">${SVG_PHONE}Mise en situation</div><div class="box-body">${md(p.plain)}</div></section>`
        : md(p.plain);
      return;
    }
    body.dataset.live = p.live;
    let html = `<section class="box-live"><div class="box-head">${SVG_BOLT}En direct</div><div class="box-body">${md(p.live) || '<span class="typing"><i></i><i></i><i></i></span>'}</div></section>`;
    if (p.learn !== null && (p.learn || !done)) html += `<section class="box-learn"><div class="box-head">${SVG_BOOK}Apprentissage</div><div class="box-body">${md(p.learn) || '<span class="typing"><i></i><i></i><i></i></span>'}</div></section>`;
    else if (!done) html += `<section class="box-learn waiting"><div class="box-head">${SVG_BOOK}Apprentissage</div><div class="box-body"><span class="typing"><i></i><i></i><i></i></span></div></section>`;
    body.innerHTML = html;
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
          send(`Résultats du quiz : ${n}/${results.length} (${detail}). Continue la mise en situation.` + SCENE_FORMAT, `Continuer l'appel · ${n}/${results.length}`);
        };
        const nw = document.createElement("button"); nw.type = "button"; nw.className = "qz-new"; nw.textContent = "Nouvelle mise en situation";
        nw.onclick = startScenario;
        foot.append(go, nw);
        foot.scrollIntoView({ block: "nearest", behavior: "smooth" });
      }
    });
  }

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
    const top = el.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop - 12;
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
    const av = document.createElement("div"); av.className = "av"; av.innerHTML = `<img src="${ICON}" alt="">`;
    const col = document.createElement("div"); col.className = "a-col";
    const who = document.createElement("div"); who.className = "who"; who.textContent = cfg.name || "Assistant";
    const body = document.createElement("div"); body.className = "body";
    body.innerHTML = '<span class="typing" aria-label="L\'assistant écrit"><i></i><i></i><i></i></span>';
    col.append(who, body); m.append(av, col); $("thread").append(m); toBottom();
    return { m, col, body };
  }

  async function send(text, display) {
    const q = String(text ?? $("q").value).trim();
    if (!q || ctl) return;
    if (/^(mets-moi en situation|résultats du quiz)/i.test(q) || /mise en situation/i.test(q)) inScenario = true;
    $("q").value = ""; autosize();
    const qm = addQuestion(display || q);
    const { m, col, body } = addAnswer();
    if (!cfg.apiUrl) { body.innerHTML = '<p class="err">L\'assistant n\'est pas encore activé.</p>'; return; }
    ctl = new AbortController();
    busy(true);
    let answer = "";
    try {
      const res = await fetch(cfg.apiUrl, {
        method: "POST",
        headers: { "content-type": "application/json", "x-agent-code": code },
        body: JSON.stringify({ question: q, history: turns.slice(-8), tier, prenom }),
        signal: ctl.signal,
      });
      if (!res.ok) {
        let msg = "La réponse a échoué. Réessayez.";
        try { msg = (await res.json()).error || msg; } catch {}
        if (res.status === 401) {
          qm.remove(); m.remove();
          if (!$("thread").children.length) $("empty").hidden = false;
          $("q").value = q; autosize(); askCode(true); return;
        }
        body.innerHTML = `<p class="err">${esc(msg)}</p>`;
        return;
      }
      const reader = res.body.getReader(); const dec = new TextDecoder();
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        const stick = nearBottom();
        answer += dec.decode(value, { stream: true });
        renderAnswer(body, answer, false);
        if (stick) toBottom();
      }
      renderAnswer(body, answer, true);
      if (!answer.trim()) { body.innerHTML = '<p class="err">Aucune réponse reçue. Réessayez.</p>'; return; }
      turns.push({ role: "user", content: q }, { role: "assistant", content: answer });
      finishAnswer(res, col, answer);
      requestAnimationFrame(() => toTopOf(m));
    } catch (e) {
      if (e.name === "AbortError") {
        if (answer) { renderAnswer(body, answer, true); turns.push({ role: "user", content: q }, { role: "assistant", content: answer }); }
        else body.innerHTML = '<p class="err">Réponse arrêtée.</p>';
      } else { if (answer) renderAnswer(body, answer, true); else body.textContent = ""; body.insertAdjacentHTML("beforeend", '<p class="err">La connexion a été interrompue. Vérifiez Internet et réessayez.</p>'); }
    } finally {
      ctl = null; busy(false);
    }
  }

  function finishAnswer(res, col, answer) {
    let sources = [];
    try { sources = JSON.parse(decodeURIComponent(res.headers.get("x-agent-sources") || "[]")); } catch {}
    const cited = sources.filter((t) => answer.includes(t));
    if (cited.length) {
      const s = document.createElement("div"); s.className = "srcs"; s.textContent = "Sources : ";
      cited.forEach((t) => { const c = document.createElement("span"); c.className = "src"; c.textContent = t; s.append(c); });
      col.append(s);
    }
    const acts = document.createElement("div"); acts.className = "actions";
    const cp = document.createElement("button"); cp.type = "button"; cp.className = "act"; const label = () => (col.querySelector(".body")?.dataset.live ? "Copier la réponse en direct" : "Copier");
    cp.innerHTML = SVG_COPY + "<span></span>"; cp.querySelector("span").textContent = label();
    cp.onclick = async () => {
      const live = col.querySelector(".body")?.dataset.live;
      try { await navigator.clipboard.writeText(live || answer); cp.querySelector("span").textContent = "Copié"; }
      catch { cp.querySelector("span").textContent = "Copie impossible"; }
      setTimeout(() => { cp.querySelector("span").textContent = label(); }, 2000);
    };
    acts.append(cp); col.append(acts);

    document.querySelectorAll(".next").forEach((n) => n.remove());
    const nx = document.createElement("div"); nx.className = "next";
    const lab = document.createElement("div"); lab.className = "who"; lab.textContent = "Pour continuer à vous former";
    const ch = document.createElement("div"); ch.className = "chips"; chipsInto(ch, pickExamples(2));
    const tb = document.createElement("button"); tb.className = "chip train"; tb.type = "button"; tb.textContent = "Nouvelle mise en situation"; tb.onclick = startScenario; ch.append(tb);
    nx.append(lab, ch); $("thread").append(nx);
  }

  function busy(on) {
    $("send").hidden = on; $("stop").hidden = !on;
    if (!on) updateSend();
  }
  function updateSend() { $("send").disabled = !$("q").value.trim(); }

  function resetConversation() {
    ctl?.abort(); turns = []; inScenario = false;
    $("thread").textContent = "";
    $("empty").hidden = false;
    renderWelcomeCards(); renderSideList();
    scroller.scrollTop = 0;
    closeMenu();
    $("q").focus();
  }

  /* ---------- code d'accès ---------- */
  function askCode(invalid, nameOnly) {
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
    if ($("q").value.trim()) send();
    else $("q").focus();
  });
  $("changeName").onclick = () => { closeMenu(); askCode(false, true); };

  /* ---------- menu (téléphone) ---------- */
  function openMenu() { $("app").classList.add("open"); }
  function closeMenu() { $("app").classList.remove("open"); }
  $("menuBtn").onclick = openMenu;
  $("modelBadge").onclick = () => { if (matchMedia("(max-width:860px)").matches) openMenu(); else $("modelSeg").querySelector('[aria-checked="true"]')?.focus(); };
  $("closeMenu").onclick = closeMenu;
  $("scrim").onclick = closeMenu;
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeMenu(); });

  /* ---------- branchements ---------- */
  function autosize() { const t = $("q"); t.style.height = "auto"; t.style.height = Math.min(t.scrollHeight, 180) + "px"; updateSend(); }
  $("q").addEventListener("input", autosize);
  $("q").addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); } });
  $("form").addEventListener("submit", (e) => { e.preventDefault(); send(); });
  $("stop").onclick = () => ctl?.abort();
  $("sideTrain").onclick = startScenario;
  $("sideNew").onclick = resetConversation;
  $("clear").onclick = resetConversation;
  $("shuffleBtn").onclick = () => { renderSideList(); if (!$("empty").hidden) renderWelcomeCards(); };

  /* ---------- démarrage ---------- */
  showName();
  fetch("config.json", { cache: "no-cache" })
    .then((r) => r.json())
    .then((c) => { cfg = { ...cfg, ...c }; })
    .catch(() => {})
    .then(() => {
      applyCfg();
      if (!cfg.apiUrl) { setStatus("bad", "Assistant pas encore activé"); return; }
      return fetch(cfg.apiUrl).then((r) => (r.ok ? r.json() : null)).then((s) => {
        if (!s) { setStatus("bad", "Service indisponible"); return; }
        if (!s.ready) { setStatus("bad", "Clé API manquante"); return; }
        setStatus("ok", "En ligne");
        needsCode = !!s.needsCode;
        if ((needsCode && !code) || !prenom) askCode(false);
      }).catch(() => setStatus("bad", "Service injoignable"));
    });
})();
