// Espace TSA › « Nutrition — Aide au conseil client ».
// Question libre, suggestions, contexte facultatif et comparateur (2 ou 3 produits).
// Les sources affichées sont celles que le relais a RÉELLEMENT consultées (succès ou échec), jamais celles
// que le texte prétend citer : un produit du comparateur sans fiche consultée est signalé comme non vérifié.
(() => {
  "use strict";
  const A = () => window.LQAgent;
  const $ = (id) => document.getElementById(id);
  const esc = (t) => String(t ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const NP = "Non précisé dans la source";
  const PRICE = "Prix et disponibilité à confirmer auprès de la clinique.";
  const OK_DOMAINS = /^https:\/\/(www\.)?(royalcanin\.com|hillspet\.ca|purina\.ca)\//i;
  const SUGG = [
    ["Comparer deux aliments", null],
    ["Refus des croquettes", "Le client dit que son animal refuse ses croquettes depuis quelques jours. Quelles questions poser et quelles options présenter, sans changer une prescription ?"],
    ["Formats et textures", "Quels formats et quelles textures existent pour cet aliment (sec, humide, taille de croquette) ? Aliment : "],
    ["Budget", "Le client trouve l'aliment recommandé trop cher. Comment l'accompagner et quelles options présenter au vétérinaire ? Aliment actuel : "],
    ["Rupture de stock", "L'aliment habituel est en rupture de stock. Quelles informations donner au client et que faut-il faire valider par le vétérinaire avant tout remplacement ? Aliment : "],
    ["Explication au client", "Aide-moi à expliquer simplement au client l'aliment prescrit et la transition alimentaire. Aliment prescrit : "],
  ];
  const FIELDS = [["espece", "Espèce", "select"], ["age", "Âge", "ex. 9 ans"], ["poids", "Poids", "ex. 4,2 kg"], ["alimentation", "Alimentation actuelle", "produit, quantité"], ["prescription", "Prescription ou diagnostic rapporté", "tel que rapporté au dossier"], ["preferences", "Préférences", "texture, saveur…"], ["budget", "Budget", "ex. 80 $ par mois"]];
  const COMP = [["fabricant", "Fabricant"], ["gamme", "Gamme"], ["espece", "Espèce"], ["forme", "Forme / texture"], ["indications", "Indications déclarées"], ["contre_indications", "Contre-indications déclarées"], ["nutrition", "Points nutritionnels déclarés"], ["formats", "Formats"], ["taille_croquette", "Taille de croquette"]];
  const ICO = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 11h18a9 9 0 0 1-18 0Z"/><path d="M8 7c0-1.5 1-2 1-3.5M12 7c0-1.5 1-2 1-3.5M16 7c0-1.5 1-2 1-3.5"/></svg>';

  let history = [], ctl = null, last = null;

  function build() {
    const d = document.createElement("dialog");
    d.id = "nutri"; d.className = "nutri"; d.setAttribute("aria-labelledby", "nuTitle");
    d.innerHTML = `
      <header class="nu-h"><span class="nu-ico">${ICO}</span><div><h2 id="nuTitle">Nutrition — Aide au conseil client</h2><p>Fiches officielles canadiennes : Royal Canin, Hill's, Purina</p></div>
        <button type="button" class="nu-x" id="nuClose" aria-label="Fermer">×</button></header>
      <div class="nu-body">
        <p class="nu-warn">Soutien au conseil nutritionnel. Ne remplace ni la prescription ni la validation du vétérinaire.</p>
        <form id="nuForm" class="nu-ask" novalidate>
          <label for="nuQ" class="sr">Votre question</label>
          <textarea id="nuQ" rows="3" maxlength="2000" placeholder="Votre question nutrition (ex. : le chat refuse son aliment rénal, que proposer au vétérinaire ?)"></textarea>
          <div class="nu-row"><button class="nu-go" id="nuGo">Demander</button><button type="button" class="nu-ghost" id="nuNew" hidden>Nouvelle demande</button><button type="button" class="nu-ghost" id="nuStop" hidden>Arrêter</button></div>
        </form>
        <div class="nu-chips" role="list" aria-label="Suggestions">${SUGG.map(([l], i) => `<button type="button" role="listitem" data-s="${i}">${esc(l)}</button>`).join("")}</div>
        <details class="nu-box" id="nuCtx"><summary>Contexte <small>(facultatif)</small></summary>
          <div class="nu-grid">${FIELDS.map(([k, l, ph]) => `<label class="nu-f"><span>${l}</span>${ph === "select" ? `<select data-k="${k}"><option value="">—</option><option>Chien</option><option>Chat</option></select>` : `<input data-k="${k}" type="text" maxlength="300" placeholder="${esc(ph)}">`}</label>`).join("")}</div>
          <p class="nu-hint">Ne remplissez que ce qui aide la question. Aucun nom de client ni numéro de dossier.</p></details>
        <details class="nu-box" id="nuCmp"><summary>Comparer des produits <small>(2 ou 3)</small></summary>
          <div class="nu-grid">${[1, 2, 3].map((i) => `<label class="nu-f"><span>Produit ${i}${i === 3 ? " (facultatif)" : ""}</span><input data-p="${i}" type="text" maxlength="200" placeholder="nom exact ou lien de la fiche"></label>`).join("")}</div>
          <div class="nu-row"><button type="button" class="nu-go" id="nuCmpGo">Comparer</button></div></details>
        <section id="nuOut" class="nu-out" aria-live="polite" hidden></section>
      </div>`;
    document.body.append(d);
    $("nuClose").onclick = () => d.close();
    d.addEventListener("close", () => { ctl?.abort(); });
    d.addEventListener("click", (e) => { if (e.target === d) d.close(); });
    $("nuForm").onsubmit = (e) => { e.preventDefault(); ask(); };
    $("nuQ").addEventListener("keydown", (e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); ask(); } });
    $("nuStop").onclick = () => ctl?.abort();
    $("nuNew").onclick = () => { history = []; last = null; $("nuOut").hidden = true; $("nuOut").innerHTML = ""; $("nuQ").value = ""; $("nuNew").hidden = true; $("nuQ").focus(); };
    d.querySelectorAll("[data-s]").forEach((b) => (b.onclick = () => {
      const [, tpl] = SUGG[Number(b.dataset.s)];
      if (!tpl) { $("nuCmp").open = true; d.querySelector('[data-p="1"]').focus(); return; }
      const q = $("nuQ"); q.value = tpl; q.focus(); q.setSelectionRange(tpl.length, tpl.length);
    }));
    $("nuCmpGo").onclick = () => {
      const prods = products();
      if (prods.length < 2) { d.querySelector(prods.length ? '[data-p="2"]' : '[data-p="1"]').focus(); showErr("Indiquez au moins deux produits à comparer."); return; }
      ask(`Compare ces ${prods.length} produits pour aider le conseil au client${$("nuQ").value.trim() ? " : " + $("nuQ").value.trim() : "."}`, prods);
    };
    return d;
  }
  const context = () => Object.fromEntries([...document.querySelectorAll("#nutri [data-k]")].map((i) => [i.dataset.k, i.value.trim()]).filter(([, v]) => v));
  const products = () => [...document.querySelectorAll("#nutri [data-p]")].map((i) => i.value.trim()).filter(Boolean);

  function showErr(msg, retry) {
    const out = $("nuOut"); out.hidden = false;
    out.insertAdjacentHTML("afterbegin", `<div class="nu-err" role="alert">${esc(msg)}${retry ? ' <button type="button" class="nu-ghost" data-retry>Réessayer</button>' : ""}</div>`);
    const r = out.querySelector("[data-retry]"); if (r) r.onclick = () => ask(last.q, last.prods);
  }

  async function ask(forced, prods) {
    const q = (forced || $("nuQ").value).trim();
    if (!q) { $("nuQ").focus(); return; }
    if (!A() || !A().ready()) { showErr("L'assistant n'est pas encore activé."); return; }
    prods = prods || [];
    last = { q, prods };
    ctl?.abort(); ctl = new AbortController();
    const out = $("nuOut"); out.hidden = false;
    out.innerHTML = `<div class="nu-q"><b>Votre demande</b>${esc(q)}${prods.length ? `<small>Produits : ${prods.map(esc).join(" · ")}</small>` : ""}</div>
      <ol class="nu-steps" id="nuSteps"><li class="on">Analyse de la demande…</li></ol>
      <div class="nu-ans" id="nuAns"></div><div id="nuCmpOut"></div><div id="nuSrc"></div>`;
    $("nuGo").disabled = $("nuCmpGo").disabled = true; $("nuStop").hidden = false; $("nuNew").hidden = true;
    let text = "", sources = [], date = "", failed = false, empty = false;
    const step = (t, cls = "") => { const ol = $("nuSteps"); ol.querySelectorAll("li.on").forEach((x) => x.classList.remove("on")); ol.insertAdjacentHTML("beforeend", `<li class="on ${cls}">${t}</li>`); };
    let idle = setTimeout(() => ctl.abort(), 90000);
    try {
      const res = await A().post({ mode: "nutrition", role: "tsa", question: q, history: history.slice(-4), prenom: A().prenom(), tier: A().tier(), nutrition: { context: context(), products: prods } }, ctl.signal);
      if (!res.ok) {
        let m = "La demande a échoué. Réessayez."; try { m = (await res.json()).error || m; } catch {}
        failed = true; showErr(m, res.status >= 500 || res.status === 429); return;
      }
      const reader = res.body.getReader(), dec = new TextDecoder(); let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        clearTimeout(idle); idle = setTimeout(() => ctl.abort(), 90000);
        buf += dec.decode(value, { stream: true });
        const lines = buf.split("\n"); buf = lines.pop();
        for (const line of lines) {
          if (!line.trim()) continue;
          let e; try { e = JSON.parse(line); } catch { continue; }
          if (e.t === "status") step(e.k === "search" ? `Recherche : « ${esc(e.d)} »` : e.k === "fetch" ? `Consultation : ${esc(shortUrl(e.d))}` : esc(e.d), e.k);
          else if (e.t === "source") step(e.ok ? `Fiche consultée : ${esc(e.title || shortUrl(e.url))}` : `Fiche inaccessible : ${esc(shortUrl(e.url))}`, e.ok ? "ok" : "bad");
          else if (e.t === "text") { text += e.d; render(text, false); }
          else if (e.t === "error") { failed = true; showErr(e.d, true); }
          else if (e.t === "empty") empty = true;
          else if (e.t === "done") { sources = e.sources || []; date = e.date || ""; }
        }
      }
      step("Terminé", "end");
      render(text, true, sources, date);
      if (empty && !failed) $("nuAns").innerHTML = '<div class="nu-empty"><b>Aucun résultat</b>Reformulez la question ou précisez le nom exact du produit.</div>';
      if (text) history.push({ role: "user", content: q + (prods.length ? `\nProduits : ${prods.join(" ; ")}` : "") }, { role: "assistant", content: text.replace(/```comparaison[\s\S]*?```/g, "").slice(0, 6000) });
    } catch (err) {
      if (err && err.name === "AbortError") { if (!text) showErr("Demande arrêtée. Vous pouvez la relancer.", true); else render(text, true, sources, date); }
      else showErr("Connexion au serveur impossible. Vérifiez votre connexion Internet.", true);
    } finally {
      clearTimeout(idle);
      $("nuGo").disabled = $("nuCmpGo").disabled = false; $("nuStop").hidden = true; $("nuNew").hidden = !text;
    }
  }
  const shortUrl = (u) => String(u || "").replace(/^https?:\/\/(www\.)?/, "").slice(0, 80);
  const fmtDate = (iso, fallback) => { try { const d = iso ? new Date(iso) : new Date(fallback + "T12:00:00"); return d.toLocaleDateString("fr-CA", { day: "numeric", month: "long", year: "numeric" }); } catch { return fallback || ""; } };

  function render(text, done, sources, date) {
    const m = text.match(/```comparaison\s*([\s\S]*?)(```|$)/);
    const prose = text.replace(/```comparaison[\s\S]*?(```|$)/g, "").trim();
    // Liens : seulement vers des pages https ; ceux hors des sites officiels sont montrés sans lien
    const html = A().md(prose).replace(/\[([^\]]+)\]\((https:\/\/[^)\s]+)\)/g, (_, t, u) => {
      const raw = u.replace(/&amp;/g, "&");
      return OK_DOMAINS.test(raw) ? `<a href="${u}" target="_blank" rel="noopener noreferrer">${t}</a>` : `${t} <small>(lien hors des sites officiels, non affiché)</small>`;
    });
    $("nuAns").innerHTML = html;
    if (!done) return;
    const consulted = new Map((sources || []).filter((s) => s.ok).map((s) => [s.url.replace(/[#?].*$/, "").replace(/\/$/, ""), s]));
    if (m) {
      let data = null; try { data = JSON.parse(m[1]); } catch {}
      const prods = Array.isArray(data?.produits) ? data.produits.slice(0, 3) : [];
      $("nuCmpOut").innerHTML = prods.length ? comparator(prods, data.notes, consulted, date) : (m[1].trim() ? '<div class="nu-err">Le comparatif reçu est illisible. Relancez la comparaison.</div>' : "");
    }
    $("nuSrc").innerHTML = sourcesHtml(sources || [], date);
  }

  function comparator(prods, notes, consulted, date) {
    const cols = prods.map((p) => {
      const key = String(p.source || "").replace(/[#?].*$/, "").replace(/\/$/, "");
      const src = consulted.get(key);
      return { p, src, verified: !!src };
    });
    const cell = (c, k) => (c.verified ? esc(String(c.p[k] || "").trim() || NP) : NP);
    return `<section class="nu-cmp" aria-label="Comparatif"><h3>Comparatif</h3>
      <div class="nu-cmp-grid" style="--n:${cols.length}">
        ${cols.map((c) => `<article class="nu-card${c.verified ? "" : " unv"}">
          <h4>${esc(c.p.nom || "Produit")}</h4>
          ${c.verified ? `<a class="nu-link" href="${esc(c.src.url)}" target="_blank" rel="noopener noreferrer">Fiche officielle</a><small>Consultée le ${esc(fmtDate(c.src.retrieved_at, date))}</small>`
            : '<p class="nu-bad">Fiche non consultée : aucune information n\'est affichée pour ce produit. Fournissez la fiche en PDF ou un document approuvé.</p>'}
          <dl>${COMP.map(([k, l]) => `<dt>${l}</dt><dd>${k === "fabricant" && c.verified ? esc(c.p[k] || c.src.fabricant || NP) : cell(c, k)}</dd>`).join("")}
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

  let dlg = null;
  function open() {
    if (!A() || !A().isTsa()) return;
    dlg = dlg || build();
    dlg.showModal();
    setTimeout(() => $("nuQ").focus(), 30);
  }
  window.LQNutrition = { open };
  document.addEventListener("click", (e) => { if (e.target.closest("[data-open-nutri]")) open(); });
})();
