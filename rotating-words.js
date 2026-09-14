/* ==========================================================================
   Wype rotating heading words — vanilla port of the "animated-hero" title
   swap. Any element with data-rotate="Word one.|Word two.|…" cycles its text
   every 2s: current word springs up and out, next springs in from below.
   ========================================================================== */
(function () {
  var CSS = ''
    + '.rw{position:relative;display:inline-block;vertical-align:top;overflow:hidden;white-space:nowrap;line-height:inherit;max-width:100%;text-align:left}'
    + '.rw__w{position:absolute;left:0;top:0;white-space:nowrap;opacity:0;transform:translateY(120%);transition:transform .9s cubic-bezier(.22,1.2,.36,1),opacity .45s ease}'
    + '.rw__w.is-in{opacity:1;transform:none}'
    + '.rw__w.is-out{opacity:0;transform:translateY(-120%)}'
    + '.rw__ghost{visibility:hidden;white-space:nowrap}'
    + '@media (prefers-reduced-motion:reduce){.rw__w{transition:none}}';
  var st = document.createElement('style'); st.textContent = CSS; document.head.appendChild(st);

  function build(el) {
    var words = (el.getAttribute('data-rotate') || '').split('|').map(function (w) { return w.trim(); }).filter(Boolean);
    if (words.length < 2) return;
    el.classList.add('rw'); el.setAttribute('aria-live', 'off');
    el.innerHTML = '';
    var widest = words.reduce(function (a, b) { return a.length >= b.length ? a : b; });
    var ghost = document.createElement('span'); ghost.className = 'rw__ghost'; ghost.textContent = widest; el.appendChild(ghost);
    var spans = words.map(function (w, i) {
      var s = document.createElement('span'); s.className = 'rw__w' + (i === 0 ? ' is-in' : ''); s.textContent = w; el.appendChild(s); return s;
    });
    // keep the box as wide as the longest word so the rest of the heading doesn't jump
    function fit() {
      ghost.textContent = widest;
      var max = el.parentElement ? el.parentElement.clientWidth : Infinity;
      if (ghost.offsetWidth > max) { el.style.whiteSpace = 'normal'; }
    }
    fit(); window.addEventListener('resize', fit);
    var i = 0;
    if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    setInterval(function () {
      var cur = spans[i]; i = (i + 1) % spans.length; var nxt = spans[i];
      cur.classList.remove('is-in'); cur.classList.add('is-out');
      nxt.classList.remove('is-out'); void nxt.offsetWidth; nxt.classList.add('is-in');
      setTimeout(function () { cur.classList.remove('is-out'); }, 950);
    }, 2000);
  }
  /* ---- character rotator (TextRotate port): red pill, letters stagger in from below, out through the top ---- */
  var CSS2 = ''
    + '.rwc{position:relative;display:inline-flex;align-items:center;vertical-align:-0.08em;overflow:hidden;background:#E01E1E;color:#fff!important;padding:.02em .38em .06em;border-radius:.32em;line-height:1.25;white-space:nowrap;transition:width .5s cubic-bezier(.22,1.2,.36,1);font-weight:800}'
    + '.rwc__box{position:relative;display:inline-block}'
    + '.rwc__w{display:inline-flex;white-space:pre}'
    + '.rwc__w--out{position:absolute;left:0;top:0}'
    + '.rwc__c{display:inline-block;transform:translateY(100%);opacity:0;transition:transform .55s cubic-bezier(.22,1.25,.36,1),opacity .25s}'
    + '.rwc__c.in{transform:none;opacity:1}'
    + '.rwc__c.out{transform:translateY(-120%);opacity:0}'
    + '.hero .rwc{background:#7e0024}'
    + '@media (prefers-reduced-motion:reduce){.rwc__c{transition:none}}';
  var st2 = document.createElement('style'); st2.textContent = CSS2; document.head.appendChild(st2);
  function chars(s) {
    if (typeof Intl !== 'undefined' && Intl.Segmenter) return Array.from(new Intl.Segmenter('en', { granularity: 'grapheme' }).segment(s), function (x) { return x.segment; });
    return Array.from(s);
  }
  function wordEl(word) {
    var w = document.createElement('span'); w.className = 'rwc__w';
    chars(word).forEach(function (c) { var s = document.createElement('span'); s.className = 'rwc__c'; s.textContent = c; w.appendChild(s); });
    return w;
  }
  function stagger(w, cls, fromLast) {
    var cs = w.querySelectorAll('.rwc__c'), n = cs.length;
    cs.forEach(function (c, i) { c.style.transitionDelay = ((fromLast ? (n - 1 - i) : i) * 25) + 'ms'; c.classList.remove('in', 'out'); void c.offsetWidth; c.classList.add(cls); });
  }
  function buildChars(el) {
    var words = (el.getAttribute('data-rotate-chars') || '').split('|').map(function (w) { return w.trim(); }).filter(Boolean);
    if (!words.length) return;
    el.classList.add('rwc'); el.setAttribute('aria-live', 'off');
    var sr = document.createElement('span'); sr.style.cssText = 'position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)'; sr.textContent = words[0];
    el.innerHTML = ''; el.appendChild(sr);
    var box = document.createElement('span'); box.className = 'rwc__box'; el.appendChild(box);
    var cur = wordEl(words[0]); box.appendChild(cur);
    var pad = 0;
    requestAnimationFrame(function () { pad = el.getBoundingClientRect().width - cur.getBoundingClientRect().width; el.style.width = (cur.getBoundingClientRect().width + pad) + 'px'; stagger(cur, 'in', true); });
    if (words.length < 2 || (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches)) return;
    var i = 0;
    setInterval(function () {
      i = (i + 1) % words.length;
      var nxt = wordEl(words[i]);
      cur.classList.add('rwc__w--out'); box.appendChild(nxt);
      el.style.width = (nxt.getBoundingClientRect().width + pad) + 'px';
      sr.textContent = words[i];
      stagger(cur, 'out', true);
      var old = cur; cur = nxt;
      requestAnimationFrame(function () { requestAnimationFrame(function () { stagger(nxt, 'in', true); }); });
      setTimeout(function () { old.remove(); }, 900);
    }, 2000);
  }
  function start() { document.querySelectorAll('[data-rotate]').forEach(build); document.querySelectorAll('[data-rotate-chars]').forEach(buildChars); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
