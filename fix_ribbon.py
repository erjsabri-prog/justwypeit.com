html = open('index.html').read()

style = """<style>
.ribbon-mobile-marquee { display: none; background: #D80000; overflow: hidden; width: 100%; padding: 12px 0; }
.ribbon-mobile-marquee__band { width: 100%; overflow: hidden; }
.ribbon-mobile-marquee__track { display: inline-flex; white-space: nowrap; animation: ribbon-scroll 18s linear infinite; }
.ribbon-mobile-marquee__track span { font-family: Nunito, Arial, sans-serif; font-size: 13px; font-weight: 800; color: #fff; letter-spacing: 2px; text-transform: uppercase; padding-right: 40px; }
@keyframes ribbon-scroll { from { transform: translateX(0); } to { transform: translateX(-50%); } }
@media (max-width: 768px) { .ribbon-marquee__inner { display: none; } .ribbon-mobile-marquee { display: block; } }
</style>
"""

target = '<!-- FOOTER -->'
if target in html:
    html = html.replace(target, style + target, 1)
    open('index.html', 'w').write(html)
    print('Done!')
else:
    print('Target comment not found - check your HTML')
