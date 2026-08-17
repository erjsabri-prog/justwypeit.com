(function () {
  var COOKIE_KEY = 'wype_cookie_consent';

  function getCookie(name) {
    var match = document.cookie.match(new RegExp('(?:^|;\\s*)' + name + '=([^;]*)'));
    return match ? match[1] : null;
  }

  function setCookie(name, value, days) {
    var expires = new Date(Date.now() + days * 864e5).toUTCString();
    document.cookie = name + '=' + value + '; expires=' + expires + '; path=/; SameSite=Lax';
  }

  function removeBanner() {
    var banner = document.getElementById('wype-cookie-banner');
    if (banner) {
      banner.style.transform = 'translateY(120%)';
      banner.style.opacity = '0';
      setTimeout(function () { banner.remove(); }, 400);
    }
  }

  function accept() {
    setCookie(COOKIE_KEY, 'accepted', 365);
    removeBanner();
  }

  function decline() {
    setCookie(COOKIE_KEY, 'declined', 180);
    removeBanner();
  }

  function injectBanner() {
    var style = document.createElement('style');
    style.textContent = [
      '#wype-cookie-banner {',
      '  position: fixed;',
      '  bottom: 24px;',
      '  left: 50%;',
      '  transform: translateX(-50%) translateY(0);',
      '  width: calc(100% - 48px);',
      '  max-width: 780px;',
      '  background: #111;',
      '  color: #f7f7f7;',
      '  border-radius: 16px;',
      '  padding: 20px 24px;',
      '  box-shadow: 0 8px 40px rgba(0,0,0,0.32);',
      '  z-index: 999999;',
      '  display: flex;',
      '  align-items: center;',
      '  gap: 20px;',
      '  font-family: "Inter", "Rajdhani", sans-serif;',
      '  font-size: 14px;',
      '  line-height: 1.5;',
      '  transition: transform 0.4s cubic-bezier(0.4,0,0.2,1), opacity 0.4s ease;',
      '}',
      '#wype-cookie-banner .wcb-icon {',
      '  font-size: 26px;',
      '  flex-shrink: 0;',
      '}',
      '#wype-cookie-banner .wcb-text {',
      '  flex: 1;',
      '}',
      '#wype-cookie-banner .wcb-text strong {',
      '  display: block;',
      '  font-size: 15px;',
      '  font-weight: 600;',
      '  margin-bottom: 4px;',
      '  color: #fff;',
      '}',
      '#wype-cookie-banner .wcb-text a {',
      '  color: #E01E1E;',
      '  text-decoration: underline;',
      '  text-underline-offset: 2px;',
      '}',
      '#wype-cookie-banner .wcb-actions {',
      '  display: flex;',
      '  gap: 10px;',
      '  flex-shrink: 0;',
      '}',
      '#wype-cookie-banner .wcb-btn {',
      '  cursor: pointer;',
      '  border: none;',
      '  border-radius: 8px;',
      '  font-family: inherit;',
      '  font-size: 13px;',
      '  font-weight: 600;',
      '  padding: 10px 20px;',
      '  transition: opacity 0.2s;',
      '}',
      '#wype-cookie-banner .wcb-btn:hover { opacity: 0.85; }',
      '#wype-cookie-banner .wcb-accept {',
      '  background: #E01E1E;',
      '  color: #fff;',
      '}',
      '#wype-cookie-banner .wcb-decline {',
      '  background: rgba(255,255,255,0.1);',
      '  color: #aaa;',
      '  border: 1px solid rgba(255,255,255,0.15);',
      '}',
      '@media (max-width: 600px) {',
      '  #wype-cookie-banner {',
      '    flex-direction: column;',
      '    align-items: flex-start;',
      '    bottom: 12px;',
      '    left: 12px;',
      '    right: 12px;',
      '    width: auto;',
      '    transform: translateY(0);',
      '  }',
      '  #wype-cookie-banner .wcb-actions { width: 100%; }',
      '  #wype-cookie-banner .wcb-btn { flex: 1; text-align: center; }',
      '}'
    ].join('\n');
    document.head.appendChild(style);

    var banner = document.createElement('div');
    banner.id = 'wype-cookie-banner';
    banner.setAttribute('role', 'dialog');
    banner.setAttribute('aria-label', 'Cookie consent');
    banner.innerHTML = [
      '<span class="wcb-icon">🍪</span>',
      '<div class="wcb-text">',
      '  <strong>We use cookies</strong>',
      '  We use cookies to enhance your experience, analyse site traffic, and personalise content.',
      '  By clicking <strong>Accept</strong> you agree to our use of cookies.',
      '  Read our <a href="/privacy.html">Privacy Policy</a> for details.',
      '</div>',
      '<div class="wcb-actions">',
      '  <button class="wcb-btn wcb-accept" id="wcb-accept">Accept all</button>',
      '  <button class="wcb-btn wcb-decline" id="wcb-decline">Decline</button>',
      '</div>'
    ].join('');

    document.body.appendChild(banner);

    document.getElementById('wcb-accept').addEventListener('click', accept);
    document.getElementById('wcb-decline').addEventListener('click', decline);
  }

  function init() {
    if (getCookie(COOKIE_KEY)) return;
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', injectBanner);
    } else {
      injectBanner();
    }
  }

  init();
})();
