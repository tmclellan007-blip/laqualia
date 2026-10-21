// Tableau de bord — démonstration avec des données fictives générées localement.
// Aucune connexion externe, aucun dossier réel : tout est calculé dans le navigateur.
(() => {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const store = { get: (k) => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch {} } };
  const fmt = (n) => n.toLocaleString("fr-CA");

  /* ---------- données fictives : formation et utilisation des agents ----------
     Une équipe fictive de 15 personnes ; chaque jour, chaque personne pose des questions,
     fait des simulations et des quiz. Tout le reste (cartes, graphique, listes) en découle. */
  function rng(seed) { let x = seed >>> 0 || 1; return () => { x ^= x << 13; x >>>= 0; x ^= x >> 17; x ^= x << 5; x >>>= 0; return x / 4294967296; }; }
  const dayKey = (d) => d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate();
  const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
  const now = new Date();
  const nowMin = now.getHours() * 60 + now.getMinutes();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  const SERIES = [
    { k: "qRec", label: "Questions Réception", color: "#6250d6" },
    { k: "qTsa", label: "Questions TSA", color: "#1baf7a" },
    { k: "sims", label: "Simulations et quiz", color: "#eb6834" },
  ];
  const TEAM = [
    ["Julie R.", "rec", 0.95, "Expert"], ["Marc-André B.", "rec", 0.7, "Intermédiaire"], ["Sophie L.", "rec", 0.85, "Intermédiaire"],
    ["Karine D.", "rec", 0.5, "Débutant"], ["Émilie G.", "rec", 0.9, "Débutant"], ["Nadia T.", "rec", 0.35, "Intermédiaire"],
    ["Olivier P.", "rec", 0.6, "Débutant"], ["Camille F.", "rec", 0.0, "Débutant"], ["Isabelle M.", "rec", 0.75, "Expert"],
    ["Vincent C.", "tsa", 0.8, "Expert"], ["Mélanie S.", "tsa", 0.9, "Intermédiaire"], ["Audrey N.", "tsa", 0.55, "Intermédiaire"],
    ["Jérôme H.", "tsa", 0.4, "Débutant"], ["Laurence V.", "tsa", 0.0, "Intermédiaire"], ["Sarah K.", "tsa", 0.7, "Débutant"],
  ].map(([name, role, act, level], i) => ({ id: i, name, role, act, level, initials: name.split(/[\s-]/).map((x) => x[0]).join("").slice(0, 2).toUpperCase() }));
  // Deux personnes inactives depuis un moment (dernière connexion il y a 9 et 16 jours)
  const LAST_SEEN_DAYS = { 7: 9, 13: 16 };

  const THEMES = {
    rec: [["Rendez-vous", 84], ["Facturation", 78], ["Plainte", 71], ["Client inquiet", 80], ["Deuil", 74], ["Urgence potentielle", 61]],
    tsa: [["Transmission au vétérinaire", 76], ["Surveillance hospitalisation", 82], ["Préparation de procédure", 85], ["Consignes au client", 79], ["Client inquiet post-op", 72], ["Urgence en hospitalisation", 63]],
  };
  const TOPICS = {
    rec: [["Lexique vétérinaire", 0.24], ["Triage téléphonique", 0.2], ["Client mécontent", 0.16], ["Facturation et dépôts", 0.13], ["Prise de rendez-vous", 0.15], ["Deuil et euthanasie", 0.12]],
    tsa: [["Transmission SBAR", 0.22], ["Anesthésie et réveil", 0.2], ["Calculs d'ordonnance", 0.17], ["Surveillance hospitalisation", 0.18], ["Laboratoire", 0.13], ["Consignes au client", 0.1]],
  };

  // Activité d'une personne pour un jour donné (journées futures : rien ; aujourd'hui : jusqu'à maintenant)
  const cache = {};
  function userDay(u, d) {
    const k = dayKey(d) * 100 + u.id;
    if (cache[k]) return cache[k];
    const r = rng(k * 2654435761 + 7);
    const daysAgo = Math.round((today - d) / 86400000);
    let act = u.act;
    if (LAST_SEEN_DAYS[u.id] !== undefined) act = daysAgo === LAST_SEEN_DAYS[u.id] ? 0.6 : 0;
    if (daysAgo < 0) act = 0;
    const weekend = d.getDay() === 0 || d.getDay() === 6;
    const works = r() < (weekend && daysAgo !== 0 ? 0.35 : 0.85) * Math.min(1, act + 0.2); // la démo traite aujourd'hui comme une journée normale
    let o = { q: 0, sims: [], min: 0, last: null };
    if (works && act > 0) {
      const dayFrac = daysAgo === 0 ? Math.max(0, Math.min(1, (nowMin - 8 * 60) / (9 * 60))) : 1;
      const q = Math.round((2 + r() * 7) * act * dayFrac);
      const nSims = r() < act * 0.7 * dayFrac ? 1 + Math.floor(r() * 2) : 0;
      const sims = [];
      for (let i = 0; i < nSims; i++) {
        const th = THEMES[u.role][Math.floor(r() * 6)];
        const lvlBonus = u.level === "Expert" ? 6 : u.level === "Débutant" ? -5 : 0;
        sims.push({ theme: th[0], score: Math.max(35, Math.min(100, Math.round(th[1] + lvlBonus + (r() - 0.5) * 22))) });
      }
      const lastMin = daysAgo === 0 ? Math.max(8 * 60, nowMin - Math.floor(r() * 240)) : 9 * 60 + Math.floor(r() * 8 * 60);
      o = { q, sims, min: q * 3 + nSims * 14, last: q || nSims ? lastMin : null };
    }
    return (cache[k] = o);
  }

  function rangeDays() {
    if (period === "day") return [today];
    if (period === "week") { const m = addDays(today, -((today.getDay() + 6) % 7)); return Array.from({ length: 7 }, (_, i) => addDays(m, i)); }
    const out = []; for (let d = new Date(today.getFullYear(), today.getMonth(), 1); d.getMonth() === today.getMonth(); d = addDays(d, 1)) out.push(d); return out;
  }
  const prevRange = () => { const ds = rangeDays(); const n = period === "month" ? 30 : ds.length; return ds.map((d) => addDays(d, -n)); };
  function aggregate(ds) {
    const a = { qRec: 0, qTsa: 0, sims: 0, scoreSum: 0, min: 0, users: new Set(), themes: {} };
    ds.forEach((d) => TEAM.forEach((u) => {
      const x = userDay(u, d);
      if (u.role === "rec") a.qRec += x.q; else a.qTsa += x.q;
      a.sims += x.sims.length; a.min += x.min;
      x.sims.forEach((sm) => { a.scoreSum += sm.score; const t = a.themes[sm.theme] || (a.themes[sm.theme] = { n: 0, sum: 0 }); t.n++; t.sum += sm.score; });
      if (x.q || x.sims.length) a.users.add(u.id);
    }));
    return a;
  }
  function lastSeen(u) {
    for (let i = 0; i < 40; i++) { const d = addDays(today, -i); const x = userDay(u, d); if (x.last !== null) return { daysAgo: i, min: x.last }; }
    return null;
  }

  /* ---------- état ---------- */
  let period = ["day", "week", "month"].includes(store.get("lq-dash-period")) ? store.get("lq-dash-period") : "week";
  let actView = "chart", schedFilter = "all", taskFilter = "rec";
  const hm = (m) => `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, "0")}`;
  const dLong = (d) => d.toLocaleDateString("fr-CA", { weekday: "long", day: "numeric", month: "long" });
  const sum = (arr, f) => arr.reduce((a, x) => a + f(x), 0);
  const perLab = () => (period === "day" ? "aujourd'hui" : period === "week" ? "cette semaine" : "ce mois-ci");

  /* ---------- cartes ---------- */
  const IC = {
    users: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c0-3.6 2.9-6 6.5-6s6.5 2.4 6.5 6"/><path d="M16 4.5a3.5 3.5 0 0 1 0 7M21.5 20c0-2.6-1.4-4.6-3.5-5.5"/>',
    chat: '<path d="M21 12a8 8 0 0 1-11.6 7.1L4 20.5l1.4-4.9A8 8 0 1 1 21 12z"/>',
    phone: '<path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2"/>',
    star: '<path d="M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9z"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  };
  const kpi = (ico, label, value, sub, bar) => `<article class="kpi"><div class="k-l"><span class="k-i"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${IC[ico]}</svg></span>${label}</div><div class="k-v">${value}</div>${bar !== undefined ? `<div class="k-bar" aria-hidden="true"><i style="width:${Math.min(100, bar)}%"></i></div>` : ""}<div class="k-s">${sub}</div></article>`;
  const delta = (cur, prev, unit = "") => { const d = cur - prev; if (!prev && !cur) return ""; return d === 0 ? "stable" : `<b>${d > 0 ? "+" : "−"}${fmt(Math.abs(d))}${unit}</b> vs période précédente`; };
  function renderKpis() {
    const A = aggregate(rangeDays()), P = aggregate(prevRange());
    const score = A.sims ? Math.round(A.scoreSum / A.sims) : 0, pscore = P.sims ? Math.round(P.scoreSum / P.sims) : 0;
    const online = TEAM.filter((u) => { const l = lastSeen(u); return l && l.daysAgo === 0 && nowMin - l.min <= 15; }).length;
    const hours = A.min / 60;
    $("kpis").innerHTML = [
      kpi("users", "Personnes actives", `${A.users.size}<small>sur ${TEAM.length}</small>`, period === "day" ? `<b>${online}</b> en ligne en ce moment` : delta(A.users.size, P.users.size)),
      kpi("chat", "Questions aux agents", fmt(A.qRec + A.qTsa), `<b>${fmt(A.qRec)}</b> Réception · <b>${fmt(A.qTsa)}</b> TSA`),
      kpi("phone", "Simulations et quiz", fmt(A.sims), delta(A.sims, P.sims) || "aucune sur la période précédente"),
      kpi("star", "Score moyen", A.sims ? score + " %" : "—", A.sims ? delta(score, pscore, " pt") : "aucune simulation", A.sims ? score : 0),
      kpi("clock", "Temps de formation", hours >= 10 ? `${Math.round(hours)} h` : `${hours.toFixed(1).replace(".", ",")} h`, A.users.size ? `≈ <b>${Math.round(A.min / A.users.size)} min</b> par personne active` : "—"),
    ].join("");
  }

  /* ---------- utilisation (colonnes groupées) ---------- */
  function buckets() {
    if (period === "day") {
      // Aujourd'hui par heure : la journée d'aujourd'hui répartie sur les heures déjà écoulées
      const A = aggregate([today]); const hours = []; const r = rng(dayKey(today));
      const cur = Math.min(17, Math.max(8, Math.floor(nowMin / 60)));
      for (let h = 8; h <= 17; h++) hours.push({ h, w: h <= cur ? 0.6 + r() * (h === 10 || h === 14 ? 1.4 : 0.9) : 0 });
      const W = sum(hours, (x) => x.w) || 1;
      const split = (tot) => { let left = tot; return hours.map((x, i) => { const v = i === hours.length - 1 ? left : Math.min(left, Math.round((tot * x.w) / W)); left -= v; return v; }); };
      const qr = split(A.qRec), qt = split(A.qTsa), sm = split(A.sims);
      return hours.map((x, i) => ({ label: x.h + " h", full: `${x.h} h à ${x.h + 1} h`, tbl: `${x.h} h`, g: { qRec: qr[i], qTsa: qt[i], sims: sm[i] }, cur: x.h === cur }));
    }
    const ds = rangeDays();
    if (period === "week") return ds.map((d) => { const A = aggregate([d]); return { label: d.toLocaleDateString("fr-CA", { weekday: "short" }).replace(".", ""), full: dLong(d), tbl: d.toLocaleDateString("fr-CA", { weekday: "short", day: "numeric" }).replace(".", ""), g: { qRec: A.qRec, qTsa: A.qTsa, sims: A.sims }, cur: dayKey(d) === dayKey(today) }; });
    const out = [];
    ds.forEach((d) => {
      const wk = addDays(d, -((d.getDay() + 6) % 7)); const start = wk < ds[0] ? ds[0] : wk;
      let b = out.find((x) => x.key === dayKey(start));
      if (!b) { b = { key: dayKey(start), label: "Sem. du " + start.getDate(), full: "Semaine du " + start.toLocaleDateString("fr-CA", { day: "numeric", month: "long" }), tbl: "Sem. du " + start.toLocaleDateString("fr-CA", { day: "numeric", month: "short" }).replace(".", ""), g: { qRec: 0, qTsa: 0, sims: 0 }, cur: false }; out.push(b); }
      const A = aggregate([d]); b.g.qRec += A.qRec; b.g.qTsa += A.qTsa; b.g.sims += A.sims;
      if (dayKey(d) === dayKey(today)) b.cur = true;
    });
    return out;
  }
  function renderActivity() {
    const B = buckets();
    $("actSub").textContent = period === "day" ? "Par heure, aujourd'hui" : period === "week" ? "Par jour, semaine en cours · aujourd'hui en évidence" : "Par semaine, " + today.toLocaleDateString("fr-CA", { month: "long", year: "numeric" });
    $("actLegend").innerHTML = SERIES.map((s) => `<span><i style="background:${s.color}"></i>${s.label}</span>`).join("");
    const W = 720, H = 260, padL = 34, padB = 28, padT = 10;
    const max = Math.max(1, ...B.map((b) => Math.max(...SERIES.map((s) => b.g[s.k]))));
    const step = max > 100 ? 50 : max > 40 ? 20 : max > 20 ? 10 : max > 8 ? 5 : 2;
    const top = Math.ceil(max / step) * step;
    const y = (v) => padT + (H - padT - padB) * (1 - v / top);
    const bw = (W - padL) / B.length, barW = Math.min(24, (bw - 14) / 3 - 2);
    let g = "";
    for (let v = 0; v <= top; v += step) g += `<line class="gl" x1="${padL}" x2="${W}" y1="${y(v)}" y2="${y(v)}"/><text class="ax" x="${padL - 8}" y="${y(v) + 4}" text-anchor="end">${v}</text>`;
    B.forEach((b, i) => {
      const cx = padL + bw * i + bw / 2;
      if (b.cur) g += `<rect class="band" x="${cx - bw / 2 + 3}" y="${padT}" width="${bw - 6}" height="${H - padT - padB}" rx="8"/>`;
      const x0 = cx - (barW * 3 + 4) / 2;
      SERIES.forEach((s, j) => {
        const v = b.g[s.k], x = x0 + j * (barW + 2), yt = y(v), h = y(0) - yt; if (h <= 0) return;
        const r = Math.min(4, h, barW / 2);
        g += `<path fill="${s.color}" d="M${x},${y(0)} V${yt + r} Q${x},${yt} ${x + r},${yt} H${x + barW - r} Q${x + barW},${yt} ${x + barW},${yt + r} V${y(0)} Z"/>`;
      });
      g += `<text class="ax${b.cur ? " cur" : ""}" x="${cx}" y="${H - 8}" text-anchor="middle">${esc(b.label)}</text><rect class="hit" data-i="${i}" x="${padL + bw * i}" y="${padT}" width="${bw}" height="${H - padT - padB + 4}"/>`;
    });
    $("actChart").innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Utilisation des agents : questions Réception, questions TSA, simulations et quiz">${g}</svg>`;
    const tip = $("dashTip");
    $("actChart").querySelectorAll(".hit").forEach((h) => {
      const b = B[+h.dataset.i];
      const show = (e) => {
        tip.innerHTML = `<b>${esc(b.full)}</b>` + SERIES.map((s) => `<div class="r"><span><i style="background:${s.color}"></i>${s.label}</span><strong>${b.g[s.k]}</strong></div>`).join("");
        tip.hidden = false;
        const z = parseFloat(getComputedStyle(document.body).zoom) || 1; // zoom grand écran
        tip.style.left = Math.min(window.innerWidth / z - tip.offsetWidth - 10, e.clientX / z + 14) + "px"; tip.style.top = Math.max(10, e.clientY / z - tip.offsetHeight - 12) + "px";
      };
      h.addEventListener("mousemove", show); h.addEventListener("click", show); h.addEventListener("mouseleave", () => (tip.hidden = true));
    });
    const tot = (k) => sum(B, (b) => b.g[k]);
    $("actTable").innerHTML = `<table><thead><tr><th>${period === "day" ? "Heure" : period === "week" ? "Jour" : "Semaine"}</th>${SERIES.map((s) => `<th>${s.label}</th>`).join("")}</tr></thead><tbody>${B.map((b) => `<tr><td>${esc(b.tbl)}${b.cur ? " · auj." : ""}</td>${SERIES.map((s) => `<td>${b.g[s.k]}</td>`).join("")}</tr>`).join("")}</tbody><tfoot><tr><td>Total</td>${SERIES.map((s) => `<td>${tot(s.k)}</td>`).join("")}</tr></tfoot></table>`;
    $("actChart").hidden = actView !== "chart"; $("actLegend").hidden = actView !== "chart"; $("actTable").hidden = actView !== "table";
  }

  /* ---------- sujets les plus consultés ---------- */
  function renderTypes() {
    const A = aggregate(rangeDays());
    const rows = [];
    ["rec", "tsa"].forEach((role) => { const tot = role === "rec" ? A.qRec : A.qTsa; let left = tot; TOPICS[role].forEach(([t, w], i) => { const n = i === TOPICS[role].length - 1 ? left : Math.round(tot * w); left -= n; rows.push({ label: t, role, n: Math.max(0, n) }); }); });
    rows.sort((a, b) => b.n - a.n);
    const top = rows.slice(0, 8), total = A.qRec + A.qTsa, max = Math.max(1, ...top.map((r) => r.n));
    $("typeSub").textContent = `${fmt(total)} questions ${perLab()} · 8 sujets principaux`;
    $("typeBars").innerHTML = total ? top.map((r) => `<div class="hb"><span class="hb-l" title="${esc(r.label)}">${esc(r.label)} <small style="color:var(--muted)">${r.role === "rec" ? "Réc." : "TSA"}</small></span><span class="hb-t" aria-hidden="true"><i style="width:${(r.n / max) * 100}%"></i></span><span class="hb-v">${fmt(r.n)}<small>${Math.round((r.n / total) * 100)} %</small></span></div>`).join("") : '<p class="empty2">Aucune question sur cette période.</p>';
  }

  /* ---------- équipe : connexions et progression ---------- */
  function seenStatus(l) {
    if (!l) return ["off", "Jamais connecté"];
    if (l.daysAgo === 0) return nowMin - l.min <= 15 ? ["on", "En ligne"] : ["day", "Aujourd'hui · " + hm(l.min)];
    if (l.daysAgo <= 7) return ["week", l.daysAgo === 1 ? "Hier" : `Il y a ${l.daysAgo} jours`];
    return ["off", `Inactif depuis ${l.daysAgo} jours`];
  }
  function renderSchedule() {
    const ds = rangeDays();
    const rows = TEAM.map((u) => {
      const l = lastSeen(u);
      let q = 0, sims = 0, sc = 0;
      ds.forEach((d) => { const x = userDay(u, d); q += x.q; sims += x.sims.length; sc += sum(x.sims, (s) => s.score); });
      return { u, l, st: seenStatus(l), q, sims, score: sims ? Math.round(sc / sims) : null };
    // L'exemple cliquable (Marc-André B.) reste toujours en tête de liste ; les autres suivent par dernière connexion.
    }).sort((a, b) => (b.u.id === DEMO_ID) - (a.u.id === DEMO_ID) || (a.l ? a.l.daysAgo * 2000 - a.l.min : 1e9) - (b.l ? b.l.daysAgo * 2000 - b.l.min : 1e9));
    const inact = rows.filter((r) => r.st[0] === "off").length;
    $("schedSub").textContent = `${TEAM.length} personnes · activité ${perLab()} · ${inact} inactive${inact > 1 ? "s" : ""} depuis plus de 7 jours`;
    const F = [["all", "Toutes", rows.length], ["rec", "Réception", rows.filter((r) => r.u.role === "rec").length], ["tsa", "TSA", rows.filter((r) => r.u.role === "tsa").length], ["off", "Inactives", inact]];
    $("schedFilter").innerHTML = F.map(([k, l, n]) => `<button type="button" data-f="${k}" aria-pressed="${schedFilter === k}">${l} <span class="n">${n}</span></button>`).join("");
    $("schedFilter").querySelectorAll("button").forEach((b) => (b.onclick = () => { schedFilter = b.dataset.f; renderSchedule(); }));
    const list = rows.filter((r) => schedFilter === "all" || (schedFilter === "off" ? r.st[0] === "off" : r.u.role === schedFilter));
    const ST = { on: "st-on", day: "st-day", week: "st-week", off: "st-off" };
    $("sched").innerHTML = list.map((r) => `<li${r.u.id === DEMO_ID ? ` class="p-link" tabindex="0" role="button" aria-label="Voir le profil de ${esc(r.u.name)}"` : ""}><span class="av2 ${r.u.role}" aria-hidden="true">${r.u.initials}</span><span class="w"><b>${esc(r.u.name)} <small style="font-weight:700;color:var(--muted)">· ${r.u.role === "rec" ? "Réception" : "TSA"} · ${r.u.level}</small></b><span class="meta"><span>${fmt(r.q)} questions</span><span>${r.sims} simulation${r.sims > 1 ? "s" : ""}</span><span>${r.score === null ? "score —" : "score " + r.score + " %"}${r.score === null ? "" : `<span class="prog" aria-hidden="true"><i style="width:${r.score}%"></i></span>`}</span></span></span><span class="st2 ${ST[r.st[0]]}"><i aria-hidden="true"></i>${esc(r.st[1])}</span>${r.u.id === DEMO_ID ? '<span class="p-go">Voir le profil <b aria-hidden="true">›</b></span>' : ""}</li>`).join("") || '<li class="empty2">Personne dans cette catégorie.</li>';
  }

  /* ---------- réussite par thème ---------- */
  function renderTasks() {
    const A = aggregate(rangeDays());
    $("taskFilter").innerHTML = [["rec", "Réception"], ["tsa", "TSA"]].map(([k, l]) => `<button type="button" data-f="${k}" aria-pressed="${taskFilter === k}">${l}</button>`).join("");
    $("taskFilter").querySelectorAll("button").forEach((b) => (b.onclick = () => { taskFilter = b.dataset.f; renderTasks(); }));
    const rows = THEMES[taskFilter].map(([t]) => { const x = A.themes[t]; return { t, n: x ? x.n : 0, score: x ? Math.round(x.sum / x.n) : null }; }).sort((a, b) => (a.score ?? 101) - (b.score ?? 101));
    const n = sum(rows, (r) => r.n);
    $("taskSub").textContent = `${n} simulation${n > 1 ? "s" : ""} ${taskFilter === "rec" ? "Réception" : "TSA"} ${perLab()} · du thème le plus faible au plus fort`;
    const lvl = (s) => (s >= 80 ? ["ok", "Solide"] : s >= 68 ? ["mid", "À consolider"] : ["low", "À renforcer"]);
    $("tasks").innerHTML = rows.map((r) => r.score === null
      ? `<div class="th"><span class="th-l">${esc(r.t)}</span><span class="th-v"><small>aucune simulation</small></span><span class="th-t"></span></div>`
      : `<div class="th"><span class="th-l">${esc(r.t)} <small>· ${r.n} essai${r.n > 1 ? "s" : ""}</small></span><span class="th-v">${r.score} %<span class="lvl ${lvl(r.score)[0]}">${lvl(r.score)[1]}</span></span><span class="th-t" aria-hidden="true"><i style="width:${r.score}%"></i></span></div>`).join("");
  }


  /* ---------- profil individuel (exemple : une seule personne, données entièrement fictives) ---------- */
  const DEMO_ID = 1; // Marc-André B.
  const PROFILE = {
    since: "mars 2026", poste: "Réceptionniste · quart de jour",
    path: { pct: 58, done: ["Accueil téléphonique et identification", "Lexique vétérinaire de base", "Prise de rendez-vous"], doing: [["Triage téléphonique", 60], ["Client mécontent ou inquiet", 35]], todo: ["Facturation et dépôts", "Deuil et euthanasie", "Urgences et transferts"] },
    strengths: ["Accueil chaleureux, identifie toujours le client et l'animal dès le début de l'appel.", "Utilise le bon vocabulaire (NPO, vaccins, castration) avec aisance."],
    work: ["Repérer plus tôt les signes d'urgence quand le client minimise.", "Expliquer les dépôts de chirurgie avec un montant clair et sans se justifier."],
    next: "Terminer le module « Triage téléphonique », puis refaire une simulation « Urgence potentielle » au niveau Intermédiaire.",
    meeting: "jeudi 23 octobre, 14 h — suivi avec la gestionnaire",
  };
  function personData(u) {
    const days = Array.from({ length: 28 }, (_, i) => addDays(today, i - 27));
    const per = days.map((d) => ({ d, x: userDay(u, d) }));
    const hist = []; for (let i = 0; i < 60; i++) { const d = addDays(today, -i); userDay(u, d).sims.forEach((sm) => hist.push({ d, ...sm })); }
    const q = sum(per, (p) => p.x.q), sims = sum(per, (p) => p.x.sims.length), mins = sum(per, (p) => p.x.min);
    const sc = sum(per, (p) => sum(p.x.sims, (s) => s.score));
    const active = per.filter((p) => p.x.q || p.x.sims.length).length;
    const prev = Array.from({ length: 28 }, (_, i) => userDay(u, addDays(today, i - 55)));
    const prevSims = sum(prev, (x) => x.sims.length), prevSc = sum(prev, (x) => sum(x.sims, (s) => s.score));
    return { per, hist, q, sims, mins, active, avg: sims ? Math.round(sc / sims) : null, prevAvg: prevSims ? Math.round(prevSc / prevSims) : null, prevQ: sum(prev, (x) => x.q) };
  }
  const lvlOf = (s) => (s >= 80 ? ["ok", "Solide"] : s >= 68 ? ["mid", "À consolider"] : ["low", "À renforcer"]);
  function renderPerson() {
    const u = TEAM[DEMO_ID], P = personData(u), st = seenStatus(lastSeen(u));
    const ST = { on: "st-on", day: "st-day", week: "st-week", off: "st-off" };
    // Activité : 28 jours
    const W = 760, H = 190, pl = 30, pb = 26, pt = 10, bw = (W - pl) / 28;
    const mx = Math.max(6, ...P.per.map((p) => p.x.q));
    const y = (v) => H - pb - (v / mx) * (H - pb - pt);
    let g = [0, Math.round(mx / 2), mx].map((v) => `<line class="gl" x1="${pl}" x2="${W}" y1="${y(v)}" y2="${y(v)}"/><text class="ax" x="${pl - 6}" y="${y(v) + 4}" text-anchor="end">${v}</text>`).join("");
    P.per.forEach((p, i) => {
      const x = pl + i * bw + bw * 0.18, w = bw * 0.64;
      if (p.x.q) g += `<rect x="${x}" y="${y(p.x.q)}" width="${w}" height="${H - pb - y(p.x.q)}" rx="3" fill="#6250d6"/>`;
      p.x.sims.forEach((_, k) => (g += `<circle cx="${x + w / 2}" cy="${y(p.x.q) - 7 - k * 9}" r="3.6" fill="#eb6834"/>`));
      if (i % 7 === 0 || i === 27) g += `<text class="ax${i === 27 ? " cur" : ""}" x="${x + w / 2}" y="${H - 6}" text-anchor="middle">${i === 27 ? "auj." : p.d.toLocaleDateString("fr-CA", { day: "numeric", month: "short" })}</text>`;
    });
    // Thèmes (60 jours)
    const th = THEMES.rec.map(([t]) => { const xs = P.hist.filter((h) => h.theme === t); return { t, n: xs.length, score: xs.length ? Math.round(sum(xs, (h) => h.score) / xs.length) : null }; }).sort((a, b) => (a.score ?? 101) - (b.score ?? 101));
    const topics = TOPICS.rec.map(([t, w], i) => [t, Math.max(1, Math.round(P.q * w * [1.3, 1.25, 0.8, 0.7, 1.1, 0.6][i]))]).sort((a, b) => b[1] - a[1]);
    const tmax = topics[0][1];
    const hdate = (d) => { const n = Math.round((today - d) / 86400000); return n === 0 ? "Aujourd'hui" : n === 1 ? "Hier" : d.toLocaleDateString("fr-CA", { day: "numeric", month: "short" }); };
    const dAvg = P.avg !== null && P.prevAvg !== null ? P.avg - P.prevAvg : 0;
    const box = $("dashPerson");
    box.innerHTML = `
      <button type="button" class="dp-back" id="dpBack"><span aria-hidden="true">‹</span> Retour au tableau de bord</button>
      <header class="dp-head">
        <span class="av2 rec dp-av" aria-hidden="true">${u.initials}</span>
        <div class="dp-id"><h1 id="dpTitle">${esc(u.name)} <span class="demo-pill" title="Profil fictif">Démo</span></h1>
          <p>${PROFILE.poste} · niveau ${u.level} · dans l'équipe depuis ${PROFILE.since}</p></div>
        <span class="st2 ${ST[st[0]]}"><i aria-hidden="true"></i>${esc(st[1])}</span>
      </header>
      <p class="dp-note">Exemple de profil individuel : toutes les données sont inventées. 30 derniers jours, sauf mention contraire.</p>
      <section class="kpis" aria-label="Indicateurs de ${esc(u.name)}">
        ${kpi("chat", "Questions aux agents", fmt(P.q), delta(P.q, P.prevQ))}
        ${kpi("phone", "Simulations et quiz", P.sims, `<b>${P.per.filter((p) => p.x.sims.length).length}</b> jours d'entraînement`)}
        ${kpi("star", "Score moyen", P.avg === null ? "—" : P.avg + " %", dAvg ? `<b>${dAvg > 0 ? "+" : "−"}${Math.abs(dAvg)} pt</b> vs mois précédent` : "stable", P.avg ?? 0)}
        ${kpi("clock", "Temps de formation", hm(P.mins), `≈ <b>${Math.round(P.mins / Math.max(1, P.active))} min</b> par jour actif`)}
        ${kpi("users", "Jours actifs", `${P.active}<small>sur 28</small>`, `Parcours complété à <b>${PROFILE.path.pct} %</b>`, PROFILE.path.pct)}
      </section>
      <div class="dgrid">
        <section class="dcard d-wide" aria-labelledby="dpAct"><div class="dc-h"><div><h2 id="dpAct">Activité des 4 dernières semaines</h2><p class="dc-sub">Questions posées par jour · un point par simulation ou quiz</p></div></div>
          <div class="legend"><span><i style="background:#6250d6"></i>Questions</span><span><i style="background:#eb6834;border-radius:50%"></i>Simulations et quiz</span></div>
          <div class="chart-wrap"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Activité quotidienne de ${esc(u.name)} sur 28 jours">${g}</svg></div></section>
        <section class="dcard" aria-labelledby="dpTop"><div class="dc-h"><div><h2 id="dpTop">Sujets les plus consultés</h2><p class="dc-sub">${fmt(P.q)} questions · 30 jours</p></div></div>
          <div class="hbars">${topics.map(([t, n]) => `<div class="hb"><span class="hb-l">${esc(t)}</span><span class="hb-t"><i style="width:${Math.round((n / tmax) * 100)}%"></i></span><span class="hb-v">${n}</span></div>`).join("")}</div></section>
        <section class="dcard" aria-labelledby="dpTh"><div class="dc-h"><div><h2 id="dpTh">Réussite par thème</h2><p class="dc-sub">Simulations des 60 derniers jours · du plus faible au plus fort</p></div></div>
          <div class="tasks">${th.map((r) => r.score === null ? `<div class="th"><span class="th-l">${esc(r.t)}</span><span class="th-v"><small>aucune simulation</small></span><span class="th-t"></span></div>` : `<div class="th"><span class="th-l">${esc(r.t)} <small>· ${r.n} essai${r.n > 1 ? "s" : ""}</small></span><span class="th-v">${r.score} %<span class="lvl ${lvlOf(r.score)[0]}">${lvlOf(r.score)[1]}</span></span><span class="th-t" aria-hidden="true"><i style="width:${r.score}%"></i></span></div>`).join("")}</div></section>
        <section class="dcard" aria-labelledby="dpSim"><div class="dc-h"><div><h2 id="dpSim">Dernières simulations</h2><p class="dc-sub">Les plus récentes en premier</p></div></div>
          <ol class="dp-sims">${P.hist.slice(0, 6).map((h) => `<li><span class="dp-d">${hdate(h.d)}</span><span class="dp-t">${esc(h.theme)}</span><span class="th-v">${h.score} %<span class="lvl ${lvlOf(h.score)[0]}">${lvlOf(h.score)[1]}</span></span></li>`).join("") || '<li class="empty2">Aucune simulation récente.</li>'}</ol></section>
        <section class="dcard" aria-labelledby="dpPath"><div class="dc-h"><div><h2 id="dpPath">Parcours de formation</h2><p class="dc-sub">${PROFILE.path.done.length} modules terminés sur ${PROFILE.path.done.length + PROFILE.path.doing.length + PROFILE.path.todo.length}</p></div></div>
          <div class="dp-bar" role="progressbar" aria-valuenow="${PROFILE.path.pct}" aria-valuemin="0" aria-valuemax="100" aria-label="Progression du parcours"><i style="width:${PROFILE.path.pct}%"></i></div>
          <ul class="dp-mods">${PROFILE.path.doing.map(([t, p]) => `<li class="doing"><b>${esc(t)}</b><small>En cours · ${p} %</small></li>`).join("")}${PROFILE.path.done.map((t) => `<li class="done"><b>${esc(t)}</b><small>Terminé</small></li>`).join("")}${PROFILE.path.todo.map((t) => `<li><b>${esc(t)}</b><small>À commencer</small></li>`).join("")}</ul></section>
        <section class="dcard" aria-labelledby="dpFollow"><div class="dc-h"><div><h2 id="dpFollow">Suivi et accompagnement</h2><p class="dc-sub">Prochain point : ${PROFILE.meeting}</p></div></div>
          <div class="dp-fb good"><b>Points forts</b><ul>${PROFILE.strengths.map((t) => `<li>${esc(t)}</li>`).join("")}</ul></div>
          <div class="dp-fb grow"><b>À travailler</b><ul>${PROFILE.work.map((t) => `<li>${esc(t)}</li>`).join("")}</ul></div>
          <p class="dp-next"><b>Prochaine étape suggérée</b>${esc(PROFILE.next)}</p></section>
      </div>`;
    $("dpBack").onclick = closePerson;
  }
  function openPerson() {
    if (!$("dashPerson")) { const sct = document.createElement("section"); sct.id = "dashPerson"; sct.className = "dp"; sct.setAttribute("aria-labelledby", "dpTitle"); document.querySelector("#dash .dash-in").append(sct); }
    renderPerson();
    $("dash").classList.add("dp-on"); $("dash").scrollTop = 0;
    $("dpBack").focus();
  }
  function closePerson() {
    if (!$("dash").classList.contains("dp-on")) return;
    $("dash").classList.remove("dp-on");
    const li = document.querySelector("#sched .p-link");
    if (li) { li.scrollIntoView({ block: "center" }); li.focus(); }
  }
  $("sched").addEventListener("click", (e) => { if (e.target.closest(".p-link")) openPerson(); });
  $("sched").addEventListener("keydown", (e) => { if ((e.key === "Enter" || e.key === " ") && e.target.closest(".p-link")) { e.preventDefault(); openPerson(); } });

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
    $("dash").hidden = true; $("dashTip").hidden = true; $("dash").classList.remove("dp-on");
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
