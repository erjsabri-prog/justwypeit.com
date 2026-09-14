/* ==========================================================================
   Wype liquid-metal buttons — CSS/JS port of the "LiquidMetalButton" React
   component (WebGL shader replaced with an animated chrome conic ring).
   Upgrades every primary CTA on the page (see TARGETS) and anything injected
   later (cart drawer, popups). Click = ripple; hover = faster shimmer + lift;
   press = sinks in.
   ========================================================================== */
(function () {
  var TARGETS = '.btn--primary, .btn--white, .tl__cta, .prc__add, .qo__checkout, .fk-cta, .btn-white, .wd-cta, .track-search__btn, .ac-btn, .awg-section__cta, .hero__cta, .sticky-cta__btn, .wype-exit__btn, .wype-cap__btn, .footer__newsletter-btn, .nl-btn';
  var CSS = ''
    + '@property --lm-a{syntax:"<angle>";inherits:false;initial-value:0deg}'
    + '.lm{position:relative;isolation:isolate;overflow:hidden;border-radius:100px!important;border:2px solid transparent!important;'
    + 'background:linear-gradient(180deg,#232323 0%,#000 100%) padding-box,conic-gradient(from var(--lm-a),#8f8f8f,#ffffff 12%,#5a5a5a 26%,#f4f4f4 40%,#3f3f3f 55%,#dcdcdc 68%,#7a7a7a 82%,#ffffff 92%,#8f8f8f) border-box!important;'
    + 'color:#e8e8e8!important;text-shadow:0 1px 2px rgba(0,0,0,.6);'
    + 'box-shadow:0 0 0 1px rgba(0,0,0,.3),0 36px 14px rgba(0,0,0,.02),0 20px 12px rgba(0,0,0,.08),0 9px 9px rgba(0,0,0,.12),0 2px 5px rgba(0,0,0,.15)!important;'
    + 'animation:lmSpin 3.2s linear infinite;transition:transform .8s cubic-bezier(.34,1.56,.64,1),box-shadow .15s cubic-bezier(.4,0,.2,1)!important;transform:none;cursor:pointer}'
    + '.lm::after{content:"";position:absolute;inset:0;border-radius:inherit;background:linear-gradient(180deg,rgba(255,255,255,.14),rgba(255,255,255,0) 45%);pointer-events:none}'
    + '.lm:hover{animation-duration:1.6s;transform:translateY(-1px);'
    + 'box-shadow:0 0 0 1px rgba(0,0,0,.4),0 12px 6px rgba(0,0,0,.05),0 8px 5px rgba(0,0,0,.1),0 4px 4px rgba(0,0,0,.15),0 1px 2px rgba(0,0,0,.2)!important;'
    + 'background:linear-gradient(180deg,#2a2a2a 0%,#050505 100%) padding-box,conic-gradient(from var(--lm-a),#8f8f8f,#ffffff 12%,#5a5a5a 26%,#f4f4f4 40%,#3f3f3f 55%,#dcdcdc 68%,#7a7a7a 82%,#ffffff 92%,#8f8f8f) border-box!important;color:#fff!important}'
    + '.lm:active,.lm.is-pressed{animation-duration:.6s;transform:translateY(1px) scale(.98)!important;'
    + 'box-shadow:0 0 0 1px rgba(0,0,0,.5),0 1px 2px rgba(0,0,0,.3),inset 0 2px 4px rgba(0,0,0,.5),inset 0 1px 2px rgba(0,0,0,.35)!important}'
    + '.lm:focus-visible{outline:2px solid #fff;outline-offset:3px}'
    + '.lm .lm__ripple{position:absolute;width:20px;height:20px;border-radius:50%;background:radial-gradient(circle,rgba(255,255,255,.45) 0%,rgba(255,255,255,0) 70%);pointer-events:none;transform:translate(-50%,-50%) scale(0);animation:lmRipple .6s ease-out forwards;z-index:2}'
    + '@keyframes lmSpin{to{--lm-a:360deg}}'
    + '@keyframes lmRipple{0%{transform:translate(-50%,-50%) scale(0);opacity:.6}100%{transform:translate(-50%,-50%) scale(6);opacity:0}}'
    + '@media (prefers-reduced-motion:reduce){.lm{animation:none}.lm .lm__ripple{animation:none;display:none}}';
  var st = document.createElement('style'); st.id = 'lm-css'; st.textContent = CSS; document.head.appendChild(st);

  function ripple(e) {
    var b = e.currentTarget, r = b.getBoundingClientRect();
    var s = document.createElement('span'); s.className = 'lm__ripple';
    s.style.left = (e.clientX - r.left) + 'px'; s.style.top = (e.clientY - r.top) + 'px';
    b.appendChild(s); setTimeout(function () { s.remove(); }, 650);
  }
  function enhance(root) {
    root = root && root.querySelectorAll ? root : document;
    var els = root.querySelectorAll(TARGETS);
    for (var i = 0; i < els.length; i++) {
      var b = els[i];
      if (b.classList.contains('lm') || b.closest('#checkoutRoot')) continue;
      b.classList.add('lm');
      b.addEventListener('pointerdown', ripple);
    }
    if (root.matches && root.matches(TARGETS) && !root.classList.contains('lm')) { root.classList.add('lm'); root.addEventListener('pointerdown', ripple); }
  }
  function start() {
    enhance(document);
    new MutationObserver(function (muts) {
      muts.forEach(function (m) { m.addedNodes.forEach(function (n) { if (n.nodeType === 1) enhance(n); }); });
    }).observe(document.body, { childList: true, subtree: true });
  }
  window.WypeLiquidButton = { enhance: enhance };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
