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
   by grid pages like airwype-plus.html where each card is its own product. */
(function () {
  'use strict';

  var scriptTag       = document.currentScript;
  var singleProductId = scriptTag && scriptTag.getAttribute('data-product');

  var _stripe, _stripeReady;

  function unitPrice(productId, qty) {
    return window.wyUnitPrice ? window.wyUnitPrice(productId, qty) : 0;
  }

  function pricing(productId, qty) {
    var subtotal = unitPrice(productId, qty) * qty;
    var delivery = subtotal >= 30 ? 0 : 3.99;
    return { qty: qty, subtotal: subtotal, delivery: delivery, total: +(subtotal + delivery).toFixed(2) };
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

  async function mountQuickPay(productId, mountEl, getQty) {
    if (!mountEl || !window.Stripe) return;
    var stripe = await ensureStripe();
    if (!stripe) return;

    var p        = pricing(productId, getQty());
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
      buttonHeight: 48,
      paymentMethods: {
        applePay: 'auto',
        googlePay: 'auto',
        paypal: 'never',
        link: 'never',
        klarna: 'never',
        amazonPay: 'never',
      },
      layout: { maxColumns: 1, maxRows: 1 },
    });

    expressEl.on('ready', function (evt) {
      var avail = evt && evt.availablePaymentMethods;
      if (avail && Object.keys(avail).length > 0) mountEl.style.display = 'block';
    });

    expressEl.on('confirm', async function (event) {
      var submitResult = await elements.submit();
      if (submitResult.error) { console.error('Quick-buy submit error:', submitResult.error.message); return; }

      var live      = pricing(productId, getQty()); // re-read qty in case the shopper changed it just before tapping
      var bd        = (event && event.billingDetails) || {};
      var addr      = bd.address || {};
      var nameParts = (bd.name || '').trim().split(' ');
      var cat       = (window.WYPE_CATALOG && window.WYPE_CATALOG[productId]) || {};

      var intentRes = await fetch('/create-payment-intent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          amount: Math.round(live.total * 100),
          currency: 'gbp',
          country: addr.country || 'GB',
          itemsSummary: live.qty + 'x ' + (cat.name || productId),
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
        items:     [live.qty + 'x ' + (cat.name || productId) + ' @ £' + unitPrice(productId, live.qty).toFixed(2) + ' each'],
        subtotal:  live.subtotal.toFixed(2),
        delivery:  live.delivery.toFixed(2),
        deliveryMethod: 'Evri Standard',
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

  function init() {
    if (singleProductId) {
      mountQuickPay(singleProductId, document.getElementById('pdpApplePay'), function () {
        return (typeof selectedQty !== 'undefined' && selectedQty > 0) ? selectedQty : 1;
      });
    }

    document.querySelectorAll('[data-pdp-quickpay]').forEach(function (mountEl) {
      var productId = mountEl.getAttribute('data-pdp-quickpay');
      var qtyElId   = mountEl.getAttribute('data-qty-el');
      mountQuickPay(productId, mountEl, function () {
        var qtyEl = qtyElId && document.getElementById(qtyElId);
        var n     = qtyEl && parseInt(qtyEl.textContent, 10);
        return (n && n > 0) ? n : 1;
      });
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
