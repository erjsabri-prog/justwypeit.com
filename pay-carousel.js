/* ==========================================================================
   Wype payment-logo carousel — vanilla port of the "LogoCarousel" React
   component. Replaces the static .pay-box-grid in the footer with columns
   that cycle through the payment methods we accept (spring in, blur out).
   ========================================================================== */
(function () {
  var W = '#fff';
  var LOGOS = [
    { name: 'Visa', svg: '<svg viewBox="0 0 120 40"><text x="60" y="30" text-anchor="middle" font-family="Arial,Helvetica,sans-serif" font-weight="900" font-style="italic" font-size="34" letter-spacing="2" fill="' + W + '">VISA</text></svg>' },
    { name: 'Mastercard', svg: '<svg viewBox="0 0 120 40"><circle cx="48" cy="20" r="16" fill="#EB001B"/><circle cx="72" cy="20" r="16" fill="#F79E1B"/><path d="M60 8.4a16 16 0 0 1 0 23.2 16 16 0 0 1 0-23.2z" fill="#FF5F00"/></svg>' },
    { name: 'American Express', svg: '<svg viewBox="0 0 120 40"><rect x="10" y="4" width="100" height="32" rx="4" fill="#2E77BC"/><text x="60" y="26" text-anchor="middle" font-family="Arial,Helvetica,sans-serif" font-weight="900" font-size="15" letter-spacing="1.5" fill="#fff">AMEX</text></svg>' },
    { name: 'Apple Pay', svg: '<svg viewBox="0 0 120 40"><g transform="translate(24,7) scale(1.7)"><path fill="' + W + '" d="M11.1 7.4c0-1.7 1.4-2.5 1.5-2.6-.8-1.2-2.1-1.4-2.6-1.4-1.1-.1-2.1.6-2.7.6-.6 0-1.5-.6-2.4-.6C3.6 3.4 2 4.5 2 7c0 1.5.6 3.1 1.3 4.2.7 1 1.3 1.8 2.2 1.8.9 0 1.2-.6 2.3-.6 1.1 0 1.4.6 2.3.6.9 0 1.6-.9 2.2-1.9.4-.7.6-1.3.7-1.4C12.9 9.6 11.1 8.9 11.1 7.4zM9.3 2.3C10 1.5 10.3.5 10.2 0 9.3.1 8.2.6 7.5 1.4c-.7.7-1.1 1.7-1 2.6C7.5 4 8.5 3.5 9.3 2.3z"/></g><text x="52" y="29" font-family="-apple-system,\'Helvetica Neue\',Arial,sans-serif" font-size="24" font-weight="600" fill="' + W + '">Pay</text></svg>' },
    { name: 'Google Pay', svg: '<svg viewBox="0 0 120 40"><g transform="translate(22,8) scale(1.1)"><path d="M21.8 10.2c0-.8-.1-1.5-.2-2.2H11.1v4.2h6a5.1 5.1 0 0 1-2.2 3.4v2.8h3.6c2.1-1.9 3.3-4.8 3.3-8.2z" fill="#4285F4"/><path d="M11.1 21.1c3 0 5.5-1 7.4-2.7l-3.6-2.8c-1 .7-2.3 1.1-3.8 1.1-2.9 0-5.4-2-6.2-4.6H1.2v2.9a11.1 11.1 0 0 0 9.9 6.1z" fill="#34A853"/><path d="M4.9 12.1a6.7 6.7 0 0 1 0-4.2V5H1.2a11.1 11.1 0 0 0 0 10z" fill="#FBBC04"/><path d="M11.1 3.3c1.6 0 3.1.6 4.2 1.7l3.2-3.2A11 11 0 0 0 11.1-1.2 11.1 11.1 0 0 0 1.2 5l3.7 2.9c.8-2.6 3.3-4.6 6.2-4.6z" fill="#EA4335"/></g><text x="52" y="29" font-family="Arial,Helvetica,sans-serif" font-size="24" font-weight="500" fill="' + W + '">Pay</text></svg>' },
    { name: 'PayPal', svg: '<svg viewBox="0 0 120 40"><text x="26" y="30" font-family="Arial,Helvetica,sans-serif" font-size="28" font-weight="800" font-style="italic" fill="#8fbcf0">Pay</text><text x="66" y="30" font-family="Arial,Helvetica,sans-serif" font-size="28" font-weight="800" font-style="italic" fill="#3fb5ff">Pal</text></svg>' },
    { name: 'Klarna', svg: '<svg viewBox="0 0 120 40"><rect x="14" y="4" width="92" height="32" rx="6" fill="#FFB3C7"/><text x="60" y="27" text-anchor="middle" font-family="Arial,Helvetica,sans-serif" font-size="19" font-weight="800" fill="#0B0B0B">Klarna.</text></svg>' },
    { name: 'Stripe', svg: '<svg viewBox="0 0 120 40"><text x="60" y="29" text-anchor="middle" font-family="Arial,Helvetica,sans-serif" font-size="27" font-weight="800" letter-spacing="-1" fill="#8b7bff">stripe</text></svg>' },
  ];
  var CSS = ''
    + '.plc{display:flex;justify-content:center;gap:16px;flex-wrap:wrap}'
    + '.plc__col{position:relative;height:56px;width:120px;overflow:hidden;opacity:0;transform:translateY(40px);animation:plcUp .5s ease-out forwards;animation-delay:calc(var(--i)*.1s)}'
    + '.plc__logo{position:absolute;inset:0;display:flex;align-items:center;justify-content:center}'
    + '.plc__logo svg{width:80%;height:70%;display:block}'
    + '.plc__logo--in{animation:plcIn .55s cubic-bezier(.34,1.35,.64,1) both}'
    + '.plc__logo--out{animation:plcOut .3s ease-in forwards}'
    + '.plc__sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}'
    + '@keyframes plcUp{to{opacity:1;transform:none}}'
    + '@keyframes plcIn{from{transform:translateY(10%);opacity:0;filter:blur(8px)}to{transform:none;opacity:1;filter:blur(0)}}'
    + '@keyframes plcOut{to{transform:translateY(-20%);opacity:0;filter:blur(6px)}}'
    + '@media (min-width:768px){.plc__col{height:72px;width:150px}}'
    + '@media (prefers-reduced-motion:reduce){.plc__col{animation:none;opacity:1;transform:none}.plc__logo--in,.plc__logo--out{animation:none}}';

  function shuffle(a) { a = a.slice(); for (var i = a.length - 1; i > 0; i--) { var j = Math.floor(Math.random() * (i + 1)); var t = a[i]; a[i] = a[j]; a[j] = t; } return a; }
  function distribute(logos, n) {
    var s = shuffle(logos), cols = []; for (var c = 0; c < n; c++) cols.push([]);
    s.forEach(function (l, i) { cols[i % n].push(l); });
    var max = Math.max.apply(null, cols.map(function (c) { return c.length; }));
    cols.forEach(function (c) { while (c.length < max) c.push(s[Math.floor(Math.random() * s.length)]); });
    return cols;
  }

  function build() {
    var grid = document.querySelector('.footer__payments .pay-box-grid');
    if (!grid || document.querySelector('.plc')) return;
    var st = document.createElement('style'); st.textContent = CSS; document.head.appendChild(st);
    var n = window.innerWidth < 600 ? 3 : 4;
    var cols = distribute(LOGOS, n);
    var wrap = document.createElement('div'); wrap.className = 'plc'; wrap.setAttribute('aria-label', 'Accepted payment methods');
    wrap.innerHTML = '<span class="plc__sr">We accept ' + LOGOS.map(function (l) { return l.name; }).join(', ') + '.</span>';
    var state = cols.map(function (logos, i) {
      var col = document.createElement('div'); col.className = 'plc__col'; col.style.setProperty('--i', i);
      var lg = document.createElement('div'); lg.className = 'plc__logo plc__logo--in'; lg.innerHTML = logos[0].svg; lg.setAttribute('title', logos[0].name);
      col.appendChild(lg); wrap.appendChild(col);
      return { logos: logos, col: col, cur: 0 };
    });
    grid.replaceWith(wrap);

    var CYCLE = 2000, start = performance.now(), reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduced) return;
    function tick() {
      var t = performance.now() - start;
      state.forEach(function (s, i) {
        var idx = Math.floor(((t + i * 200) % (CYCLE * s.logos.length)) / CYCLE);
        if (idx === s.cur) return;
        s.cur = idx;
        var old = s.col.querySelector('.plc__logo');
        if (old) { old.className = 'plc__logo plc__logo--out'; setTimeout(function () { old.remove(); }, 320); }
        var nw = document.createElement('div'); nw.className = 'plc__logo plc__logo--in'; nw.innerHTML = s.logos[idx].svg; nw.setAttribute('title', s.logos[idx].name);
        s.col.appendChild(nw);
      });
    }
    var timer = setInterval(tick, 100);
    document.addEventListener('visibilitychange', function () { if (document.hidden) { clearInterval(timer); timer = null; } else if (!timer) { timer = setInterval(tick, 100); } });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', build); else build();
})();
