// Tableau de bord — démonstration avec des données fictives générées localement.
// Aucune connexion externe, aucun dossier réel : tout est calculé dans le navigateur.
(() => {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const store = { get: (k) => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch {} } };
  const fmt = (n) => n.toLocaleString("fr-CA");

  /* ---------- données fictives, cohérentes entre cartes, graphiques et listes ---------- */
  // Générateur pseudo-aléatoire stable : les mêmes jours donnent toujours les mêmes chiffres
  function rng(seed) { let x = seed >>> 0 || 1; return () => { x ^= x << 13; x >>>= 0; x ^= x >> 17; x ^= x << 5; x >>>= 0; return x / 4294967296; }; }
  const dayKey = (d) => d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate();
  const TYPES = [
    { k: "consult", label: "Consultation", group: "consultations" },
    { k: "vaccin", label: "Vaccination", group: "consultations" },
    { k: "urgence", label: "Urgence", group: "consultations" },
    { k: "chir", label: "Chirurgie", group: "chirurgies" },
    { k: "dent", label: "Dentisterie", group: "chirurgies" },
    { k: "exam", label: "Imagerie et laboratoire", group: "examens" },
  ];
  const SERIES = [
    { k: "consultations", label: "Consultations", color: "var(--s1)" },
    { k: "chirurgies", label: "Chirurgies", color: "var(--s2)" },
    { k: "examens", label: "Examens", color: "var(--s3)" },
  ];
  const CAPACITY = (d) => (d.getDay() === 0 ? 10 : d.getDay() === 6 ? 16 : 22);

  // Aujourd'hui : une journée type fixe (18 rendez-vous), le reste est généré
  const TODAY_TYPES = { consult: 6, vaccin: 4, urgence: 2, chir: 2, dent: 1, exam: 3 };
  function dayData(d, isToday) {
    const r = rng(dayKey(d) * 2654435761);
    const cap = CAPACITY(d);
    let types;
    if (isToday) types = { ...TODAY_TYPES };
    else {
      const total = Math.max(4, Math.round(cap * (0.66 + r() * 0.3)));
      const w = { consult: 0.34, vaccin: 0.22, urgence: 0.1, chir: 0.1, dent: 0.06, exam: 0.18 };
      types = {}; let used = 0;
      TYPES.forEach((t, i) => {
        const n = i === TYPES.length - 1 ? total - used : Math.max(0, Math.round(total * w[t.k] * (0.7 + r() * 0.6)));
        types[t.k] = Math.max(0, i === TYPES.length - 1 ? n : Math.min(n, total - used)); used += types[t.k];
      });
      if (d.getDay() === 0) { types.chir = 0; types.dent = 0; } // dimanche : pas de chirurgie planifiée
    }
    const rdv = Object.values(types).reduce((a, b) => a + b, 0);
    const groups = { consultations: 0, chirurgies: 0, examens: 0 };
    TYPES.forEach((t) => (groups[t.group] += types[t.k]));
    return {
      date: d, types, groups, rdv, cap: isToday ? 22 : cap,
      calls: isToday ? 47 : Math.round(rdv * (2.2 + r() * 0.9)),
      hosp: isToday ? 4 : 2 + Math.floor(r() * 4),
      admissions: isToday ? 2 : Math.floor(r() * 3),
    };
  }

  // Heure de la démo : l'heure réelle pendant la journée, sinon 11 h 20 (pour voir tous les statuts)
  const now = new Date();
  const mins = now.getHours() * 60 + now.getMinutes();
  const demoMin = mins >= 9 * 60 + 30 && mins <= 16 * 60 + 30 ? mins : 11 * 60 + 20;
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  const days = {};
  const getDay = (d) => { const k = dayKey(d); return days[k] || (days[k] = dayData(d, k === dayKey(today))); };
  const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
  const monday = addDays(today, -((today.getDay() + 6) % 7));
  const weekDays = Array.from({ length: 7 }, (_, i) => getDay(addDays(monday, i)));
  const monthStart = new Date(today.getFullYear(), today.getMonth(), 1);
  const monthEnd = new Date(today.getFullYear(), today.getMonth() + 1, 0);
  const monthDays = []; for (let d = monthStart; d <= monthEnd; d = addDays(d, 1)) monthDays.push(getDay(d));

  // Horaire du jour, construit à partir des 18 rendez-vous d'aujourd'hui (noms d'animaux fictifs, aucun client)
  const PETS = [["Moka", "Chien · Labrador"], ["Pistache", "Chat · Européen"], ["Bijou", "Chien · Shih Tzu"], ["Caramel", "Chat · Maine Coon"], ["Rocky", "Chien · Berger allemand"], ["Nala", "Chatte · Siamoise"], ["Biscuit", "Lapin · Bélier"], ["Luna", "Chienne · Golden"], ["Gaston", "Chat · Persan"], ["Fripouille", "Furet"], ["Max", "Chien · Beagle"], ["Mimi", "Chatte · Européenne"], ["Oscar", "Chien · Bouledogue français"], ["Praline", "Chatte · Ragdoll"], ["Zeus", "Chien · Husky"], ["Noisette", "Cochon d'Inde"], ["Charlie", "Chien · Caniche"], ["Simba", "Chat · Bengal"]];
  const REASON = { consult: ["Examen annuel", "Boiterie", "Problème de peau", "Suivi de poids", "Otite", "Examen de santé"], vaccin: ["Vaccins annuels", "Rappel de vaccin", "Vaccins de base", "Vaccin rage"], urgence: ["Vomissements", "Plaie à la patte"], chir: ["Stérilisation", "Retrait de masse"], dent: ["Détartrage"], exam: ["Radiographie", "Analyses sanguines", "Échographie"] };
  const LEN = { consult: 30, vaccin: 20, urgence: 30, chir: 90, dent: 60, exam: 30 };
  const VET = ["Dre Lavoie", "Dr Tremblay", "Dre Côté"];
  function buildSchedule() {
    const td = getDay(today);
    const list = [];
    Object.entries(td.types).forEach(([k, n]) => { for (let i = 0; i < n; i++) list.push({ k, reason: REASON[k][i % REASON[k].length] }); });
    // ordre de la journée : chirurgies et dentisterie le matin, le reste réparti
    const order = ["chir", "dent", "vaccin", "consult", "exam", "urgence"];
    const r = rng(dayKey(today));
    list.sort((a, b) => order.indexOf(a.k) - order.indexOf(b.k) + (r() - 0.5) * 3.2);
    let t = 8 * 60; const vetT = [8 * 60, 8 * 60, 8 * 60 + 30];
    return list.map((x, i) => {
      const v = i % 3; const start = Math.max(vetT[v], t); vetT[v] = start + LEN[x.k] + (x.k === "chir" ? 0 : 10); t = start + 15;
      const end = start + LEN[x.k];
      const status = end <= demoMin ? "done" : start <= demoMin ? "cons" : start - demoMin <= 25 && i % 2 === 0 ? "arr" : "up";
      const [name, sp] = PETS[i % PETS.length];
      return { start, end, name, sp, reason: x.reason, type: TYPES.find((tt) => tt.k === x.k).label, vet: VET[v], status };
    }).sort((a, b) => a.start - b.start);
  }
  const schedule = buildSchedule();

  const TASKS = [
    { c: "rappel", t: "Rappeler pour les résultats d'analyses de {exam}", d: "Aujourd'hui · 10 h", who: "Réception", late: true },
    { c: "rappel", t: "Rappel de vaccins annuels : 6 animaux à contacter", d: "Aujourd'hui", who: "Réception" },
    { c: "rappel", t: "Confirmer le rendez-vous de détartrage de demain", d: "Aujourd'hui · 15 h", who: "Réception" },
    { c: "rappel", t: "Rappel vermifuge printanier : liste à envoyer", d: "Demain", who: "Réception" },
    { c: "rappel", t: "Rappeler pour le renouvellement d'une ordonnance", d: "Hier", who: "TSA", late: true },
    { c: "rappel", t: "Relancer un estimé de chirurgie non confirmé", d: "Aujourd'hui", who: "Réception" },
    { c: "suivi", t: "Suivi post-opératoire de {chir}", d: "Aujourd'hui · 14 h", who: "TSA" },
    { c: "suivi", t: "Appel de suivi après l'urgence de {urg}", d: "Aujourd'hui", who: "TSA" },
    { c: "suivi", t: "Envoyer les consignes de diète à un propriétaire", d: "Aujourd'hui", who: "Réception", done: true },
    { c: "suivi", t: "Vérifier l'appétit de {dent} après son détartrage", d: "Demain", who: "TSA" },
    { c: "prep", t: "Préparer la salle de chirurgie pour 8 h", d: "Aujourd'hui · 7 h 45", who: "TSA", done: true },
    { c: "prep", t: "Vérifier le jeûne des patients opérés demain", d: "Aujourd'hui · 16 h", who: "Réception" },
    { c: "prep", t: "Préparer les dossiers des nouveaux patients de l'après-midi", d: "Aujourd'hui · 12 h", who: "Réception" },
    { c: "prep", t: "Réapprovisionner la salle d'examen 2", d: "Aujourd'hui", who: "TSA" },
  ];
  // Les tâches parlent des animaux vus aujourd'hui (même horaire, mêmes noms)
  const firstOf = (type) => (schedule.find((x) => x.type === type) || {}).name || "un patient";
  const SUB = { exam: firstOf("Imagerie et laboratoire"), chir: firstOf("Chirurgie"), urg: firstOf("Urgence"), dent: firstOf("Dentisterie") };
  TASKS.forEach((t) => (t.t = t.t.replace(/\{(\w+)\}/g, (_, k) => SUB[k] || "un patient")));
  // État des tâches propre à cet appareil (démo) : cocher ne modifie aucun dossier
  try { const saved = JSON.parse(store.get("lq-dash-tasks") || "null"); if (Array.isArray(saved) && saved.length === TASKS.length) saved.forEach((v, i) => (TASKS[i].done = !!v)); } catch {}
  const CAT = { suivi: ["Suivis clients", "tg-suivi", "Suivi"], rappel: ["Rappels", "tg-rappel", "Rappel"], prep: ["Préparation", "tg-prep", "Préparation"] };

  /* ---------- état ---------- */
  let period = ["day", "week", "month"].includes(store.get("lq-dash-period")) ? store.get("lq-dash-period") : "day";
  let actView = "chart", schedFilter = "all", taskFilter = "all";
  const STATUS = { up: ["À venir", "st-up"], arr: ["Arrivé", "st-arr"], cons: ["En consultation", "st-cons"], done: ["Terminé", "st-done"] };
  const hm = (m) => `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, "0")}`;
  const dLong = (d) => d.toLocaleDateString("fr-CA", { weekday: "long", day: "numeric", month: "long" });
  const dShort = (d) => d.toLocaleDateString("fr-CA", { weekday: "short" }).replace(".", "");
  const sum = (arr, f) => arr.reduce((a, x) => a + f(x), 0);

  function periodDays() { return period === "day" ? [getDay(today)] : period === "week" ? weekDays : monthDays; }

  /* ---------- cartes ---------- */
  const IC = {
    cal: '<path d="M7 3v3M17 3v3M4 8h16"/><rect x="4" y="5" width="16" height="16" rx="2"/>',
    bed: '<path d="M3 18v-7a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v7M3 14h18M7 9V6"/>',
    phone: '<path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2"/>',
    bell: '<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9M10 21h4"/>',
    gauge: '<path d="M12 14l4-4"/><path d="M3.5 18a9 9 0 1 1 17 0"/>',
  };
  const kpi = (ico, label, value, sub, bar) => `<article class="kpi"><div class="k-l"><span class="k-i"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${IC[ico]}</svg></span>${label}</div><div class="k-v">${value}</div>${bar !== undefined ? `<div class="k-bar" aria-hidden="true"><i style="width:${Math.min(100, bar)}%"></i></div>` : ""}<div class="k-s">${sub}</div></article>`;
  function renderKpis() {
    const ds = periodDays();
    const rdv = sum(ds, (x) => x.rdv), cap = sum(ds, (x) => x.cap), calls = sum(ds, (x) => x.calls), adm = sum(ds, (x) => x.admissions);
    const occ = Math.round((rdv / cap) * 100);
    const open = TASKS.filter((t) => t.c === "rappel" && !t.done), late = open.filter((t) => t.late).length;
    const td = getDay(today);
    const doneToday = schedule.filter((s) => s.status === "done").length;
    const lab = period === "day" ? "aujourd'hui" : period === "week" ? "cette semaine" : "ce mois-ci";
    $("kpis").innerHTML = [
      kpi("cal", period === "day" ? "Rendez-vous du jour" : "Rendez-vous", fmt(rdv), period === "day" ? `<b>${doneToday}</b> terminés · <b>${rdv - doneToday}</b> à venir ou en cours` : `<b>${fmt(Math.round(rdv / ds.length))}</b> par jour en moyenne`),
      kpi("bed", "Animaux hospitalisés", td.hosp + "<small>en ce moment</small>", period === "day" ? `<b>${td.admissions}</b> admissions aujourd'hui` : `<b>${adm}</b> admissions ${lab}`),
      kpi("phone", "Appels reçus", fmt(calls), period === "day" ? `<b>${Math.round(calls / 9)}</b> par heure en moyenne` : `<b>${fmt(Math.round(calls / ds.length))}</b> par jour en moyenne`),
      kpi("bell", "Rappels à effectuer", open.length, late ? `<span class="late">${late} en retard</span> · voir les tâches` : "aucun en retard"),
      kpi("gauge", "Taux d'occupation", occ + " %", `<b>${fmt(rdv)}</b> plages réservées sur <b>${fmt(cap)}</b>`, occ),
    ].join("");
  }

  /* ---------- activité (colonnes groupées, 3 séries) ---------- */
  function actBuckets() {
    if (period === "month") {
      const out = [];
      monthDays.forEach((d) => {
        const wk = addDays(d.date, -((d.date.getDay() + 6) % 7));
        let b = out.find((x) => x.key === dayKey(wk));
        if (!b) { b = { key: dayKey(wk), label: "Sem. du " + Math.max(wk < monthStart ? 1 : wk.getDate(), 1), full: "Semaine du " + (wk < monthStart ? monthStart : wk).toLocaleDateString("fr-CA", { day: "numeric", month: "long" }), tbl: "Sem. du " + (wk < monthStart ? monthStart : wk).toLocaleDateString("fr-CA", { day: "numeric", month: "short" }).replace(".", ""), g: { consultations: 0, chirurgies: 0, examens: 0 }, cur: false }; out.push(b); }
        SERIES.forEach((s) => (b.g[s.k] += d.groups[s.k]));
        if (dayKey(d.date) === dayKey(today)) b.cur = true;
      });
      return out;
    }
    return weekDays.map((d) => ({ key: dayKey(d.date), label: dShort(d.date), full: dLong(d.date), tbl: d.date.toLocaleDateString("fr-CA", { weekday: "short", day: "numeric" }).replace(".", ""), g: d.groups, cur: dayKey(d.date) === dayKey(today) }));
  }
  function renderActivity() {
    const B = actBuckets();
    $("actSub").textContent = period === "month" ? "Par semaine, " + today.toLocaleDateString("fr-CA", { month: "long", year: "numeric" }) : period === "week" ? "Par jour, semaine en cours" : "Semaine en cours · aujourd'hui en évidence";
    $("actLegend").innerHTML = SERIES.map((s) => `<span><i style="background:${s.color}"></i>${s.label}</span>`).join("");
    const W = 720, H = 260, padL = 34, padB = 28, padT = 10;
    const max = Math.max(...B.map((b) => Math.max(...SERIES.map((s) => b.g[s.k]))));
    const step = max > 60 ? 20 : max > 30 ? 10 : 5;
    const top = Math.ceil(max / step) * step || step;
    const y = (v) => padT + (H - padT - padB) * (1 - v / top);
    const bw = (W - padL) / B.length;
    const barW = Math.min(24, (bw - 18) / 3 - 2);
    let g = "";
    for (let v = 0; v <= top; v += step) g += `<line class="gl" x1="${padL}" x2="${W}" y1="${y(v)}" y2="${y(v)}"/><text class="ax" x="${padL - 8}" y="${y(v) + 4}" text-anchor="end">${v}</text>`;
    B.forEach((b, i) => {
      const cx = padL + bw * i + bw / 2;
      if (b.cur && period !== "month") g += `<rect class="band" x="${cx - bw / 2 + 4}" y="${padT}" width="${bw - 8}" height="${H - padT - padB}" rx="8"/>`;
      const x0 = cx - (barW * 3 + 4) / 2;
      g += `<g data-i="${i}">`;
      SERIES.forEach((s, j) => {
        const v = b.g[s.k], x = x0 + j * (barW + 2), yt = y(v), h = y(0) - yt;
        if (h <= 0) return;
        const r = Math.min(4, h, barW / 2);
        g += `<path class="bar" fill="${s.color}" d="M${x},${y(0)} V${yt + r} Q${x},${yt} ${x + r},${yt} H${x + barW - r} Q${x + barW},${yt} ${x + barW},${yt + r} V${y(0)} Z"/>`;
      });
      g += `</g><text class="ax${b.cur ? " cur" : ""}" x="${cx}" y="${H - 8}" text-anchor="middle">${esc(b.label)}${b.cur && period !== "month" ? " ●" : ""}</text>`;
      g += `<rect class="hit" data-i="${i}" x="${padL + bw * i}" y="${padT}" width="${bw}" height="${H - padT - padB + 4}"/>`;
    });
    $("actChart").innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Activité : consultations, chirurgies et examens">${g}</svg>`;
    const tip = $("dashTip");
    $("actChart").querySelectorAll(".hit").forEach((h) => {
      const b = B[+h.dataset.i];
      const show = (e) => {
        tip.innerHTML = `<b>${esc(b.full)}</b>` + SERIES.map((s) => `<div class="r"><span><i style="background:${s.color}"></i>${s.label}</span><strong>${b.g[s.k]}</strong></div>`).join("") + `<div class="r" style="margin-top:3px;opacity:.8"><span>Total</span><strong>${sum(SERIES, (s) => b.g[s.k])}</strong></div>`;
        tip.hidden = false;
        const x = Math.min(window.innerWidth - tip.offsetWidth - 10, e.clientX + 14), yy = Math.max(10, e.clientY - tip.offsetHeight - 12);
        tip.style.left = x + "px"; tip.style.top = yy + "px";
      };
      h.addEventListener("mousemove", show); h.addEventListener("click", show);
      h.addEventListener("mouseleave", () => (tip.hidden = true));
    });
    // Vue tableau (mêmes données)
    const tot = (k) => sum(B, (b) => b.g[k]);
    $("actTable").innerHTML = `<table><thead><tr><th>${period === "month" ? "Semaine" : "Jour"}</th>${SERIES.map((s) => `<th>${s.label}</th>`).join("")}<th>Total</th></tr></thead><tbody>${B.map((b) => `<tr><td>${esc(b.tbl || b.full)}${b.cur ? " · auj." : ""}</td>${SERIES.map((s) => `<td>${b.g[s.k]}</td>`).join("")}<td>${sum(SERIES, (s) => b.g[s.k])}</td></tr>`).join("")}</tbody><tfoot><tr><td>Total</td>${SERIES.map((s) => `<td>${tot(s.k)}</td>`).join("")}<td>${sum(SERIES, (s) => tot(s.k))}</td></tr></tfoot></table>`;
    $("actChart").hidden = actView !== "chart"; $("actLegend").hidden = actView !== "chart"; $("actTable").hidden = actView !== "table";
  }

  /* ---------- répartition par type (barres horizontales, une couleur) ---------- */
  function renderTypes() {
    const ds = periodDays();
    const rows = TYPES.map((t) => ({ label: t.label, n: sum(ds, (d) => d.types[t.k]) })).sort((a, b) => b.n - a.n);
    const total = sum(rows, (r) => r.n), max = Math.max(...rows.map((r) => r.n)) || 1;
    $("typeSub").textContent = `${fmt(total)} rendez-vous ${period === "day" ? "aujourd'hui" : period === "week" ? "cette semaine" : "ce mois-ci"}`;
    $("typeBars").innerHTML = rows.map((r) => `<div class="hb"><span class="hb-l" title="${esc(r.label)}">${esc(r.label)}</span><span class="hb-t" aria-hidden="true"><i style="width:${(r.n / max) * 100}%"></i></span><span class="hb-v">${fmt(r.n)}<small>${total ? Math.round((r.n / total) * 100) : 0} %</small></span></div>`).join("");
  }

  /* ---------- horaire du jour ---------- */
  function renderSchedule() {
    const counts = { all: schedule.length }; Object.keys(STATUS).forEach((k) => (counts[k] = schedule.filter((s) => s.status === k).length));
    $("schedSub").textContent = `${dLong(today)} · ${schedule.length} rendez-vous · il est ${hm(demoMin)}`;
    $("schedFilter").innerHTML = [["all", "Tous"], ...Object.entries(STATUS).map(([k, [l]]) => [k, l])].map(([k, l]) => `<button type="button" data-f="${k}" aria-pressed="${schedFilter === k}">${l} <span class="n">${counts[k]}</span></button>`).join("");
    $("schedFilter").querySelectorAll("button").forEach((b) => (b.onclick = () => { schedFilter = b.dataset.f; renderSchedule(); }));
    const list = schedule.filter((s) => schedFilter === "all" || s.status === schedFilter);
    $("sched").innerHTML = list.length ? list.map((s) => `<li class="${s.status === "cons" ? "now" : ""}"><span class="t">${hm(s.start).replace(" h ", ":").replace(/^(\d):/, "0$1:")}</span><span class="w"><b>${esc(s.name)} · ${esc(s.reason)}</b><small>${esc(s.sp)} · ${esc(s.type)} · ${esc(s.vet)}</small></span><span class="st2 ${STATUS[s.status][1]}"><i aria-hidden="true"></i>${STATUS[s.status][0]}</span></li>`).join("") : '<li class="empty2">Aucun rendez-vous avec ce statut.</li>';
  }

  /* ---------- tâches ---------- */
  function renderTasks() {
    const open = TASKS.filter((t) => !t.done).length;
    $("taskSub").textContent = `${open} à faire · ${TASKS.length - open} faites`;
    const cnt = (c) => TASKS.filter((t) => (c === "all" || t.c === c) && !t.done).length;
    $("taskFilter").innerHTML = [["all", "Toutes"], ...Object.entries(CAT).map(([k, [l]]) => [k, l])].map(([k, l]) => `<button type="button" data-f="${k}" aria-pressed="${taskFilter === k}">${l} <span class="n">${cnt(k)}</span></button>`).join("");
    $("taskFilter").querySelectorAll("button").forEach((b) => (b.onclick = () => { taskFilter = b.dataset.f; renderTasks(); }));
    const list = TASKS.map((t, i) => ({ ...t, i })).filter((t) => taskFilter === "all" || t.c === taskFilter).sort((a, b) => a.done - b.done || b.late - a.late);
    $("tasks").innerHTML = list.map((t) => `<li class="${t.done ? "done" : ""}"><label><input type="checkbox" data-i="${t.i}"${t.done ? " checked" : ""}><span class="tt"><b>${esc(t.t)}</b><small>${t.late && !t.done ? '<span class="late">En retard · </span>' : ""}${esc(t.d)} · ${esc(t.who)}</small></span></label><span class="tag2 ${CAT[t.c][1]}">${CAT[t.c][2]}</span></li>`).join("");
    $("tasks").querySelectorAll("input").forEach((c) => (c.onchange = () => {
      TASKS[+c.dataset.i].done = c.checked;
      store.set("lq-dash-tasks", JSON.stringify(TASKS.map((t) => !!t.done)));
      renderTasks(); renderKpis();
    }));
  }

  function render() {
    $("dashOrg").textContent = document.getElementById("orgName")?.textContent || "";
    $("dashDate").textContent = dLong(today);
    document.querySelectorAll("#dashPeriod button").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.p === period)));
    document.querySelectorAll("#actView button").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.v === actView)));
    renderKpis(); renderActivity(); renderTypes(); renderSchedule(); renderTasks();
  }
  document.querySelectorAll("#dashPeriod button").forEach((b) => (b.onclick = () => { period = b.dataset.p; store.set("lq-dash-period", period); render(); }));
  document.querySelectorAll("#actView button").forEach((b) => (b.onclick = () => { actView = b.dataset.v; render(); }));
  // Flèches gauche/droite dans les sélecteurs (radiogroup)
  ["dashPeriod", "actView"].forEach((id) => $(id).addEventListener("keydown", (e) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    const bs = [...$(id).querySelectorAll("button")]; const i = bs.indexOf(document.activeElement); if (i < 0) return;
    const n = bs[(i + (e.key === "ArrowRight" ? 1 : bs.length - 1)) % bs.length]; n.focus(); n.click();
  }));

  /* ---------- onglet ---------- */
  const tab = $("tabDash");
  function openDash() {
    document.body.classList.add("dash-on");
    $("dash").hidden = false;
    tab.setAttribute("aria-selected", "true");
    $("roleRec").setAttribute("aria-selected", "false"); $("roleTsa").setAttribute("aria-selected", "false");
    store.set("lq-view", "dash");
    render();
  }
  function closeDash() {
    if (!document.body.classList.contains("dash-on")) return;
    document.body.classList.remove("dash-on");
    $("dash").hidden = true; $("dashTip").hidden = true;
    tab.setAttribute("aria-selected", "false");
    const tsa = document.body.classList.contains("tsa");
    $("roleRec").setAttribute("aria-selected", String(!tsa)); $("roleTsa").setAttribute("aria-selected", String(tsa));
    store.set("lq-view", "app");
  }
  tab.onclick = openDash;
  new MutationObserver(() => {
    if (!document.body.classList.contains("dash-on")) return;
    if ($("roleRec").getAttribute("aria-selected") === "true" || $("roleTsa").getAttribute("aria-selected") === "true") { $("roleRec").setAttribute("aria-selected", "false"); $("roleTsa").setAttribute("aria-selected", "false"); }
  }).observe(document.body, { attributes: true, attributeFilter: ["class"] });
  // Revenir à la Réception ou au TSA ferme le tableau de bord (le clic poursuit ensuite son effet habituel)
  ["roleRec", "roleTsa"].forEach((id) => $(id).addEventListener("click", closeDash, true));
  // La fenêtre du code TSA peut s'ouvrir depuis le tableau de bord : on reste cohérent
  if (store.get("lq-view") === "dash") openDash();
})();
