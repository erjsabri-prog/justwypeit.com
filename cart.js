/* ── Wype Basket System ── */
(function () {
  'use strict';

  var CART_KEY    = 'wype_cart';
  var SESSION_KEY = 'wype_checkout_cart';

  var CATALOG = {
    'nanowype': {
      id:    'nanowype',
      name:  'NanoWype+™',
      spec:  '1200 GSM · Nano Wave · 60×90 cm',
      thumb: 'assets/nano-porsche-bonnet.jpg',
      tiers: [
        { min: 1, max: 1,  price: 16.00 },
        { min: 2, max: 4,  price: 12.80 },
        { min: 5, max: 99, price: 11.20 },
      ],
    },
    'wype-plus': {
      id:    'wype-plus',
      name:  'MicroWype+™',
      spec:  '40×40 cm · Anti-snag · Pro Grade',
      thumb: 'assets/micro-911.jpg',
      tiers: [
        { min: 1, max: 1,  price: 12.80 },
        { min: 2, max: 4,  price: 10.24 },
        { min: 5, max: 99, price:  8.96 },
      ],
    },
  };

  function unitPrice(productId, qty) {
    var cat = CATALOG[productId];
    if (!cat) return 0;
    for (var i = 0; i < cat.tiers.length; i++) {
      var t = cat.tiers[i];
      if (qty >= t.min && qty <= t.max) return t.price;
    }
    return cat.tiers[cat.tiers.length - 1].price;
  }

  /* ─── Cart ─── */
  var Cart = window.Cart = {
    get: function () {
      try { return JSON.parse(localStorage.getItem(CART_KEY)) || []; } catch (e) { return []; }
    },
    save: function (items) {
      localStorage.setItem(CART_KEY, JSON.stringify(items));
      Cart._refresh();
    },
    add: function (productId, qty) {
      var items    = Cart.get();
      var existing = null;
      for (var i = 0; i < items.length; i++) { if (items[i].id === productId) { existing = items[i]; break; } }
      if (existing) { existing.qty += qty; } else { items.push({ id: productId, qty: qty }); }
      Cart.save(items);
      CartDrawer.open();
    },
    remove: function (productId) {
      Cart.save(Cart.get().filter(function (i) { return i.id !== productId; }));
    },
    updateQty: function (productId, delta) {
      var items = Cart.get();
      for (var i = 0; i < items.length; i++) {
        if (items[i].id === productId) {
          var nq = items[i].qty + delta;
          if (nq < 1) { Cart.remove(productId); return; }
          items[i].qty = nq;
          Cart.save(items);
          return;
        }
      }
    },
    clear: function () { localStorage.removeItem(CART_KEY); Cart._refresh(); },
    totalQty: function () { return Cart.get().reduce(function (s, i) { return s + i.qty; }, 0); },
    subtotal: function () {
      return Cart.get().reduce(function (s, i) { return s + unitPrice(i.id, i.qty) * i.qty; }, 0);
    },
    deliveryCost: function () { return Cart.totalQty() >= 2 ? 0 : 3.99; },
    total: function () { return +(Cart.subtotal() + Cart.deliveryCost()).toFixed(2); },
    _refresh: function () {
      var count = Cart.totalQty();
      var badges = document.querySelectorAll('.wype-cart-badge');
      for (var b = 0; b < badges.length; b++) {
        badges[b].textContent = count;
        badges[b].style.display = count > 0 ? 'flex' : 'none';
      }
      CartDrawer.render();
    },
  };

  /* ─── Drawer ─── */
  var CartDrawer = window.CartDrawer = {
    el:      null,
    overlay: null,

    init: function () {
      var style     = document.createElement('style');
      style.textContent = [
        '.wype-drawer-overlay{position:fixed;inset:0;background:rgba(0,0,0,.48);z-index:9000;opacity:0;pointer-events:none;transition:opacity .3s}',
        '.wype-drawer-overlay.wdo{opacity:1;pointer-events:auto}',
        '.wype-drawer{position:fixed;top:0;right:0;bottom:0;width:min(420px,100vw);background:#fff;z-index:9001;display:flex;flex-direction:column;transform:translateX(100%);transition:transform .35s cubic-bezier(.4,0,.2,1);box-shadow:-4px 0 40px rgba(0,0,0,.18)}',
        '.wype-drawer.wdo{transform:translateX(0)}',
        '.wd-head{display:flex;align-items:center;justify-content:space-between;padding:20px 22px;border-bottom:1px solid #f0f0f0;flex-shrink:0}',
        '.wd-title{font-family:"Rajdhani",sans-serif;font-size:20px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;color:#111}',
        '.wd-close{background:none;border:none;cursor:pointer;color:#777;padding:4px;display:flex;align-items:center;border-radius:50%;width:32px;height:32px;justify-content:center;transition:background .2s}',
        '.wd-close:hover{background:#f4f4f4}',
        '.wd-body{flex:1;overflow-y:auto;padding:12px 22px}',
        '.wd-foot{padding:18px 22px;border-top:1px solid #f0f0f0;flex-shrink:0}',
        '.wd-empty{text-align:center;padding:48px 0}',
        '.wd-empty-icon{font-size:44px;margin-bottom:14px}',
        '.wd-empty-txt{font-family:"Inter",sans-serif;font-size:15px;color:#999;margin-bottom:18px}',
        '.wd-empty-link{display:inline-block;font-family:"Inter",sans-serif;font-size:13px;font-weight:600;color:#E01E1E;border:1.5px solid #E01E1E;padding:10px 22px;border-radius:100px;text-decoration:none;transition:all .2s}',
        '.wd-empty-link:hover{background:#E01E1E;color:#fff}',
        '.wd-item{display:flex;gap:12px;padding:14px 0;border-bottom:1px solid #f5f5f5}',
        '.wd-item:last-child{border-bottom:none}',
        '.wd-thumb{width:68px;height:68px;border-radius:10px;object-fit:cover;flex-shrink:0;background:#f0f0f0}',
        '.wd-info{flex:1;min-width:0}',
        '.wd-name{font-family:"Rajdhani",sans-serif;font-size:16px;font-weight:700;color:#111;margin-bottom:2px;line-height:1.2}',
        '.wd-spec{font-family:"Inter",sans-serif;font-size:11px;color:#999;margin-bottom:8px}',
        '.wd-row{display:flex;align-items:center;justify-content:space-between;margin-bottom:6px}',
        '.wd-qty{display:flex;align-items:center;border:1.5px solid #e8e8e8;border-radius:100px;overflow:hidden}',
        '.wd-qbtn{background:none;border:none;cursor:pointer;width:30px;height:30px;display:flex;align-items:center;justify-content:center;font-size:17px;color:#444;transition:background .15s;flex-shrink:0}',
        '.wd-qbtn:hover{background:#f5f5f5}',
        '.wd-qnum{font-family:"Inter",sans-serif;font-size:13px;font-weight:600;color:#111;min-width:26px;text-align:center}',
        '.wd-line{font-family:"Rajdhani",sans-serif;font-size:17px;font-weight:700;color:#111}',
        '.wd-save{font-family:"Inter",sans-serif;font-size:10px;font-weight:700;color:#E01E1E;background:#fff5f5;border:1px solid rgba(224,30,30,.25);padding:2px 7px;border-radius:100px;margin-left:5px;vertical-align:middle}',
        '.wd-remove{background:none;border:none;cursor:pointer;font-family:"Inter",sans-serif;font-size:11px;color:#ccc;padding:0;text-decoration:underline;transition:color .2s}',
        '.wd-remove:hover{color:#E01E1E}',
        '.wd-totals{display:flex;flex-direction:column;gap:7px;margin-bottom:14px}',
        '.wd-trow{display:flex;justify-content:space-between;font-family:"Inter",sans-serif;font-size:13px;color:#777}',
        '.wd-trow.big{font-family:"Rajdhani",sans-serif;font-size:19px;font-weight:700;color:#111;padding-top:9px;border-top:1px solid #ebebeb}',
        '.wd-free{color:#0a9a55;font-weight:600}',
        '.wd-cta{display:block;width:100%;background:#E01E1E;color:#fff;border:none;border-radius:10px;padding:15px;font-family:"Rajdhani",sans-serif;font-size:17px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;cursor:pointer;text-align:center;text-decoration:none;transition:background .2s;line-height:1;box-sizing:border-box}',
        '.wd-cta:hover{background:#c01515;color:#fff}',
        '.wd-secure{display:flex;align-items:center;justify-content:center;gap:5px;margin-top:9px;font-family:"Inter",sans-serif;font-size:11px;color:#bbb}',

        /* Nav cart button */
        '.wype-cart-btn{position:relative;background:none;border:none;cursor:pointer;display:flex;align-items:center;justify-content:center;width:38px;height:38px;border-radius:50%;transition:background .2s}',
        '.wype-cart-btn:hover{background:rgba(255,255,255,.15)}',
        '.wype-cart-badge{position:absolute;top:1px;right:1px;width:17px;height:17px;border-radius:50%;background:#E01E1E;color:#fff;font-family:"Inter",sans-serif;font-size:10px;font-weight:700;display:none;align-items:center;justify-content:center;pointer-events:none;line-height:1}',
      ].join('');
      document.head.appendChild(style);

      var overlay = document.createElement('div');
      overlay.className = 'wype-drawer-overlay';
      overlay.addEventListener('click', CartDrawer.close);

      var drawer = document.createElement('div');
      drawer.className = 'wype-drawer';
      drawer.innerHTML =
        '<div class="wd-head">' +
          '<span class="wd-title">Your Basket</span>' +
          '<button class="wd-close" aria-label="Close">' +
            '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>' +
          '</button>' +
        '</div>' +
        '<div class="wd-body" id="wdBody"></div>' +
        '<div class="wd-foot" id="wdFoot"></div>';
      drawer.querySelector('.wd-close').addEventListener('click', CartDrawer.close);

      document.body.appendChild(overlay);
      document.body.appendChild(drawer);
      CartDrawer.el      = drawer;
      CartDrawer.overlay = overlay;
      Cart._refresh();
    },

    open: function () {
      CartDrawer.el.classList.add('wdo');
      CartDrawer.overlay.classList.add('wdo');
      document.body.style.overflow = 'hidden';
    },
    close: function () {
      CartDrawer.el.classList.remove('wdo');
      CartDrawer.overlay.classList.remove('wdo');
      document.body.style.overflow = '';
    },

    render: function () {
      var body = document.getElementById('wdBody');
      var foot = document.getElementById('wdFoot');
      if (!body || !foot) return;
      var items = Cart.get();

      if (!items.length) {
        body.innerHTML =
          '<div class="wd-empty">' +
            '<div class="wd-empty-icon">🛒</div>' +
            '<p class="wd-empty-txt">Your basket is empty.</p>' +
            '<a href="index.html#products" class="wd-empty-link" onclick="CartDrawer.close()">Shop Towels</a>' +
          '</div>';
        foot.innerHTML = '';
        return;
      }

      body.innerHTML = items.map(function (item) {
        var cat = CATALOG[item.id];
        if (!cat) return '';
        var up    = unitPrice(item.id, item.qty);
        var line  = (up * item.qty).toFixed(2);
        var disc  = item.qty >= 5 ? 'SAVE 30%' : item.qty >= 2 ? 'SAVE 20%' : '';
        return (
          '<div class="wd-item">' +
            '<img src="' + cat.thumb + '" alt="' + cat.name + '" class="wd-thumb">' +
            '<div class="wd-info">' +
              '<div class="wd-name">' + cat.name + (disc ? '<span class="wd-save">' + disc + '</span>' : '') + '</div>' +
              '<div class="wd-spec">' + cat.spec + '</div>' +
              '<div class="wd-row">' +
                '<div class="wd-qty">' +
                  '<button class="wd-qbtn" onclick="Cart.updateQty(\'' + item.id + '\',-1)">−</button>' +
                  '<span class="wd-qnum">' + item.qty + '</span>' +
                  '<button class="wd-qbtn" onclick="Cart.updateQty(\'' + item.id + '\',1)">+</button>' +
                '</div>' +
                '<span class="wd-line">£' + line + '</span>' +
              '</div>' +
              '<button class="wd-remove" onclick="Cart.remove(\'' + item.id + '\')">Remove</button>' +
            '</div>' +
          '</div>'
        );
      }).join('');

      var sub  = Cart.subtotal();
      var del  = Cart.deliveryCost();
      var tot  = Cart.total();
      var delStr = del === 0 ? '<span class="wd-free">✓ Free</span>' : '£' + del.toFixed(2);

      foot.innerHTML =
        '<div class="wd-totals">' +
          '<div class="wd-trow"><span>Subtotal</span><span>£' + sub.toFixed(2) + '</span></div>' +
          '<div class="wd-trow"><span>Delivery</span><span>' + delStr + '</span></div>' +
          '<div class="wd-trow big"><span>Total</span><span>£' + tot.toFixed(2) + '</span></div>' +
        '</div>' +
        '<a href="checkout.html?from=cart" class="wd-cta" onclick="CartDrawer._saveCartSession()">' +
          'Checkout Securely · £' + tot.toFixed(2) +
        '</a>' +
        '<div class="wd-secure">' +
          '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>' +
          ' Secured by Stripe · SSL encrypted' +
        '</div>';
    },

    _saveCartSession: function () {
      sessionStorage.setItem(SESSION_KEY, localStorage.getItem(CART_KEY) || '[]');
    },
  };

  /* ─── Inject cart icon into nav ─── */
  function injectCartBtn() {
    var existingBag = document.querySelector('.nav__bag-btn');
    if (existingBag && !existingBag.dataset.cartReady) {
      if (!existingBag.querySelector('.wype-cart-badge')) {
        var badge = document.createElement('span');
        badge.className = 'wype-cart-badge';
        badge.textContent = '0';
        existingBag.appendChild(badge);
      }
      existingBag.dataset.cartReady = 'true';
      existingBag.addEventListener('click', function (e) {
        if (Cart.totalQty() > 0) {
          e.preventDefault();
          CartDrawer.open();
        }
      });
    }

    var actions = document.querySelector('.nav__actions') || document.querySelector('.nav__right');
    if (!actions || actions.querySelector('.wype-cart-btn') || existingBag) return;
    var btn = document.createElement('button');
    btn.className  = 'wype-cart-btn';
    btn.setAttribute('aria-label', 'Open basket');
    btn.innerHTML  =
      '<svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
        '<path d="M6 2 3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4z"/><line x1="3" y1="6" x2="21" y2="6"/><path d="M16 10a4 4 0 0 1-8 0"/>' +
      '</svg>' +
      '<span class="wype-cart-badge">0</span>';
    btn.addEventListener('click', CartDrawer.open);
    var menu = actions.querySelector('.nav__menu-btn');
    if (menu) actions.insertBefore(btn, menu); else actions.appendChild(btn);
  }

  /* ─── Expose catalog & unitPrice for product pages ─── */
  window.WYPE_CATALOG   = CATALOG;
  window.wyUnitPrice    = unitPrice;

  /* ─── Init ─── */
  function init() { CartDrawer.init(); injectCartBtn(); }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
