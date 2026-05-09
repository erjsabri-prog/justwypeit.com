html = open('index.html').read()

old = '''      .product-proof__videos {
        display: block;
        width: 100%;
        max-width: 430px;
        min-height: 520px;
        margin: 0 auto;
        padding: 12px 0 6px;
        position: relative;
        overflow: visible;
      }
      .product-proof__video-card {
        position: absolute;
        overflow: hidden;
        border-radius: 16px;
        aspect-ratio: 9 / 16;
        flex-shrink: 0;
        box-shadow: 0 18px 44px rgba(0,0,0,0.14);
      }
      .product-proof__video-card video {
        position: absolute;
        top: 0;
        left: 0;
        width: 100%;
        height: 100%;
        object-fit: cover;
        display: block;
      }
      /* Nano — side card */
      .product-proof__video-card--nano {
        width: min(100%, 230px);
        left: 12px;
        bottom: 0;
        transform: rotate(-7deg) !important;
        z-index: 1;
      }
      /* Micro */
      .product-proof__video-card--micro {
        width: min(100%, 205px);
        aspect-ratio: 9 / 16;
        right: 10px;
        top: 10px;
        transform: rotate(4deg) !important;
        z-index: 2;
      }'''

new = '''      .product-proof__videos {
        display: flex;
        flex-direction: row;
        align-items: flex-end;
        gap: 12px;
        width: 100%;
        max-width: 520px;
        margin: 0 auto;
        padding: 12px 0 6px;
      }
      .product-proof__video-card {
        position: relative;
        overflow: hidden;
        border-radius: 16px;
        aspect-ratio: 9 / 16;
        flex: 1;
        box-shadow: 0 18px 44px rgba(0,0,0,0.14);
      }
      .product-proof__video-card:nth-child(2) {
        transform: translateY(-24px);
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

if old in html:
    html = html.replace(old, new, 1)
    open('index.html', 'w').write(html)
    print('CSS updated!')
else:
    print('Not found')
