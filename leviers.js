/* Trois leviers à la suite : galerie de captures + agrandissement (sans défilement automatique) */
(() => {
  const sec = document.getElementById('leviers');
  if (!sec) return;
  const tabs = [...sec.querySelectorAll('.lev-tab')];
  const THEMES = ['pil--formed', 'pil--tooled', 'pil--encadre'];
  const BASE = sec.dataset.base || '';
  const EN = /^en/i.test(document.documentElement.lang);
  const L = EN ? { enlarge: 'Enlarge screenshot: ' } : { enlarge: 'Agrandir la capture : ' };
  const src = (n, w) => `${BASE}assets/app/${n}-${w}.webp?v=3`;
  const shotsOf = (panel) => panel.dataset.shots.split('|').map((x) => { const [n, t, c] = x.split('::'); return { n, t, c }; });

  /* ---------- onglets ---------- */
  function select(tab, focus) {
    tabs.forEach((t) => {
      const on = t === tab;
      t.setAttribute('aria-selected', String(on)); t.tabIndex = on ? 0 : -1;
      document.getElementById(t.getAttribute('aria-controls')).hidden = !on;
    });
    sec.classList.remove(...THEMES); sec.classList.add(tab.dataset.theme);
    if (focus) tab.focus();
  }
  tabs.forEach((t, i) => {
    t.addEventListener('click', () => select(t));
    t.addEventListener('keydown', (e) => {
      const k = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
      if (k) { e.preventDefault(); select(tabs[(i + k + tabs.length) % tabs.length], true); }
      else if (e.key === 'Home') { e.preventDefault(); select(tabs[0], true); }
      else if (e.key === 'End') { e.preventDefault(); select(tabs[tabs.length - 1], true); }
    });
  });
  // Pastilles de l'introduction → onglet correspondant
  document.querySelectorAll('[data-lev]').forEach((a) => a.addEventListener('click', () => {
    const t = document.getElementById('lev-tab-' + a.dataset.lev); if (t) select(t);
  }));

  /* ---------- galerie de chaque levier ---------- */
  sec.querySelectorAll('.lev-panel').forEach((panel) => {
    const shots = shotsOf(panel);
    const img = panel.querySelector('.lev-zoom img');
    const zoom = panel.querySelector('.lev-zoom');
    const steps = [...panel.querySelectorAll('.lev-step')];
    const cap = panel.querySelector('figcaption');
    let cur = 0;
    function show(i) {
      cur = (i + shots.length) % shots.length;
      const s = shots[cur];
      img.classList.add('is-swap');
      const next = new Image();
      next.onload = next.onerror = () => {
        img.src = src(s.n, 1200); img.srcset = `${src(s.n, 1200)} 1200w, ${src(s.n, 1920)} 1920w`;
        img.alt = `${s.t}${EN ? ":" : " :"} ${s.c}`;
        requestAnimationFrame(() => img.classList.remove('is-swap'));
      };
      next.src = src(s.n, 1200);
      zoom.setAttribute('aria-label', L.enlarge + s.t);
      cap.querySelector('.lev-count').textContent = `${cur + 1} / ${shots.length}`;
      cap.querySelector('strong').textContent = s.t;
      cap.querySelector('.lev-cap').textContent = s.c;
      steps.forEach((b, k) => b.setAttribute('aria-pressed', String(k === cur)));
    }
    steps.forEach((b, k) => b.addEventListener('click', () => show(k)));
    panel.querySelector('.lev-nav.prev').addEventListener('click', () => show(cur - 1));
    panel.querySelector('.lev-nav.next').addEventListener('click', () => show(cur + 1));
    zoom.addEventListener('click', () => openLb(shots, cur, (i) => show(i)));
    swipe(panel.querySelector('.lev-shot'), (d) => show(cur + d));
  });

  /* ---------- appel à l'action : pré-remplit le message du formulaire ---------- */
  sec.querySelectorAll('[data-prefill]').forEach((a) => a.addEventListener('click', () => {
    const m = document.getElementById('message');
    if (m && !m.value.trim()) m.value = a.dataset.prefill;
  }));

  /* ---------- agrandissement ---------- */
  const lb = document.getElementById('lev-lb');
  const lbImg = document.getElementById('lev-lb-img');
  let lbShots = [], lbI = 0, lbSync = null, opener = null;
  function lbShow(i) {
    lbI = (i + lbShots.length) % lbShots.length;
    const s = lbShots[lbI];
    lbImg.src = src(s.n, 1920); lbImg.alt = `${s.t}${EN ? ":" : " :"} ${s.c}`;
    lb.querySelector('.lb-scroll').scrollLeft = 0;
    document.getElementById('lev-lb-count').textContent = `${lbI + 1} / ${lbShots.length}`;
    document.getElementById('lev-lb-title').textContent = s.t;
    document.getElementById('lev-lb-cap').textContent = s.c;
    lbSync && lbSync(lbI);
  }
  function openLb(shots, i, sync) {
    lbShots = shots; lbSync = sync; opener = document.activeElement;
    lbShow(i);
    if (typeof lb.showModal === 'function') lb.showModal(); else lb.setAttribute('open', '');
    document.documentElement.classList.add('lb-open');
  }
  function closeLb() { if (lb.open) lb.close(); }
  lb.addEventListener('close', () => { document.documentElement.classList.remove('lb-open'); opener && opener.focus(); });
  lb.querySelector('.lb-prev').addEventListener('click', () => lbShow(lbI - 1));
  lb.querySelector('.lb-next').addEventListener('click', () => lbShow(lbI + 1));
  lb.querySelector('.lb-close').addEventListener('click', closeLb);
  lb.addEventListener('click', (e) => { if (e.target === lb) closeLb(); });
  lb.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowLeft') { e.preventDefault(); lbShow(lbI - 1); }
    if (e.key === 'ArrowRight') { e.preventDefault(); lbShow(lbI + 1); }
  });
  // Sur téléphone, l'image agrandie défile à l'horizontale : pas de balayage pour changer de capture
  if (!matchMedia('(max-width: 760px)').matches) swipe(lb, (d) => lbShow(lbI + d));

  // Balayage horizontal sur écran tactile
  function swipe(el, cb) {
    let x0 = null, y0 = 0;
    el.addEventListener('touchstart', (e) => { x0 = e.touches[0].clientX; y0 = e.touches[0].clientY; }, { passive: true });
    el.addEventListener('touchend', (e) => {
      if (x0 === null) return;
      const dx = e.changedTouches[0].clientX - x0, dy = e.changedTouches[0].clientY - y0; x0 = null;
      if (Math.abs(dx) > 45 && Math.abs(dx) > Math.abs(dy) * 1.4) cb(dx < 0 ? 1 : -1);
    }, { passive: true });
  }
})();
