/* ==========================================================================
   Wype order timeline — vanilla port of the "TrackingTimeline" (rich, icon
   nodes + pulse) and "OrderTracking" (compact, check-circle + thin line)
   React components. Used on track.html, order-confirmed.html, account.html.

   WypeTimeline.render(el, items, { variant: 'rich' | 'compact' })
   WypeTimeline.fromOrder({ status, placedAt, dispatchedAt, deliveredAt, carrier, trackingNumber })
   item = { title, date, status: 'completed' | 'in-progress' | 'pending', icon? }
   ========================================================================== */
(function () {
  var CSS = ''
    + ':root{--wtl-accent:#E01E1E;--wtl-bg:#fff;--wtl-text:#111;--wtl-muted:#8a8a8a;--wtl-line:rgba(0,0,0,.12);--wtl-pending:#ececec;--wtl-pending-ic:#b5b5b5}.wtl{font-family:"Nunito",sans-serif;margin:0;padding:0;list-style:none}'
    /* rich */
    + '.wtl--rich{position:relative;margin-left:16px;border-left:1px solid var(--wtl-line)}'
    + '.wtl--rich .wtl__item{position:relative;margin:0 0 26px 32px;opacity:0;transform:translateY(16px);animation:wtlIn .5s cubic-bezier(.22,1,.36,1) forwards;animation-delay:calc(var(--i,0)*.16s)}'
    + '.wtl--rich .wtl__item:last-child{margin-bottom:0}'
    + '.wtl--rich .wtl__node{position:absolute;left:-49px;top:-4px;width:32px;height:32px;border-radius:50%;display:flex;align-items:center;justify-content:center;box-shadow:0 0 0 6px var(--wtl-bg);background:var(--wtl-pending);color:var(--wtl-pending-ic)}'
    + '.wtl--rich .wtl__item--completed .wtl__node{background:var(--wtl-accent);color:#fff}'
    + '.wtl--rich .wtl__item--in-progress .wtl__node{background:rgba(224,30,30,.16);color:var(--wtl-accent)}'
    + '.wtl__ping{position:absolute;inset:0;border-radius:50%;background:rgba(224,30,30,.5);animation:wtlPing 1.4s cubic-bezier(0,0,.2,1) infinite}'
    + '.wtl__node svg{position:relative;width:16px;height:16px}'
    + '.wtl__title{margin:0;font-size:15px;font-weight:800;color:var(--wtl-text);letter-spacing:-.1px;line-height:1.3}'
    + '.wtl__item--in-progress .wtl__title{color:var(--wtl-accent)}'
    + '.wtl__item--pending .wtl__title{color:var(--wtl-muted);font-weight:700}'
    + '.wtl__date{display:block;margin-top:2px;font-size:13px;color:var(--wtl-muted);font-weight:500}'
    + '.wtl__item--in-progress .wtl__date{color:var(--wtl-text);font-weight:600}'
    + '.wtl__date a{color:var(--wtl-accent);font-weight:700;text-decoration:none}'
    /* compact */
    + '.wtl--compact{max-width:440px}'
    + '.wtl--compact .wtl__item{display:flex;opacity:0;animation:wtlIn .4s ease forwards;animation-delay:calc(var(--i,0)*.1s)}'
    + '.wtl--compact .wtl__rail{display:flex;flex-direction:column;align-items:center;flex:0 0 24px}'
    + '.wtl--compact .wtl__rail svg{width:24px;height:24px;flex:0 0 auto}'
    + '.wtl--compact .wtl__item--completed .wtl__rail svg{color:var(--wtl-accent)}'
    + '.wtl--compact .wtl__item--in-progress .wtl__rail svg{color:var(--wtl-accent)}'
    + '.wtl--compact .wtl__item--pending .wtl__rail svg{color:var(--wtl-pending-ic)}'
    + '.wtl--compact .wtl__seg{width:1.5px;flex:1 1 auto;min-height:18px;background:var(--wtl-pending-ic);margin:2px 0}'
    + '.wtl--compact .wtl__seg--on{background:var(--wtl-accent)}'
    + '.wtl--compact .wtl__body{margin-left:12px;padding-bottom:22px}'
    + '.wtl--compact .wtl__item:last-child .wtl__body{padding-bottom:0}'
    + '.wtl--compact .wtl__title{font-size:14px;font-weight:700}'
    + '.wtl--compact .wtl__date{font-size:13px}'
    + '@keyframes wtlIn{to{opacity:1;transform:none}}'
    + '@keyframes wtlPing{75%,100%{transform:scale(2);opacity:0}}'
    + '@media (prefers-reduced-motion:reduce){.wtl .wtl__item{animation:none;opacity:1;transform:none}.wtl__ping{animation:none}}';

  function svg(d, extra) { return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + d + (extra || '') + '</svg>'; }
  var ICONS = {
    check:          svg('<path d="M20 6 9 17l-5-5"/>'),
    circle:         svg('<circle cx="12" cy="12" r="9"/>'),
    circleDot:      svg('<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="2.5" fill="currentColor" stroke="none"/>'),
    checkCircle:    svg('<circle cx="12" cy="12" r="9"/><path d="m8.5 12 2.5 2.5 5-5"/>'),
    clipboardCheck: svg('<rect x="8" y="2" width="8" height="4" rx="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><path d="m9 14 2 2 4-4"/>'),
    box:            svg('<path d="M16.5 9.4 7.5 4.21"/><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><path d="M3.3 7 12 12l8.7-5"/><path d="M12 22V12"/>'),
    warehouse:      svg('<path d="M22 8.35V20a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V8.35A2 2 0 0 1 3.26 6.5l8-3.2a2 2 0 0 1 1.48 0l8 3.2A2 2 0 0 1 22 8.35Z"/><path d="M6 18h12"/><path d="M6 14h12"/><rect x="6" y="10" width="12" height="12"/>'),
    truck:          svg('<path d="M14 18V6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v11a1 1 0 0 0 1 1h2"/><path d="M15 18H9"/><path d="M19 18h2a1 1 0 0 0 1-1v-3.65a1 1 0 0 0-.22-.62l-3.48-4.35A1 1 0 0 0 17.52 8H14"/><circle cx="17" cy="18" r="2"/><circle cx="7" cy="18" r="2"/>'),
    home:           svg('<path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/>'),
    x:              svg('<path d="M18 6 6 18"/><path d="m6 6 12 12"/>'),
  };

  function injectCSS() {
    if (document.getElementById('wtl-css')) return;
    var s = document.createElement('style'); s.id = 'wtl-css'; s.textContent = CSS; document.head.appendChild(s);
  }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }

  function render(el, items, opts) {
    if (!el) return;
    injectCSS();
    opts = opts || {};
    var variant = opts.variant === 'compact' ? 'compact' : 'rich';
    var html = '';
    if (!items || !items.length) {
      el.innerHTML = '<p class="wtl__date">This order has no tracking information yet.</p>';
      return;
    }
    if (variant === 'rich') {
      html += '<ol class="wtl wtl--rich">';
      items.forEach(function (it, i) {
        var st = it.status || 'pending';
        var icon = it.icon ? (ICONS[it.icon] || it.icon) : (st === 'completed' ? ICONS.check : st === 'in-progress' ? ICONS.circleDot : ICONS.circle);
        html += '<li class="wtl__item wtl__item--' + st + '" style="--i:' + i + '"' + (st === 'in-progress' ? ' aria-current="step"' : '') + '>'
          + '<span class="wtl__node">' + (st === 'in-progress' ? '<span class="wtl__ping"></span>' : '') + icon + '</span>'
          + '<div class="wtl__body"><h3 class="wtl__title">' + esc(it.title) + '</h3>'
          + (it.date ? '<time class="wtl__date">' + (it.dateHtml ? it.date : esc(it.date)) + '</time>' : '') + '</div></li>';
      });
      html += '</ol>';
    } else {
      html += '<div class="wtl wtl--compact">';
      items.forEach(function (it, i) {
        var st = it.status || 'pending';
        var icon = st === 'completed' ? ICONS.checkCircle : st === 'in-progress' ? ICONS.circleDot : ICONS.circle;
        var next = items[i + 1];
        html += '<div class="wtl__item wtl__item--' + st + '" style="--i:' + i + '">'
          + '<div class="wtl__rail">' + icon + (next ? '<div class="wtl__seg' + (next.status === 'completed' || next.status === 'in-progress' ? ' wtl__seg--on' : '') + '"></div>' : '') + '</div>'
          + '<div class="wtl__body"><p class="wtl__title">' + esc(it.title) + '</p>'
          + (it.date ? '<p class="wtl__date">' + (it.dateHtml ? it.date : esc(it.date)) + '</p>' : '') + '</div></div>';
      });
      html += '</div>';
    }
    el.innerHTML = html;
  }

  function fmt(d) {
    if (!d) return '';
    var t = new Date(d); if (isNaN(t)) return '';
    return t.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) + ', ' + t.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  }

  function fromOrder(o) {
    o = o || {};
    var status = String(o.status || 'Processing');
    var placed = fmt(o.placedAt) || 'Today';
    if (/cancel/i.test(status)) {
      return [
        { title: 'Order placed', date: placed, status: 'completed', icon: 'clipboardCheck' },
        { title: 'Cancelled', date: 'Refunded to your original payment method', status: 'completed', icon: 'x' },
      ];
    }
    var shipped   = /dispatch|shipped|deliver/i.test(status);
    var delivered = /deliver/i.test(status);
    var carrier   = o.carrier || 'Evri';
    var dispatched = fmt(o.dispatchedAt);
    var trackBit = '';
    if (o.trackingNumber) {
      trackBit = o.trackUrl
        ? ' · <a href="' + esc(o.trackUrl) + '" target="_blank" rel="noopener">' + esc(o.trackingNumber) + '</a>'
        : ' · ' + esc(o.trackingNumber);
    }
    return [
      { title: 'Order placed', date: placed, status: 'completed', icon: 'clipboardCheck' },
      { title: 'Packing your order', date: shipped ? (dispatched || 'Done') : 'In progress · 1–2 working days', status: shipped ? 'completed' : 'in-progress', icon: 'box' },
      { title: 'Dispatched', date: shipped ? (dispatched || 'On its way') : 'Within 2–3 working days', status: shipped ? 'completed' : 'pending', icon: 'warehouse' },
      { title: 'Out for delivery', date: delivered ? 'Done' : shipped ? ('With ' + esc(carrier) + trackBit) : (esc(carrier) + ' · fully tracked'), dateHtml: true, status: delivered ? 'completed' : shipped ? 'in-progress' : 'pending', icon: 'truck' },
      { title: 'Delivered', date: delivered ? (fmt(o.deliveredAt) || 'Delivered') : 'Delivery day', status: delivered ? 'completed' : 'pending', icon: 'home' },
    ];
  }

  window.WypeTimeline = { render: render, fromOrder: fromOrder, ICONS: ICONS };
})();
