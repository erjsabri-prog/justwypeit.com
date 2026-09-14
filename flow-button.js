/* ==========================================================================
   Wype flow buttons — CSS/JS port of the "FlowButton" React component.
   Outline pill; on hover a dark circle grows from the centre, text turns
   white, corners square to 12px, the right arrow slides out and a left arrow
   slides in. Applied to secondary/outline CTAs (see TARGETS). Dark surfaces
   set --fb-ink/--fb-paper to invert.
   ========================================================================== */
(function () {
  var TARGETS = '.btn--outline, .btn--ghost, .prc__more, .qo__add, .btn-outline-white, .ac-order-toggle, .awg-section__more';
  var ARROW = '<svg class="fb__arr" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14"/><path d="m12 5 7 7-7 7"/></svg>';
  var CSS = ''
    + '.fb{--fb-ink:#111;--fb-paper:#fff;position:relative;display:inline-flex!important;align-items:center;justify-content:center;gap:4px;overflow:hidden;'
    + 'border-radius:100px!important;border:1.5px solid rgba(51,51,51,.4)!important;background:transparent!important;color:var(--fb-ink)!important;'
    + 'cursor:pointer;transition:all .6s cubic-bezier(.23,1,.32,1)!important;transform:none}'
    + '.btn-outline-white.fb,.s-dark-cta .fb,.footer .fb,.hero .fb,.rvx .fb,.wype-cap .fb,.product-card--hero[style*="#111"] .fb{--fb-ink:#fff;--fb-paper:#111;border-color:rgba(255,255,255,.4)!important}'
    + '.fb:hover{border-color:transparent!important;color:var(--fb-paper)!important;border-radius:12px!important;background:transparent!important;transform:none}'
    + '.fb:active{transform:scale(.95)!important}'
    + '.fb__t{position:relative;z-index:1;transform:translateX(-12px);transition:transform .8s ease-out;display:inline-flex;align-items:center;gap:6px}'
    + '.fb:hover .fb__t{transform:translateX(12px)}'
    + '.fb__arr{position:absolute;top:50%;width:16px;height:16px;margin-top:-8px;z-index:9;color:var(--fb-ink);transition:all .8s cubic-bezier(.34,1.56,.64,1);pointer-events:none}'
    + '.fb__arr--l{left:-25%}.fb:hover .fb__arr--l{left:16px;color:var(--fb-paper)}'
    + '.fb__arr--r{right:16px}.fb:hover .fb__arr--r{right:-25%;color:var(--fb-paper)}'
    + '.fb__circle{position:absolute;top:50%;left:50%;width:16px;height:16px;margin:-8px 0 0 -8px;border-radius:50%;background:var(--fb-ink);opacity:0;transition:all .8s cubic-bezier(.19,1,.22,1);pointer-events:none;z-index:0}'
    + '.fb:hover .fb__circle{width:520px;height:520px;margin:-260px 0 0 -260px;opacity:1}'
    + '.fb.fb--wide .fb__t{transform:none}.fb.fb--wide:hover .fb__t{transform:translateX(10px)}'
    + '@media (prefers-reduced-motion:reduce){.fb,.fb__t,.fb__arr,.fb__circle{transition:none!important}}';
  var st = document.createElement('style'); st.id = 'fb-css'; st.textContent = CSS; document.head.appendChild(st);

  function enhance(root) {
    root = root && root.querySelectorAll ? root : document;
    var els = Array.prototype.slice.call(root.querySelectorAll(TARGETS));
    if (root.matches && root.matches(TARGETS)) els.push(root);
    els.forEach(function (b) {
      if (b.classList.contains('fb') || b.classList.contains('lm') || b.closest('#checkoutRoot')) return;
      var t = document.createElement('span'); t.className = 'fb__t';
      while (b.firstChild) t.appendChild(b.firstChild);
      b.appendChild(t);
      b.insertAdjacentHTML('afterbegin', ARROW.replace('fb__arr', 'fb__arr fb__arr--l'));
      b.insertAdjacentHTML('beforeend', '<span class="fb__circle"></span>' + ARROW.replace('fb__arr', 'fb__arr fb__arr--r'));
      b.classList.add('fb');
      if (b.offsetWidth > 260) b.classList.add('fb--wide');
    });
  }
  function start() {
    enhance(document);
    new MutationObserver(function (muts) {
      muts.forEach(function (m) { m.addedNodes.forEach(function (n) { if (n.nodeType === 1) enhance(n); }); });
    }).observe(document.body, { childList: true, subtree: true });
  }
  window.WypeFlowButton = { enhance: enhance };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
