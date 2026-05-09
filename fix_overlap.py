html = open('index.html').read()

old = '''      .product-proof__video-card:nth-child(1) {
        transform: rotate(-8deg);
        right: 440px;
        z-index: 1;
      }
      .product-proof__video-card:nth-child(2) {
        transform: rotate(-2deg);
        right: 240px;
        z-index: 2;
      }
      .product-proof__video-card:nth-child(3) {
        transform: rotate(5deg);
        right: 20px;
        z-index: 3;
      }'''

new = '''      .product-proof__video-card:nth-child(1) {
        transform: rotate(-8deg);
        right: 320px;
        z-index: 1;
      }
      .product-proof__video-card:nth-child(2) {
        transform: rotate(-1deg);
        right: 120px;
        z-index: 2;
      }
      .product-proof__video-card:nth-child(3) {
        transform: rotate(6deg);
        right: -60px;
        z-index: 3;
      }'''

if old in html:
    html = html.replace(old, new, 1)
    open('index.html', 'w').write(html)
    print('Done!')
else:
    print('Not found')
