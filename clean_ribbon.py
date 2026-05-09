html = open('index.html').read()

old = '''  <div style="display:none;">
      <div class="ribbon-marquee__track" aria-hidden="true">
        <svg class="ribbon-marquee__svg" viewBox="-300 0 3000 260" preserveAspectRatio="none" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="">
          <defs>
            <path id="ribbon-path-footer-a" d="M-240 138 C120 58 500 22 870 34 C1240 46 1610 112 1970 114 C2290 116 2560 86 2760 62"/>
          </defs>
          <use href="#ribbon-path-footer-a" fill="none" stroke="#D80000" stroke-width="132" stroke-linecap="round" stroke-linejoin="round"/>
          <text class="ribbon-marquee__text" fill="#ffffff" dominant-baseline="middle">
            <textPath href="#ribbon-path-footer-a" startOffset="0%">
              NANO WYPE+™  ✦  MICRO WYPE+™  ✦  FREE UK DELIVERY  ✦  RATED 4.9 / 5  ✦  NANO WYPE+™  ✦  MICRO WYPE+™  ✦  FREE UK DELIVERY  ✦  RATED 4.9 / 5  ✦
            </textPath>
          </text>
        </svg>
      </div>
      <div class="ribbon-marquee__track" aria-hidden="true">
        <svg class="ribbon-marquee__svg" viewBox="-300 0 3000 260" preserveAspectRatio="none" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="">
          <defs>
            <path id="ribbon-path-footer-b" d="M-240 138 C120 58 500 22 870 34 C1240 46 1610 112 1970 114 C2290 116 2560 86 2760 62"/>
          </defs>
          <use href="#ribbon-path-footer-b" fill="none" stroke="#D80000" stroke-width="132" stroke-linecap="round" stroke-linejoin="round"/>
          <text class="ribbon-marquee__text" fill="#ffffff" dominant-baseline="middle">
            <textPath href="#ribbon-path-footer-b" startOffset="0%">
              NANO WYPE+™  ✦  MICRO WYPE+™  ✦  FREE UK DELIVERY  ✦  RATED 4.9 / 5  ✦  NANO WYPE+™  ✦  MICRO WYPE+™  ✦  FREE UK DELIVERY  ✦  RATED 4.9 / 5  ✦
            </textPath>
          </text>
        </svg>
      </div>
    </div>
    <div class="ribbon-mobile-marquee" aria-hidden="true">
      <div class="ribbon-mobile-marquee__band">
        <div class="ribbon-mobile-marquee__track">
          <span>JustWypeIt · NanoWype+ · MicroWype+ · Free UK Delivery · Rated 4.9 / 5 ·</span>
          <span>JustWypeIt · NanoWype+ · MicroWype+ · Free UK Delivery · Rated 4.9 / 5 ·</span>
        </div>
      </div>
    </div>
  </section>'''

if old in html:
    html = html.replace(old, '', 1)
    open('index.html', 'w').write(html)
    print('Done!')
else:
    print('Target not found')
