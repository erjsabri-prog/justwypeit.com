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
    /* ── footer band ── */
    '.wype-cap{background:#0f0e0d;padding:60px 20px;text-align:center}' +
    '.wype-cap__kicker{font-family:Inter,"Helvetica Neue",Arial,sans-serif;font-size:10px;font-weight:700;letter-spacing:.24em;text-transform:uppercase;color:rgba(255,255,255,.55);margin:0 0 14px}' +
    '.wype-cap__title{font-family:Inter,"Helvetica Neue",Arial,sans-serif;font-size:26px;font-weight:700;color:#fff;margin:0 0 10px;letter-spacing:-.02em}' +
    '.wype-cap__sub{font-size:14px;line-height:1.6;color:rgba(255,255,255,.62);margin:0 auto 26px;max-width:420px}' +
    '.wype-cap__form{display:flex;gap:0;justify-content:center;max-width:420px;margin:0 auto}' +
    '.wype-cap__input{flex:1 1 auto;min-width:0;padding:14px 16px;border:1px solid rgba(255,255,255,.35);border-right:none;background:transparent;color:#fff;font-size:14px;outline:none;border-radius:0}' +
    '.wype-cap__input::placeholder{color:rgba(255,255,255,.4)}' +
    '.wype-cap__input:focus{border-color:#fff}' +
    '.wype-cap__btn{padding:14px 24px;border:1px solid #fff;background:#fff;color:#111;font-size:11px;font-weight:700;letter-spacing:.16em;text-transform:uppercase;cursor:pointer;border-radius:0}' +
    '.wype-cap__btn:disabled{opacity:.55;cursor:default}' +
    '.wype-cap__msg{font-size:13px;margin:16px 0 0;color:#9be0a8;min-height:16px}' +
    '.wype-cap__msg--err{color:#ffb3b3}' +

    /* animations.js tags injected headings with its scroll-reveal and ours
       never completed — it froze at 27% opacity, 20px down, overlapping the
       copy. These elements opt out of that system entirely. */
    '.wype-cap, .wype-cap *, .wype-exit, .wype-exit *{opacity:1 !important;transform:none !important;transition:none !important}' +
    '.wype-exit__btn:hover{background:#E01E1E}' +

    /* ── signup modal: photo left, form right ── */
    '.wype-exit{position:fixed;inset:0;background:rgba(12,10,9,.55);z-index:99999;display:flex;align-items:center;justify-content:center;padding:20px}' +
    '.wype-exit__card{position:relative;display:flex;width:100%;max-width:880px;max-height:calc(100vh - 40px);background:#fff;overflow:hidden;box-shadow:0 30px 90px rgba(0,0,0,.35)}' +
    '.wype-exit__photo{flex:0 0 46%;position:relative;overflow:hidden;background:#e9e6e2}' +
    '.wype-exit__photo img{width:100%;height:100%;object-fit:cover;object-position:50% 42%;display:block}' +
    '.wype-exit__panel{flex:1 1 auto;padding:52px 52px 46px;display:flex;flex-direction:column;justify-content:center;overflow-y:auto}' +
    '.wype-exit__close{position:absolute;top:16px;right:16px;width:32px;height:32px;background:none;border:none;color:#111;font-size:22px;line-height:1;cursor:pointer;padding:0;display:flex;align-items:center;justify-content:center;opacity:.65}' +
    '.wype-exit__close:hover{opacity:1}' +
    '.wype-exit__label{font-family:Inter,"Helvetica Neue",Arial,sans-serif;font-size:11px;font-weight:700;letter-spacing:.22em;text-transform:uppercase;color:#111;text-align:center;margin:0 0 18px}' +
    '.wype-exit__title{font-family:Inter,"Helvetica Neue",Arial,sans-serif;font-size:23px;font-weight:700;letter-spacing:-.02em;color:#111;margin:0 0 12px;line-height:1.2}' +
    '.wype-exit__title em{font-style:normal;color:#E01E1E}' +
    '.wype-exit__sub2{font-size:14px;line-height:1.65;color:#4a4744;margin:0 0 26px}' +
    '.wype-exit__field{font-size:10px;font-weight:700;letter-spacing:.2em;text-transform:uppercase;color:#111;display:block;margin:0 0 8px}' +
    '.wype-exit__input{width:100%;box-sizing:border-box;padding:13px 14px;border:1px solid #111;background:#fff;color:#111;font-size:14px;outline:none;border-radius:0}' +
    '.wype-exit__input:focus{box-shadow:inset 0 0 0 1px #111}' +
    '.wype-exit__fine{font-size:11.5px;line-height:1.55;color:#8f8c89;margin:16px 0 20px}' +
    '.wype-exit__btn{width:100%;padding:16px;border:none;background:#111;color:#fff;font-family:Inter,"Helvetica Neue",Arial,sans-serif;font-size:11px;font-weight:700;letter-spacing:.2em;cursor:pointer;text-transform:uppercase;border-radius:0}' +
    '.wype-exit__btn:hover{background:#E01E1E}' +
    '.wype-exit__btn:disabled{opacity:.55;cursor:default}' +
    '.wype-exit__no{display:block;margin:16px auto 0;background:none;border:none;font-size:12px;letter-spacing:.06em;color:#8f8c89;cursor:pointer;text-decoration:underline;text-underline-offset:3px}' +
    '.wype-exit__msg{font-size:13px;margin:14px 0 0;color:#118a44;min-height:16px}' +
    '.wype-exit__msg.wype-cap__msg--err{color:#c02020}' +
    '@media(max-width:760px){' +
      '.wype-exit__card{flex-direction:column;max-width:420px}' +
      '.wype-exit__photo{flex:0 0 150px}' +
      '.wype-exit__photo img{object-position:50% 38%}' +
      '.wype-exit__panel{padding:32px 26px 30px}' +
      '.wype-exit__title{font-size:20px}' +
    '}' +
    '@media(max-width:480px){.wype-cap__title{font-size:21px}.wype-cap__form{flex-direction:column;gap:10px}' +
      '.wype-cap__input{border-right:1px solid rgba(255,255,255,.35)}}';
  document.head.appendChild(css);

  function formHtml(idPrefix) {
    return '<p class="wype-cap__kicker">First order offer</p>' +
      '<h3 class="wype-cap__title">10% off your first order</h3>' +
      '<p class="wype-cap__sub">Join the list for your welcome code, restock alerts and new drops. No spam, unsubscribe any time.</p>' +
      '<form class="wype-cap__form" id="' + idPrefix + 'Form">' +
      '<input class="wype-cap__input" id="' + idPrefix + 'Email" type="email" required placeholder="Your email address" autocomplete="email">' +
      '<button class="wype-cap__btn" id="' + idPrefix + 'Btn" type="submit">Sign up</button>' +
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

  /* ?signup=1 or #signup force-opens it, ignoring the dismissal window —
     handy for checking the design without clearing site data. */
  var forced = /[?&]signup=1/.test(location.search) || location.hash === '#signup';

  if (popupPages && (forced || (!subscribed && !dismissedRecently))) {
    var shown = false;
    function showPopup() {
      if (shown) return;
      shown = true;
      var wrap = document.createElement('div');
      wrap.className = 'wype-exit';
      wrap.innerHTML = '<div class="wype-exit__card" role="dialog" aria-modal="true" aria-label="Sign up for 10% off">' +
        '<div class="wype-exit__photo"><img src="assets/signup-stand.jpg" alt=""></div>' +
        '<div class="wype-exit__panel">' +
        '<button class="wype-exit__close" id="wypeExitClose" aria-label="Close">&times;</button>' +
        '<p class="wype-exit__label">Sign up</p>' +
        '<h3 class="wype-exit__title"><em>10% off</em> your first order</h3>' +
        '<p class="wype-exit__sub2">Be first to hear about new drops, restocks and the odd offer. Your code lands in your inbox straight away.</p>' +
        '<form id="wypeCapXForm">' +
        '<label class="wype-exit__field" for="wypeCapXEmail">Email</label>' +
        '<input class="wype-exit__input" id="wypeCapXEmail" type="email" required placeholder="you@example.com" autocomplete="email">' +
        '<p class="wype-exit__fine">Submitting confirms you have read our privacy policy. We never share your details, and you can unsubscribe any time.</p>' +
        '<button class="wype-exit__btn" id="wypeCapXBtn" type="submit">Get my 10% code</button>' +
        '</form><p class="wype-exit__msg" id="wypeCapXMsg"></p>' +
        '<button class="wype-exit__no" id="wypeExitNo" type="button">No thanks</button>' +
        '</div></div>';
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
    /* Popup shows on arrival; exit-intent and scroll kept as fallbacks. */
    if (forced) {
      showPopup();
    } else {
      document.addEventListener('mouseout', function (ev) {
        if (!ev.relatedTarget && ev.clientY <= 0) showPopup();
      });

      /* Show straight away on arrival (1s lets the page paint first). */
      setTimeout(showPopup, 1000);

      var onScroll = function () {
        var doc = document.documentElement;
        var scrollable = doc.scrollHeight - window.innerHeight;
        if (scrollable > 400 && (window.scrollY / scrollable) >= 0.55) {
          window.removeEventListener('scroll', onScroll);
          showPopup();
        }
      };
      window.addEventListener('scroll', onScroll, { passive: true });
    }
  }

  /* Manual trigger for the console: wypeShowSignup() */
  window.wypeShowSignup = function () {
    try {
      localStorage.removeItem(DISMISS_KEY);
      localStorage.removeItem(DONE_KEY);
    } catch (e) {}
    location.href = location.pathname + '?signup=1';
  };
})();
