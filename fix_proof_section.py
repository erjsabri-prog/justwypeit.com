html = open('index.html').read()

# Find and replace the entire product-proof section HTML (just the inner div, keeping the section tag)
old = '''      <div class="product-proof__videos" aria-label="Product demonstration videos">
        <div class="product-proof__video-card product-proof__video-card--nano">
          <video src="assets/nanowype-demo.mp4" autoplay muted loop playsinline preload="metadata"></video>
          <span class="product-proof__label">NanoWype+™</span>
        </div>
        <div class="product-proof__video-card product-proof__video-card--micro">
          <video src="assets/microwype-demo-portrait.mp4" autoplay muted loop playsinline preload="metadata"></video>
          <span class="product-proof__label">MicroWype+™</span>
        </div>
      </div>'''

new = '''      <div class="product-proof__videos" aria-label="Product demonstration videos">
        <div class="product-proof__video-card">
          <video src="assets/nanowype-demo.mp4" autoplay muted loop playsinline preload="metadata"></video>
          <span class="product-proof__label">NanoWype+™</span>
        </div>
        <div class="product-proof__video-card">
          <video src="assets/microwype-demo-portrait.mp4" autoplay muted loop playsinline preload="metadata"></video>
          <span class="product-proof__label">MicroWype+™</span>
        </div>
        <div class="product-proof__video-card">
          <video src="assets/thirdwype-demo-lite.mp4" autoplay muted loop playsinline preload="metadata"></video>
          <span class="product-proof__label">NanoWype+™</span>
        </div>
      </div>'''

if old in html:
    html = html.replace(old, new, 1)
    open('index.html', 'w').write(html)
    print('Videos updated!')
else:
    print('Not found')
