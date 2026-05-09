html = open('index.html').read()

old = '''      .product-proof__inner {
        max-width: 1240px;
        margin: 0 auto;
        display: grid;
        grid-template-columns: 420px 1fr;
        gap: 48px;
        align-items: center;
      }'''

new = '''      .product-proof__inner {
        max-width: 1240px;
        margin: 0 auto;
        display: flex;
        flex-direction: row;
        align-items: center;
        gap: 0;
        overflow: visible;
      }
      .product-proof__copy {
        flex: 0 0 380px;
        z-index: 5;
      }'''

if old in html:
    html = html.replace(old, new, 1)
    print('Inner updated!')
else:
    print('Inner not found')

old2 = '''      .product-proof__videos {
        display: flex;
        flex-direction: row;
        align-items: center;
        gap: 16px;
        width: 100%;
        padding: 40px 0;
      }
      .product-proof__video-card {
        position: relative;
        overflow: hidden;
        border-radius: 20px;
        aspect-ratio: 9 / 16;
        flex: 1;
        box-shadow: 0 24px 60px rgba(0,0,0,0.18);
        transform: rotate(-4deg);
        transition: transform 0.3s ease;
      }
      .product-proof__video-card:nth-child(2) {
        transform: rotate(0deg) scale(1.06);
        z-index: 2;
      }
      .product-proof__video-card:nth-child(3) {
        transform: rotate(4deg);
      }
      .product-proof__video-card:hover {
        transform: rotate(0deg) scale(1.04);
        z-index: 3;
      }
      .product-proof__video-card video {
        position: absolute;
        top: 0;
        left: 0;
        width: 100%;
        height: 100%;
        object-fit: cover;
        display: block;
      }'''

new2 = '''      .product-proof__videos {
        flex: 1;
        display: flex;
        flex-direction: row;
        align-items: center;
        justify-content: flex-end;
        position: relative;
        height: 580px;
        padding-right: 20px;
      }
      .product-proof__video-card {
        position: absolute;
        overflow: hidden;
        border-radius: 24px;
        aspect-ratio: 9 / 16;
        height: 520px;
        box-shadow: 0 32px 80px rgba(0,0,0,0.22);
        transition: transform 0.3s ease, z-index 0s;
      }
      .product-proof__video-card:nth-child(1) {
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
      }
      .product-proof__video-card:hover {
        transform: rotate(0deg) scale(1.03);
        z-index: 10;
      }
      .product-proof__video-card video {
        position: absolute;
        top: 0;
        left: 0;
        width: 100%;
        height: 100%;
        object-fit: cover;
        display: block;
      }'''

if old2 in html:
    html = html.replace(old2, new2, 1)
    print('Videos updated!')
else:
    print('Videos not found')

open('index.html', 'w').write(html)
