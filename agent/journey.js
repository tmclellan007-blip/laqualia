/* Parcours de l'apprenant — page de démonstration.
   Données 100 % fictives, codées ici : rien n'est lu ni enregistré. */
(() => {
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const btn = $("sideJourney"), page = $("journey");
  if (!btn || !page) return;

  const DATA = {
    rec: {
      mode: "Réception",
      global: 62, done: 3, total: 8, hours: 7.5, streak: 4,
      modules: [
        { t: "Accueil téléphonique et identification", s: "done", p: 100, score: 92, d: "8 leçons" },
        { t: "Lexique vétérinaire de base", s: "done", p: 100, score: 85, d: "6 leçons" },
        { t: "Prise et confirmation de rendez-vous", s: "done", p: 100, score: 88, d: "5 leçons" },
        { t: "Triage téléphonique", s: "doing", p: 60, d: "Leçon 4 sur 7" },
        { t: "Client mécontent ou inquiet", s: "doing", p: 30, d: "Leçon 2 sur 6" },
        { t: "Facturation, estimations et dépôts", s: "todo", p: 0, d: "5 leçons · 40 min" },
        { t: "Deuil et euthanasie", s: "todo", p: 0, d: "4 leçons · 35 min" },
        { t: "Urgences et transferts au personnel clinique", s: "todo", p: 0, d: "6 leçons · 50 min" },
      ],
      skills: [
        ["Accueil et ton professionnel", 88],
        ["Vocabulaire vétérinaire", 81],
        ["Prise de rendez-vous", 77],
        ["Reconnaître une urgence", 64],
        ["Gérer les émotions du client", 56],
        ["Expliquer les frais et dépôts", 48],
      ],
      sims: [
        [1, "Chien qui vomit depuis la veille", "Simulation complète", 74],
        [3, "Confirmation de chirurgie la veille", "Mise en situation", 90],
        [5, "Client mécontent d'une facture", "Simulation complète", 58],
        [8, "Chat qui ne mange plus", "Mise en situation", 82],
        [12, "Nouveau client, premier rendez-vous", "Simulation complète", 93],
      ],
      strengths: [
        "Accueil chaleureux et identification complète du client et de l'animal.",
        "Vocabulaire juste : NPO, castration, vaccins de base.",
        "Confirme toujours la date, l'heure et les consignes avant de raccrocher.",
      ],
      improve: [
        "Poser plus tôt les questions de signes d'alerte (respiration, saignement, abattement).",
        "Reformuler l'inquiétude du client avant de proposer une solution.",
        "Expliquer le dépôt de chirurgie avec des mots simples et un montant clair.",
      ],
      next: {
        mod: "Triage téléphonique · leçon 4",
        t: "Reconnaître les signes d'urgence chez le chat",
        d: "Quatre courts cas à classer : urgent, à voir aujourd'hui ou rendez-vous régulier. Environ 12 minutes.",
        cta: "Lancer une mise en situation",
      },
    },
    tsa: {
      mode: "Équipe technique — TSA",
      global: 54, done: 3, total: 8, hours: 9, streak: 3,
      modules: [
        { t: "Calculs de doses et dilutions", s: "done", p: 100, score: 90, d: "7 leçons" },
        { t: "Transmission SBAR", s: "done", p: 100, score: 84, d: "4 leçons" },
        { t: "Hygiène, asepsie et stérilisation", s: "done", p: 100, score: 95, d: "5 leçons" },
        { t: "Surveillance anesthésique", s: "doing", p: 55, d: "Leçon 5 sur 9" },
        { t: "Soins postopératoires et douleur", s: "doing", p: 25, d: "Leçon 2 sur 7" },
        { t: "Urgences et réanimation (RCP)", s: "todo", p: 0, d: "6 leçons · 55 min" },
        { t: "Imagerie et radioprotection", s: "todo", p: 0, d: "5 leçons · 40 min" },
        { t: "Laboratoire et prélèvements", s: "todo", p: 0, d: "6 leçons · 45 min" },
      ],
      skills: [
        ["Asepsie et préparation stérile", 91],
        ["Calculs de doses", 86],
        ["Transmission SBAR", 79],
        ["Surveillance anesthésique", 63],
        ["Évaluation de la douleur", 57],
        ["Gestion des urgences", 44],
      ],
      sims: [
        [1, "Réveil anesthésique d'un chat âgé", "Simulation complète", 68],
        [2, "Calcul d'une perfusion de liquides", "Mise en situation", 94],
        [6, "Transmission SBAR au vétérinaire", "Simulation complète", 81],
        [9, "Score de douleur après une OVH", "Mise en situation", 62],
        [13, "Préparation d'un plateau chirurgical", "Mise en situation", 96],
      ],
      strengths: [
        "Calculs exacts, avec vérification de l'unité et du poids.",
        "Transmissions SBAR structurées et concises.",
        "Rigueur d'asepsie constante lors de la préparation.",
      ],
      improve: [
        "Noter les paramètres vitaux à intervalle régulier pendant le réveil.",
        "Utiliser une échelle de douleur reconnue et la documenter.",
        "Annoncer plus vite au vétérinaire une valeur hors norme.",
      ],
      next: {
        mod: "Surveillance anesthésique · leçon 5",
        t: "Hypothermie et hypotension au réveil",
        d: "Un cas guidé : repérer les signes, choisir les mesures et rédiger la transmission. Environ 15 minutes.",
        cta: "Lancer un cas pratique",
      },
    },
  };

  const isTsa = () => document.body.classList.contains("tsa");
  const level = (n) => (n >= 80 ? ["Solide", "ok"] : n >= 65 ? ["À consolider", "mid"] : ["À renforcer", "low"]);
  const day = (ago) => {
    const d = new Date(); d.setDate(d.getDate() - ago);
    return ago === 1 ? "Hier" : d.toLocaleDateString("fr-CA", { day: "numeric", month: "short" });
  };
  const ICO = {
    done: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
    doing: '<circle cx="12" cy="12" r="8"/><path d="M12 7.5V12l3 2"/>',
    todo: '<circle cx="12" cy="12" r="8" stroke-dasharray="3 3"/>',
  };
  const svg = (p, w = 18) => `<svg viewBox="0 0 24 24" width="${w}" height="${w}" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${p}</svg>`;

  function render() {
    const D = DATA[isTsa() ? "tsa" : "rec"];
    const name = ($("userName")?.textContent || "").trim();
    const who = name && name !== "Invité" ? name : "Apprenant fictif";
    const groups = [["doing", "En cours"], ["todo", "À commencer"], ["done", "Terminés"]];
    const avg = Math.round(D.sims.reduce((a, s) => a + s[3], 0) / D.sims.length);

    page.innerHTML = `<div class="jr-in">
      <header class="jr-head">
        <h1>Parcours de l'apprenant <span class="demo-pill">Démo</span></h1>
        <p>${esc(who)} · ${esc(D.mode)}</p>
      </header>

      <div class="jr-top">
        <section class="jr-card jr-prog" aria-labelledby="jrP">
          <h2 id="jrP">Progression globale</h2>
          <div class="jr-big"><b>${D.global} %</b><span>du parcours ${isTsa() ? "TSA" : "Réception"}</span></div>
          <div class="jr-bar" role="progressbar" aria-valuenow="${D.global}" aria-valuemin="0" aria-valuemax="100" aria-label="Progression globale"><i style="width:${D.global}%"></i></div>
          <ul class="jr-stats">
            <li><b>${D.done}/${D.total}</b><span>modules terminés</span></li>
            <li><b>${String(D.hours).replace(".", ",")} h</b><span>de formation</span></li>
            <li><b>${avg} %</b><span>moyenne en simulation</span></li>
          </ul>
        </section>
        <section class="jr-card jr-next" aria-labelledby="jrN">
          <h2 id="jrN">Prochaine étape suggérée</h2>
          <p class="jr-mod">${esc(D.next.mod)}</p>
          <p class="jr-nt">${esc(D.next.t)}</p>
          <p class="jr-nd">${esc(D.next.d)}</p>
          <button type="button" class="jr-cta" id="jrGo">${svg('<path d="M8 5v14l11-7z"/>', 16)}${esc(D.next.cta)}</button>
        </section>
      </div>

      <section class="jr-card" aria-labelledby="jrM">
        <h2 id="jrM">Modules de formation</h2>
        <div class="jr-mods">${groups.map(([k, lab]) => {
          const list = D.modules.filter((m) => m.s === k);
          return `<div class="jr-col jr-${k}"><h3>${svg(ICO[k], 16)}${lab} <span>${list.length}</span></h3><ul>${list.map((m) => `<li>
            <b>${esc(m.t)}</b><small>${esc(m.d)}${m.score ? ` · résultat ${m.score} %` : ""}</small>
            ${k === "doing" ? `<div class="jr-bar sm"><i style="width:${m.p}%"></i></div>` : ""}</li>`).join("")}</ul></div>`;
        }).join("")}</div>
      </section>

      <div class="jr-two">
        <section class="jr-card" aria-labelledby="jrC">
          <h2 id="jrC">Compétences travaillées</h2>
          <ul class="jr-skills">${D.skills.map(([t, n]) => { const [l, c] = level(n); return `<li>
            <span class="jr-st">${esc(t)}</span><span class="jr-sv"><b>${n} %</b><em class="lv ${c}">${l}</em></span>
            <div class="jr-bar sm"><i style="width:${n}%"></i></div></li>`; }).join("")}</ul>
        </section>
        <section class="jr-card" aria-labelledby="jrS">
          <h2 id="jrS">Dernières simulations</h2>
          <ul class="jr-sims">${D.sims.map(([ago, t, type, n]) => { const [l, c] = level(n); return `<li>
            <span class="jr-date">${day(ago)}</span>
            <span class="jr-sim"><b>${esc(t)}</b><small>${esc(type)}</small></span>
            <span class="jr-res"><b>${n} %</b><em class="lv ${c}">${l}</em></span></li>`; }).join("")}</ul>
        </section>
      </div>

      <div class="jr-two">
        <section class="jr-card jr-fb good" aria-labelledby="jrF">
          <h2 id="jrF">${svg('<path d="m12 3 2.6 5.5 6 .8-4.4 4.2 1.1 6L12 16.6 6.7 19.5l1.1-6L3.4 9.3l6-.8z"/>')}Points forts</h2>
          <ul>${D.strengths.map((s) => `<li>${esc(s)}</li>`).join("")}</ul>
        </section>
        <section class="jr-card jr-fb grow" aria-labelledby="jrA">
          <h2 id="jrA">${svg('<path d="M4 17 10 11l4 4 6-7"/><path d="M15 8h5v5"/>')}Axes d'amélioration</h2>
          <ul>${D.improve.map((s) => `<li>${esc(s)}</li>`).join("")}</ul>
        </section>
      </div>
    </div>`;

    $("jrGo").onclick = () => { close(); $("sideTrain").click(); };
  }

  function open() {
    if ($("learnToggle").getAttribute("aria-pressed") === "true") $("learnToggle").click();
    render();
    document.body.classList.add("journey");
    page.hidden = false;
    btn.setAttribute("aria-pressed", "true");
    $("app").classList.remove("open");
    page.scrollTop = 0;
    page.focus({ preventScroll: true });
  }
  function close() {
    if (!document.body.classList.contains("journey")) return;
    document.body.classList.remove("journey");
    page.hidden = true;
    btn.setAttribute("aria-pressed", "false");
  }

  btn.onclick = () => (document.body.classList.contains("journey") ? close() : open());
  // Toute autre navigation (menu, nouvelle conversation, logo) ferme la page
  document.querySelector(".side").addEventListener("click", (e) => {
    const b = e.target.closest("button, a, [role=button], li");
    if (b && !btn.contains(b) && b.id !== "sideCollapse" && !b.closest("#tabRecent, #tabFaq")) close();
  }, true);
  ["clear", "homeLogo"].forEach((id) => $(id)?.addEventListener("click", close, true));
  // Changement Réception ↔ TSA : la page suit le mode actif
  let lastTsa = isTsa();
  new MutationObserver(() => { const t = isTsa(); if (t !== lastTsa) { lastTsa = t; if (document.body.classList.contains("journey")) render(); } })
    .observe(document.body, { attributes: true, attributeFilter: ["class"] });
})();
