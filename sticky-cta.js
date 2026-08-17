(function () {
  var SHOW_AFTER = 380;
  var HIDE_NEAR_FOOTER = 120;

  var style = document.createElement('style');
  style.textContent = [
    '@keyframes wype-shimmer {',
    '  0%   { transform: translateX(-120%) skewX(-18deg); opacity: 0; }',
    '  15%  { opacity: 1; }',
    '  85%  { opacity: 1; }',
    '  100% { transform: translateX(520%) skewX(-18deg); opacity: 0; }',
    '}',
    '@keyframes wype-glow-pulse {',
    '  0%, 100% { box-shadow: 0 8px 32px rgba(220,20,20,0.48), 0 2px 10px rgba(0,0,0,0.2), inset 0 1px 0 rgba(255,255,255,0.18); }',
    '  50%       { box-shadow: 0 10px 40px rgba(220,20,20,0.68), 0 4px 12px rgba(0,0,0,0.22), inset 0 1px 0 rgba(255,255,255,0.22); }',
    '}',
    '#wype-sticky-cta {',
    '  position: fixed;',
    '  bottom: 28px;',
    '  right: 28px;',
    '  z-index: 8000;',
    '  display: flex;',
    '  align-items: center;',
    '  gap: 10px;',
    '  background: linear-gradient(135deg, #f42424 0%, #b80e0e 100%);',
    '  color: #fff;',
    '  border: none;',
    '  border-radius: 100px;',
    '  padding: 16px 30px;',
    '  font-family: "Rajdhani", "Inter", sans-serif;',
    '  font-size: 15px;',
    '  font-weight: 700;',
    '  letter-spacing: 1.8px;',
    '  text-transform: uppercase;',
    '  cursor: pointer;',
    '  box-shadow: 0 8px 32px rgba(220,20,20,0.48), 0 2px 10px rgba(0,0,0,0.2), inset 0 1px 0 rgba(255,255,255,0.18);',
    '  transform: translateY(90px);',
    '  opacity: 0;',
    '  transition: transform 0.38s cubic-bezier(0.4,0,0.2,1), opacity 0.38s ease, box-shadow 0.25s ease;',
    '  text-decoration: none;',
    '  white-space: nowrap;',
    '  pointer-events: none;',
    '  overflow: hidden;',
    '}',
    '#wype-sticky-cta::before {',
    '  content: "";',
    '  position: absolute;',
    '  top: 0; bottom: 0;',
    '  left: 0;',
    '  width: 36px;',
    '  background: rgba(255,255,255,0.22);',
    '  filter: blur(8px);',
    '  border-radius: 50%;',
    '  animation: wype-shimmer 3.8s ease-in-out infinite;',
    '  pointer-events: none;',
    '}',
    '#wype-sticky-cta.visible {',
    '  transform: translateY(0);',
    '  opacity: 1;',
    '  pointer-events: auto;',
    '  animation: wype-glow-pulse 3s ease-in-out infinite;',
    '}',
    '#wype-sticky-cta:hover {',
    '  background: linear-gradient(135deg, #ff3030 0%, #c81212 100%);',
    '  box-shadow: 0 12px 44px rgba(220,20,20,0.7), 0 4px 14px rgba(0,0,0,0.25), inset 0 1px 0 rgba(255,255,255,0.25);',
    '  transform: translateY(-3px);',
    '  animation: none;',
    '}',
    '#wype-sticky-cta:active {',
    '  background: linear-gradient(135deg, #d41414 0%, #9e0a0a 100%);',
    '  transform: scale(0.96);',
    '  box-shadow: 0 4px 18px rgba(220,20,20,0.4), 0 1px 6px rgba(0,0,0,0.18), inset 0 1px 0 rgba(255,255,255,0.1);',
    '  animation: none;',
    '}',
    '#wype-sticky-cta svg { flex-shrink: 0; filter: drop-shadow(0 1px 2px rgba(0,0,0,0.2)); }',
    '#wype-sticky-cta .wype-cta-arrow {',
    '  font-style: normal;',
    '  opacity: 0.75;',
    '  font-size: 17px;',
    '  transition: transform 0.2s ease;',
    '}',
    '#wype-sticky-cta:hover .wype-cta-arrow { transform: translateX(3px); opacity: 1; }',
    '@media (max-width: 600px) {',
    '  #wype-sticky-cta {',
    '    bottom: max(18px, calc(env(safe-area-inset-bottom, 0px) + 10px));',
    '    right: 14px;',
    '    left: 14px;',
    '    border-radius: 20px;',
    '    justify-content: center;',
    '    font-size: 16px;',
    '    letter-spacing: 2px;',
    '    padding: 19px 20px;',
    '    gap: 12px;',
    '    box-shadow: 0 10px 36px rgba(220,20,20,0.55), 0 2px 10px rgba(0,0,0,0.28), inset 0 1px 0 rgba(255,255,255,0.18);',
    '  }',
    '  #wype-sticky-cta svg { width: 20px; height: 20px; }',
    '}',
  ].join('\n');
  document.head.appendChild(style);

  var btn = document.createElement('button');
  btn.id = 'wype-sticky-cta';
  btn.setAttribute('aria-label', 'Order now');
  btn.innerHTML =
    '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">' +
      '<circle cx="9" cy="21" r="1"/><circle cx="20" cy="21" r="1"/>' +
      '<path d="M1 1h4l2.68 13.39a2 2 0 0 0 2 1.61h9.72a2 2 0 0 0 2-1.61L23 6H6"/>' +
    '</svg>' +
    'Order Now' +
    '<i class="wype-cta-arrow">→</i>';

  btn.addEventListener('click', function () {
    if (typeof openCheckout === 'function') {
      openCheckout();
    } else if (typeof Cart !== 'undefined' && typeof Cart.open === 'function') {
      Cart.open();
    } else {
      window.location.href = '/checkout.html';
    }
  });

  function inject() {
    document.body.appendChild(btn);
    updateVisibility();
    window.addEventListener('scroll', updateVisibility, { passive: true });
  }

  function updateVisibility() {
    var scrollY  = window.scrollY || window.pageYOffset;
    var footer   = document.querySelector('footer') || document.querySelector('.footer') || document.querySelector('[class*="footer"]');
    var nearBot  = false;
    if (footer) {
      var rect = footer.getBoundingClientRect();
      nearBot  = rect.top < window.innerHeight + HIDE_NEAR_FOOTER;
    }
    var show = scrollY > SHOW_AFTER && !nearBot;
    btn.classList.toggle('visible', show);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', inject);
  } else {
    inject();
  }
})();
