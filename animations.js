/* ===========================
   WYPE — Scroll Reveal
   =========================== */

(function () {
  // Zones that should never animate
  const SKIP = '#hero, .nav, .co-header, .co-dispatch, .announcement, footer, .sticky-cta';

  // Whole-block elements — animate as one unit (children won't animate separately)
  const UNITS = [
    '.review-card',
    '.gsm-explainer__item',
    '.gsm-compare__row',
    '.product-card',
    '.p-acc-item',
    '.co-trust__item',
    '.p-spec',
    '.p-bundle',
    '.p-badge',
    '.p-usp__item',
  ].join(', ');

  // Individual text elements — only when not already inside a UNIT
  const TEXT = [
    '.section-tag',
    '.section-title',
    '.section-sub',
    'h2', 'h3', 'h4',
    '.p-desc__intro',
    '.legal-wrap p',
    '.legal-wrap li',
    '.gsm-section p',
    '.gsm-compare__title',
    '.p-hero h1',
    '.p-hero p',
  ].join(', ');

  function init() {
    const inSkip = el => el.closest(SKIP);
    const inUnit = el => el.closest(UNITS);

    const units = Array.from(document.querySelectorAll(UNITS))
      .filter(el => !inSkip(el));

    const texts = Array.from(document.querySelectorAll(TEXT))
      .filter(el => !inSkip(el) && !inUnit(el) && !el.classList.contains('reveal'));

    // Mark all elements
    [...units, ...texts].forEach(el => {
      if (!el.classList.contains('reveal')) el.classList.add('reveal');
    });

    // Stagger siblings inside the same parent
    document.querySelectorAll('.reveal').forEach(el => {
      const revealSiblings = Array.from(el.parentElement.children)
        .filter(c => c.classList.contains('reveal'));
      const idx = revealSiblings.indexOf(el);
      if (idx > 0) {
        el.style.transitionDelay = `${Math.min(idx * 0.1, 0.3)}s`;
      }
    });

    // Observe
    const io = new IntersectionObserver(entries => {
      entries.forEach(({ target, isIntersecting }) => {
        if (isIntersecting) {
          target.classList.add('visible');
          io.unobserve(target);
        }
      });
    }, { threshold: 0.1, rootMargin: '0px 0px -36px 0px' });

    document.querySelectorAll('.reveal').forEach(el => io.observe(el));
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
