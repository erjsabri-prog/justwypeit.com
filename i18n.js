/* wype® language switcher
 * Translates the shop UI in place, keyed on the English source text.
 * Dictionaries live in /i18n/<lang>.json — any string missing from a
 * dictionary simply stays in English, so partial coverage is safe.
 */
(function () {
  'use strict';

  var LANGS = {
    en: { label: 'English',    short: 'EN', flag: 'gb', htmlLang: 'en',    checkout: 'en-GB' },
    de: { label: 'Deutsch',    short: 'DE', flag: 'de', htmlLang: 'de',    checkout: 'de'    },
    fr: { label: 'Français',   short: 'FR', flag: 'fr', htmlLang: 'fr',    checkout: 'fr'    },
    es: { label: 'Español',    short: 'ES', flag: 'es', htmlLang: 'es',    checkout: 'es'    },
    it: { label: 'Italiano',   short: 'IT', flag: 'it', htmlLang: 'it',    checkout: 'it'    },
    nl: { label: 'Nederlands', short: 'NL', flag: 'nl', htmlLang: 'nl',    checkout: 'nl'    }
  };

  var COUNTRY_LANG = {
    DE: 'de', FR: 'fr', ES: 'es', IT: 'it', NL: 'nl', BE: 'nl',
    GB: 'en', IE: 'en', US: 'en', CA: 'en', AU: 'en', NZ: 'en', ZZ: 'en'
  };

  var ATTRS = ['placeholder', 'aria-label', 'title', 'alt'];

  // Bump when a dictionary changes so visitors don't keep a stale copy.
  var DICT_VERSION = '5';

  // Never touched: prices rewritten by country-selector.js, code, inputs.
  var SKIP_TAGS = { SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, SVG: 1, PATH: 1, CODE: 1, PRE: 1, TEXTAREA: 1, IFRAME: 1, VIDEO: 1, AUDIO: 1, CANVAS: 1 };

  var dict = {};          // active dictionary: english -> translated
  var current = 'en';
  var applying = false;
  var observer = null;
  var pending = null;

  /* ---------- storage ---------- */

  function store(key, value) {
    try { localStorage.setItem(key, value); } catch (e) { /* private mode */ }
  }
  function read(key) {
    try { return localStorage.getItem(key); } catch (e) { return null; }
  }

  function inferLang() {
    var saved = read('wype_lang');
    if (saved && LANGS[saved]) return saved;
    var country = read('wype_country');
    if (country && COUNTRY_LANG[country]) return COUNTRY_LANG[country];
    var nav = (navigator.language || 'en').slice(0, 2).toLowerCase();
    return LANGS[nav] ? nav : 'en';
  }

  /* ---------- translation ---------- */

  var FLAG = /^([\uD83C][\uDDE6-\uDDFF][\uD83C][\uDDE6-\uDDFF]\s*)?/;

  function lookupExact(key) {
    var hit = dict[key];
    return (hit && hit !== key) ? hit : null;
  }

  function lookup(text) {
    var key = text.replace(/\s+/g, ' ').trim();
    if (!key) return null;
    var hit = lookupExact(key);
    if (hit) return hit;

    // Compound labels like "🇩🇪 Germany · EUR €" — translate the parts we know
    // and leave currencies, flags and sizes alone.
    if (key.indexOf(' · ') === -1) return null;
    var translatedAny = false;
    var parts = key.split(' · ').map(function (part) {
      var flag = (part.match(FLAG) || [''])[0];
      var body = part.slice(flag.length);
      var partHit = lookupExact(body);
      if (partHit) translatedAny = true;
      return flag + (partHit || body);
    });
    return translatedAny ? parts.join(' · ') : null;
  }

  function skipElement(el) {
    for (var node = el; node && node !== document.body; node = node.parentElement) {
      if (SKIP_TAGS[node.tagName]) return true;
      if (node.hasAttribute && (node.hasAttribute('data-no-i18n') ||
                                node.hasAttribute('data-gbp') ||
                                node.getAttribute('translate') === 'no')) return true;
    }
    return false;
  }

  function translateTextNode(node) {
    if (node.__wypeEn === undefined) {
      if (!/[A-Za-z]{2}/.test(node.nodeValue)) return;   // numbers, symbols, prices
      node.__wypeEn = node.nodeValue;
    }
    var original = node.__wypeEn;
    var hit = lookup(original);
    var next = hit === null ? original
             : original.replace(/^(\s*)([\s\S]*?)(\s*)$/, function (_, lead, __, tail) {
                 return lead + hit + tail;
               });
    if (node.nodeValue !== next) node.nodeValue = next;
  }

  function translateAttrs(el) {
    for (var i = 0; i < ATTRS.length; i++) {
      var name = ATTRS[i];
      if (!el.hasAttribute(name)) continue;
      var cacheKey = '__wypeAttr_' + name;
      if (el[cacheKey] === undefined) el[cacheKey] = el.getAttribute(name);
      var original = el[cacheKey];
      var hit = lookup(original);
      el.setAttribute(name, hit === null ? original : hit);
    }
  }

  function translateTree(root) {
    if (root.nodeType === Node.TEXT_NODE) {
      if (root.parentElement && !skipElement(root.parentElement)) translateTextNode(root);
      return;
    }
    if (root.nodeType !== Node.ELEMENT_NODE) return;
    if (skipElement(root)) return;

    var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: function (node) {
        var parent = node.parentElement;
        if (!parent) return NodeFilter.FILTER_REJECT;
        if (SKIP_TAGS[parent.tagName]) return NodeFilter.FILTER_REJECT;
        if (parent.hasAttribute('data-no-i18n') || parent.hasAttribute('data-gbp') ||
            parent.getAttribute('translate') === 'no') return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    var batch = [];
    var node;
    while ((node = walker.nextNode())) batch.push(node);
    for (var i = 0; i < batch.length; i++) {
      if (!skipElement(batch[i].parentElement)) translateTextNode(batch[i]);
    }

    if (root.matches && root.matches('[placeholder],[aria-label],[title],[alt]')) translateAttrs(root);
    var attrEls = root.querySelectorAll('[placeholder],[aria-label],[title],[alt]');
    for (var j = 0; j < attrEls.length; j++) {
      if (!skipElement(attrEls[j])) translateAttrs(attrEls[j]);
    }
  }

  function applyAll() {
    applying = true;
    if (document.__wypeTitleEn === undefined) document.__wypeTitleEn = document.title;
    var titleHit = lookup(document.__wypeTitleEn);
    document.title = titleHit === null ? document.__wypeTitleEn : titleHit;
    translateTree(document.body);
    document.documentElement.lang = LANGS[current].htmlLang;
    document.documentElement.setAttribute('data-wype-lang', current);
    if (observer) observer.takeRecords();
    applying = false;
  }

  /* ---------- dynamic content (cart, checkout, order tracking) ---------- */

  function startObserver() {
    if (observer || !window.MutationObserver) return;
    observer = new MutationObserver(function (records) {
      if (applying || current === 'en') return;
      var roots = [];
      for (var i = 0; i < records.length; i++) {
        var rec = records[i];
        if (rec.type === 'characterData') roots.push(rec.target);
        for (var j = 0; j < rec.addedNodes.length; j++) roots.push(rec.addedNodes[j]);
      }
      if (!roots.length) return;
      clearTimeout(pending);
      pending = setTimeout(function () {
        applying = true;
        for (var k = 0; k < roots.length; k++) {
          var node = roots[k];
          if (node.isConnected) translateTree(node);
        }
        observer.takeRecords();
        applying = false;
      }, 30);
    });
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
  }

  /* ---------- dictionary loading ---------- */

  var cache = {};

  function loadDict(lang) {
    if (lang === 'en') return Promise.resolve({});
    if (cache[lang]) return Promise.resolve(cache[lang]);
    return fetch('i18n/' + lang + '.json?v=' + DICT_VERSION)
      .then(function (res) { return res.ok ? res.json() : {}; })
      .then(function (data) { cache[lang] = data; return data; })
      .catch(function () { return {}; });
  }

  /* ---------- checkout / Stripe locale sync ---------- */

  function syncCheckoutLocale(lang) {
    var select = document.getElementById('coLanguage');
    if (!select) return;
    var wanted = LANGS[lang].checkout;
    var found = false;
    for (var i = 0; i < select.options.length; i++) {
      if (select.options[i].value === wanted) { found = true; break; }
    }
    if (!found) {
      var opt = document.createElement('option');
      opt.value = wanted;
      opt.textContent = LANGS[lang].label;
      select.appendChild(opt);
    }
    if (select.value === wanted) return;
    select.value = wanted;
    if (typeof window.onLocaleChange === 'function') window.onLocaleChange();
  }

  /* ---------- switcher UI ---------- */

  function optionsMarkup() {
    return Object.keys(LANGS).map(function (code) {
      return '<option value="' + code + '">' + LANGS[code].label + '</option>';
    }).join('');
  }

  function renderPickers() {
    var data = LANGS[current];
    var pickers = document.querySelectorAll('[data-lang-picker]');
    for (var i = 0; i < pickers.length; i++) {
      var wrap = pickers[i];
      var flag = wrap.querySelector('[data-lang-flag]');
      var text = wrap.querySelector('[data-lang-text]');
      var select = wrap.querySelector('[data-lang-select]');
      if (flag) flag.style.backgroundImage = 'url(https://flagcdn.com/w40/' + data.flag + '.png)';
      if (text) text.textContent = data.short;
      if (select) select.value = current;
      wrap.setAttribute('title', 'Language · ' + data.label);
    }
  }

  function buildPicker(className) {
    var label = document.createElement('label');
    label.className = className;
    label.setAttribute('data-lang-picker', '');
    label.setAttribute('data-no-i18n', '');
    label.setAttribute('aria-label', 'Select language');
    label.innerHTML =
      '<span class="wype-lang__flag" data-lang-flag></span>' +
      '<span class="wype-lang__text" data-lang-text>EN</span>' +
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><polyline points="6 9 12 15 18 9"/></svg>' +
      '<select class="wype-lang__select" data-lang-select aria-label="Language">' + optionsMarkup() + '</select>';
    return label;
  }

  function injectStyles() {
    if (document.getElementById('wypeLangStyles')) return;
    var style = document.createElement('style');
    style.id = 'wypeLangStyles';
    style.textContent = [
      '.wype-lang, .wype-lang--float { position: relative; display: inline-flex; align-items: center; gap: 7px; cursor: pointer; }',
      '.wype-lang__flag { width: 20px; height: 14px; border-radius: 2px; background-size: cover; background-position: center; flex-shrink: 0; box-shadow: 0 0 0 1px rgba(0,0,0,0.08); }',
      '.wype-lang__text { font-size: 12px; font-weight: 900; letter-spacing: 0.05em; }',
      '.wype-lang svg, .wype-lang--float svg { width: 11px; height: 11px; }',
      '.wype-lang__select { position: absolute; inset: 0; width: 100%; height: 100%; opacity: 0; cursor: pointer; }',
      '.wype-lang--float { position: fixed; top: 18px; right: 148px; z-index: 10050; min-height: 44px; padding: 0 14px;',
      '  border-radius: 999px; border: 2px solid rgba(224,30,30,0.9); background: rgba(255,255,255,0.98); color: #111;',
      '  box-shadow: 0 10px 34px rgba(0,0,0,0.18); font-family: Inter, Arial, sans-serif; font-weight: 900; backdrop-filter: blur(12px); }',
      '.wype-lang--float.wype-lang--solo { right: 18px; }',
      '@media (max-width: 1180px) { .wype-lang--float { top: 84px; right: 142px; } .wype-lang--float.wype-lang--solo { right: 12px; } }',
      '@media (max-width: 1024px) { .wype-lang--float { top: auto; bottom: 12px; right: 128px; min-height: 42px; padding: 0 12px; } .wype-lang--float.wype-lang--solo { right: 12px; } }',
      '.nav__panel-lang { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-top: 10px; }',
      '.nav__panel-lang-label { font-size: 11px; letter-spacing: 0.12em; text-transform: uppercase; opacity: 0.7; }',
      // Translations run longer than English; keep the desktop nav off the logo.
      '@media (min-width: 1025px) {',
      '  html[data-wype-lang]:not([data-wype-lang="en"]) #nav.nav .nav__left,',
      '  html[data-wype-lang]:not([data-wype-lang="en"]) #nav.nav .nav__right { gap: 14px !important; }',
      '  html[data-wype-lang]:not([data-wype-lang="en"]) #nav.nav .nav__link,',
      '  html[data-wype-lang]:not([data-wype-lang="en"]) #nav.nav .nav__products-btn { font-size: 15px !important; }',
      '  html[data-wype-lang]:not([data-wype-lang="en"]) #nav.nav .nav__products-btn { padding: 0 18px !important; }',
      '}',
      '@media (min-width: 1025px) and (max-width: 1340px) {',
      '  html[data-wype-lang]:not([data-wype-lang="en"]) #nav.nav .nav__link--hide-sm { display: none !important; }',
      '}'
    ].join('\n');
    document.head.appendChild(style);
  }

  function injectPickers() {
    // 1. Desktop nav — sit beside the existing country pill and borrow its styling.
    var navCountry = document.querySelector('.nav__country[data-country-picker]');
    if (navCountry && !navCountry.parentElement.querySelector('[data-lang-picker]')) {
      var navPicker = buildPicker('nav__country wype-lang');
      navCountry.parentElement.insertBefore(navPicker, navCountry);
    }

    // 2. Slide-out menu panel.
    var panelCountry = document.querySelector('.nav__panel-country');
    if (panelCountry && !panelCountry.querySelector('[data-lang-picker]')) {
      var row = document.createElement('div');
      row.className = 'nav__panel-lang';
      row.setAttribute('data-no-i18n', '');
      var text = document.createElement('span');
      text.className = 'nav__panel-lang-label';
      text.textContent = 'Language';
      row.appendChild(text);
      row.appendChild(buildPicker('nav__panel-country-badge wype-lang'));
      panelCountry.appendChild(row);
    }

    // 3. Pages without a nav pill get a floating one next to the country switcher.
    if (!document.querySelector('[data-lang-picker]')) {
      document.body.appendChild(buildPicker('wype-lang--float'));
    }
    positionFloatingPicker();
  }

  function positionFloatingPicker() {
    var float = document.querySelector('.wype-lang--float');
    if (!float) return;
    float.classList.toggle('wype-lang--solo', !document.getElementById('wypeCountrySwitcher'));
  }

  function bindPickers() {
    var selects = document.querySelectorAll('[data-lang-select]');
    for (var i = 0; i < selects.length; i++) {
      if (selects[i].__wypeBound) continue;
      selects[i].__wypeBound = true;
      selects[i].addEventListener('change', function (e) {
        store('wype_lang_manual', '1');
        setLang(e.target.value);
        e.target.blur();
      });
    }
  }

  /* ---------- public API ---------- */

  function setLang(lang) {
    if (!LANGS[lang]) lang = 'en';
    return loadDict(lang).then(function (data) {
      dict = data;
      current = lang;
      store('wype_lang', lang);
      renderPickers();
      applyAll();
      syncCheckoutLocale(lang);
      window.dispatchEvent(new CustomEvent('wype:languagechange', { detail: { lang: lang } }));
      return lang;
    });
  }

  window.wypeI18n = {
    set: setLang,
    get: function () { return current; },
    languages: LANGS,
    refresh: function () { if (current !== 'en') applyAll(); },
    // Logs every on-page string with no translation — for extending the dictionaries.
    missing: function () {
      var out = {};
      var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null);
      var node;
      while ((node = walker.nextNode())) {
        var raw = node.__wypeEn !== undefined ? node.__wypeEn : node.nodeValue;
        var key = raw.replace(/\s+/g, ' ').trim();
        if (key && /[A-Za-z]{2}/.test(key) && !lookup(key) && !skipElement(node.parentElement)) out[key] = '';
      }
      console.log(JSON.stringify(out, null, 2));
      return out;
    }
  };

  /* ---------- boot ---------- */

  function init() {
    injectStyles();
    injectPickers();
    bindPickers();
    startObserver();
    setLang(inferLang());

    // Picking a country switches language too, unless the visitor chose one.
    window.addEventListener('wype:countrychange', function (e) {
      var mapped = COUNTRY_LANG[e.detail && e.detail.country];
      if (mapped && !read('wype_lang_manual') && mapped !== current) setLang(mapped);
      else if (current !== 'en') setTimeout(applyAll, 0);   // prices just re-rendered
    });

    window.addEventListener('resize', function () {
      injectPickers();
      bindPickers();
      renderPickers();
    });

    // country-selector.js injects its own floating pill slightly after us
    setTimeout(positionFloatingPicker, 300);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
