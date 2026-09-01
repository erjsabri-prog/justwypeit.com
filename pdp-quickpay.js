/* ── Wype PDP Quick-Buy — Apple Pay / Google Pay express button ──
   Single-product mode: shared by nanowype-plus.html, wype-plus.html,
   multiwype-plus.html. Include as:
   <script src="pdp-quickpay.js" data-product="nanowype"></script>
   after cart.js (needs window.WYPE_CATALOG / window.wyUnitPrice) and after
   the page's own <script> that declares `let selectedQty`. Mounts a
   wallets-only Stripe Express Checkout button into #pdpApplePay.

   Multi-product mode: any element with [data-pdp-quickpay="<productId>"]
   on the page gets its own express-checkout button. Quantity is read from
   the element named by its [data-qty-el] attribute (falls back to 1). Used
   by grid pages like airwype-plus.html where each card is its own product.

   Bundle mode: any element with [data-pdp-quickpay-bundle="id:qty,id:qty"]
   gets a button that charges for every listed product in one payment.
   Used by the landing page bundle deal.

   Discount codes: add [data-quickpay-discount] to any mount element and a
   "Have a discount code?" field is rendered above the express button. Codes
   are the same ones checkout.html accepts (hardcoded list + server-validated
   trade codes via /api/validate-discount). */
(function () {
  'use strict';

  var scriptTag       = document.currentScript;
  var singleProductId = scriptTag && scriptTag.getAttribute('data-product');

  var _stripe, _stripeReady;

  function unitPrice(productId, qty) {
    return window.wyUnitPrice ? window.wyUnitPrice(productId, qty) : 0;
  }

  /* True when any line's quantity puts it below its single-unit price —
     the order already carries a multi-buy discount, so codes don't stack. */
  function hasMultiBuy(items) {
    return items.some(function (it) { return unitPrice(it.id, it.qty) < unitPrice(it.id, 1); });
  }

  /* items: [{ id, qty }] — one entry for a normal PDP, several for a bundle
     disc:  { code, pct, fixedTotal } — the applied discount, or null */
  function pricing(items, disc) {
    var subtotal = 0;
    items.forEach(function (it) { subtotal += unitPrice(it.id, it.qty) * it.qty; });
    subtotal = +subtotal.toFixed(2);
    var delivery     = subtotal >= 30 ? 0 : 3.99;
    var discountAmt  = 0;
    var total        = +(subtotal + delivery).toFixed(2);

    if (disc && disc.pct > 0 && hasMultiBuy(items)) disc = null;

    if (disc && disc.fixedTotal != null) {
      discountAmt = +(total - disc.fixedTotal).toFixed(2);
      total       = disc.fixedTotal;
    } else if (disc && disc.pct > 0) {
      discountAmt = +(subtotal * disc.pct / 100).toFixed(2);
      total       = +(subtotal - discountAmt + delivery).toFixed(2);
    }

    return {
      items: items,
      subtotal: subtotal,
      delivery: delivery,
      discountCode: (disc && discountAmt > 0) ? disc.code : '',
      discountAmt: discountAmt > 0 ? discountAmt : 0,
      total: total,
    };
  }

  /* ── Discount code entry ─────────────────────────────────────────────
     Same codes checkout.html honours, so a shopper can use theirs without
     leaving the landing page. Returns { pct } / { fixedTotal } / null. */
  var HARDCODED_DISCOUNTS = {
    'ERJOSABRI123': { fixedTotal: 0.30, label: 'Test discount applied: total £0.30' },
    '911C63':       { pct: 25, label: 'Friends & Family discount applied' },
    'TRSDE911C63':  { pct: 20, label: 'Trade discount applied' },
    'MORVIUS15':    { pct: 15, label: 'Instagram discount applied' },
  };

  async function lookupDiscount(code) {
    var upper = code.trim().toUpperCase();
    if (!upper) return null;
    if (HARDCODED_DISCOUNTS[upper]) {
      return Object.assign({ code: upper }, HARDCODED_DISCOUNTS[upper]);
    }
    try {
      var res  = await fetch('/api/validate-discount?code=' + encodeURIComponent(upper));
      var data = await res.json();
      if (data && data.valid && data.discountPct > 0) {
        return { code: upper, pct: data.discountPct, label: 'Discount applied (' + data.discountPct + '% off)' };
      }
    } catch (e) { return { error: 'Could not verify code. Please try again.' }; }
    return null;
  }

  /* Builds the code field above `mountEl`. onApply(disc) re-syncs the sheet
     amount. Returns the wrapper so it can be revealed with the button. */
  function buildDiscountUI(mountEl, state, onApply, getItems) {
    var wrap = document.createElement('div');
    wrap.className = 'qp-discount';
    wrap.style.cssText = 'display:none;margin-top:12px;font-family:Inter,system-ui,sans-serif;text-align:left;';
    wrap.innerHTML =
      '<button type="button" class="qp-discount__toggle" style="background:none;border:0;padding:0;font:inherit;font-size:13px;font-weight:600;color:inherit;opacity:.7;text-decoration:underline;cursor:pointer;">Have a discount code?</button>' +
      '<div class="qp-discount__row" style="display:none;gap:8px;margin-top:8px;">' +
        '<input type="text" class="qp-discount__input" placeholder="Discount code" autocomplete="off" autocapitalize="characters" spellcheck="false" ' +
          'style="flex:1;min-width:0;height:42px;padding:0 12px;font:inherit;font-size:14px;letter-spacing:1px;text-transform:uppercase;color:inherit;background:rgba(128,128,128,0.12);border:1px solid rgba(128,128,128,0.45);border-radius:6px;">' +
        '<button type="button" class="qp-discount__apply" style="height:42px;padding:0 18px;font:inherit;font-size:13px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:inherit;background:transparent;border:1px solid currentColor;border-radius:6px;cursor:pointer;">Apply</button>' +
      '</div>' +
      '<div class="qp-discount__msg" role="status" style="display:none;margin-top:8px;font-size:13px;font-weight:600;"></div>';

    var toggle = wrap.querySelector('.qp-discount__toggle');
    var row    = wrap.querySelector('.qp-discount__row');
    var input  = wrap.querySelector('.qp-discount__input');
    var apply  = wrap.querySelector('.qp-discount__apply');
    var msg    = wrap.querySelector('.qp-discount__msg');

    function showMsg(text, ok) {
      msg.textContent = text;
      msg.style.display = 'block';
      msg.style.color = ok ? '#1fa463' : '#e0281e';
    }

    toggle.addEventListener('click', function () {
      var open = row.style.display === 'flex';
      row.style.display = open ? 'none' : 'flex';
      if (!open) input.focus();
    });

    async function submit() {
      var code = input.value.trim();
      if (!code) { showMsg('Please enter a discount code.', false); return; }
      if (code.toUpperCase() !== 'ERJOSABRI123' && getItems && hasMultiBuy(getItems())) {
        showMsg('Discount codes can’t be combined with multi-buy pricing — this order already includes a bulk discount.', false);
        return;
      }
      apply.disabled = true;
      var prev = apply.textContent;
      apply.textContent = '…';
      var found = await lookupDiscount(code);
      apply.disabled = false;
      apply.textContent = prev;

      if (!found) { showMsg('That code isn\'t valid.', false); return; }
      if (found.error) { showMsg(found.error, false); return; }

      state.discount = { code: found.code, pct: found.pct || 0, fixedTotal: found.fixedTotal != null ? found.fixedTotal : null };
      var p = onApply();
      showMsg(found.label + ' — you pay £' + p.total.toFixed(2), true);
      row.style.display = 'none';
      toggle.textContent = 'Discount ' + found.code + ' applied';
      toggle.disabled = true;
      toggle.style.textDecoration = 'none';
    }

    apply.addEventListener('click', submit);
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); submit(); }
    });

    mountEl.parentNode.insertBefore(wrap, mountEl.nextSibling);
    return wrap;
  }

  function itemName(productId) {
    var cat = (window.WYPE_CATALOG && window.WYPE_CATALOG[productId]) || {};
    return cat.name || productId;
  }

  function summaryLine(items) {
    return items.map(function (it) { return it.qty + 'x ' + itemName(it.id); }).join(' | ').slice(0, 490);
  }

  function ensureStripe() {
    if (_stripe) return Promise.resolve(_stripe);
    if (_stripeReady) return _stripeReady;
    _stripeReady = (async function () {
      try {
        var cfgRes = await fetch('/stripe-config');
        var cfg    = await cfgRes.json();
        if (!cfg.publishableKey || !cfg.publishableKey.startsWith('pk_')) return null;
        _stripe = Stripe(cfg.publishableKey);
        return _stripe;
      } catch (e) { return null; }
    })();
    return _stripeReady;
  }

  /* getItems(): returns the live [{ id, qty }] list at tap time.
     opts.onReady(mountEl) may override the default show-on-ready behaviour. */
  async function mountQuickPay(getItems, mountEl, opts) {
    opts = opts || {};
    if (!mountEl || !window.Stripe) return;
    var stripe = await ensureStripe();
    if (!stripe) return;

    var state    = { discount: null };
    var p        = pricing(getItems(), state.discount);
    var elements = stripe.elements({
      mode: 'payment',
      amount: Math.round(p.total * 100),
      currency: 'gbp',
      appearance: {
        theme: 'stripe',
        variables: { colorPrimary: '#111111', borderRadius: '0px', fontFamily: 'Inter, system-ui, sans-serif' },
      },
    });

    var expressEl = elements.create('expressCheckout', {
      buttonType: { applePay: 'buy', googlePay: 'buy' },
      buttonTheme: { applePay: 'black', googlePay: 'black' },
      buttonHeight: 48,
      paymentMethods: {
        applePay: 'auto',
        googlePay: 'auto',
        paypal: 'never',
        link: 'auto',
        klarna: 'never',
        amazonPay: 'never',
      },
      layout: { maxColumns: 1, maxRows: 1 },
    });

    /* Optional discount-code field — shown/hidden with the button */
    var discountWrap = null;
    if (mountEl.hasAttribute('data-quickpay-discount')) {
      discountWrap = buildDiscountUI(mountEl, state, function () {
        var live = pricing(getItems(), state.discount);
        if (live.items.length) elements.update({ amount: Math.round(live.total * 100) });
        return live;
      }, getItems);
    }

    expressEl.on('ready', function (evt) {
      var avail = evt && evt.availablePaymentMethods;
      if (!avail || Object.keys(avail).length === 0) return;
      if (opts.onReady) { opts.onReady(mountEl); } else { mountEl.style.display = 'block'; }
      if (discountWrap) discountWrap.style.display = 'block';
    });

    /* Re-sync the sheet amount at tap time — quantities may have changed
       since mount (basket drawer, PDP qty steppers). */
    expressEl.on('click', function (event) {
      var live = pricing(getItems(), state.discount);
      if (live.items.length) elements.update({ amount: Math.round(live.total * 100) });
      event.resolve();
    });

    expressEl.on('confirm', async function (event) {
      var submitResult = await elements.submit();
      if (submitResult.error) { console.error('Quick-buy submit error:', submitResult.error.message); return; }

      var live      = pricing(getItems(), state.discount); // re-read in case the shopper changed qty just before tapping
      var bd        = (event && event.billingDetails) || {};
      var addr      = bd.address || {};
      var nameParts = (bd.name || '').trim().split(' ');

      var intentRes = await fetch('/create-payment-intent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          amount: Math.round(live.total * 100),
          currency: 'gbp',
          country: addr.country || 'GB',
          itemsSummary: summaryLine(live.items),
          discountCode: live.discountCode || undefined,
        }),
      });
      var intentData = await intentRes.json();
      if (intentData.error || !intentData.clientSecret) { console.error('Quick-buy intent error:', intentData.error); return; }
      var paymentIntentId = intentData.clientSecret.split('_secret_')[0];

      var pendingOrder = {
        firstName: nameParts[0] || '',
        lastName:  nameParts.slice(1).join(' ') || '',
        email:     bd.email || '',
        phone:     bd.phone || '',
        address1:  addr.line1 || '',
        address2:  addr.line2 || '',
        city:      addr.city || '',
        postcode:  addr.postal_code || '',
        country:   addr.country || 'GB',
        items:     live.items.map(function (it) {
          return it.qty + 'x ' + itemName(it.id) + ' @ £' + unitPrice(it.id, it.qty).toFixed(2) + ' each';
        }),
        subtotal:  live.subtotal.toFixed(2),
        delivery:  live.delivery.toFixed(2),
        deliveryMethod: 'Evri Standard',
        discountCode: live.discountCode || undefined,
        discountAmt:  live.discountAmt > 0 ? live.discountAmt.toFixed(2) : undefined,
        total:     live.total.toFixed(2),
        paymentCurrency: 'GBP',
        paymentTotal: live.total.toFixed(2),
        paymentIntentId: paymentIntentId,
      };
      sessionStorage.setItem('wype_pending_order', JSON.stringify(pendingOrder));

      try {
        await fetch('/api/register-pending-order', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(Object.assign({ paymentIntentId: paymentIntentId }, pendingOrder)),
        });
      } catch (e) {}

      var result = await stripe.confirmPayment({
        elements: elements,
        clientSecret: intentData.clientSecret,
        confirmParams: { return_url: window.location.origin + '/checkout.html?payment=success' },
      });
      if (result.error) { console.error('Quick-buy confirm error:', result.error.message); return; }
      window.location.href = window.location.origin + '/checkout.html?payment=success';
    });

    expressEl.mount(mountEl);
  }

  function singleItemGetter(productId, getQty) {
    return function () { return [{ id: productId, qty: getQty() }]; };
  }

  function init() {
    if (singleProductId) {
      mountQuickPay(singleItemGetter(singleProductId, function () {
        return (typeof selectedQty !== 'undefined' && selectedQty > 0) ? selectedQty : 1;
      }), document.getElementById('pdpApplePay'));
    }

    document.querySelectorAll('[data-pdp-quickpay]').forEach(function (mountEl) {
      var productId = mountEl.getAttribute('data-pdp-quickpay');
      var qtyElId   = mountEl.getAttribute('data-qty-el');
      mountQuickPay(singleItemGetter(productId, function () {
        if (qtyElId) {
          var qtyEl = document.getElementById(qtyElId);
          var n     = qtyEl && parseInt(qtyEl.textContent, 10);
          return (n && n > 0) ? n : 1;
        }
        // No qty element named — this mount shares the page's single product
        // quantity (e.g. a buy-strip echoing the main PDP's selectedQty).
        return (typeof selectedQty !== 'undefined' && selectedQty > 0) ? selectedQty : 1;
      }), mountEl);
    });

    document.querySelectorAll('[data-pdp-quickpay-bundle]').forEach(function (mountEl) {
      var items = mountEl.getAttribute('data-pdp-quickpay-bundle').split(',')
        .map(function (part) {
          var bits = part.split(':');
          return { id: bits[0].trim(), qty: Math.max(1, parseInt(bits[1], 10) || 1) };
        })
        .filter(function (it) { return it.id; });
      if (!items.length) return;
      mountQuickPay(function () { return items; }, mountEl);
    });

    /* Basket drawer — one button charging the whole cart */
    var cartMount = document.getElementById('wdQuickpay');
    if (cartMount && window.Cart && typeof Cart.get === 'function') {
      mountQuickPay(function () {
        return Cart.get().map(function (it) { return { id: it.id, qty: it.qty }; });
      }, cartMount, {
        onReady: function (el) {
          el.dataset.ready = '1';
          if (Cart.get().length) el.style.display = 'block';
        },
      });
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
