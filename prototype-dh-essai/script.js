// Site créé par Jarvis — menu, apparitions au défilement, compteurs, visionneuse. Sans bibliothèque externe.
(() => {
  const doux = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const barre = document.getElementById('barre');

  // Barre : fond quand on défile ; menu mobile
  const majBarre = () => barre.classList.toggle('defilee', scrollY > 30);
  addEventListener('scroll', majBarre, { passive: true });
  majBarre();
  const burger = barre.querySelector('.burger');
  burger.addEventListener('click', () => {
    const ouvert = barre.classList.toggle('ouverte');
    burger.setAttribute('aria-expanded', ouvert);
    burger.setAttribute('aria-label', ouvert ? 'Fermer le menu' : 'Ouvrir le menu');
  });
  barre.querySelectorAll('.menu a').forEach((a) => a.addEventListener('click', () => {
    barre.classList.remove('ouverte'); burger.setAttribute('aria-expanded', 'false');
  }));

  // Lien du menu actif selon la section visible
  const liens = [...barre.querySelectorAll('.menu a[href^="#"]')];
  const cibles = liens.map((a) => document.querySelector(a.getAttribute('href'))).filter(Boolean);
  if ('IntersectionObserver' in window && cibles.length) {
    const io = new IntersectionObserver((entrees) => entrees.forEach((en) => {
      if (en.isIntersecting) liens.forEach((a) => a.classList.toggle('actif', a.getAttribute('href') === '#' + en.target.id));
    }), { rootMargin: '-45% 0px -50% 0px' });
    cibles.forEach((c) => io.observe(c));
  }

  // Apparitions au défilement + compteurs
  const compter = (el) => {
    const cible = parseFloat(el.dataset.cible);
    const decimales = (el.dataset.cible.split('.')[1] || '').length;
    if (doux) { el.textContent = cible.toLocaleString('fr-FR', { minimumFractionDigits: decimales }); return; }
    const debut = performance.now(), duree = 1600;
    const pas = (t) => {
      const p = Math.min(1, (t - debut) / duree), v = cible * (1 - Math.pow(1 - p, 3));
      el.textContent = v.toLocaleString('fr-FR', { minimumFractionDigits: decimales, maximumFractionDigits: decimales });
      if (p < 1) requestAnimationFrame(pas);
    };
    requestAnimationFrame(pas);
  };
  if ('IntersectionObserver' in window) {
    if (!doux) document.querySelectorAll('.reveal .compteur').forEach((el) => { el.textContent = '0'; });  // animés depuis 0
    const io = new IntersectionObserver((entrees) => entrees.forEach((en) => {
      if (!en.isIntersecting) return;
      en.target.classList.add('visible');
      en.target.querySelectorAll('.compteur').forEach(compter);
      io.unobserve(en.target);
    }), { threshold: 0.15, rootMargin: '0px 0px -8% 0px' });
    document.querySelectorAll('.reveal').forEach((el) => io.observe(el));
  } else {
    document.documentElement.classList.add('sans-js');
  }

  // Visionneuse de la galerie
  const v = document.querySelector('.visionneuse');
  const fermer = () => { v.hidden = true; document.body.style.overflow = ''; };
  document.querySelectorAll('[data-visionneuse]').forEach((a) => a.addEventListener('click', (ev) => {
    ev.preventDefault();
    const img = a.querySelector('img');
    v.querySelector('img').src = a.href;
    v.querySelector('img').alt = img ? img.alt : '';
    v.hidden = false; document.body.style.overflow = 'hidden';
    v.querySelector('.fermer').focus();
  }));
  v.addEventListener('click', (ev) => { if (ev.target !== v.querySelector('img')) fermer(); });
  addEventListener('keydown', (ev) => { if (ev.key === 'Escape' && !v.hidden) fermer(); });
})();
