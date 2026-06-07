(() => {
  const header = document.querySelector('[data-header]');
  const nav = document.querySelector('[data-nav]');
  const navToggle = document.querySelector('[data-nav-toggle]');
  const year = document.querySelector('[data-year]');
  const form = document.querySelector('#contactForm');
  const note = document.querySelector('[data-form-note]');

  if (year) year.textContent = new Date().getFullYear();

  const setHeaderState = () => {
    if (!header) return;
    header.classList.toggle('is-scrolled', window.scrollY > 12);
  };
  setHeaderState();
  window.addEventListener('scroll', setHeaderState, { passive: true });

  if (nav && navToggle) {
    navToggle.addEventListener('click', () => {
      const isOpen = nav.classList.toggle('is-open');
      navToggle.setAttribute('aria-expanded', String(isOpen));
    });

    nav.querySelectorAll('a').forEach((link) => {
      link.addEventListener('click', () => {
        nav.classList.remove('is-open');
        navToggle.setAttribute('aria-expanded', 'false');
      });
    });
  }

  const revealItems = document.querySelectorAll('.reveal');
  if ('IntersectionObserver' in window) {
    const observer = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          entry.target.classList.add('is-visible');
          observer.unobserve(entry.target);
        }
      });
    }, { threshold: 0.12 });

    revealItems.forEach((item) => observer.observe(item));
  } else {
    revealItems.forEach((item) => item.classList.add('is-visible'));
  }

  const buildMailto = (data) => {
    const subject = `Demande de rencontre exploratoire - ${data.organization || data.name}`;
    const body = [
      'Bonjour Amélie,',
      '',
      'J’aimerais planifier une rencontre exploratoire avec La Qualia.',
      '',
      `Nom : ${data.name}`,
      `Organisation : ${data.organization || 'Non précisée'}`,
      `Courriel : ${data.email}`,
      '',
      'Message :',
      data.message,
      '',
      'Merci,'
    ].join('\n');

    return `mailto:Amelie.brunelle@laqualia.com?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
  };

  if (form) {
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const formData = new FormData(form);
      const data = Object.fromEntries(formData.entries());
      const required = ['name', 'email', 'message'];
      const missing = required.some((field) => !String(data[field] || '').trim());
      const emailIsValid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(data.email || '').trim());

      if (missing || !emailIsValid) {
        if (note) {
          note.textContent = 'Merci de remplir le nom, un courriel valide et le message.';
          note.classList.add('is-error');
        }
        return;
      }

      if (note) {
        note.textContent = 'Votre application courriel va s’ouvrir avec la demande préparée.';
        note.classList.remove('is-error');
      }
      window.location.href = buildMailto(data);
    });
  }
})();
