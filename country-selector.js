(function() {
  const COUNTRIES = {
    GB: { flagCode: 'gb', label: 'United Kingdom', currency: 'GBP' },
    NL: { flagCode: 'nl', label: 'Netherlands',    currency: 'EUR' },
    IE: { flagCode: 'ie', label: 'Ireland',         currency: 'EUR' },
    DE: { flagCode: 'de', label: 'Germany',         currency: 'EUR' },
    FR: { flagCode: 'fr', label: 'France',          currency: 'EUR' },
    BE: { flagCode: 'be', label: 'Belgium',         currency: 'EUR' },
    ES: { flagCode: 'es', label: 'Spain',           currency: 'EUR' },
    IT: { flagCode: 'it', label: 'Italy',           currency: 'EUR' },
    US: { flagCode: 'us', label: 'United States',   currency: 'USD' },
    CA: { flagCode: 'ca', label: 'Canada',          currency: 'GBP' },
    AU: { flagCode: 'au', label: 'Australia',       currency: 'AUD' },
    NZ: { flagCode: 'nz', label: 'New Zealand',     currency: 'NZD' },
    ZZ: { flagCode: null,  label: 'Other',           currency: 'GBP' },
  };

  const CURRENCIES = {
    GBP: { symbol: '£',   rate: 1    },
    EUR: { symbol: '€',   rate: 1.17 },
    USD: { symbol: '$',   rate: 1.26 },
    AUD: { symbol: 'A$',  rate: 1.94 },
    NZD: { symbol: 'NZ$', rate: 2.09 },
  };

  function updatePrices(currency) {
    const c = CURRENCIES[currency] || CURRENCIES.GBP;
    document.querySelectorAll('[data-gbp]').forEach(function(el) {
      const gbp = parseFloat(el.getAttribute('data-gbp'));
      el.textContent = c.symbol + (gbp * c.rate).toFixed(2);
    });
  }

  function flagUrl(code) {
    if (!code) return null;
    return 'https://flagcdn.com/w40/' + code + '.png';
  }

  function inferCountry() {
    const stored = localStorage.getItem('wype_country');
    if (stored && COUNTRIES[stored]) return stored;
    const language = (navigator.language || '').toLowerCase();
    if (language.startsWith('nl')) return 'NL';
    if (language.startsWith('de')) return 'DE';
    if (language.startsWith('fr')) return 'FR';
    if (language.startsWith('es')) return 'ES';
    if (language === 'en-us') return 'US';
    return 'GB';
  }

  function syncCheckoutCountry(country) {
    const checkoutCountry = document.getElementById('coCountry');
    if (!checkoutCountry) return;
    // Don't override a user's manual selection
    if (window._checkoutCountryUserSet) return;
    const changed = checkoutCountry.value !== country;
    if (!changed && country !== 'NL') return;
    checkoutCountry.value = country;
    if (typeof window.onCountryChange === 'function') window.onCountryChange();
  }

  function renderControl(select) {
    const data = COUNTRIES[select.value] || COUNTRIES.GB;
    const wrap = select.closest('[data-country-picker]');
    if (!wrap) return;
    const flagEl = wrap.querySelector('[data-country-flag]');
    const text = wrap.querySelector('[data-country-text]');
    if (flagEl) {
      const url = flagUrl(data.flagCode);
      if (url) {
        flagEl.setAttribute('data-has-img', '');
        flagEl.style.backgroundImage = 'url(' + url + ')';
        flagEl.textContent = '';
      } else {
        flagEl.removeAttribute('data-has-img');
        flagEl.style.backgroundImage = '';
        flagEl.textContent = '🌍';
      }
    }
    if (text) text.textContent = data.currency;
    wrap.setAttribute('title', 'Shopping from ' + data.label + ' · ' + data.currency);
  }

  function countryOptionsMarkup() {
    return Object.keys(COUNTRIES).map(function(code) {
      const country = COUNTRIES[code];
      return '<option value="' + code + '">' + country.label + ' · ' + country.currency + '</option>';
    }).join('');
  }

  function shouldUseFloatingPicker() {
    if (window.innerWidth > 1024) return false;
    return !document.querySelector('.nav [data-country-picker]');
  }

  function injectTopRightPicker() {
    if (!shouldUseFloatingPicker() || document.getElementById('wypeCountrySwitcher')) return;
    const switcher = document.createElement('label');
    switcher.id = 'wypeCountrySwitcher';
    switcher.className = 'wype-country-switcher';
    switcher.setAttribute('data-country-picker', '');
    switcher.setAttribute('aria-label', 'Select shopping country');
    switcher.innerHTML =
      '<span class="wype-country-switcher__label">Ship to</span>' +
      '<span class="wype-country-switcher__flag" data-country-flag></span>' +
      '<span class="wype-country-switcher__currency" data-country-text>GBP</span>' +
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><polyline points="6 9 12 15 18 9"/></svg>' +
      '<select class="wype-country-switcher__select" data-country-select aria-label="Shopping country">' + countryOptionsMarkup() + '</select>';
    document.body.appendChild(switcher);
  }

  function removeTopRightPicker() {
    const switcher = document.getElementById('wypeCountrySwitcher');
    if (switcher) switcher.remove();
  }

  function injectStyles() {
    if (document.getElementById('wypeCountrySwitcherStyles')) return;
    const style = document.createElement('style');
    style.id = 'wypeCountrySwitcherStyles';
    style.textContent = `
      .wype-country-switcher {
        position: fixed;
        top: 18px;
        right: 18px;
        z-index: 10050;
        min-height: 44px;
        display: inline-flex;
        align-items: center;
        gap: 8px;
        padding: 0 16px;
        border-radius: 999px;
        border: 2px solid rgba(224,30,30,0.9);
        background: rgba(255,255,255,0.98);
        color: #111;
        box-shadow: 0 10px 34px rgba(0,0,0,0.18);
        font-family: Inter, Arial, sans-serif;
        font-weight: 900;
        cursor: pointer;
        backdrop-filter: blur(12px);
      }
      .wype-country-switcher__label {
        font-size: 11px;
        letter-spacing: 0.12em;
        text-transform: uppercase;
        color: #e01e1e;
      }
      .wype-country-switcher__flag { display:flex; align-items:center; line-height:1; }
      .wype-country-switcher__currency { min-width: 28px; font-size: 12px; letter-spacing: 0.05em; }
      .wype-country-switcher svg { width: 11px; height: 11px; }
      .wype-country-switcher__select {
        position: absolute;
        inset: 0;
        width: 100%;
        height: 100%;
        opacity: 0;
        cursor: pointer;
      }
      @media (max-width: 1180px) {
        .wype-country-switcher { top: 84px; right: 12px; }
      }
      @media (max-width: 1024px) {
        .wype-country-switcher {
          top: auto;
          right: 12px;
          bottom: 12px;
          min-height: 42px;
          padding: 0 13px;
        }
        .wype-country-switcher__label { display: none; }
      }
      @media (max-width: 640px) {
        .wype-country-switcher {
          min-height: 42px;
          padding: 0 12px;
        }
      }
    `;
    document.head.appendChild(style);
  }

  function setCountry(country, sourceSelect) {
    if (!COUNTRIES[country]) country = 'GB';
    localStorage.setItem('wype_country', country);
    document.querySelectorAll('[data-country-select]').forEach(function(select) {
      select.value = country;
      renderControl(select);
    });
    updatePrices((COUNTRIES[country] || COUNTRIES.GB).currency);
    syncCheckoutCountry(country);
    window.dispatchEvent(new CustomEvent('wype:countrychange', { detail: { country } }));
    if (sourceSelect) sourceSelect.blur();
  }

  // Expose so checkout can sync the nav badge when billing country changes
  window.wygeSetCountry = setCountry;

  function init() {
    injectStyles();
    if (shouldUseFloatingPicker()) injectTopRightPicker();
    else removeTopRightPicker();
    const initial = inferCountry();
    document.querySelectorAll('[data-country-select]').forEach(function(select) {
      select.value = initial;
      renderControl(select);
      select.addEventListener('change', function() {
        setCountry(select.value, select);
      });
    });
    updatePrices((COUNTRIES[initial] || COUNTRIES.GB).currency);
    syncCheckoutCountry(initial);
  }

  window.addEventListener('resize', function() {
    const current = localStorage.getItem('wype_country') || inferCountry();
    if (shouldUseFloatingPicker()) {
      injectTopRightPicker();
      document.querySelectorAll('[data-country-select]').forEach(function(select) {
        select.value = current;
        renderControl(select);
      });
    } else {
      removeTopRightPicker();
    }
  });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
