/* ==========================================================================
   Wype footer wave — red ribbon marquee riding a wave, page colour above,
   black below, merging into the footer. Injected before <footer class="footer">
   on every page (removed the inline copy from index.html).
   ========================================================================== */
(function () {
  function build() {
    var footer = document.querySelector('footer.footer');
    if (!footer || document.getElementById('footWave')) return;
    var s = document.createElement('section');
    s.id = 'footWave'; s.setAttribute('aria-hidden', 'true');
    s.style.cssText = 'position:relative;overflow:hidden;height:210px;background:transparent;margin:0 0 -1px;padding:0;';
    var txt = 'NANO WYPE+™  ✦  MICRO WYPE+™  ✦  FREE UK DELIVERY  ✦  TRIED BY 1,000+ PEOPLE  ✦  RATED EXCELLENT ON TRUSTPILOT  ✦  ';
    s.innerHTML = ''
      + '<svg viewBox="0 0 2000 210" preserveAspectRatio="xMidYMid slice" xmlns="http://www.w3.org/2000/svg" style="position:absolute;top:0;left:0;width:100%;height:100%;display:block;">'
      + '<defs><path id="wypeWavePath" d="M-140,105 C 120,22 400,188 660,105 C 920,22 1200,188 1460,105 C 1720,22 1990,188 2260,105" fill="none"/></defs>'
      + '<path d="M-140,105 C 120,22 400,188 660,105 C 920,22 1200,188 1460,105 C 1720,22 1990,188 2260,105 L2260,210 L-140,210 Z" fill="#000000"/>'
      + '<use href="#wypeWavePath" stroke="#d80000" stroke-width="68" fill="none"/>'
      + '<text dominant-baseline="middle" style="font-family:Nunito,sans-serif;font-weight:900;font-size:23px;letter-spacing:3.5px;fill:#fff;">'
      + '<textPath id="wypeWaveText" href="#wypeWavePath" startOffset="0">' + txt + txt + txt + txt + '</textPath></text></svg>';
    footer.insertAdjacentElement('beforebegin', s);
    /* Match the colour of whatever sits above so there is no stripe between it and the wave. */
    function sync() {
      var prev = s.previousElementSibling, bg = '';
      while (prev) {
        var c = getComputedStyle(prev).backgroundColor;
        if (c && c !== 'transparent' && !/rgba\(\s*\d+,\s*\d+,\s*\d+,\s*0\)/.test(c)) { bg = c; break; }
        prev = prev.previousElementSibling;
      }
      s.style.background = bg || getComputedStyle(document.body).backgroundColor || 'transparent';
    }
    sync(); window.addEventListener('load', sync); setTimeout(sync, 1500);
    new MutationObserver(sync).observe(s.parentNode, { childList: true });
    var tp = document.getElementById('wypeWaveText');
    if (!tp || !tp.getComputedTextLength) return;
    var unit = 0, offset = 0;
    try { unit = tp.getComputedTextLength() / 4; } catch (e) { unit = 0; }
    var reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduced || !unit) return;
    (function tick() { offset -= 0.55; if (offset <= -unit) offset += unit; tp.setAttribute('startOffset', offset); requestAnimationFrame(tick); })();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', build); else build();
})();
