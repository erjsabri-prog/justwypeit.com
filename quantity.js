/* ==========================================================================
   Wype quantity stepper — vanilla port of the Quantity{Decrease,Value,Increase}
   React component: spring scale on hover/tap, disabled at min/max, and the
   number slides up/down when it changes. Upgrades every stepper on the site:
   cart drawer (.wd-*), checkout (.co-qty-*), homepage quick order (.qo__*).
   WypeQty.bump(valueEl, newValue)  — animate a value change
   WypeQty.enhance(root)            — (re)apply to newly rendered steppers
   ========================================================================== */
(function () {
  var CSS = ''
    + '.qty-spring{transition:transform .28s cubic-bezier(.34,1.56,.64,1),background .15s,color .15s!important;will-change:transform}'
    + '.qty-spring:hover:not(:disabled){transform:scale(1.08)}'
    + '.qty-spring:active:not(:disabled){transform:scale(.92)}'
    + '.qty-spring:disabled{opacity:.4;cursor:not-allowed}'
    + '.qty-val{position:relative;overflow:hidden;font-variant-numeric:tabular-nums}'
    + '.qty-val>span{display:inline-block}'
    + '@keyframes qtyIn{from{transform:translateY(7px);opacity:0}to{transform:none;opacity:1}}'
    + '@keyframes qtyOut{to{transform:translateY(-7px);opacity:0}}'
    + '.qty-val--in>span{animation:qtyIn .16s ease-out}'
    + '@media (prefers-reduced-motion:reduce){.qty-spring{transition:none}.qty-val--in>span{animation:none}}';
  var s = document.createElement('style'); s.textContent = CSS; document.head.appendChild(s);

  var BTN = '.wd-qbtn,.co-qty-btn,.qo__qb';
  var VAL = '.wd-qnum,.co-qty-num,.qo__qn';
  var lastChange = null;                         // { id, at } set by Cart.updateQty wrapper

  function wrap(v) {
    if (!v.querySelector('span')) { var sp = document.createElement('span'); sp.textContent = v.textContent; v.textContent = ''; v.appendChild(sp); }
    return v.querySelector('span');
  }
  function bump(el, value) {
    if (!el) return;
    var sp = wrap(el);
    if (String(value) === sp.textContent) return;
    sp.style.animation = 'qtyOut .15s ease-out forwards';
    setTimeout(function () { sp.textContent = value; sp.style.animation = 'qtyIn .16s ease-out'; }, 150);
  }
  function itemIdFor(v) {                        // which cart line does this value belong to?
    var row = v.parentElement; if (!row) return null;
    var b = row.querySelector('[data-id]'); if (b) return b.getAttribute('data-id');
    b = row.querySelector('button[onclick]'); if (!b) return null;
    var m = /updateQty\('([^']+)'/.exec(b.getAttribute('onclick')); return m ? m[1] : null;
  }
  function enhance(root) {
    root = root && root.querySelectorAll ? root : document;
    root.querySelectorAll(BTN).forEach(function (b) { b.classList.add('qty-spring'); });
    root.querySelectorAll(VAL).forEach(function (v) {
      if (v.classList.contains('qty-val')) return;
      v.classList.add('qty-val'); wrap(v);
      if (lastChange && Date.now() - lastChange.at < 600 && itemIdFor(v) === lastChange.id) {
        v.classList.add('qty-val--in'); setTimeout(function () { v.classList.remove('qty-val--in'); }, 200);
      }
    });
  }
  function hookCart() {
    var C = window.Cart; if (!C || C.__qtyHooked) return;
    C.__qtyHooked = true;
    var orig = C.updateQty;
    C.updateQty = function (id, delta) { lastChange = { id: id, at: Date.now() }; return orig.apply(C, arguments); };
  }
  function start() {
    hookCart(); enhance(document);
    new MutationObserver(function (muts) {
      muts.forEach(function (m) { m.addedNodes.forEach(function (n) { if (n.nodeType === 1) enhance(n); }); });
    }).observe(document.body, { childList: true, subtree: true });
  }
  window.WypeQty = { bump: bump, enhance: enhance };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
