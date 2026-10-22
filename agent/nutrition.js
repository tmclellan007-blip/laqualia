// Espace TSA › « Nutrition — Aide au conseil client », intégré à la conversation (aucune autre fenêtre).
// Le bouton sous le champ active le mode Nutrition : le champ change de couleur, un bandeau rappelle le mode
// juste au-dessus, et les réponses arrivent dans le fil. Si on demande une comparaison, elle s'affiche avec ses sources.
// Les sources affichées sont celles que le relais a RÉELLEMENT consultées : un produit du comparateur sans
// fiche consultée est signalé comme non vérifié, sans aucune caractéristique.
(() => {
  "use strict";
  const A = () => window.LQAgent;
  const $ = (id) => document.getElementById(id);
  const esc = (t) => String(t ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const NP = "Non précisé dans la source";
  const PRICE = "Prix et disponibilité à confirmer auprès de la clinique.";
  const OK_DOMAINS = /^https:\/\/(www\.)?(royalcanin\.com|hillspet\.ca|purina\.ca)\//i;
  const PH = () => (matchMedia("(max-width: 520px)").matches ? "Question nutrition…" : "Question nutrition (ex. : le chat refuse son aliment rénal)…");
  const COMP = [["fabricant", "Fabricant"], ["gamme", "Gamme"], ["espece", "Espèce"], ["forme", "Forme / texture"], ["indications", "Indications déclarées"], ["contre_indications", "Contre-indications déclarées"], ["nutrition", "Points nutritionnels déclarés"], ["formats", "Formats"], ["taille_croquette", "Taille de croquette"]];

  let on = false, history = [], prevPH = "";

  /* ---------- bandeau au-dessus du champ : mode actif, rappel des sources, Quitter ---------- */
  function buildTray() {
    $("nutriTray").innerHTML = `<div class="nt-head"><span class="nt-badge"><span class="nt-dot" aria-hidden="true"></span>Mode Nutrition &amp; produits</span><button type="button" class="nt-quit" id="ntQuit">Quitter</button></div>`;
    $("ntQuit").onclick = () => exit(true);
  }

  function enter() {
    if (on || !A() || !A().isTsa()) return;
    if (!$("nutriTray").childElementCount) buildTray();
    on = true;
    document.body.classList.add("nutri");
    $("nutriTray").hidden = false;
    syncTile();
    const q = $("q"); prevPH = q.placeholder; q.placeholder = PH(); q.setAttribute("aria-label", "Question nutrition"); q.focus();
  }
  // Tuile « Nutrition » des outils TSA : indique si le mode est actif (la tuile est redessinée avec les outils)
  function syncTile() {
    document.querySelectorAll(".nutri-tool").forEach((t) => {
      t.setAttribute("aria-pressed", String(on));
      t.title = on ? "Mode actif · touchez pour quitter" : "";
    });
  }
  function exit(focus) {
    if (!on) return;
    on = false;
    document.body.classList.remove("nutri");
    $("nutriTray").hidden = true;
    syncTile();
    const q = $("q"); if (prevPH) q.placeholder = prevPH; q.setAttribute("aria-label", "Décrivez le cas ou la tâche");
    if (focus) q.focus();
  }

  /* ---------- envoi et réponse dans le fil ---------- */
  async function send(forced, prods) {
    const q = String(forced ?? $("q").value).trim();
    if (!q) { $("q").focus(); return; }
    prods = [];
    if (!forced) { $("q").value = ""; A().chat.autosize(); }
    const chat = A().chat;
    chat.addQuestion(`Nutrition & produits — ${q}`);
    const { m, col, body } = chat.addAnswer();
    m.classList.add("nutri-msg");
    body.innerHTML = '<ol class="nu-steps"><li class="on">Analyse de la demande…</li></ol><div class="nu-ans"></div><div class="nu-cmp-out"></div><div class="nu-src-out"></div>';
    const S = (sel) => body.querySelector(sel);
    const step = (html, cls = "") => { const ol = S(".nu-steps"); ol.querySelectorAll("li.on").forEach((x) => x.classList.remove("on")); ol.insertAdjacentHTML("beforeend", `<li class="on ${cls}">${html}</li>`); };
    const err = (msg, retry) => {
      S(".nu-ans").insertAdjacentHTML("beforeend", `<div class="nu-err" role="alert">${esc(msg)}${retry ? ' <button type="button" class="nu-retry">Réessayer</button>' : ""}</div>`);
      const r = body.querySelector(".nu-retry"); if (r) r.onclick = () => send(q, prods);
    };
    if (!A().ready()) { body.innerHTML = '<p class="err">L\'assistant n\'est pas encore activé.</p>'; return; }
    const run = await chat.begin();
    let text = "", sources = [], date = "", empty = false, failed = false, first = true;
    let idle = 0;
    const abortIdle = () => { clearTimeout(idle); idle = setTimeout(() => ctlAbort(), 90000); };
    let ctlAbort = () => {};
    try {
      const ac = new AbortController();
      run.signal.addEventListener("abort", () => ac.abort());
      ctlAbort = () => ac.abort();
      abortIdle();
      const res = await A().post({ mode: "nutrition", role: "tsa", question: q, history: history.slice(-4), prenom: A().prenom(), tier: A().tier(), nutrition: {} }, ac.signal);
      if (!res.ok) {
        let msg = "La demande a échoué. Réessayez."; try { msg = (await res.json()).error || msg; } catch {}
        failed = true; S(".nu-steps").remove(); err(msg, res.status >= 500 || res.status === 429); return;
      }
      const reader = res.body.getReader(), dec = new TextDecoder(); let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        abortIdle();
        buf += dec.decode(value, { stream: true });
        const lines = buf.split("\n"); buf = lines.pop();
        for (const line of lines) {
          if (!line.trim()) continue;
          let e; try { e = JSON.parse(line); } catch { continue; }
          if (e.t === "status") step(e.k === "search" ? `Recherche : « ${esc(e.d)} »` : e.k === "fetch" ? `Consultation : ${esc(shortUrl(e.d))}` : esc(e.d), e.k);
          else if (e.t === "source") step(e.ok ? `Fiche consultée : ${esc(e.title || shortUrl(e.url))}` : `Fiche inaccessible : ${esc(shortUrl(e.url))}`, e.ok ? "ok" : "bad");
          else if (e.t === "text") { text += e.d; render(body, text, false); if (first) { first = false; chat.toTopOf(m); } }
          else if (e.t === "error") { failed = true; err(e.d, true); }
          else if (e.t === "empty") empty = true;
          else if (e.t === "done") { sources = e.sources || []; date = e.date || ""; }
        }
      }
      step(failed ? "Interrompu" : "Terminé", failed ? "bad" : "end");
      if (text) render(body, text, true, sources, date);
      else if (!failed) S(".nu-ans").innerHTML = '<div class="nu-empty"><b>Aucun résultat</b>Reformulez la question ou précisez le nom exact du produit.</div>';
      if (!text && sources.length) S(".nu-src-out").innerHTML = sourcesHtml(sources, date);
      if (text) {
        history.push({ role: "user", content: q }, { role: "assistant", content: text.replace(/```comparaison[\s\S]*?```/g, "").slice(0, 6000) });
        chat.remember("Nutrition & produits — " + q, text.replace(/```comparaison[\s\S]*?```/g, ""));
        addCopy(col, body);
      }
      requestAnimationFrame(() => chat.toTopOf(m));
    } catch (e2) {
      if (e2 && e2.name === "AbortError") { if (text) { render(body, text, true, sources, date); S(".nu-ans").insertAdjacentHTML("beforeend", '<p class="stopped">Réponse arrêtée.</p>'); } else { S(".nu-steps")?.remove(); err("Demande arrêtée. Vous pouvez la relancer.", true); } }
      else err("Connexion au serveur impossible. Vérifiez votre connexion Internet.", true);
    } finally {
      clearTimeout(idle);
      run.end();
    }
  }
  function addCopy(col, body) {
    const acts = document.createElement("div"); acts.className = "actions";
    const cp = document.createElement("button"); cp.type = "button"; cp.className = "act"; cp.innerHTML = "<span>Copier la réponse</span>";
    cp.onclick = async () => {
      try { await navigator.clipboard.writeText(body.querySelector(".nu-ans").innerText + "\n\n" + (body.querySelector(".nu-src-out")?.innerText || "")); cp.firstChild.textContent = "Copié ✓"; }
      catch { cp.firstChild.textContent = "Copie impossible"; }
      setTimeout(() => (cp.firstChild.textContent = "Copier la réponse"), 2000);
    };
    acts.append(cp); col.append(acts);
  }
  const shortUrl = (u) => String(u || "").replace(/^https?:\/\/(www\.)?/, "").slice(0, 80);
  const fmtDate = (iso, fallback) => { try { const d = iso ? new Date(iso) : new Date(fallback + "T12:00:00"); return d.toLocaleDateString("fr-CA", { day: "numeric", month: "long", year: "numeric" }); } catch { return fallback || ""; } };

  function render(body, text, done, sources, date) {
    const m = text.match(/```comparaison\s*([\s\S]*?)(```|$)/);
    const prose = text.replace(/```comparaison[\s\S]*?(```|$)/g, "").trim();
    const html = A().md(prose).replace(/\[([^\]]+)\]\((https:\/\/[^)\s]+)\)/g, (_, t, u) => {
      const raw = u.replace(/&amp;/g, "&");
      return OK_DOMAINS.test(raw) ? `<a href="${u}" target="_blank" rel="noopener noreferrer">${t}</a>` : `${t} <small>(lien hors des sites officiels, non affiché)</small>`;
    });
    body.querySelector(".nu-ans").innerHTML = html;
    if (!done) return;
    const consulted = new Map((sources || []).filter((s) => s.ok).map((s) => [norm(s.url), s]));
    if (m) {
      let data = null; try { data = JSON.parse(m[1]); } catch {}
      const prods = Array.isArray(data?.produits) ? data.produits.slice(0, 3) : [];
      body.querySelector(".nu-cmp-out").innerHTML = prods.length ? comparator(prods, data.notes, consulted, date) : (m[1].trim() ? '<div class="nu-err">Le comparatif reçu est illisible. Relancez la comparaison.</div>' : "");
    }
    body.querySelector(".nu-src-out").innerHTML = sourcesHtml(sources || [], date);
  }
  const norm = (u) => String(u || "").replace(/[#?].*$/, "").replace(/\/$/, "");

  function comparator(prods, notes, consulted, date) {
    const cols = prods.map((p) => { const src = consulted.get(norm(p.source)); return { p, src, verified: !!src }; });
    const cell = (c, k) => (c.verified ? esc(String(c.p[k] || "").trim() || NP) : NP);
    return `<section class="nu-cmp" aria-label="Comparatif"><h3>Comparatif</h3>
      <div class="nu-cmp-grid" style="--n:${cols.length}">
        ${cols.map((c) => `<article class="nu-card${c.verified ? "" : " unv"}">
          <h4>${esc(c.p.nom || "Produit")}</h4>
          ${c.verified ? `<a class="nu-link" href="${esc(c.src.url)}" target="_blank" rel="noopener noreferrer">Fiche officielle</a><small>Consultée le ${esc(fmtDate(c.src.retrieved_at, date))}</small>`
            : '<p class="nu-bad">Fiche non consultée : aucune information n\'est affichée pour ce produit. Fournissez la fiche en PDF ou un document approuvé.</p>'}
          ${c.verified ? `<dl>${COMP.map(([k, l]) => `<dt>${l}</dt><dd>${k === "fabricant" ? esc(c.p[k] || c.src.fabricant || NP) : cell(c, k)}</dd>`).join("")}` : "<dl>"}
          <dt>Prix et disponibilité</dt><dd>${PRICE}</dd></dl></article>`).join("")}
      </div>
      <p class="nu-note"><b>Important :</b> deux aliments d'une même catégorie ne sont pas pour autant équivalents sur le plan thérapeutique. Tout remplacement d'un aliment thérapeutique se décide par le vétérinaire.</p>
      ${Array.isArray(notes) && notes.length ? `<ul class="nu-notes">${notes.slice(0, 6).map((n) => `<li>${esc(n)}</li>`).join("")}</ul>` : ""}</section>`;
  }
  function sourcesHtml(sources, date) {
    const ok = sources.filter((s) => s.ok), bad = sources.filter((s) => !s.ok);
    if (!sources.length) return `<div class="nu-src"><h3>Sources</h3><p class="nu-hint">Aucune fiche produit consultée pour cette réponse. ${PRICE}</p></div>`;
    return `<div class="nu-src"><h3>Fiches consultées</h3><ul>
      ${ok.map((s) => `<li class="ok"><b>${esc(s.title || shortUrl(s.url))}</b><span>${esc(s.fabricant || "")} · consultée le ${esc(fmtDate(s.retrieved_at, date))}</span><a href="${esc(s.url)}" target="_blank" rel="noopener noreferrer">${esc(shortUrl(s.url))}</a></li>`).join("")}
      ${bad.map((s) => `<li class="bad"><b>Fiche inaccessible</b><span>${esc(s.fabricant || "")} · ${esc(shortUrl(s.url) || "adresse inconnue")}</span><span>Non consultée. Vous pouvez fournir la fiche en PDF ou un document approuvé par la clinique.</span></li>`).join("")}
      </ul><p class="nu-hint">${PRICE} « Référencé au Canada » ne veut dire ni « vendu par la clinique » ni « en stock ».</p></div>`;
  }

  window.LQNutrition = { active: () => on, send: () => send(), enter, exit, syncTile };
  document.addEventListener("click", (e) => { if (e.target.closest("[data-open-nutri]")) (on ? exit(true) : enter()); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && on && document.activeElement && document.activeElement.closest && document.activeElement.closest("#nutriTray")) exit(true); });
})();
