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
    '.wype-cap{background:#000;padding:52px 20px;text-align:center}' +
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
    '.wype-exit{position:fixed;inset:0;background:rgba(10,5,7,0.62);z-index:99999;display:flex;align-items:center;justify-content:center;padding:20px}' +
    '.wype-exit__card{position:relative;max-width:400px;width:100%;border-radius:20px;overflow:hidden;background:#ffffff;padding:40px 30px 28px;text-align:center;box-shadow:0 24px 70px rgba(0,0,0,0.45)}' +
    '.wype-exit__close{position:absolute;top:14px;right:14px;width:34px;height:34px;border-radius:50%;background:#efefef;border:none;color:#555;font-size:20px;line-height:1;cursor:pointer;display:flex;align-items:center;justify-content:center}' +
    '.wype-exit__title{font-family:"Rajdhani","Helvetica Neue",Arial,sans-serif;font-size:34px;font-weight:800;color:#111;line-height:1.08;letter-spacing:-0.5px;margin:0 0 4px}' +
    '.wype-exit__title span{color:#E01E1E}' +
    '.wype-exit__mascot{width:150px;height:auto;display:block;margin:14px auto 10px}' +
    '.wype-exit__sub2{font-size:15px;color:#444;margin:0 0 18px}' +
    '.wype-exit__input{width:100%;box-sizing:border-box;padding:14px 16px;border-radius:10px;border:1.5px solid #ddd;background:#fff;color:#111;font-size:15px;outline:none;text-align:left}' +
    '.wype-exit__input:focus{border-color:#E01E1E}' +
    '.wype-exit__btn{width:100%;margin-top:10px;padding:16px;border-radius:10px;border:none;background:#E01E1E;color:#fff;font-family:"Rajdhani","Helvetica Neue",Arial,sans-serif;font-size:18px;font-weight:800;letter-spacing:1.5px;cursor:pointer;text-transform:uppercase}' +
    '.wype-exit__btn:disabled{opacity:0.6;cursor:default}' +
    '.wype-exit__no{display:inline-block;margin-top:16px;background:none;border:none;font-size:15px;color:#333;cursor:pointer;text-decoration:none}' +
    '.wype-exit__msg{font-size:13px;margin:12px 0 0;color:#118a44;min-height:16px}' +
    '.wype-exit__msg.wype-cap__msg--err{color:#c02020}' +
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
    var footer = document.getElementById('footWave') || document.querySelector('footer');
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
        '<h3 class="wype-exit__title">We have a<br><span>gift</span> for you</h3>' +
        '<img class="wype-exit__mascot" src="assets/mascot-wype.png" alt="wype mascot">' +
        '<p class="wype-exit__sub2">Your personal 10% code is waiting below</p>' +
        '<form id="wypeCapXForm">' +
        '<input class="wype-exit__input" id="wypeCapXEmail" type="email" required placeholder="Email" autocomplete="email">' +
        '<button class="wype-exit__btn" id="wypeCapXBtn" type="submit">Get my gift &#127873;</button>' +
        '</form><p class="wype-exit__msg" id="wypeCapXMsg"></p>' +
        '<button class="wype-exit__no" id="wypeExitNo" type="button">No, thanks</button></div>';
      document.body.appendChild(wrap);
      function close() {
        try { localStorage.setItem(DISMISS_KEY, String(Date.now())); } catch (e) {}
        wrap.remove();
      }
      document.getElementById('wypeExitClose').addEventListener('click', close);
      document.getElementById('wypeExitNo').addEventListener('click', close);
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
