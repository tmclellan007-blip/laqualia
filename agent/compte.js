// Mon compte : profil, établissement, membres et invitations, rôles et permissions, plateforme.
// L'interface ne décide de rien : chaque action est vérifiée par le serveur, qui fait foi.
(() => {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const main = $("main");
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const fmtDate = (t) => (t ? new Date(t).toLocaleDateString("fr-CA", { day: "numeric", month: "short", year: "numeric" }) : "—");
  const fmtDT = (t) => (t ? new Date(t).toLocaleString("fr-CA", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "—");
  const S = { me: null, meta: null, orgId: null };
  const ROLE_BADGE = { owner: "b-owner", admin: "b-admin", member: "b-role" };
  const STATUS = { active: ["b-active", "Actif"], disabled: ["b-disabled", "Désactivé"], invited: ["b-invited", "Invité"], expired: ["b-expired", "Invitation expirée"] };
  const PROV = { google: "Google", apple: "Apple", email: "Code par courriel" };

  /* ---------- outils ---------- */
  class ApiError extends Error { constructor(status, data) { super((data && data.error) || "Erreur."); this.status = status; this.data = data || {}; } }
  async function api(path, { method = "GET", body } = {}) {
    let r;
    try {
      r = await fetch(path, { method, credentials: "same-origin", headers: { ...(method !== "GET" ? { "x-lq-csrf": "1" } : {}), ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
    } catch { throw new ApiError(0, { error: "Connexion au serveur impossible. Vérifiez votre connexion Internet." }); }
    let data = null; try { data = await r.json(); } catch {}
    if (r.status === 401) {
      const why = data && data.code === "session_expired" ? "&erreur=etat_expire" : "";
      location.href = "connexion.html?suite=" + encodeURIComponent("/agent/compte.html" + location.hash) + why;
      throw new ApiError(401, data);
    }
    if (!r.ok) throw new ApiError(r.status, data);
    return data;
  }
  let toastT;
  function toast(msg, err) { const t = $("toast"); t.textContent = msg; t.className = "toast" + (err ? " err" : ""); t.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => (t.hidden = true), 4200); }
  const fail = (e) => toast(e.message || "L'action a échoué.", true);
  const initials = (u) => ((u.first_name || "")[0] || "") + ((u.last_name || "")[0] || "") ? (((u.first_name || "")[0] || "") + ((u.last_name || "")[0] || "")).toUpperCase() : "?";
  const avatar = (u, cls = "") => `<span class="av ${cls}" aria-hidden="true">${u.photo ? `<img src="${esc(u.photo)}" alt="" referrerpolicy="no-referrer">` : esc(initials(u))}</span>`;
  const fullName = (u) => [u.first_name, u.last_name].filter(Boolean).join(" ") || "(sans nom)";
  const roleLabel = (r) => (S.meta?.roleLabels?.[r] || r);
  const fnLabel = (f) => (S.meta?.functions?.[f] || f);
  const membership = () => S.me.memberships.find((m) => m.org_id === S.orgId);
  const perms = () => new Set(membership()?.permissions || (S.me.user.platform_admin ? ["platform"] : []));
  const canDo = (a) => perms().has(a);

  // Dialogue de confirmation accessible (focus piégé par <dialog>)
  function dialog(html, { onOpen } = {}) {
    return new Promise((resolve) => {
      const d = $("dlg"), f = $("dlgForm");
      f.innerHTML = html;
      const done = (v) => { d.close(); resolve(v); };
      f.onsubmit = (e) => { e.preventDefault(); const sub = e.submitter; if (sub && sub.value === "cancel") return done(null); done(Object.fromEntries(new FormData(f))); };
      d.oncancel = () => resolve(null);
      d.showModal(); onOpen && onOpen(f);
      const first = f.querySelector("input,select,textarea,button[value=ok]"); first && first.focus();
    });
  }
  const confirmBox = (title, text, okLabel = "Confirmer", danger = false, extra = "") => dialog(`<h2>${esc(title)}</h2><p>${text}</p>${extra}<div class="row"><button class="btn ghost" value="cancel" formnovalidate>Annuler</button><button class="btn ${danger ? "danger" : ""}" value="ok">${esc(okLabel)}</button></div>`);
  const loading = () => (main.innerHTML = '<div class="cards"><div class="card"><div class="skel"></div><div class="skel" style="width:60%"></div><div class="skel" style="width:80%"></div></div></div>');
  const errorCard = (e) => `<div class="card"><div class="notice err" role="alert">${esc(e.message)}</div></div>`;

  /* ---------- démarrage ---------- */
  async function boot() {
    try {
      [S.me, S.meta] = await Promise.all([api("/api/me"), api("/api/permissions")]);
    } catch (e) {
      if (e.status === 401) return;
      main.innerHTML = `<div class="card"><div class="notice ${e.status === 404 || e.status === 0 ? "warn" : "err"}">${e.status === 404 || e.status === 0 ? "Le module de comptes est disponible sur laqualia.com seulement." : esc(e.message)}</div></div>`;
      return;
    }
    S.orgId = S.me.activeOrgId;
    renderChrome();
    window.addEventListener("hashchange", route);
    const qs = new URLSearchParams(location.search);
    if (qs.get("associe")) toast(qs.get("associe") === "email" ? "L'adresse courriel est maintenant associée à votre compte." : `${PROV[qs.get("associe")] || "Moyen de connexion"} est maintenant associé à votre compte.`);
    if (qs.get("erreur") === "identite_deja_utilisee") toast("Ce moyen de connexion est déjà relié à un autre compte. Les comptes ne sont jamais fusionnés.", true);
    if (qs.toString()) history.replaceState(null, "", location.pathname + location.hash);
    route();
    // Expiration de session : avertissement une minute avant
    const left = S.me.session.expiresAt - Date.now();
    if (left > 60e3) setTimeout(() => toast("Votre session va expirer : enregistrez vos modifications."), Math.min(left - 60e3, 2 ** 31 - 1));
  }
  function renderChrome() {
    const u = S.me.user;
    $("chip").hidden = false; $("logout").hidden = false;
    $("chipAv").outerHTML = avatar(u).replace('class="av ', 'id="chipAv" class="av ');
    $("chipName").textContent = u.first_name || u.last_name ? fullName(u) : (S.me.identities.find((i) => i.email)?.email || fullName(u));
    const act = S.me.memberships.filter((m) => m.status === "active");
    $("orgpick").hidden = act.length < 1;
    $("orgSel").innerHTML = act.map((m) => `<option value="${esc(m.org_id)}"${m.org_id === S.orgId ? " selected" : ""}>${esc(m.org_name)}</option>`).join("")
      + (S.orgId && !act.some((m) => m.org_id === S.orgId) && S.platOrgName ? `<option value="${esc(S.orgId)}" selected>${esc(S.platOrgName)} (plateforme)</option>` : "");
    if (S.orgId && !act.some((m) => m.org_id === S.orgId) && S.platOrgName) $("orgpick").hidden = false;
    $("navPlat").hidden = $("platSep").hidden = !(u.platform_admin || S.me.platform.canBootstrap);
  }
  $("orgSel").onchange = async (e) => {
    try { await api("/api/session/org", { method: "POST", body: { orgId: e.target.value } }); S.orgId = e.target.value; toast("Établissement sélectionné."); route(); }
    catch (err) { fail(err); }
  };
  $("logout").onclick = async () => { try { await api("/auth/logout", { method: "POST" }); } catch {} location.href = "connexion.html"; };

  function route() {
    const r = (location.hash.slice(1) || "profil").split("?")[0];
    document.querySelectorAll("#nav a").forEach((a) => (a.dataset.r === r ? a.setAttribute("aria-current", "page") : a.removeAttribute("aria-current")));
    const view = { profil: viewProfile, etablissement: viewOrg, membres: viewMembers, roles: viewRoles, plateforme: viewPlatform }[r] || viewProfile;
    if (S.me.user.status === "deactivated" && view !== viewProfile) return viewProfile();
    view();
  }
  const noOrg = () => {
    const off = S.me.memberships.filter((m) => m.status === "disabled");
    return `<div class="card">${off.length ? `<div class="notice warn" role="alert">Votre accès à ${off.map((m) => "<b>" + esc(m.org_name) + "</b>").join(", ")} a été désactivé par un responsable. Communiquez avec lui pour le rétablir.</div>` : ""}<div class="empty"><b>Aucun établissement actif</b>Ouvrez le lien d'invitation reçu de votre responsable pour rejoindre un établissement.</div></div>`;
  };

  /* ---------- Associer une adresse courriel (code à usage unique) ---------- */
  async function linkEmail() {
    const v = await dialog(`<h2>Associer une adresse courriel</h2><p>Vous pourrez ensuite vous connecter avec un code envoyé à cette adresse, et accepter les invitations qui lui sont destinées. Nous vérifions d'abord qu'elle vous appartient.</p>
      <div class="f" style="margin:0"><label for="lkEmail">Adresse courriel</label><input type="email" id="lkEmail" name="email" autocomplete="email" required maxlength="254"></div>
      <div class="row"><button class="btn ghost" value="cancel" formnovalidate>Annuler</button><button class="btn" value="ok">Envoyer un code</button></div>`);
    if (!v) return;
    let sent;
    try { sent = await api("/auth/email/start", { method: "POST", body: { email: v.email, mode: "link", next: "/agent/compte.html#profil" } }); }
    catch (e) {
      if (e.data.code === "reauth") { await confirmBox("Reconnexion nécessaire", "Par sécurité, reconnectez-vous avant d'associer un nouveau moyen de connexion. Revenez ensuite ici.", "Me reconnecter") && (await api("/auth/logout", { method: "POST" }).catch(() => {}), location.href = "connexion.html?suite=" + encodeURIComponent("/agent/compte.html#profil")); return; }
      return fail(e);
    }
    for (let tries = 0; tries < 6; tries++) {
      const c = await dialog(`<h2>Entrez le code</h2><p>Code envoyé à <b>${esc(sent.emailHint)}</b>. Il est valable 10 minutes.</p>
        <div class="f" style="margin:0"><label for="lkCode">Code à 6 chiffres</label><input type="text" id="lkCode" name="code" class="codein" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" required></div>
        <div class="row"><button class="btn ghost" value="cancel" formnovalidate>Annuler</button><button class="btn" value="ok">Associer</button></div>`);
      if (!c) return;
      try { const r = await api("/auth/email/verify", { method: "POST", body: { code: c.code } }); location.href = r.next; return; }
      catch (e) { toast(e.message, true); if (e.data.code !== "code_incorrect") return; }
    }
  }

  /* ---------- Mon profil ---------- */
  function viewProfile() {
    const { user: u, identities, memberships } = S.me;
    const np = u.notif_prefs || {};
    const deact = u.status === "deactivated";
    const canLink = (p) => S.me.providers[p] && !identities.some((i) => i.provider === p);
    main.innerHTML = `
      <div class="head"><div><h1>Mon profil</h1><p>Vos informations personnelles, vos établissements et vos moyens de connexion.</p></div></div>
      <div class="cards">
        ${deact ? `<div class="notice warn" role="alert"><div><b>Votre compte est désactivé.</b> Vos accès sont suspendus. Vous pouvez le réactiver maintenant.</div><button class="btn sm" id="react">Réactiver mon compte</button></div>` : ""}
        ${!u.first_name && !u.last_name && !deact ? '<div class="notice info" role="status"><div><b>Bienvenue !</b> Ajoutez votre prénom et votre nom : vos responsables vous reconnaîtront plus facilement.</div></div>' : ""}
        <section class="card" aria-labelledby="h-id">
          <h2 id="h-id">Identité</h2><p class="lead">Ces informations sont visibles par les responsables de vos établissements.</p>
          <form id="fProfile">
            <div class="row" style="margin-bottom:16px">${avatar(u, "lg")}
              <div class="row"><label class="btn ghost sm" for="photo">Changer la photo</label><input type="file" id="photo" accept="image/png,image/jpeg,image/webp" class="sr">
              ${u.photo ? '<button class="btn ghost sm" type="button" id="rmPhoto">Retirer la photo</button>' : ""}</div></div>
            <div class="grid2">
              <div class="f"><label for="fn">Prénom</label><input type="text" id="fn" name="first_name" autocomplete="given-name" maxlength="60" value="${esc(u.first_name)}"></div>
              <div class="f"><label for="ln">Nom</label><input type="text" id="ln" name="last_name" autocomplete="family-name" maxlength="60" value="${esc(u.last_name)}"></div>
              <div class="f"><label for="jt">Fonction</label><input type="text" id="jt" name="job_title" maxlength="80" placeholder="Ex. : Réceptionniste" value="${esc(u.job_title)}"><span class="hint">Votre titre. Il n'accorde aucune permission.</span></div>
              <div class="f"><label for="lg">Langue</label><select id="lg" name="locale"><option value="fr-CA"${u.locale === "fr-CA" ? " selected" : ""}>Français</option><option value="en-CA"${u.locale === "en-CA" ? " selected" : ""}>English</option></select></div>
            </div>
            <button class="btn" ${deact ? "disabled" : ""}>Enregistrer</button>
          </form>
        </section>
        <section class="card" aria-labelledby="h-notif">
          <h2 id="h-notif">Notifications</h2><p class="lead">Choisissez ce que La Qualia peut vous envoyer par courriel.</p>
          <form id="fNotif" class="checks">
            <label class="check"><input type="checkbox" name="invitations" ${np.invitations ? "checked" : ""}> Invitations et changements d'établissement</label>
            <label class="check"><input type="checkbox" name="roleChanges" ${np.roleChanges ? "checked" : ""}> Changements de mon rôle ou de mes accès</label>
            <label class="check"><input type="checkbox" name="product" ${np.product ? "checked" : ""}> Nouveautés de la plateforme</label>
            <div><button class="btn ghost" ${deact ? "disabled" : ""}>Enregistrer les préférences</button></div>
          </form>
        </section>
        <section class="card" aria-labelledby="h-orgs">
          <h2 id="h-orgs">Mes établissements</h2><p class="lead">Votre rôle détermine vos permissions ; votre fonction décrit votre travail.</p>
          ${memberships.length ? `<ul class="list">${memberships.map((m) => `<li class="item"><div class="who"><span class="av" aria-hidden="true">${esc(m.org_name[0] || "?")}</span><div><b>${esc(m.org_name)}</b><small>${esc(fnLabel(m.function))}${m.org_city ? " · " + esc(m.org_city) : ""}</small></div></div>
            <div class="tags"><span class="badge ${ROLE_BADGE[m.role]}">${esc(roleLabel(m.role))}</span><span class="badge ${STATUS[m.status][0]}">${STATUS[m.status][1]}</span>${m.org_id === S.orgId ? '<span class="badge b-invited">Établissement actif</span>' : ""}</div>
            <div class="acts">${m.status === "active" && m.org_id !== S.orgId ? `<button class="btn ghost sm" data-use="${esc(m.org_id)}">Travailler ici</button>` : ""}<button class="btn ghost sm" data-leave="${esc(m.org_id)}" ${deact ? "disabled" : ""}>Quitter</button></div></li>`).join("")}</ul>` : '<div class="empty"><b>Aucun établissement</b>Ouvrez le lien d\'invitation reçu pour rejoindre votre équipe.</div>'}
        </section>
        <section class="card" aria-labelledby="h-ids">
          <h2 id="h-ids">Moyens de connexion</h2><p class="lead">Associez un deuxième moyen de connexion : il vous servira si vous perdez l'accès au premier.</p>
          <ul class="list">${identities.map((i) => `<li class="item"><div class="who"><span class="av" aria-hidden="true" style="background:#101010">${i.provider === "google" ? "G" : i.provider === "apple" ? "A" : "@"}</span><div><b>${PROV[i.provider]}</b><small>${esc(i.email || "Adresse non transmise")}${i.email_verified ? "" : " · non vérifiée"}</small></div></div>
            <div class="tags">${i.is_private_email ? '<span class="badge b-warn">Adresse masquée Apple</span>' : ""}<span class="badge b-role">Dernière connexion : ${fmtDate(i.last_login_at)}</span></div>
            <div class="acts"><button class="btn danger ghost sm" data-unlink="${esc(i.id)}" ${identities.length < 2 || deact ? 'disabled title="Gardez au moins un moyen de connexion"' : ""}>Retirer</button></div></li>`).join("")}</ul>
          <div class="row" style="margin-top:12px">${["google", "apple"].filter(canLink).map((p) => `<a class="btn ghost" href="/auth/${p}/start?mode=link&next=${encodeURIComponent("/agent/compte.html#profil")}">Associer ${PROV[p]}</a>`).join("")}${S.me.providers.email && !deact ? '<button class="btn ghost" type="button" id="linkEmail">Associer une adresse courriel</button>' : ""}${!["google", "apple"].some(canLink) && !(S.me.providers.email && !deact) ? '<span class="fine">Aucun autre moyen de connexion disponible.</span>' : ""}</div>
          ${identities.some((i) => i.is_private_email) ? `<div class="notice info" style="margin-top:14px"><div><b>Adresse masquée Apple.</b> Les invitations doivent être envoyées à <b>${esc(identities.find((i) => i.is_private_email).email)}</b>, ou acceptées avec un autre moyen de connexion qui utilise l'adresse invitée. Pour associer un autre moyen en toute sécurité : connectez-vous d'abord ici, puis utilisez « Associer » ; La Qualia ne fusionne jamais deux comptes à partir d'une adresse courriel.</div></div>` : ""}
        </section>
        <section class="card" aria-labelledby="h-sess">
          <h2 id="h-sess">Session</h2><p class="lead">Votre session expire après 12 heures d'inactivité, ou au plus tard le ${fmtDT(S.me.session.expiresAt)}.</p>
          <button class="btn ghost" id="logoutAll">Se déconnecter de tous les appareils</button>
        </section>
        <section class="card danger" aria-labelledby="h-danger">
          <h2 id="h-danger">Désactiver ou supprimer mon compte</h2>
          <p class="lead">La désactivation suspend vos accès sans rien effacer. La suppression efface définitivement vos données personnelles.</p>
          <div class="row">${deact ? "" : '<button class="btn ghost" id="deact">Désactiver mon compte</button>'}<button class="btn danger" id="del">Demander la suppression</button></div>
        </section>
      </div>`;
    $("react") && ($("react").onclick = async () => { try { S.me = await api("/api/me/reactivate", { method: "POST" }); toast("Compte réactivé."); renderChrome(); viewProfile(); } catch (e) { fail(e); } });
    $("fProfile").onsubmit = async (e) => {
      e.preventDefault();
      const b = Object.fromEntries(new FormData(e.target));
      try { S.me = await api("/api/me", { method: "PATCH", body: b }); renderChrome(); toast("Profil enregistré."); } catch (er) { fail(er); }
    };
    $("photo").onchange = async (e) => {
      const file = e.target.files[0]; if (!file) return;
      try { const data = await resizeImage(file, 256); S.me = await api("/api/me", { method: "PATCH", body: { photo: data } }); renderChrome(); viewProfile(); toast("Photo mise à jour."); }
      catch (er) { fail(er); }
    };
    $("rmPhoto") && ($("rmPhoto").onclick = async () => { try { S.me = await api("/api/me", { method: "PATCH", body: { photo: null } }); renderChrome(); viewProfile(); } catch (e) { fail(e); } });
    $("fNotif").onsubmit = async (e) => {
      e.preventDefault();
      const f = e.target;
      try { S.me = await api("/api/me", { method: "PATCH", body: { notif_prefs: { invitations: f.invitations.checked, roleChanges: f.roleChanges.checked, product: f.product.checked } } }); toast("Préférences enregistrées."); } catch (er) { fail(er); }
    };
    main.querySelectorAll("[data-use]").forEach((b) => (b.onclick = async () => { try { await api("/api/session/org", { method: "POST", body: { orgId: b.dataset.use } }); S.orgId = b.dataset.use; renderChrome(); viewProfile(); toast("Établissement sélectionné."); } catch (e) { fail(e); } }));
    main.querySelectorAll("[data-leave]").forEach((b) => (b.onclick = async () => {
      const m = S.me.memberships.find((x) => x.org_id === b.dataset.leave);
      if (!(await confirmBox("Quitter l'établissement ?", `Vous perdrez immédiatement l'accès à <b>${esc(m.org_name)}</b>. Pour revenir, il faudra une nouvelle invitation.`, "Quitter", true))) return;
      try { await api(`/api/orgs/${m.org_id}/leave`, { method: "POST" }); await reloadMe(); toast("Vous avez quitté l'établissement."); viewProfile(); } catch (e) { fail(e); }
    }));
    main.querySelectorAll("[data-unlink]").forEach((b) => (b.onclick = async () => {
      if (!(await confirmBox("Retirer ce moyen de connexion ?", "Vous ne pourrez plus vous connecter avec lui, sauf en l'associant de nouveau.", "Retirer", true))) return;
      try { S.me = await api(`/api/me/identities/${b.dataset.unlink}`, { method: "DELETE" }); viewProfile(); toast("Moyen de connexion retiré."); } catch (e) { fail(e); }
    }));
    $("linkEmail") && ($("linkEmail").onclick = linkEmail);
    $("logoutAll").onclick = async () => {
      if (!(await confirmBox("Se déconnecter partout ?", "Toutes vos sessions ouvertes, y compris celle-ci, seront fermées.", "Se déconnecter partout"))) return;
      try { await api("/auth/logout-all", { method: "POST" }); } catch {} location.href = "connexion.html";
    };
    $("deact") && ($("deact").onclick = async () => {
      if (!(await confirmBox("Désactiver votre compte ?", "Vos sessions seront fermées et vos accès suspendus dans tous vos établissements. Rien n'est effacé : vous pourrez réactiver le compte en vous reconnectant.", "Désactiver", true))) return;
      try { await api("/api/me/deactivate", { method: "POST", body: { confirm: true } }); location.href = "connexion.html"; } catch (e) { fail(e); }
    });
    $("del").onclick = async () => {
      const r = await dialog(`<h2>Supprimer votre compte</h2>
        <p><b>Supprimé immédiatement et définitivement :</b> votre profil et votre photo, vos moyens de connexion, vos sessions et vos appartenances aux établissements.</p>
        <p><b>Conservé :</b> le journal des établissements garde la trace des actions passées (date et identifiant interne, sans votre nom ni votre courriel), pour la sécurité des équipes.</p>
        <p><b>Dans ce navigateur :</b> l'historique de l'assistant est stocké localement ; cochez la case pour l'effacer aussi.</p>
        <label class="check"><input type="checkbox" name="local" checked> Effacer aussi l'historique de l'assistant dans ce navigateur</label>
        <div class="f"><label for="cf">Tapez SUPPRIMER pour confirmer</label><input type="text" id="cf" name="confirm" autocomplete="off" required pattern="[Ss][Uu][Pp][Pp][Rr][Ii][Mm][Ee][Rr]"></div>
        <div class="row"><button class="btn ghost" value="cancel" formnovalidate>Annuler</button><button class="btn danger" value="ok">Supprimer définitivement</button></div>`);
      if (!r) return;
      try {
        await api("/api/me/delete", { method: "POST", body: { confirm: r.confirm } });
        if (r.local) { try { Object.keys(localStorage).filter((k) => k.startsWith("lq-")).forEach((k) => localStorage.removeItem(k)); } catch {} }
        location.href = "connexion.html";
      } catch (e) { fail(e); }
    };
  }
  async function reloadMe() { S.me = await api("/api/me"); if (!S.me.user.platform_admin && !S.me.memberships.some((m) => m.org_id === S.orgId && m.status === "active")) S.orgId = S.me.activeOrgId; renderChrome(); }
  function resizeImage(file, size) {
    return new Promise((resolve, reject) => {
      if (!/^image\/(png|jpeg|webp)$/.test(file.type)) return reject(new Error("Choisissez une image JPEG, PNG ou WebP."));
      const img = new Image(), url = URL.createObjectURL(file);
      img.onload = () => {
        const c = document.createElement("canvas"); c.width = c.height = size;
        const s = Math.min(img.width, img.height); const g = c.getContext("2d");
        g.drawImage(img, (img.width - s) / 2, (img.height - s) / 2, s, s, 0, 0, size, size);
        URL.revokeObjectURL(url);
        let q = 0.85, out = c.toDataURL("image/jpeg", q);
        while (out.length > 100000 && q > 0.4) { q -= 0.1; out = c.toDataURL("image/jpeg", q); }
        resolve(out);
      };
      img.onerror = () => reject(new Error("Image illisible."));
      img.src = url;
    });
  }

  /* ---------- Mon établissement ---------- */
  async function viewOrg() {
    if (!S.orgId) { main.innerHTML = `<div class="head"><div><h1>Mon établissement</h1></div></div>${noOrg()}`; return; }
    loading();
    let d;
    try { d = await api(`/api/orgs/${S.orgId}`); } catch (e) { main.innerHTML = errorCard(e); return; }
    const { org, membership: m, level, counts } = d;
    const P = new Set(d.permissions);
    main.innerHTML = `
      <div class="head"><div><h1>${esc(org.name)}</h1><p>${org.city ? esc(org.city) + " · " : ""}Créé le ${fmtDate(org.created_at)}</p></div></div>
      <div class="cards">
        <section class="card" aria-labelledby="h-me"><h2 id="h-me">Mon accès</h2>
          <p class="lead">Votre niveau d'accès : <span class="badge ${ROLE_BADGE[m?.role] || "b-admin"}">${esc(roleLabel(m ? m.role : level))}</span>${m ? ` · fonction : <b>${esc(fnLabel(m.function))}</b>` : ""}${level === "platform" ? ' <span class="badge b-warn">Administrateur de la plateforme</span>' : ""}</p>
          ${counts ? `<div class="row"><span class="badge b-active">${counts.active} actif${counts.active > 1 ? "s" : ""}</span><span class="badge b-invited">${counts.invited} invitation${counts.invited > 1 ? "s" : ""} en attente</span><span class="badge b-disabled">${counts.disabled} désactivé${counts.disabled > 1 ? "s" : ""}</span><a class="btn ghost sm" href="#membres">Gérer les membres</a></div>` : ""}
        </section>
        <section class="card" aria-labelledby="h-info"><h2 id="h-info">Informations de l'établissement</h2>
          <p class="lead">${P.has("org.update") ? "Visibles par tous les membres." : "Seuls les administrateurs peuvent modifier ces informations."}</p>
          <form id="fOrg">
            <div class="grid2">
              <div class="f"><label for="on">Nom</label><input type="text" id="on" name="name" maxlength="120" required value="${esc(org.name)}" ${P.has("org.update") ? "" : "disabled"}></div>
              <div class="f"><label for="oc">Ville</label><input type="text" id="oc" name="city" maxlength="80" value="${esc(org.city)}" ${P.has("org.update") ? "" : "disabled"}></div>
            </div>
            <div class="f"><label for="ol">Adresse du logo (https)</label><input type="text" id="ol" name="logo" inputmode="url" placeholder="https://…" value="${esc(org.logo && org.logo.startsWith("https") ? org.logo : "")}" ${P.has("org.update") ? "" : "disabled"}></div>
            ${P.has("org.update") ? '<button class="btn">Enregistrer</button>' : ""}
          </form>
        </section>
        ${P.has("ownership.transfer") ? `<section class="card" aria-labelledby="h-tr"><h2 id="h-tr">Transférer la propriété</h2><p class="lead">Nommez un autre membre actif propriétaire. Vous deviendrez administrateur, sauf si vous choisissez de rester propriétaire.</p><button class="btn ghost" id="transfer">Transférer la propriété…</button></section>` : ""}
        ${m ? `<section class="card danger" aria-labelledby="h-lv"><h2 id="h-lv">Quitter l'établissement</h2><p class="lead">Vous perdrez l'accès immédiatement.${m.role === "owner" ? " Un dernier propriétaire doit d'abord transférer la propriété." : ""}</p><button class="btn danger ghost" id="leave">Quitter ${esc(org.name)}</button></section>` : ""}
      </div>`;
    $("fOrg").onsubmit = async (e) => {
      e.preventDefault();
      try { await api(`/api/orgs/${org.id}`, { method: "PATCH", body: Object.fromEntries(new FormData(e.target)) }); await reloadMe(); toast("Établissement mis à jour."); viewOrg(); } catch (er) { fail(er); }
    };
    $("leave") && ($("leave").onclick = async () => {
      if (!(await confirmBox("Quitter l'établissement ?", `Vous perdrez immédiatement l'accès à <b>${esc(org.name)}</b>.`, "Quitter", true))) return;
      try { await api(`/api/orgs/${org.id}/leave`, { method: "POST" }); await reloadMe(); toast("Vous avez quitté l'établissement."); location.hash = "#profil"; } catch (e) { fail(e); }
    });
    $("transfer") && ($("transfer").onclick = async () => {
      let list;
      try { list = (await api(`/api/orgs/${org.id}/members?status=active`)).members.filter((x) => x.type === "member" && !x.self); } catch (e) { return fail(e); }
      if (!list.length) return toast("Invitez d'abord une autre personne : il faut un membre actif pour transférer la propriété.", true);
      const r = await dialog(`<h2>Transférer la propriété</h2><p>Le nouveau propriétaire pourra gérer tous les membres, y compris les propriétaires.</p>
        <div class="f"><label for="tm">Nouveau propriétaire</label><select id="tm" name="memberId" required>${list.map((x) => `<option value="${esc(x.id)}">${esc(fullName(x))} · ${esc(x.email || "")}</option>`).join("")}</select></div>
        ${m && m.role === "owner" ? '<label class="check"><input type="checkbox" name="keep"> Rester aussi propriétaire</label>' : ""}
        <div class="row"><button class="btn ghost" value="cancel" formnovalidate>Annuler</button><button class="btn" value="ok">Transférer</button></div>`);
      if (!r) return;
      try { await api(`/api/orgs/${org.id}/transfer`, { method: "POST", body: { memberId: r.memberId, keepMyOwnership: !!r.keep } }); await reloadMe(); toast("Propriété transférée."); viewOrg(); } catch (e) { fail(e); }
    });
  }

  /* ---------- Membres et invitations ---------- */
  const F = { q: "", status: "", role: "", function: "" };
  async function viewMembers() {
    if (!S.orgId) { main.innerHTML = `<div class="head"><div><h1>Membres et invitations</h1></div></div>${noOrg()}`; return; }
    const org = S.me.memberships.find((m) => m.org_id === S.orgId) || { org_name: "" };
    main.innerHTML = `
      <div class="head"><div><h1>Membres et invitations</h1><p>${esc(org.org_name)}</p></div><button class="btn" id="inv" hidden>Inviter une personne</button></div>
      <div class="cards">
        <section class="card" aria-labelledby="h-list"><h2 id="h-list" class="sr">Liste des membres</h2>
          <form class="toolbar" id="filters" role="search">
            <div class="f q" style="margin:0"><label for="q">Rechercher</label><input type="search" id="q" name="q" placeholder="Nom, courriel, fonction…" value="${esc(F.q)}"></div>
            <div class="f" style="margin:0"><label for="fs">Statut</label><select id="fs" name="status"><option value="">Tous</option><option value="active">Actif</option><option value="invited">Invité</option><option value="disabled">Désactivé</option><option value="expired">Invitation expirée</option></select></div>
            <div class="f" style="margin:0"><label for="fr">Rôle</label><select id="fr" name="role"><option value="">Tous</option>${S.meta.roles.slice().reverse().map((r) => `<option value="${r}">${esc(roleLabel(r))}</option>`).join("")}</select></div>
            <div class="f" style="margin:0"><label for="ff">Fonction</label><select id="ff" name="function"><option value="">Toutes</option>${Object.entries(S.meta.functions).map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join("")}</select></div>
            <button class="btn ghost" type="reset">Effacer</button>
          </form>
          <div id="mlist"><div class="skel"></div><div class="skel"></div><div class="skel" style="width:70%"></div></div>
        </section>
        <section class="card" aria-labelledby="h-audit" id="auditCard" hidden><h2 id="h-audit">Journal des changements</h2><p class="lead">Rôles, invitations, désactivations et transferts de propriété. Aucun jeton ni secret n'y est consigné.</p><div id="audit"></div></section>
      </div>`;
    ["fs", "fr", "ff"].forEach((id, i) => ($(id).value = F[["status", "role", "function"][i]]));
    let t;
    $("filters").oninput = (e) => { clearTimeout(t); t = setTimeout(() => { Object.assign(F, Object.fromEntries(new FormData($("filters")))); loadMembers(); }, e.target.id === "q" ? 250 : 0); };
    $("filters").onreset = () => setTimeout(() => { Object.assign(F, { q: "", status: "", role: "", function: "" }); loadMembers(); });
    $("filters").onsubmit = (e) => e.preventDefault();
    $("inv").onclick = inviteDialog;
    loadMembers();
  }
  async function loadMembers() {
    const box = $("mlist"); if (!box) return;
    let d;
    try { d = await api(`/api/orgs/${S.orgId}/members?` + new URLSearchParams(Object.entries(F).filter(([, v]) => v))); }
    catch (e) {
      box.innerHTML = e.status === 403 ? `<div class="empty"><b>Accès réservé</b>Seuls les administrateurs et propriétaires de l'établissement voient la liste des membres.</div>` : `<div class="notice err">${esc(e.message)}</div>`;
      return;
    }
    const P = new Set(d.permissions);
    $("inv").hidden = !P.has("members.invite");
    const lvl = d.level;
    const rows = d.members;
    if (!rows.length) { box.innerHTML = `<div class="empty"><b>${Object.values(F).some(Boolean) ? "Aucun résultat" : "Aucun membre"}</b>${Object.values(F).some(Boolean) ? "Modifiez la recherche ou les filtres." : "Invitez une première personne."}</div>`; return; }
    const canOwner = P.has("members.manage_owner");
    box.innerHTML = `<p class="fine" style="margin:6px 0 2px">${rows.length} résultat${rows.length > 1 ? "s" : ""}</p><ul class="list">${rows.map((r) => {
      const st = STATUS[r.status] || STATUS.active;
      if (r.type === "invitation") return `<li class="item"><div class="who"><span class="av" aria-hidden="true" style="background:#c9c6d6">@</span><div><b>${esc(r.email)}</b><small>Invité(e) le ${fmtDate(r.created_at)} · ${r.status === "expired" ? "expirée le" : "expire le"} ${fmtDate(r.expires_at)}</small></div></div>
        <div class="tags"><span class="badge ${st[0]}">${st[1]}</span><span class="badge ${ROLE_BADGE[r.role]}">${esc(roleLabel(r.role))}</span><span class="badge b-role">${esc(fnLabel(r.function))}</span></div>
        <div class="acts">${P.has("invitations.revoke") && (r.role !== "owner" || canOwner) ? `<button class="btn danger ghost sm" data-revoke="${esc(r.id)}" data-email="${esc(r.email)}">Révoquer</button>` : ""}</div></li>`;
      const locked = r.role === "owner" && !canOwner;
      return `<li class="item"><div class="who">${avatar(r)}<div><b>${esc(fullName(r))}${r.self ? " (vous)" : ""}</b><small>${esc(r.email || "")}${r.job_title ? " · " + esc(r.job_title) : ""}${r.last_seen_at ? " · vu " + fmtDT(r.last_seen_at) : ""}</small></div></div>
        <div class="tags"><span class="badge ${st[0]}">${st[1]}</span>${r.user_status === "deactivated" ? '<span class="badge b-warn">Compte désactivé</span>' : ""}<span class="badge ${ROLE_BADGE[r.role]}">${esc(roleLabel(r.role))}</span><span class="badge b-role">${esc(fnLabel(r.function))}</span></div>
        <div class="acts">${!locked && (P.has("members.update_role") || P.has("members.update_function")) ? `<button class="btn ghost sm" data-edit="${esc(r.id)}">Modifier</button>` : ""}
          ${!locked && !r.self && P.has("members.disable") ? `<button class="btn ghost sm" data-toggle="${esc(r.id)}">${r.status === "active" ? "Désactiver" : "Réactiver"}</button>` : ""}
          ${!locked && !r.self && P.has("members.remove") ? `<button class="btn danger ghost sm" data-remove="${esc(r.id)}">Retirer</button>` : ""}</div></li>`;
    }).join("")}</ul>`;
    const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
    box.querySelectorAll("[data-edit]").forEach((b) => (b.onclick = () => editMember(byId[b.dataset.edit], lvl, canOwner)));
    box.querySelectorAll("[data-toggle]").forEach((b) => (b.onclick = async () => {
      const r = byId[b.dataset.toggle]; const off = r.status === "active";
      if (off && !(await confirmBox("Désactiver l'accès ?", `<b>${esc(fullName(r))}</b> perdra immédiatement l'accès à l'établissement, même dans une session déjà ouverte. Ses informations sont conservées et l'accès peut être rétabli.`, "Désactiver", true))) return;
      try { await api(`/api/orgs/${S.orgId}/members/${r.id}`, { method: "PATCH", body: { status: off ? "disabled" : "active" } }); toast(off ? "Accès désactivé." : "Accès réactivé."); loadMembers(); loadAudit(); } catch (e) { fail(e); }
    }));
    box.querySelectorAll("[data-remove]").forEach((b) => (b.onclick = async () => {
      const r = byId[b.dataset.remove];
      if (!(await confirmBox("Retirer de l'établissement ?", `<b>${esc(fullName(r))}</b> ne fera plus partie de l'établissement. Son compte personnel n'est pas supprimé. Pour revenir, il faudra une nouvelle invitation.`, "Retirer", true))) return;
      try { await api(`/api/orgs/${S.orgId}/members/${r.id}`, { method: "DELETE" }); toast("Membre retiré."); loadMembers(); loadAudit(); } catch (e) { fail(e); }
    }));
    box.querySelectorAll("[data-revoke]").forEach((b) => (b.onclick = async () => {
      if (!(await confirmBox("Révoquer l'invitation ?", `Le lien envoyé à <b>${esc(b.dataset.email)}</b> ne fonctionnera plus.`, "Révoquer", true))) return;
      try { await api(`/api/orgs/${S.orgId}/invitations/${b.dataset.revoke}`, { method: "DELETE" }); toast("Invitation révoquée."); loadMembers(); loadAudit(); } catch (e) { fail(e); }
    }));
    if (P.has("audit.read")) loadAudit();
  }
  async function editMember(r, lvl, canOwner) {
    const roles = S.meta.roles.filter((x) => x !== "owner" || canOwner);
    const v = await dialog(`<h2>Modifier ${esc(fullName(r))}</h2><p>Le rôle donne les permissions ; la fonction décrit le travail et n'accorde aucun droit.</p>
      <div class="f"><label for="er">Rôle (permissions)</label><select id="er" name="role">${roles.slice().reverse().map((x) => `<option value="${x}"${x === r.role ? " selected" : ""}>${esc(roleLabel(x))}</option>`).join("")}</select></div>
      <div class="f"><label for="ef">Fonction</label><select id="ef" name="function">${Object.entries(S.meta.functions).map(([k, l]) => `<option value="${k}"${k === r.function ? " selected" : ""}>${esc(l)}</option>`).join("")}</select></div>
      <div class="row"><button class="btn ghost" value="cancel" formnovalidate>Annuler</button><button class="btn" value="ok">Enregistrer</button></div>`);
    if (!v) return;
    const body = {}; if (v.role !== r.role) body.role = v.role; if (v.function !== r.function) body.function = v.function;
    if (!Object.keys(body).length) return;
    if (body.role && !(await confirmBox("Changer le rôle ?", `${esc(fullName(r))} passera de <b>${esc(roleLabel(r.role))}</b> à <b>${esc(roleLabel(body.role))}</b>. Le changement s'applique immédiatement.`, "Changer le rôle"))) return;
    try { await api(`/api/orgs/${S.orgId}/members/${r.id}`, { method: "PATCH", body }); toast("Membre mis à jour."); await reloadMe(); loadMembers(); } catch (e) { fail(e); }
  }
  async function inviteDialog() {
    const canOwner = (S.me.memberships.find((m) => m.org_id === S.orgId)?.permissions || []).includes("members.invite_owner") || S.me.user.platform_admin;
    const v = await dialog(`<h2>Inviter une personne</h2><p>Un lien personnel, à usage unique et valable 7 jours, sera créé. La personne devra se connecter avec un compte qui utilise exactement cette adresse.</p>
      <div class="f"><label for="ie">Adresse courriel</label><input type="email" id="ie" name="email" required autocomplete="off" maxlength="200"></div>
      <div class="grid2"><div class="f"><label for="ir">Rôle</label><select id="ir" name="role">${S.meta.roles.filter((x) => x !== "owner" || canOwner).map((x) => `<option value="${x}">${esc(roleLabel(x))}</option>`).join("")}</select></div>
      <div class="f"><label for="if">Fonction</label><select id="if" name="function">${Object.entries(S.meta.functions).map(([k, l]) => `<option value="${k}">${esc(l)}</option>`).join("")}</select></div></div>
      <div class="row"><button class="btn ghost" value="cancel" formnovalidate>Annuler</button><button class="btn" value="ok">Créer l'invitation</button></div>`);
    if (!v) return;
    let d;
    try { d = await api(`/api/orgs/${S.orgId}/invitations`, { method: "POST", body: v }); } catch (e) { return fail(e); }
    await dialog(`<h2>Invitation créée</h2><p>Transmettez ce lien à <b>${esc(d.invitation.email)}</b> (courriel, Teams…). <b>Il ne sera plus affiché</b> : copiez-le maintenant. Aucun courriel n'a été envoyé automatiquement.</p>
      <div class="linkbox"><code id="lnk">${esc(d.link)}</code><button class="btn sm" type="button" id="cp">Copier</button></div>
      <div class="row"><button class="btn" value="ok">Terminé</button></div>`, { onOpen: (f) => { f.querySelector("#cp").onclick = () => { navigator.clipboard?.writeText(d.link).then(() => toast("Lien copié."), () => toast("Sélectionnez le lien et copiez-le.", true)); }; } });
    loadMembers();
  }
  const ACTIONS = { "invitation.created": "a invité", "invitation.revoked": "a révoqué l'invitation de", "invitation.accepted": "a rejoint l'établissement", "member.role_changed": "a changé le rôle de", "member.function_changed": "a changé la fonction de", "member.disabled": "a désactivé l'accès de", "member.enabled": "a réactivé l'accès de", "member.removed": "a retiré", "member.left": "a quitté l'établissement", "ownership.transferred": "a transféré la propriété à", "org.updated": "a modifié l'établissement", "org.created": "a créé l'établissement", "account.deleted": "a supprimé son compte" };
  async function loadAudit() {
    const box = $("audit"); if (!box) return;
    $("auditCard").hidden = false;
    try {
      const { entries } = await api(`/api/orgs/${S.orgId}/audit`);
      const n = (f, l, id) => (f || l ? esc([f, l].filter(Boolean).join(" ")) : id ? "Compte supprimé" : "—");
      box.innerHTML = entries.length ? `<ul class="list">${entries.slice(0, 40).map((e) => {
        const det = e.details || {};
        const extra = det.from && det.to ? ` (${esc(roleLabel(det.from) || det.from)} → ${esc(roleLabel(det.to) || det.to)})` : det.email ? ` ${esc(det.email)}` : "";
        const tgt = e.target_user_id && e.target_user_id !== e.actor_user_id ? " " + n(e.target_first, e.target_last, e.target_user_id) : "";
        return `<li class="item"><div class="who"><div><b>${n(e.actor_first, e.actor_last, e.actor_user_id)}</b> ${esc(ACTIONS[e.action] || e.action)}${tgt}${extra}<small>${fmtDT(e.created_at)}</small></div></div></li>`;
      }).join("")}</ul>` : '<div class="empty"><b>Aucun événement</b>Les changements apparaîtront ici.</div>';
    } catch (e) { $("auditCard").hidden = true; }
  }

  /* ---------- Rôles et permissions ---------- */
  function viewRoles() {
    const m = membership();
    const mine = S.me.user.platform_admin ? "platform" : m?.role;
    const cols = ["member", "admin", "owner", "platform"];
    const RANK = { member: 1, admin: 2, owner: 3, platform: 4 };
    main.innerHTML = `
      <div class="head"><div><h1>Rôles et permissions</h1><p>La même matrice est appliquée par le serveur à chaque requête.</p></div></div>
      <div class="cards">
        <section class="card"><h2>Rôle et fonction : deux choses distinctes</h2>
          <p class="lead">Le <b>rôle</b> (Membre, Administrateur, Propriétaire) détermine ce que vous pouvez faire dans l'établissement. La <b>fonction</b> (${Object.values(S.meta.functions).map(esc).join(", ")}) décrit votre travail : elle adapte l'assistant, mais n'accorde aucune permission.</p>
          ${mine ? `<div class="notice info">Votre niveau ${m ? `dans ${esc(m.org_name)}` : ""} : <b>${esc(roleLabel(mine))}</b>.</div>` : ""}</section>
        <section class="card"><h2>Matrice des permissions</h2><p class="lead">Chaque niveau hérite des permissions du niveau inférieur. Les données de chaque établissement sont strictement isolées.</p>
          <div class="tablewrap"><table class="matrix"><caption class="sr">Permissions par niveau</caption>
            <thead><tr><th scope="col">Action</th>${cols.map((c) => `<th scope="col"${c === mine ? ' class="me"' : ""}>${esc(roleLabel(c))}</th>`).join("")}</tr></thead>
            <tbody>${S.meta.matrix.map((row) => `<tr><th scope="row" style="font-weight:600">${esc(row.label)}</th>${cols.map((c) => `<td${c === mine ? ' class="me"' : ""}>${RANK[c] >= RANK[row.min] ? '<span class="yes" aria-label="Permis">✓</span>' : '<span class="no" aria-label="Non permis">—</span>'}</td>`).join("")}</tr>`).join("")}</tbody>
          </table></div></section>
        <section class="card"><h2>Règles de sécurité</h2><ul style="margin:0;padding-left:20px;display:flex;flex-direction:column;gap:6px">
          <li>Un administrateur ne peut ni modifier ni retirer un propriétaire, ni nommer un propriétaire.</li>
          <li>Le dernier propriétaire ne peut pas être rétrogradé, désactivé ou retiré, ni quitter l'établissement, sans transfert préalable.</li>
          <li>Une désactivation ou un changement de rôle s'applique immédiatement, y compris dans une session déjà ouverte.</li>
          <li>Les invitations sont personnelles, à usage unique, révocables et valables 7 jours. Aucun rattachement automatique selon le domaine du courriel.</li>
          <li>Les comptes sont identifiés par l'identifiant vérifié de Google ou d'Apple ; deux comptes ne sont jamais fusionnés à partir d'une adresse courriel.</li></ul></section>
      </div>`;
  }

  /* ---------- Plateforme ---------- */
  async function viewPlatform() {
    if (!S.me.user.platform_admin) {
      if (!S.me.platform.canBootstrap) { main.innerHTML = errorCard(new Error("Réservé à l'administrateur de la plateforme.")); return; }
      main.innerHTML = `<div class="head"><div><h1>Plateforme</h1><p>Première configuration</p></div></div><div class="cards"><section class="card"><h2>Devenir administrateur de la plateforme</h2>
        <p class="lead">Aucun administrateur de la plateforme n'existe encore. Entrez le code d'administration (ADMIN_CODE) pour lier ce rôle à votre compte. Cette opération ne peut être faite qu'une fois.</p>
        <form id="fBoot" class="row"><input type="text" name="code" autocomplete="off" aria-label="Code d'administration" required style="max-width:320px"><button class="btn">Activer</button></form></section></div>`;
      $("fBoot").onsubmit = async (e) => { e.preventDefault(); try { S.me = await api("/api/platform/bootstrap", { method: "POST", body: { code: e.target.code.value } }); renderChrome(); toast("Vous êtes administrateur de la plateforme."); viewPlatform(); } catch (er) { fail(er); } };
      return;
    }
    loading();
    let orgs, users;
    try { [orgs, users] = await Promise.all([api("/api/platform/orgs"), api("/api/platform/users")]); } catch (e) { main.innerHTML = errorCard(e); return; }
    main.innerHTML = `<div class="head"><div><h1>Plateforme</h1><p>Établissements et comptes de toute la plateforme.</p></div><button class="btn" id="newOrg">Créer un établissement</button></div>
      <div class="cards">
        <section class="card"><h2>Établissements (${orgs.orgs.length})</h2>
          ${orgs.orgs.length ? `<ul class="list">${orgs.orgs.map((o) => `<li class="item"><div class="who"><span class="av" aria-hidden="true">${esc(o.name[0])}</span><div><b>${esc(o.name)}</b><small>${o.city ? esc(o.city) + " · " : ""}${o.members} membre${o.members > 1 ? "s" : ""} actif${o.members > 1 ? "s" : ""} · créé le ${fmtDate(o.created_at)}</small></div></div>
            <div class="acts"><button class="btn ghost sm" data-open="${esc(o.id)}">Gérer</button></div></li>`).join("")}</ul>` : '<div class="empty"><b>Aucun établissement</b>Créez le premier établissement.</div>'}</section>
        <section class="card"><h2>Comptes (${users.users.length})</h2><p class="lead">Suspendre un compte ferme immédiatement toutes ses sessions.</p>
          <ul class="list">${users.users.map((u) => `<li class="item"><div class="who">${avatar(u)}<div><b>${esc(fullName(u))}${u.id === S.me.user.id ? " (vous)" : ""}</b><small>${esc(u.logins || "")}</small></div></div>
            <div class="tags">${u.platform_admin ? '<span class="badge b-warn">Plateforme</span>' : ""}<span class="badge ${u.status === "active" ? "b-active" : u.status === "suspended" ? "b-danger" : "b-disabled"}">${{ active: "Actif", suspended: "Suspendu", deactivated: "Désactivé" }[u.status]}</span></div>
            <div class="acts">${u.id !== S.me.user.id ? `<button class="btn ghost sm" data-susp="${esc(u.id)}" data-st="${u.status}">${u.status === "suspended" ? "Rétablir" : "Suspendre"}</button><button class="btn ghost sm" data-rec="${esc(u.id)}">Lien de récupération</button>` : ""}</div></li>`).join("")}</ul></section>
      </div>`;
    $("newOrg").onclick = async () => {
      const v = await dialog(`<h2>Créer un établissement</h2>
        <div class="f"><label for="nn">Nom</label><input type="text" id="nn" name="name" required maxlength="120"></div>
        <div class="f"><label for="nc">Ville</label><input type="text" id="nc" name="city" maxlength="80"></div>
        <div class="f"><label for="no">Inviter le propriétaire (courriel)</label><input type="email" id="no" name="ownerEmail" maxlength="200"><span class="hint">Facultatif. Un lien d'invitation de propriétaire sera créé.</span></div>
        <label class="check"><input type="checkbox" name="iAmOwner"> Je suis aussi propriétaire de cet établissement</label>
        <div class="row"><button class="btn ghost" value="cancel" formnovalidate>Annuler</button><button class="btn" value="ok">Créer</button></div>`);
      if (!v) return;
      try {
        const d = await api("/api/platform/orgs", { method: "POST", body: { name: v.name, city: v.city, ownerEmail: v.ownerEmail || undefined, iAmOwner: !!v.iAmOwner } });
        await reloadMe();
        if (d.invite) await dialog(`<h2>Établissement créé</h2><p>Lien d'invitation du propriétaire (${esc(d.invite.invitation.email)}) — copiez-le maintenant, il ne sera plus affiché :</p><div class="linkbox"><code>${esc(d.invite.link)}</code></div><div class="row"><button class="btn" value="ok">Terminé</button></div>`);
        else toast("Établissement créé.");
        viewPlatform();
      } catch (e) { fail(e); }
    };
    main.querySelectorAll("[data-open]").forEach((b) => (b.onclick = async () => { try { await api("/api/session/org", { method: "POST", body: { orgId: b.dataset.open } }); S.orgId = b.dataset.open; S.platOrgName = orgs.orgs.find((o) => o.id === S.orgId).name; await reloadMe(); location.hash = "#membres"; } catch (e) { fail(e); } }));
    main.querySelectorAll("[data-susp]").forEach((b) => (b.onclick = async () => {
      const susp = b.dataset.st !== "suspended";
      if (susp && !(await confirmBox("Suspendre ce compte ?", "Toutes ses sessions seront fermées immédiatement et la connexion sera refusée.", "Suspendre", true))) return;
      try { await api(`/api/platform/users/${b.dataset.susp}/status`, { method: "POST", body: { status: susp ? "suspended" : "active" } }); toast(susp ? "Compte suspendu." : "Compte rétabli."); viewPlatform(); } catch (e) { fail(e); }
    }));
    main.querySelectorAll("[data-rec]").forEach((b) => (b.onclick = async () => {
      const v = await dialog(`<h2>Lien de récupération d'accès</h2><p>Pour une personne qui a perdu l'accès à son moyen de connexion. Vérifiez son identité par un autre moyen (téléphone, en personne) avant de lui remettre le lien. Le nouveau moyen de connexion devra utiliser l'adresse vérifiée indiquée ci-dessous. Lien à usage unique, valable 24 heures.</p>
        <div class="f"><label for="re">Adresse vérifiée du nouveau moyen de connexion</label><input type="email" id="re" name="email" required></div>
        <div class="row"><button class="btn ghost" value="cancel" formnovalidate>Annuler</button><button class="btn" value="ok">Créer le lien</button></div>`);
      if (!v) return;
      try { const d = await api(`/api/platform/users/${b.dataset.rec}/recovery`, { method: "POST", body: { email: v.email } }); await dialog(`<h2>Lien créé</h2><p>Remettez ce lien à la personne de façon sûre. Il ne sera plus affiché.</p><div class="linkbox"><code>${esc(d.link)}</code></div><div class="row"><button class="btn" value="ok">Terminé</button></div>`); } catch (e) { fail(e); }
    }));
  }

  boot();
})();
