html = open('index.html').read()

old = '''      .product-proof__inner {
        max-width: 1240px;
        margin: 0 auto;
        display: grid;
        grid-template-columns: 1fr;
        gap: 28px;
        align-items: center;
      }'''

new = '''      .product-proof__inner {
        max-width: 1240px;
        margin: 0 auto;
        display: grid;
        grid-template-columns: 420px 1fr;
        gap: 48px;
        align-items: center;
      }'''

if old in html:
    html = html.replace(old, new, 1)
    open('index.html', 'w').write(html)
    print('Done!')
else:
    print('Not found')
