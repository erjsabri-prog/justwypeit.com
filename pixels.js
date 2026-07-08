/* wype® marketing pixels + GA4 ecommerce events.
   Meta / TikTok ship DORMANT: paste your pixel IDs below and redeploy to activate.
   GA4 (gtag) is already loaded on every page; this file only sends events to it. */
(function () {
  'use strict';

  var META_PIXEL_ID   = '';   /* e.g. '1234567890123456' from Meta Events Manager */
  var TIKTOK_PIXEL_ID = '';   /* e.g. 'ABC123DEF456' from TikTok Ads Manager */

  var PRODUCTS = {
    'nanowype-plus': { id: 'nanowype-plus', name: 'NanoWype+', price: 19.50 },
    'wype-plus':     { id: 'wype-plus',     name: 'MicroWype+', price: 15.90 }
  };

  /* ── Meta pixel bootstrap (no-op while ID empty) ── */
  if (META_PIXEL_ID) {
    !function(f,b,e,v,n,t,s){if(f.fbq)return;n=f.fbq=function(){n.callMethod?
    n.callMethod.apply(n,arguments):n.queue.push(arguments)};if(!f._fbq)f._fbq=n;
    n.push=n;n.loaded=!0;n.version='2.0';n.queue=[];t=b.createElement(e);t.async=!0;
    t.src=v;s=b.getElementsByTagName(e)[0];s.parentNode.insertBefore(t,s)}(window,
    document,'script','https://connect.facebook.net/en_US/fbevents.js');
    window.fbq('init', META_PIXEL_ID);
    window.fbq('track', 'PageView');
  }

  /* ── TikTok pixel bootstrap (no-op while ID empty) ── */
  if (TIKTOK_PIXEL_ID) {
    !function (w, d, t) {
      w.TiktokAnalyticsObject=t;var ttq=w[t]=w[t]||[];ttq.methods=["page","track","identify","instances","debug","on","off","once","ready","alias","group","enableCookie","disableCookie"];
      ttq.setAndDefer=function(t,e){t[e]=function(){t.push([e].concat(Array.prototype.slice.call(arguments,0)))}};
      for(var i=0;i<ttq.methods.length;i++)ttq.setAndDefer(ttq,ttq.methods[i]);
      ttq.instance=function(t){for(var e=ttq._i[t]||[],n=0;n<ttq.methods.length;n++)ttq.setAndDefer(e,ttq.methods[n]);return e};
      ttq.load=function(e,n){var i="https://analytics.tiktok.com/i18n/pixel/events.js";ttq._i=ttq._i||{},ttq._i[e]=[],ttq._i[e]._u=i,ttq._t=ttq._t||{},ttq._t[e]=+new Date,ttq._o=ttq._o||{},ttq._o[e]=n||{};
      var o=document.createElement("script");o.type="text/javascript",o.async=!0,o.src=i+"?sdkid="+e+"&lib="+t;var a=document.getElementsByTagName("script")[0];a.parentNode.insertBefore(o,a)};
      ttq.load(TIKTOK_PIXEL_ID);ttq.page();
    }(window, document, 'ttq');
  }

  var META_EVENTS   = { view_item: 'ViewContent', add_to_cart: 'AddToCart', begin_checkout: 'InitiateCheckout', purchase: 'Purchase', generate_lead: 'Lead' };
  var TIKTOK_EVENTS = { view_item: 'ViewContent', add_to_cart: 'AddToCart', begin_checkout: 'InitiateCheckout', purchase: 'CompletePayment', generate_lead: 'SubmitForm' };

  /* Central tracker: wypeTrack('add_to_cart', { value: 18.00, items: [...] }) */
  window.wypeTrack = function (event, params) {
    params = params || {};
    try {
      if (typeof window.gtag === 'function') {
        window.gtag('event', event, Object.assign({ currency: 'GBP' }, params));
      }
      if (window.fbq && META_EVENTS[event]) {
        window.fbq('track', META_EVENTS[event], { value: params.value, currency: 'GBP' });
      }
      if (window.ttq && TIKTOK_EVENTS[event]) {
        window.ttq.track(TIKTOK_EVENTS[event], { value: params.value, currency: 'GBP' });
      }
    } catch (e) { /* tracking must never break the shop */ }
  };

  /* Auto view_item on product pages */
  var path = location.pathname.replace(/\.html$/, '').replace(/^\//, '');
  var prod = PRODUCTS[path];
  if (prod) {
    window.wypeTrack('view_item', {
      value: prod.price,
      items: [{ item_id: prod.id, item_name: prod.name, price: prod.price, quantity: 1 }]
    });
  }

  /* Auto begin_checkout on checkout page, once per browser session.
     Deferred to DOMContentLoaded so cart.js has loaded and Cart exists. */
  if (/checkout/.test(location.pathname) && !sessionStorage.getItem('wype_bc')) {
    document.addEventListener('DOMContentLoaded', function () {
      if (sessionStorage.getItem('wype_bc')) return;
      sessionStorage.setItem('wype_bc', '1');
      var value = 0;
      try {
        value = (window.Cart && typeof window.Cart.subtotal === 'function') ? window.Cart.subtotal() : 0;
      } catch (e) {}
      window.wypeTrack('begin_checkout', { value: value });
    });
  }
})();
