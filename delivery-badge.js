/* ==========================================================================
   Wype estimated-arrival badge — vanilla port of the "EstimatedDateBadge"
   React component. Drops itself in after `.p-stock` on product pages.
   Date = today + 3 working days for packing/dispatch + 2 working days Evri
   Standard (the outer edge of what we promise), skipping weekends.
   ========================================================================== */
(function () {
  var CSS = ''
    + '.eta{--eta:#E01E1E;font-family:"Nunito",sans-serif;margin:-6px 0 22px;max-width:520px;animation:etaFadeUp .6s ease both}'
    + '.eta__wrap{position:relative}'
    + '.eta__card{position:relative;overflow:hidden;background:#fff;border-radius:16px;padding:16px 18px;cursor:pointer;display:flex;align-items:center;gap:14px;box-shadow:0 8px 28px rgba(0,0,0,.06);transition:transform .2s,box-shadow .2s;user-select:none}'
    + '.eta__card:hover{transform:translateY(-1px);box-shadow:0 12px 34px rgba(0,0,0,.09)}'
    + '.eta__shimmer{position:absolute;inset:0;background:linear-gradient(90deg,transparent,rgba(224,30,30,.06),transparent);background-size:1000px 100%;animation:etaShimmer 3.5s linear infinite;pointer-events:none}'
    + '.eta__icon{flex:0 0 auto;width:44px;height:44px;border-radius:12px;background:rgba(224,30,30,.1);display:flex;align-items:center;justify-content:center;color:var(--eta);animation:etaGlow 2.4s ease-in-out infinite}'
    + '.eta__icon svg{width:22px;height:22px;animation:etaBounce 2.4s ease-in-out infinite}'
    + '.eta__text{flex:1 1 auto;min-width:0}'
    + '.eta__label{margin:0;font-size:10.5px;font-weight:800;letter-spacing:2px;text-transform:uppercase;color:#8a8a8a}'
    + '.eta__date{margin:2px 0 0;font-size:20px;font-weight:900;color:#111;letter-spacing:-.3px;line-height:1.1}'
    + '.eta__day{margin:2px 0 0;font-size:13px;font-weight:600;color:#555}'
    + '.eta__right{flex:0 0 auto;display:flex;align-items:center;gap:10px}'
    + '.eta__pill{background:var(--eta);color:#fff;font-size:11px;font-weight:800;letter-spacing:1.5px;text-transform:uppercase;padding:6px 11px;border-radius:999px;white-space:nowrap;animation:etaPulse 2.4s ease-in-out infinite}'
    + '.eta__arrow{width:18px;height:18px;color:#999;transition:transform .3s}'
    + '.eta--open .eta__arrow{transform:rotate(180deg)}'
    + '.eta__border{position:absolute;inset:0;width:100%;height:100%;pointer-events:none;border-radius:16px}'
    + '.eta__border rect{stroke-dasharray:1;stroke-dashoffset:1;animation:etaLine 2.2s ease-out forwards}'
    + '.eta__details{display:grid;grid-template-rows:0fr;transition:grid-template-rows .4s cubic-bezier(.22,1,.36,1)}'
    + '.eta--open .eta__details{grid-template-rows:1fr}'
    + '.eta__details>div{overflow:hidden}'
    + '.eta__dcard{margin-top:10px;background:#fafafa;border:1px solid #ececec;border-radius:14px;padding:16px 18px;display:flex;flex-direction:column;gap:14px}'
    + '.eta__item{opacity:0;transform:translateX(-10px);transition:opacity .35s,transform .35s}'
    + '.eta--open .eta__item{opacity:1;transform:none}'
    + '.eta--open .eta__item:nth-child(2){transition-delay:.08s}.eta--open .eta__item:nth-child(3){transition-delay:.16s}'
    + '.eta__h{margin:0 0 3px;font-size:13px;font-weight:800;color:#111;display:flex;align-items:center;gap:8px}'
    + '.eta__n{width:20px;height:20px;border-radius:50%;background:var(--eta);color:#fff;font-size:11px;font-weight:800;display:inline-flex;align-items:center;justify-content:center;flex:0 0 auto}'
    + '.eta__p{margin:0 0 0 28px;font-size:13px;line-height:1.55;color:#555}'
    + '.eta__p a{color:var(--eta);font-weight:700;text-decoration:none}'
    + '@keyframes etaFadeUp{from{opacity:0;transform:translateY(14px)}to{opacity:1;transform:none}}'
    + '@keyframes etaShimmer{0%{background-position:-1000px 0}100%{background-position:1000px 0}}'
    + '@keyframes etaGlow{0%,100%{box-shadow:0 0 0 0 rgba(224,30,30,.35)}50%{box-shadow:0 0 0 8px rgba(224,30,30,0)}}'
    + '@keyframes etaBounce{0%,100%{transform:translateY(0)}50%{transform:translateY(-3px)}}'
    + '@keyframes etaPulse{0%,100%{opacity:1}50%{opacity:.75}}'
    + '@keyframes etaLine{to{stroke-dashoffset:0}}'
    + '@media (max-width:480px){.eta__card{padding:14px;gap:10px}.eta__date{font-size:17px}.eta__pill{font-size:10px;padding:5px 9px}}'
    + '@media (prefers-reduced-motion:reduce){.eta,.eta__shimmer,.eta__icon,.eta__icon svg,.eta__pill,.eta__border rect{animation:none}}';

  function addWorkingDays(from, n) {
    var d = new Date(from.getFullYear(), from.getMonth(), from.getDate());
    while (n > 0) { d.setDate(d.getDate() + 1); var w = d.getDay(); if (w !== 0 && w !== 6) n--; }
    return d;
  }

  function build() {
    var stock = document.querySelector('.p-stock');
    if (!stock || document.querySelector('.eta')) return;
    if (/pre-?order/i.test(stock.textContent)) return;           // pre-order pages have their own ship dates
    var s = document.createElement('style'); s.textContent = CSS; document.head.appendChild(s);

    var now = new Date();
    var latest = addWorkingDays(now, 5);                            // 3 to dispatch + 2 Evri Standard
    var dateStr = latest.toLocaleDateString('en-GB', { day: 'numeric', month: 'long' });
    var dayStr  = latest.toLocaleDateString('en-GB', { weekday: 'long' });

    var el = document.createElement('div');
    el.className = 'eta';
    el.innerHTML = ''
      + '<div class="eta__wrap">'
      + '  <div class="eta__card" role="button" tabindex="0" aria-expanded="false" aria-controls="etaDetails">'
      + '    <div class="eta__shimmer"></div>'
      + '    <div class="eta__icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"/></svg></div>'
      + '    <div class="eta__text"><p class="eta__label">Estimated arrival</p><h3 class="eta__date">by ' + dateStr + '</h3><p class="eta__day">' + dayStr + ' · Evri tracked</p></div>'
      + '    <div class="eta__right"><span class="eta__pill">Free over £25</span><svg class="eta__arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 9l-7 7-7-7"/></svg></div>'
      + '    <svg class="eta__border" aria-hidden="true"><rect x="1" y="1" width="calc(100% - 2px)" height="calc(100% - 2px)" rx="15" ry="15" fill="none" stroke="#E01E1E" stroke-width="2" pathLength="1"/></svg>'
      + '  </div>'
      + '  <div class="eta__details" id="etaDetails"><div><div class="eta__dcard">'
      + '    <div class="eta__item"><h4 class="eta__h"><span class="eta__n">1</span>Dispatch</h4><p class="eta__p">Packed and dispatched from the UK within 2–3 working days. Your tracking number lands in your inbox the moment it leaves.</p></div>'
      + '    <div class="eta__item"><h4 class="eta__h"><span class="eta__n">2</span>Delivery</h4><p class="eta__p">Evri Standard, 1–2 working days, fully tracked. Free on orders over £25, otherwise £3.99. Next-day option at checkout.</p></div>'
      + '    <div class="eta__item"><h4 class="eta__h"><span class="eta__n">3</span>Need a hand?</h4><p class="eta__p">Email <a href="mailto:customer@justwypeit.com">customer@justwypeit.com</a>, we reply within 24 hours.</p></div>'
      + '  </div></div></div>'
      + '</div>';
    stock.insertAdjacentElement('afterend', el);

    var card = el.querySelector('.eta__card');
    function toggle() { var open = el.classList.toggle('eta--open'); card.setAttribute('aria-expanded', open ? 'true' : 'false'); }
    card.addEventListener('click', toggle);
    card.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', build); else build();
})();
