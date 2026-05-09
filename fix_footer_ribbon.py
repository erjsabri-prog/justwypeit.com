html = open('index.html').read()

old = '''  <!-- Footer ribbon -->
  <section class="ribbon-marquee ribbon-marquee--footer" aria-label="Just Wype It ribbon">
    <div class="ribbon-marquee__inner">'''

new = '''  <!-- Footer ribbon -->
  <section style="position:relative;overflow:hidden;height:110px;background:transparent;margin:0;padding:0;">
    <svg viewBox="0 0 800 110" preserveAspectRatio="none" xmlns="http://www.w3.org/2000/svg" style="position:absolute;top:0;left:0;width:100%;height:100%;z-index:0;">
      <path d="M0 20 C200 -5 600 -5 800 20 L800 90 C600 115 200 115 0 90 Z" fill="#d80000"/>
    </svg>
    <div style="position:absolute;top:0;left:0;width:100%;height:100%;display:flex;align-items:center;overflow:hidden;z-index:1;">
      <div class="rib2">
        <span style="font-family:Nunito,Arial,sans-serif;font-size:14px;font-weight:800;color:#fff;letter-spacing:2px;text-transform:uppercase;padding-right:24px;">NANO WYPE+™ &nbsp;✦&nbsp; MICRO WYPE+™ &nbsp;✦&nbsp; FREE UK DELIVERY &nbsp;✦&nbsp; RATED 4.9/5 &nbsp;✦&nbsp; NANO WYPE+™ &nbsp;✦&nbsp; MICRO WYPE+™ &nbsp;✦&nbsp; FREE UK DELIVERY &nbsp;✦&nbsp; RATED 4.9/5 &nbsp;✦&nbsp;</span>
        <span style="font-family:Nunito,Arial,sans-serif;font-size:14px;font-weight:800;color:#fff;letter-spacing:2px;text-transform:uppercase;padding-right:24px;">NANO WYPE+™ &nbsp;✦&nbsp; MICRO WYPE+™ &nbsp;✦&nbsp; FREE UK DELIVERY &nbsp;✦&nbsp; RATED 4.9/5 &nbsp;✦&nbsp; NANO WYPE+™ &nbsp;✦&nbsp; MICRO WYPE+™ &nbsp;✦&nbsp; FREE UK DELIVERY &nbsp;✦&nbsp; RATED 4.9/5 &nbsp;✦&nbsp;</span>
      </div>
    </div>
  </section>
  <div style="display:none;">'''

if old in html:
    html = html.replace(old, new, 1)
    open('index.html', 'w').write(html)
    print('Done!')
else:
    print('Target not found')
