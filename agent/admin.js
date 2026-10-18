// Configuration de l'Assistant La Qualia : un espace Réception et un espace TSA,
// chacun avec sa configuration et sa base de connaissances privées (Cloudflare KV, via le relais).
(() => {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const ss = { get: (k) => { try { return sessionStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { sessionStorage.setItem(k, v); } catch {} }, del: (k) => { try { sessionStorage.removeItem(k); } catch {} } };
  const ls = { get: (k) => { try { return localStorage.getItem(k); } catch { return null; } } };
  const DEFAULTS = {"SCENARIOS": ["un client en colère au sujet d'une facture", "un propriétaire inquiet dont le chien vomit depuis ce matin", "un client qui veut annuler une chirurgie le matin même", "un client en deuil qui appelle pour l'incinération", "un client qui demande une dose de médicament", "un nouveau client qui veut un rendez-vous rapidement", "un appel où l'animal a peut-être avalé un toxique", "un client qui conteste un dépôt pour chirurgie", "un technicien qui te demande de rappeler un client pour des résultats", "un client pressé qui veut parler au vétérinaire tout de suite", "un client qui trouve les prix trop élevés", "un client âgé qui a du mal à comprendre les consignes préopératoires"], "SCENARIOS_TSA": ["un chat hospitalisé dont la fréquence respiratoire augmente pendant la nuit", "un chien au réveil d'une anesthésie qui reste hypotherme", "un patient sous fluidothérapie dont le cathéter semble infiltré", "un vétérinaire qui te demande une transmission rapide avant sa chirurgie", "un client qui comprend mal les consignes post-opératoires déjà validées", "une ordonnance où une donnée manque pour vérifier un débit de perfusion", "un chien admis pour vomissements dont l'anamnèse est incomplète", "un patient diabétique hospitalisé avec une glycémie inattendue", "la préparation d'une salle pour un nettoyage dentaire sous anesthésie", "un collègue qui veut donner un médicament sans ordonnance écrite"], "SIM_TYPES": [["Rendez-vous", "prise ou changement de rendez-vous ; horaire chargé, client pressé ou exigeant"], ["Facturation", "question ou contestation d'une facture, d'un dépôt ou d'un estimé"], ["Plainte", "plainte sur un service, une attente ou un membre de l'équipe"], ["Client inquiet", "propriétaire inquiet pour un symptôme léger à modéré de son animal"], ["Deuil", "fin de vie, euthanasie à planifier ou décès récent d'un animal"], ["Urgence potentielle", "symptômes qui cachent une vraie urgence, que le client minimise au début"]], "SIM_TYPES_TSA": [["Transmission au vétérinaire", "le médecin vétérinaire reçoit la transmission de l'apprenant au sujet d'un patient hospitalisé fictif ; tu joues le vétérinaire et tu poses des questions précises"], ["Surveillance hospitalisation", "le vétérinaire demande un point de surveillance sur un patient fictif dont les paramètres se dégradent légèrement ; tu joues le vétérinaire"], ["Préparation de procédure", "le vétérinaire vérifie que tout est prêt avant une anesthésie ou une chirurgie fictive ; tu joues le vétérinaire"], ["Consignes au client", "un client appelle après le congé de son animal pour comprendre des consignes déjà validées par le vétérinaire ; tu joues le client"], ["Client inquiet post-op", "un client signale des signes après une chirurgie, dont certains peuvent exiger le vétérinaire ; tu joues le client"], ["Urgence en hospitalisation", "un collègue signale qu'un patient hospitalisé fictif se dégrade rapidement ; tu joues le collègue"]]};
  const MODELS = { quick: ["Rapide", "Haiku, le plus vif"], default: ["Standard", "Sonnet, équilibré"], complex: ["Approfondi", "Opus, le plus réfléchi"] };
  let fileCfg = {}; // agent/config.json lu directement par la page : la source des réglages d'origine
  const FALLBACK_RE = /^Tu es un assistant pour l'équipe d'accueil d'un établissement vétérinaire\. Réponds en français\.?\s*$/;
  const FIELDS = ["name", "disclaimer", "instructions", "examples", "scenarios", "simTypes", "simulationClient", "simulationBilan", "tier", "modelesProposes"];
  function fileRole() {
    const src = role === "tsa" ? (fileCfg.tsa || {}) : fileCfg;
    const out = {};
    FIELDS.forEach((k) => { const v = src[k] ?? (role === "tsa" && (k === "tier" || k === "modelesProposes") ? fileCfg[k] : undefined); if (v !== undefined && v !== "" && !(Array.isArray(v) && !v.length)) out[k] = v; });
    return out;
  }
  let apiUrl = "", adminCode = ss.get("lq-admin-code") || "", role = "reception", data = null, dirty = false, busy = false;

  /* ---------- appels au relais ---------- */
  async function call(body) {
    const r = await fetch(apiUrl, {
      method: "POST",
      headers: { "content-type": "application/json", "x-agent-code": ls.get("lq-agent-code") || "", "x-agent-mode": "admin", "x-admin-code": adminCode },
      body: JSON.stringify({ role, ...body }),
    });
    let j = {}; try { j = await r.json(); } catch {}
    if (!r.ok) { const e = new Error(j.error || "Le relais n'a pas répondu."); e.status = r.status; throw e; }
    return j;
  }
  function toast(t) { const el = $("toast"); el.textContent = t; el.hidden = false; clearTimeout(toast.t); toast.t = setTimeout(() => (el.hidden = true), 2600); }
  function setState(kind, text) {
    $("state").className = "state" + (kind ? " " + kind : "");
    $("stateTxt").textContent = text;
    $("saveBtn").disabled = kind !== "dirty" || busy;
  }
  function markDirty() { if (!data) return; dirty = true; setState("dirty", "Modifications non enregistrées"); }

  /* ---------- connexion ---------- */
  async function login(code) {
    adminCode = code;
    try {
      role = "reception";
      await load();
      ss.set("lq-admin-code", code);
      $("login").hidden = true; $("app").hidden = false; $("savebar").hidden = false; $("out").hidden = false;
    } catch (e) {
      adminCode = ""; ss.del("lq-admin-code");
      $("login").hidden = false; $("app").hidden = true; $("savebar").hidden = true;
      $("loginErr").hidden = false; $("loginErr").textContent = e.message;
    }
  }
  $("loginForm").addEventListener("submit", (e) => { e.preventDefault(); const v = $("adminCode").value.trim(); if (v) login(v); });
  $("out").onclick = () => { if (dirty && !confirm("Des modifications ne sont pas enregistrées. Quitter quand même ?")) return; ss.del("lq-admin-code"); location.reload(); };

  /* ---------- chargement d'un espace ---------- */
  async function load() {
    const j = await call({ action: "load" });
    data = j;
    const orig = fileRole();
    const c = data.config || (data.config = {});
    // Copie absente, ou copie abîmée (texte de remplacement au lieu de vos instructions) : on reprend config.json
    const broken = !c.instructions || FALLBACK_RE.test(c.instructions.trim());
    let seeded = false;
    if (!j.customized || broken) {
      if (!j.customized) Object.assign(c, orig);
      else FIELDS.forEach((k) => { const v = c[k]; if (k === "instructions" || v === undefined || v === "" || (Array.isArray(v) && !v.length)) { if (orig[k] !== undefined) c[k] = orig[k]; } });
      if (!data.etablissement && fileCfg.etablissement) data.etablissement = fileCfg.etablissement;
      seeded = true;
    }
    fill();
    dirty = false;
    if (seeded && orig.instructions) {
      try {
        await call({ action: "save", config: collect(), etablissement: $("etab").value.trim() });
        data.customized = true;
        setState("", j.customized ? "Vos instructions d'origine ont été restaurées" : "Configuration d'origine copiée dans l'interface");
        toast(j.customized ? "Instructions d'origine restaurées depuis config.json" : "Configuration d'origine copiée : vous partez de vos réglages actuels");
      } catch (e) { setState("err", e.message); }
    } else setState("", "Tout est enregistré");
  }
  const linesOf = (v) => (Array.isArray(v) ? v.join("\n") : String(v || ""));
  function fill() {
    const c = data.config || {};
    const tsa = role === "tsa";
    document.body.classList.toggle("tsa", tsa);
    $("tabRec").setAttribute("aria-selected", String(!tsa));
    $("tabTsa").setAttribute("aria-selected", String(tsa));
    $("roleBadge").textContent = tsa ? "Équipe technique — TSA" : "Réception";
    $("title").textContent = tsa ? "Agent Équipe technique — TSA" : "Agent Réception";
    $("sceneExample").textContent = tsa ? "« je suis TSA et je gère … »" : "« je reçois un appel de … »";
    $("legacy").hidden = tsa;
    $("etab").value = data.etablissement || "";
    $("name").value = c.name || "";
    $("disclaimer").value = c.disclaimer || "";
    $("instructions").value = c.instructions || "";
    $("examples").value = linesOf(c.examples);
    $("scenarios").value = linesOf(c.scenarios && c.scenarios.length ? c.scenarios : tsa ? DEFAULTS.SCENARIOS_TSA : DEFAULTS.SCENARIOS);
    $("simClient").value = c.simulationClient || "";
    $("simBilan").value = c.simulationBilan || "";
    renderTypes(c.simTypes && c.simTypes.length ? c.simTypes : tsa ? DEFAULTS.SIM_TYPES_TSA : DEFAULTS.SIM_TYPES);
    const allowed = Array.isArray(c.modelesProposes) && c.modelesProposes.length ? c.modelesProposes : Object.keys(MODELS);
    $("models").textContent = "";
    Object.entries(MODELS).forEach(([k, [n, d]]) => {
      const l = document.createElement("label"); l.className = "chk";
      l.innerHTML = `<input type="checkbox" value="${k}"${allowed.includes(k) ? " checked" : ""}> ${n} <small>${d}</small>`;
      l.querySelector("input").onchange = () => { renderTier(); markDirty(); };
      $("models").append(l);
    });
    renderTier(c.tier);
    renderDocs();
    counts();
  }
  function renderTier(cur) {
    const sel = $("tier"); const prev = cur || sel.value;
    const on = [...$("models").querySelectorAll("input:checked")].map((x) => x.value);
    sel.textContent = "";
    (on.length ? on : Object.keys(MODELS)).forEach((k) => sel.append(new Option(MODELS[k][0] + " · " + MODELS[k][1], k)));
    sel.value = [...sel.options].some((o) => o.value === prev) ? prev : sel.options[0].value;
  }
  const nLines = (id) => $(id).value.split("\n").map((x) => x.trim()).filter(Boolean).length;
  function counts() {
    $("cInstr").textContent = $("instructions").value.length.toLocaleString("fr-CA") + " caractères";
    $("cFaq").textContent = nLines("examples") + " questions"; $("nFaq").textContent = nLines("examples");
    $("cScene").textContent = nLines("scenarios") + " situations"; $("nScene").textContent = nLines("scenarios");
    $("nKb").textContent = (data?.docs || []).length;
  }

  /* ---------- types de simulation ---------- */
  const SVG_X = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>';
  function typeRow(n = "", d = "") {
    const row = document.createElement("div"); row.className = "st-row";
    const a = document.createElement("input"); a.type = "text"; a.value = n; a.placeholder = "Nom (ex. : Facturation)"; a.maxLength = 60;
    const b = document.createElement("input"); b.type = "text"; b.value = d; b.placeholder = "Description pour l'agent (qui appelle, pourquoi, difficulté)"; b.maxLength = 400;
    const x = document.createElement("button"); x.type = "button"; x.className = "icon-btn"; x.innerHTML = SVG_X; x.setAttribute("aria-label", "Retirer ce type");
    x.onclick = () => { row.remove(); markDirty(); };
    [a, b].forEach((i) => i.addEventListener("input", markDirty));
    row.append(a, b, x); return row;
  }
  function renderTypes(list) { const box = $("simTypes"); box.textContent = ""; list.forEach(([n, d]) => box.append(typeRow(n, d))); }
  $("addType").onclick = () => { if ($("simTypes").children.length >= 12) return toast("12 types au maximum."); $("simTypes").append(typeRow()); markDirty(); };

  /* ---------- enregistrement ---------- */
  function collect() {
    const lines = (id) => $(id).value.split("\n").map((x) => x.trim()).filter(Boolean);
    return {
      name: $("name").value.trim(),
      disclaimer: $("disclaimer").value.trim(),
      instructions: $("instructions").value,
      examples: lines("examples"),
      scenarios: lines("scenarios"),
      simTypes: [...$("simTypes").children].map((r) => [r.children[0].value.trim(), r.children[1].value.trim()]).filter(([n, d]) => n && d),
      simulationClient: $("simClient").value,
      simulationBilan: $("simBilan").value,
      modelesProposes: [...$("models").querySelectorAll("input:checked")].map((x) => x.value),
      tier: $("tier").value,
    };
  }
  async function save() {
    const c = collect();
    if (!c.instructions.trim()) return toast("Les instructions ne peuvent pas être vides.");
    if (!c.modelesProposes.length) return toast("Cochez au moins un modèle.");
    busy = true; setState("dirty", "Enregistrement…"); $("saveBtn").disabled = true;
    try {
      await call({ action: "save", config: c, etablissement: $("etab").value.trim() });
      dirty = false; setState("", "Enregistré · actif dans l'agent d'ici une minute");
      toast("Configuration enregistrée");
    } catch (e) { setState("err", e.message); }
    finally { busy = false; if (dirty) $("saveBtn").disabled = false; }
  }
  $("saveBtn").onclick = save;
  document.addEventListener("keydown", (e) => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") { e.preventDefault(); if (dirty) save(); } });
  $("resetBtn").onclick = async () => {
    if (!confirm(`Rétablir les réglages d'origine de l'espace ${role === "tsa" ? "TSA" : "Réception"} ? Vos modifications de configuration seront effacées (la base de connaissances est conservée).`)) return;
    try { await call({ action: "reset" }); await load(); toast("Réglages d'origine rétablis"); } catch (e) { setState("err", e.message); }
  };
  ["etab", "name", "disclaimer", "instructions", "examples", "scenarios", "simClient", "simBilan", "tier"].forEach((id) => $(id).addEventListener("input", () => { markDirty(); counts(); }));
  window.addEventListener("beforeunload", (e) => { if (dirty) { e.preventDefault(); e.returnValue = ""; } });

  /* ---------- onglets ---------- */
  async function switchRole(r) {
    if (r === role || !adminCode) return;
    if (dirty && !confirm("Des modifications ne sont pas enregistrées dans cet espace. Changer d'espace quand même ?")) return;
    const prev = role; role = r;
    try { await load(); window.scrollTo({ top: 0 }); } catch (e) { role = prev; toast(e.message); }
  }
  $("tabRec").onclick = () => switchRole("reception");
  $("tabTsa").onclick = () => switchRole("tsa");

  /* ---------- base de connaissances ---------- */
  const SVG_DOC = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6"/></svg>';
  const fmtDate = (s) => { try { return new Date(s).toLocaleDateString("fr-CA", { day: "numeric", month: "short", year: "numeric" }); } catch { return ""; } };
  const fmtSize = (n) => n > 9999 ? Math.round(n / 1000) + " k caractères" : n + " caractères";
  function renderDocs() {
    const box = $("docs"); box.textContent = "";
    const docs = data.docs || [];
    if (!docs.length) { box.innerHTML = '<div class="empty">Aucun document pour cet espace. Ajoutez vos procédures, protocoles ou lexiques.</div>'; counts(); return; }
    docs.forEach((d) => {
      const row = document.createElement("div"); row.className = "doc";
      row.innerHTML = `<span class="di">${SVG_DOC}</span><span><b></b><small></small></span><span class="acts"><button type="button" class="ed">Ouvrir</button><button type="button" class="del">Supprimer</button></span>`;
      row.querySelector("b").textContent = d.title;
      row.querySelector("small").textContent = `${fmtSize(d.chars || 0)} · mis à jour le ${fmtDate(d.updated)}${d.source ? " · " + d.source : ""}`;
      row.querySelector(".ed").onclick = () => openDoc(d);
      row.querySelector(".del").onclick = async () => {
        if (!confirm(`Supprimer « ${d.title} » de la base de connaissances ?`)) return;
        try { await call({ action: "docDelete", id: d.id }); data.docs = data.docs.filter((x) => x.id !== d.id); renderDocs(); toast("Document supprimé"); } catch (e) { toast(e.message); }
      };
      box.append(row);
    });
    counts();
  }
  let editing = null;
  async function openDoc(d) {
    editing = d || null;
    $("dmTitle").textContent = d ? "Modifier le document" : "Nouveau document";
    $("dmName").value = d ? d.title : ""; $("dmText").value = d ? "Chargement…" : "";
    $("dmInfo").textContent = role === "tsa" ? "Espace TSA" : "Espace Réception";
    $("docModal").hidden = false; setTimeout(() => $(d ? "dmText" : "dmName").focus(), 30);
    if (d) { try { $("dmText").value = (await call({ action: "docGet", id: d.id })).text; } catch (e) { $("dmText").value = ""; toast(e.message); } }
  }
  $("pasteBtn").onclick = () => openDoc(null);
  $("dmCancel").onclick = () => ($("docModal").hidden = true);
  $("docModal").addEventListener("keydown", (e) => { if (e.key === "Escape") $("docModal").hidden = true; });
  $("dmSave").onclick = async () => {
    const title = $("dmName").value.trim(), text = $("dmText").value;
    if (!title) return toast("Donnez un titre au document.");
    if (!text.trim()) return toast("Le document est vide.");
    $("dmSave").disabled = true;
    try { await saveDoc({ id: editing?.id, title, text, source: editing?.source || "" }); $("docModal").hidden = true; toast("Document enregistré"); }
    catch (e) { toast(e.message); } finally { $("dmSave").disabled = false; }
  };
  async function saveDoc(d) {
    const j = await call({ action: "docSave", ...d });
    data.docs = [j.doc, ...(data.docs || []).filter((x) => x.id !== j.doc.id)];
    renderDocs();
  }

  // Extraction du texte dans le navigateur (rien n'est envoyé ailleurs que dans votre relais)
  const loadScript = (src) => new Promise((ok, ko) => { if (document.querySelector(`script[src="${src}"]`)) return ok(); const s = document.createElement("script"); s.src = src; s.onload = ok; s.onerror = () => ko(new Error("Impossible de charger le lecteur de fichiers.")); document.head.append(s); });
  async function pdfText(file) {
    await loadScript("https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js");
    const lib = window.pdfjsLib; lib.GlobalWorkerOptions.workerSrc = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
    const pdf = await lib.getDocument({ data: await file.arrayBuffer() }).promise;
    const out = [];
    for (let i = 1; i <= pdf.numPages; i++) {
      const c = await (await pdf.getPage(i)).getTextContent();
      let line = "", lastY = null; const rows = [];
      c.items.forEach((it) => { const y = it.transform[5]; if (lastY !== null && Math.abs(y - lastY) > 2) { rows.push(line); line = ""; } line += it.str; lastY = y; });
      rows.push(line);
      out.push(`--- Page ${i} ---\n` + rows.join("\n"));
    }
    return out.join("\n\n");
  }
  async function docxText(file) {
    await loadScript("https://cdnjs.cloudflare.com/ajax/libs/mammoth/1.6.0/mammoth.browser.min.js");
    return (await window.mammoth.extractRawText({ arrayBuffer: await file.arrayBuffer() })).value;
  }
  async function fileText(f) {
    const n = f.name.toLowerCase();
    if (n.endsWith(".pdf")) return pdfText(f);
    if (n.endsWith(".docx")) return docxText(f);
    if (n.endsWith(".html") || n.endsWith(".htm")) { const d = new DOMParser().parseFromString(await f.text(), "text/html"); return d.body.innerText || d.body.textContent || ""; }
    if (/\.(txt|md|csv)$/.test(n)) return f.text();
    throw new Error(`Format non pris en charge : ${f.name}`);
  }
  async function addFiles(files) {
    for (const f of files) {
      if (f.size > 20 * 1024 * 1024) { toast(`${f.name} : fichier trop gros (20 Mo max).`); continue; }
      toast(`Lecture de ${f.name}…`);
      try {
        const text = (await fileText(f)).replace(/\u0000/g, "").replace(/[ \t]+\n/g, "\n").replace(/\n{4,}/g, "\n\n\n").trim();
        if (text.length < 20) { toast(`${f.name} : aucun texte lisible (document numérisé ?).`); continue; }
        await saveDoc({ title: f.name.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " "), text: text.slice(0, 1500000), source: f.name });
        toast(`${f.name} ajouté`);
      } catch (e) { toast(`${f.name} : ${e.message}`); }
    }
  }
  $("upBtn").onclick = () => $("file").click();
  $("file").onchange = () => { addFiles([...$("file").files]); $("file").value = ""; };
  const drop = $("drop");
  ["dragenter", "dragover"].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add("over"); }));
  ["dragleave", "drop"].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove("over"); }));
  drop.addEventListener("drop", (e) => addFiles([...e.dataTransfer.files]));

  /* ---------- démarrage ---------- */
  fetch("config.json", { cache: "no-cache" }).then((r) => r.json()).then((c) => {
    fileCfg = c || {};
    apiUrl = c.apiUrl || "";
    if (!apiUrl) { $("loginErr").hidden = false; $("loginErr").textContent = "apiUrl manquante dans config.json."; return; }
    if (adminCode) login(adminCode); else setTimeout(() => $("adminCode").focus(), 50);
  }).catch(() => { $("loginErr").hidden = false; $("loginErr").textContent = "Impossible de lire config.json."; });
})();
