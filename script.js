(() => {
  'use strict';

  const menuButton = document.querySelector('.menu-toggle');
  const menu = document.querySelector('.main-nav');

  function setMenu(open) {
    if (!menuButton || !menu) return;
    menuButton.setAttribute('aria-expanded', String(open));
    menu.classList.toggle('is-open', open);
    document.body.classList.toggle('menu-open', open);
  }

  menuButton?.addEventListener('click', () => {
    setMenu(menuButton.getAttribute('aria-expanded') !== 'true');
  });

  menu?.querySelectorAll('a').forEach((link) => link.addEventListener('click', () => setMenu(false)));
  document.addEventListener('keydown', (event) => { if (event.key === 'Escape') setMenu(false); });
  window.addEventListener('resize', () => { if (window.innerWidth > 900) setMenu(false); }, { passive: true });

  const revealItems = document.querySelectorAll('.reveal');
  if ('IntersectionObserver' in window && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    const revealObserver = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        entry.target.classList.add('is-visible');
        revealObserver.unobserve(entry.target);
      });
    }, { threshold: 0.08, rootMargin: '0px 0px -4% 0px' });
    revealItems.forEach((item) => revealObserver.observe(item));
  } else {
    revealItems.forEach((item) => item.classList.add('is-visible'));
  }

  const heroMedia = document.querySelector('.hero-media');
  const heroGifs = [...document.querySelectorAll('[data-hero-gif]')];
  const availableHeroGifs = new Set();
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  let activeHeroPosition = 0;
  let heroTimer = null;

  function getAvailableIndexes() {
    return [...availableHeroGifs].sort((a, b) => a - b);
  }

  function updateHeroFallback() {
    heroMedia?.classList.toggle('no-gifs', availableHeroGifs.size === 0);
  }

  function showHeroByPosition(position) {
    const indexes = getAvailableIndexes();
    if (!indexes.length) return;

    const normalized = ((position % indexes.length) + indexes.length) % indexes.length;
    const activeIndex = indexes[normalized];

    heroGifs.forEach((layer, index) => {
      layer.classList.toggle('is-active', index === activeIndex);
    });

    activeHeroPosition = (normalized + 1) % indexes.length;
  }

  function restartHeroTimer() {
    if (heroTimer) window.clearInterval(heroTimer);
    heroTimer = null;

    if (reduceMotion || document.hidden || availableHeroGifs.size < 2) return;
    heroTimer = window.setInterval(() => showHeroByPosition(activeHeroPosition), 5600);
  }

  heroGifs.forEach((layer, index) => {
    const image = layer.querySelector('[data-hero-image]');
    if (!image) return;

    const markLoaded = () => {
      availableHeroGifs.add(index);
      layer.classList.remove('is-missing');
      updateHeroFallback();

      if (getAvailableIndexes().length === 1) showHeroByPosition(0);
      restartHeroTimer();
    };

    const markMissing = () => {
      availableHeroGifs.delete(index);
      layer.classList.remove('is-active');
      layer.classList.add('is-missing');
      updateHeroFallback();
      showHeroByPosition(0);
      restartHeroTimer();
    };

    image.addEventListener('load', markLoaded, { once: true });
    image.addEventListener('error', markMissing, { once: true });

    if (image.complete) {
      if (image.naturalWidth > 0) markLoaded();
      else markMissing();
    }
  });

  window.setTimeout(() => {
    updateHeroFallback();
    showHeroByPosition(0);
    restartHeroTimer();
  }, 200);

  document.addEventListener('visibilitychange', restartHeroTimer);

  document.querySelectorAll('.case-video-wrap').forEach((wrap) => {
    const video = wrap.querySelector('[data-case-video]');
    const toggle = wrap.querySelector('[data-video-toggle]');
    if (!video || !toggle) return;

    video.muted = true;
    video.playsInline = true;
    video.autoplay = false;
    video.pause();

    const markReady = () => {
      wrap.classList.remove('is-missing');
      video.pause();
      toggle.textContent = 'Пуск';
      toggle.setAttribute('aria-label', 'Воспроизвести видео');
    };

    const markMissing = () => {
      wrap.classList.add('is-missing');
      toggle.hidden = true;
    };

    video.addEventListener('loadeddata', markReady, { once: true });
    video.addEventListener('error', markMissing, { once: true });

    if (video.readyState >= 2) markReady();

    function syncButton() {
      const paused = video.paused;
      toggle.textContent = paused ? 'Пуск' : 'Пауза';
      toggle.setAttribute('aria-label', paused ? 'Воспроизвести видео' : 'Поставить видео на паузу');
    }

    toggle.addEventListener('click', async () => {
      try {
        if (video.paused) {
          document.querySelectorAll('[data-case-video]').forEach((otherVideo) => {
            if (otherVideo !== video) otherVideo.pause();
          });
          await video.play();
        } else {
          video.pause();
        }
      } catch {
        markMissing();
      }
      syncButton();
    });

    video.addEventListener('play', syncButton);
    video.addEventListener('pause', syncButton);
  });

  const form = document.querySelector('#lead-form');
  const status = document.querySelector('#form-status');
  const submit = form?.querySelector('button[type="submit"]');
  const submitText = submit?.querySelector('span');

  function setStatus(message, type = '') {
    if (!status) return;
    status.textContent = message;
    status.className = `form-status ${type}`.trim();
  }

  form?.addEventListener('submit', async (event) => {
    event.preventDefault();
    setStatus('');

    if (!form.checkValidity()) {
      form.reportValidity();
      setStatus('Проверьте обязательные поля.', 'error');
      return;
    }

    const data = Object.fromEntries(new FormData(form).entries());
    if (submit) submit.disabled = true;
    if (submitText) submitText.textContent = 'Отправляем заявку...';

    try {
      const response = await fetch('/api/lead', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: data.name,
          contact: data.contact,
          company: data.company,
          projectType: data.projectType,
          message: data.message,
          website: data.website,
          page: window.location.href
        })
      });

      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || 'Не удалось отправить заявку.');

      form.reset();
      setStatus(result.message || 'Заявка отправлена. Менеджер свяжется с вами.', 'success');
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Ошибка отправки. Попробуйте ещё раз.', 'error');
    } finally {
      if (submit) submit.disabled = false;
      if (submitText) submitText.textContent = 'Отправить заявку';
    }
  });

  const year = document.querySelector('#year');
  if (year) year.textContent = String(new Date().getFullYear());
})();
