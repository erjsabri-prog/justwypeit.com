/* ── wype® Marketplace — shared client helpers ── */
(function () {
  'use strict';

  var MP = window.MP = {};

  /* ── Auth (shares the main site's account tokens) ── */
  MP.token = function () { return localStorage.getItem('wype_token'); };
  MP.user  = function () { try { return JSON.parse(localStorage.getItem('wype_user')); } catch (e) { return null; } };
  MP.setAuth = function (token, user) { localStorage.setItem('wype_token', token); localStorage.setItem('wype_user', JSON.stringify(user)); };
  MP.logout  = function () { localStorage.removeItem('wype_token'); localStorage.removeItem('wype_user'); };

  MP.api = function (url, opts) {
    opts = opts || {};
    var headers = Object.assign({}, opts.headers || {});
    if (opts.body && typeof opts.body !== 'string') { opts.body = JSON.stringify(opts.body); headers['Content-Type'] = 'application/json'; }
    var t = MP.token();
    if (t && opts.auth !== false) headers['Authorization'] = 'Bearer ' + t;
    return fetch(url, Object.assign({}, opts, { headers: headers })).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (d) {
        if (!r.ok) { var e = new Error(d.error || ('HTTP ' + r.status)); e.status = r.status; e.data = d; throw e; }
        return d;
      });
    });
  };

  /* ── Formatting ── */
  MP.money = function (n) { return '£' + Number(n || 0).toFixed(2); };
  MP.esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
  MP.date = function (d, withTime) {
    if (!d) return '—';
    var x = new Date(d);
    var o = { day: 'numeric', month: 'short', year: 'numeric' };
    if (withTime) { o.hour = '2-digit'; o.minute = '2-digit'; }
    return x.toLocaleDateString('en-GB', o);
  };
  MP.stars = function (r) {
    if (r == null) return '<span class="muted small">No ratings yet</span>';
    var n = Math.round(r), s = '';
    for (var i = 1; i <= 5; i++) s += i <= n ? '★' : '☆';
    return '<span class="stars">' + s + '</span> <span class="small muted">' + Number(r).toFixed(1) + '</span>';
  };
  MP.qs = function (k) { return new URLSearchParams(location.search).get(k); };
  MP.placeholder = 'data:image/svg+xml;utf8,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="400" height="400"><rect width="400" height="400" fill="#f0f0f0"/><text x="200" y="210" text-anchor="middle" font-family="Arial" font-size="18" fill="#bbb">No photo</text></svg>');

  /* ── Toast ── */
  var toastEl;
  MP.toast = function (msg, isErr) {
    if (!toastEl) { toastEl = document.createElement('div'); toastEl.className = 'toast'; document.body.appendChild(toastEl); }
    toastEl.textContent = msg; toastEl.className = 'toast show' + (isErr ? ' err' : '');
    clearTimeout(toastEl._t); toastEl._t = setTimeout(function () { toastEl.className = 'toast'; }, 3200);
  };

  /* ── Header / footer ── */
  MP.renderHeader = function (opts) {
    opts = opts || {};
    var el = document.getElementById('mpHeader'); if (!el) return;
    var u = MP.user();
    var q = MP.esc(MP.qs('q') || '');
    el.className = 'mp-header';
    el.innerHTML =
      '<div class="mp-backbar"><div class="mp-wrap">' +
        '<a href="/">← Back to justwypeit.com</a><a href="/marketplace">Marketplace home</a><a href="/marketplace/order">Track a marketplace order</a><a href="/seller-hub" style="margin-left:auto">Seller Hub</a>' +
      '</div></div>' +
      '<div class="mp-wrap"><div class="mp-header__row">' +
        '<a class="mp-logo" href="/marketplace"><img src="/assets/wype-logo-black.png" alt="wype"><span>Marketplace</span></a>' +
        '<form class="mp-search" action="/marketplace" method="get">' +
          '<input type="search" name="q" placeholder="Search car care, detailing, parts…" value="' + q + '" aria-label="Search">' +
          '<select name="category" id="mpHeaderCat"><option value="">All categories</option></select>' +
          '<button type="submit">Search</button>' +
        '</form>' +
        '<div class="mp-header__links">' +
          (u ? '<a href="/account.html" class="keep">Hi, ' + MP.esc(u.firstName || 'there') + '</a>' : '<a href="/seller-hub" class="keep">Sign in</a>') +
          '<a href="/seller-hub" class="sell">Sell</a>' +
        '</div>' +
      '</div>' +
      (opts.cats === false ? '' : '<nav class="mp-cats" id="mpCats"></nav>') +
      '</div>';
    MP.meta().then(function (m) {
      var sel = document.getElementById('mpHeaderCat'), cur = MP.qs('category') || '';
      if (sel) m.categories.forEach(function (c) { var o = document.createElement('option'); o.value = c.id; o.textContent = c.label; if (c.id === cur) o.selected = true; sel.appendChild(o); });
      var nav = document.getElementById('mpCats');
      if (nav) nav.innerHTML = '<a href="/marketplace" class="' + (!cur && opts.catsHighlight !== false ? 'on' : '') + '">All</a>' +
        m.categories.map(function (c) { return '<a href="/marketplace?category=' + c.id + '" class="' + (c.id === cur ? 'on' : '') + '">' + MP.esc(c.label) + '</a>'; }).join('');
    }).catch(function () {});
  };

  MP.renderFooter = function () {
    var el = document.getElementById('mpFooter'); if (!el) return;
    el.className = 'mp-footer';
    el.innerHTML = '<div class="mp-wrap">' +
      '<div class="brand"><img src="/assets/wype-logo-white.png" alt="wype"><p>The wype® Marketplace lets independent sellers list car-care and detailing products. Every payment is processed securely by wype® and sellers are only paid once you confirm your order arrived.</p></div>' +
      '<div><h4>Buy</h4><a href="/marketplace">Browse listings</a><a href="/marketplace/order">Track an order</a><a href="/faq.html">Buyer protection & FAQ</a></div>' +
      '<div><h4>Sell</h4><a href="/seller-hub">Seller Hub</a><a href="/seller-hub?view=payouts">Fees & payouts</a><a href="/terms.html">Seller terms</a></div>' +
      '<div><h4>wype®</h4><a href="/">Shop wype® towels</a><a href="/about.html">Our story</a><a href="mailto:customer@justwypeit.com">customer@justwypeit.com</a></div>' +
      '</div>';
  };

  var metaCache;
  MP.meta = function () {
    if (!metaCache) metaCache = MP.api('/api/mp/meta', { auth: false }).catch(function () { metaCache = null; return { categories: [], conditions: {}, shipsTo: {}, commissionPct: 10 }; });
    return metaCache;
  };

  /* ── Listing card ── */
  MP.listingCard = function (l) {
    var s = l.seller || {};
    var ship = l.shippingPrice > 0 ? '+ ' + MP.money(l.shippingPrice) + ' postage' : 'Free postage';
    return '<a class="lcard" href="/marketplace/listing/' + l.id + '">' +
      '<div class="lcard__img"><img src="' + (l.image || MP.placeholder) + '" alt="' + MP.esc(l.title) + '" loading="lazy"></div>' +
      (l.condition === 'new' ? '<span class="pill pill--dark lcard__badge">New</span>' : '') +
      '<div class="lcard__body">' +
        '<div class="lcard__title">' + MP.esc(l.title) + '</div>' +
        '<div class="lcard__cond">' + MP.esc(l.conditionLabel || '') + (l.brand ? ' · ' + MP.esc(l.brand) : '') + '</div>' +
        '<div class="lcard__price">' + MP.money(l.price) + '</div>' +
        '<div class="lcard__ship" style="' + (l.shippingPrice > 0 ? 'color:var(--muted)' : '') + '">' + ship + '</div>' +
        '<div class="lcard__seller">' + (s.logoUrl ? '<img src="' + s.logoUrl + '" style="width:18px;height:18px;border-radius:50%;object-fit:cover">' : '') + MP.esc(s.shopName || '') + (s.rating != null ? ' · <span class="stars">★</span> ' + Number(s.rating).toFixed(1) : '') + '</div>' +
      '</div></a>';
  };

  /* ── Client-side image compression → data URL ── */
  MP.compressImage = function (file, maxPx, quality) {
    maxPx = maxPx || 1400; quality = quality || 0.82;
    return new Promise(function (resolve, reject) {
      if (!/^image\//.test(file.type)) return reject(new Error('Not an image'));
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () {
        var w = img.naturalWidth, h = img.naturalHeight, scale = Math.min(1, maxPx / Math.max(w, h));
        var c = document.createElement('canvas'); c.width = Math.round(w * scale); c.height = Math.round(h * scale);
        var ctx = c.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height); ctx.drawImage(img, 0, 0, c.width, c.height);
        URL.revokeObjectURL(url);
        resolve(c.toDataURL('image/jpeg', quality));
      };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('Could not read image')); };
      img.src = url;
    });
  };

  /* ── Modal helper ── */
  MP.modal = function (id, open) {
    var m = document.getElementById(id); if (!m) return;
    m.classList.toggle('open', open !== false);
    document.body.style.overflow = open !== false ? 'hidden' : '';
  };
  document.addEventListener('click', function (e) {
    if (e.target.classList && e.target.classList.contains('modal-bg')) { e.target.classList.remove('open'); document.body.style.overflow = ''; }
  });
})();
