
/* La Qualia: basic consent mode. No Google script is fetched before opt-in. */
(() => {
  'use strict';
  const ID = 'G-7WQ2G8JCFT', KEY = 'laqualia.cookieConsent.v1';
  const TTL = 180 * 24 * 60 * 60 * 1000;
  const en = document.documentElement.lang.startsWith('en');
  const text = en ? {
    saved: 'Your preferences have been saved.', temporary: 'Your choice applies to this page. Your browser could not save it for future visits.'
  } : {
    saved: 'Vos préférences ont été enregistrées.', temporary: 'Votre choix est appliqué à cette page. Votre navigateur n’a pas pu le conserver pour vos prochaines visites.'
  };
  let loaded = false, current = null, returnFocus = null;
  window['ga-disable-' + ID] = true;
  window.dataLayer = window.dataLayer || [];
  window.gtag = window.gtag || function () { window.dataLayer.push(arguments); };
  const denied = {analytics_storage:'denied', ad_storage:'denied', ad_user_data:'denied', ad_personalization:'denied'};
  window.gtag('consent', 'default', denied);
  function read() {
    try {
      const value = JSON.parse(localStorage.getItem(KEY));
      if (value && value.version === 1 && typeof value.analytics === 'boolean' && Number.isFinite(value.savedAt) && value.savedAt <= Date.now() && Date.now() - value.savedAt < TTL) return value;
    } catch (_) {}
    return null;
  }
  function clearAnalyticsCookies() {
    const names = document.cookie.split(';').map(x => x.trim().split('=')[0]).filter(x => /^(_ga(?:_|$)|_gid$|_gat(?:_|$))/.test(x));
    const parts = location.hostname.split('.');
    const domains = [''];
    for (let i = 0; i < parts.length - 1; i++) domains.push(parts.slice(i).join('.'), '.' + parts.slice(i).join('.'));
    const paths = new Set(['/']);
    const segments = location.pathname.split('/').filter(Boolean);
    for (let i = 1; i <= segments.length; i++) { const p = '/' + segments.slice(0,i).join('/'); paths.add(p); paths.add(p + '/'); }
    names.forEach(name => domains.forEach(domain => paths.forEach(path => {
      document.cookie = name + '=; Max-Age=0; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=' + path + (domain ? '; domain=' + domain : '') + '; SameSite=Lax';
    })));
  }
  function apply(allow) {
    window['ga-disable-' + ID] = !allow;
    window.gtag('consent','update', {...denied, analytics_storage: allow ? 'granted' : 'denied'});
    if (!allow) { clearAnalyticsCookies(); return; }
    if (loaded) return;
    loaded = true;
    window.gtag('js', new Date());
    window.gtag('config', ID, {allow_google_signals:false, allow_ad_personalization_signals:false, cookie_expires:15552000, cookie_update:false});
    const script = document.createElement('script');
    script.async = true; script.id = 'laqualia-analytics';
    script.src = 'https://www.googletagmanager.com/gtag/js?id=' + ID;
    document.head.appendChild(script);
  }
  current = read();
  apply(!!current?.analytics);
  function init() {
    const banner = document.getElementById('lq-cookie-banner');
    const dialog = document.getElementById('lq-cookie-dialog');
    const checkbox = document.getElementById('lq-cookie-analytics');
    const status = document.getElementById('lq-cookie-status');
    function open() {
      returnFocus = document.activeElement;
      checkbox.checked = !!current?.analytics;
      dialog.showModal();
    }
    function close() { dialog.close(); if (returnFocus?.isConnected) returnFocus.focus(); }
    function save(analytics) {
      const wasLoaded = loaded;
      current = {version:1, analytics, savedAt:Date.now()};
      let persisted = false;
      try { localStorage.setItem(KEY, JSON.stringify(current)); persisted = true; } catch (_) {}
      apply(analytics);
      if (dialog.open) close();
      banner.hidden = true;
      const top = document.querySelector('h1');
      if (top) {
        const previousTabindex = top.getAttribute('tabindex');
        top.setAttribute('tabindex', '-1');
        top.focus({preventScroll:true});
        top.addEventListener('blur', () => {
          if (previousTabindex === null) top.removeAttribute('tabindex');
          else top.setAttribute('tabindex', previousTabindex);
        }, {once:true});
      }
      // Remove section anchors so a consent-withdrawal reload cannot jump to the footer.
      try { history.replaceState(history.state, '', location.pathname + location.search); } catch (_) {}
      window.scrollTo({top:0, left:0, behavior:'instant'});
      status.textContent = persisted ? text.saved : text.temporary;
      setTimeout(() => { status.textContent = ''; }, 8000);
      // Unload the previously authorized library after revocation.
      if (!analytics && wasLoaded && persisted) {
        try { history.scrollRestoration = 'manual'; } catch (_) {}
        location.reload();
      }
    }
    banner.hidden = !!current;
    document.querySelectorAll('[data-cookie-action]').forEach(button => {
      button.addEventListener('click', () => {
        const action = button.dataset.cookieAction;
        if (action === 'open') open();
        else if (action === 'close') close();
        else if (action === 'accept') save(true);
        else if (action === 'reject') save(false);
        else if (action === 'save') save(checkbox.checked);
      });
    });
    dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
    window.addEventListener('storage', event => {
      if (event.key !== KEY && event.key !== null) return;
      const wasLoaded = loaded;
      current = read(); apply(!!current?.analytics);
      checkbox.checked = !!current?.analytics; banner.hidden = !!current;
      if (wasLoaded && !current?.analytics) location.reload();
    });
    // Recheck expiry when returning to an already-open tab.
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && current && Date.now() - current.savedAt >= TTL) {
        current = null; apply(false); banner.hidden = false;
        if (loaded) location.reload();
      }
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, {once:true});
  else init();
})();
