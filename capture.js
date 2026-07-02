/* wype® email capture: footer signup band + exit-intent offer.
   Posts to /api/subscribe; server emails a unique 10% welcome code. */
(function () {
  'use strict';

  var DONE_KEY    = 'wype_sub_done';
  var DISMISS_KEY = 'wype_capture_dismissed';
  var DISMISS_DAYS = 7;

  if (/admin|affiliate|account|checkout|order-confirmed/.test(location.pathname)) return;

  var subscribed = false;
  try { subscribed = localStorage.getItem(DONE_KEY) === '1'; } catch (e) {}

  var css = document.createElement('style');
  css.textContent =
    '.wype-cap{background:#120a0d;background-image:radial-gradient(120% 130% at 50% -20%,#6e0020 0%,#38040f 45%,#120a0d 78%);padding:52px 20px;text-align:center}' +
    '.wype-cap__kicker{font-family:"Courier New",monospace;font-size:11px;letter-spacing:4px;text-transform:uppercase;color:#e79aad;margin:0 0 10px}' +
    '.wype-cap__title{font-family:"Helvetica Neue",Arial,sans-serif;font-size:28px;font-weight:800;color:#fff;margin:0 0 8px;letter-spacing:-0.5px}' +
    '.wype-cap__sub{font-size:14px;color:rgba(255,255,255,0.75);margin:0 0 22px}' +
    '.wype-cap__form{display:flex;gap:8px;justify-content:center;flex-wrap:wrap;max-width:440px;margin:0 auto}' +
    '.wype-cap__input{flex:1 1 220px;min-width:0;padding:13px 16px;border-radius:8px;border:1px solid rgba(255,255,255,0.25);background:rgba(255,255,255,0.08);color:#fff;font-size:14px;outline:none}' +
    '.wype-cap__input::placeholder{color:rgba(255,255,255,0.45)}' +
    '.wype-cap__btn{padding:13px 26px;border-radius:8px;border:none;background:#E01E1E;color:#fff;font-size:14px;font-weight:800;letter-spacing:0.5px;cursor:pointer;text-transform:uppercase}' +
    '.wype-cap__btn:disabled{opacity:0.6;cursor:default}' +
    '.wype-cap__msg{font-size:13px;margin:14px 0 0;color:#9be0a8;min-height:16px}' +
    '.wype-cap__msg--err{color:#ffb3b3}' +
    '.wype-exit{position:fixed;inset:0;background:rgba(10,5,7,0.72);z-index:99999;display:flex;align-items:center;justify-content:center;padding:20px}' +
    '.wype-exit__card{position:relative;max-width:420px;width:100%;border-radius:16px;overflow:hidden;background:#120a0d;background-image:radial-gradient(130% 110% at 50% -14%,#6e0020 0%,#38040f 48%,#120a0d 80%);padding:44px 32px 36px;text-align:center;box-shadow:0 24px 70px rgba(0,0,0,0.55)}' +
    '.wype-exit__close{position:absolute;top:12px;right:16px;background:none;border:none;color:rgba(255,255,255,0.6);font-size:26px;line-height:1;cursor:pointer}' +
    '.wype-exit__pct{font-size:56px;font-weight:900;color:#fff;letter-spacing:-2px;margin:6px 0 2px}' +
    '@media(max-width:480px){.wype-cap__title{font-size:22px}}';
  document.head.appendChild(css);

  function formHtml(idPrefix) {
    return '<p class="wype-cap__kicker">First order offer</p>' +
      '<h3 class="wype-cap__title">Get 10% off your first order</h3>' +
      '<p class="wype-cap__sub">Join the list for your welcome code, restock alerts and new drops. No spam, unsubscribe anytime.</p>' +
      '<form class="wype-cap__form" id="' + idPrefix + 'Form">' +
      '<input class="wype-cap__input" id="' + idPrefix + 'Email" type="email" required placeholder="Your email address" autocomplete="email">' +
      '<button class="wype-cap__btn" id="' + idPrefix + 'Btn" type="submit">Get 10% off</button>' +
      '</form><p class="wype-cap__msg" id="' + idPrefix + 'Msg"></p>';
  }

  function wireForm(idPrefix, source, onSuccess) {
    var form = document.getElementById(idPrefix + 'Form');
    if (!form) return;
    form.addEventListener('submit', function (ev) {
      ev.preventDefault();
      var email = document.getElementById(idPrefix + 'Email').value.trim();
      var btn = document.getElementById(idPrefix + 'Btn');
      var msg = document.getElementById(idPrefix + 'Msg');
      if (!email) return;
      btn.disabled = true;
      fetch('/api/subscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email, source: source })
      }).then(function (r) { return r.json(); }).then(function (data) {
        if (data && data.ok) {
          msg.classList.remove('wype-cap__msg--err');
          msg.textContent = 'Check your inbox, your 10% code is on its way.';
          try { localStorage.setItem(DONE_KEY, '1'); } catch (e) {}
          if (window.wypeTrack) window.wypeTrack('generate_lead', { value: 0 });
          if (onSuccess) setTimeout(onSuccess, 1800);
        } else {
          msg.classList.add('wype-cap__msg--err');
          msg.textContent = (data && data.error) || 'Something went wrong. Please try again.';
          btn.disabled = false;
        }
      }).catch(function () {
        msg.classList.add('wype-cap__msg--err');
        msg.textContent = 'Something went wrong. Please try again.';
        btn.disabled = false;
      });
    });
  }

  /* ── Footer band on every customer page ── */
  if (!subscribed) {
    var footer = document.querySelector('footer');
    if (footer) {
      var band = document.createElement('section');
      band.className = 'wype-cap';
      band.innerHTML = formHtml('wypeCapF');
      footer.parentNode.insertBefore(band, footer);
      wireForm('wypeCapF', 'footer');
    }
  }

  /* ── Exit-intent popup: homepage + product pages only ── */
  var popupPages = /^\/(index\.html)?$|nanowype-plus|wype-plus/.test(location.pathname);
  var dismissedAt = 0;
  try { dismissedAt = parseInt(localStorage.getItem(DISMISS_KEY) || '0', 10); } catch (e) {}
  var dismissedRecently = dismissedAt && (Date.now() - dismissedAt) < DISMISS_DAYS * 864e5;

  if (popupPages && !subscribed && !dismissedRecently) {
    var shown = false;
    function showPopup() {
      if (shown) return;
      shown = true;
      var wrap = document.createElement('div');
      wrap.className = 'wype-exit';
      wrap.innerHTML = '<div class="wype-exit__card">' +
        '<button class="wype-exit__close" id="wypeExitClose" aria-label="Close">&times;</button>' +
        '<p class="wype-cap__kicker">Before you go</p>' +
        '<div class="wype-exit__pct">10% off</div>' +
        '<p class="wype-cap__sub">your first order, straight to your inbox.</p>' +
        '<form class="wype-cap__form" id="wypeCapXForm">' +
        '<input class="wype-cap__input" id="wypeCapXEmail" type="email" required placeholder="Your email address" autocomplete="email">' +
        '<button class="wype-cap__btn" id="wypeCapXBtn" type="submit">Send my code</button>' +
        '</form><p class="wype-cap__msg" id="wypeCapXMsg"></p></div>';
      document.body.appendChild(wrap);
      function close() {
        try { localStorage.setItem(DISMISS_KEY, String(Date.now())); } catch (e) {}
        wrap.remove();
      }
      document.getElementById('wypeExitClose').addEventListener('click', close);
      wrap.addEventListener('click', function (ev) { if (ev.target === wrap) close(); });
      wireForm('wypeCapX', 'exit-intent', function () { wrap.remove(); });
    }
    /* Desktop: cursor leaves viewport top. Mobile: 25s dwell. */
    document.addEventListener('mouseout', function (ev) {
      if (!ev.relatedTarget && ev.clientY <= 0) showPopup();
    });
    if (window.matchMedia && window.matchMedia('(pointer: coarse)').matches) {
      setTimeout(showPopup, 25000);
    }
  }
})();
