abc
cat > fix.py
cat > fix.pyabc
python3 -c "
import re
h=open('index.html').read()
p=re.compile(r'[ \t]*\.product-proof__(?:videos|video-card)[^{]*\{[^}]*\}\n?',re.M)
print('Removed',len(p.findall(h)),'rules')
h=p.sub('',h)
c='''      .product-proof__videos { display:flex; align-items:center; justify-content:center; gap:8px; padding:40px 24px; overflow:visible; }
      .product-proof__video-card { position:relative; flex:1 1 0; max-width:260px; aspect-ratio:9/16; border-radius:24px; overflow:hidden; box-shadow:0 28px 70px rgba(0,0,0,.22); transition:transform .4s ease; background:#f5f5f5; }
      .product-proof__video-card:nth-child(1) { transform:rotate(-6deg); z-index:1; }
      .product-proof__video-card:nth-child(2) { transform:rotate(-1deg) translateY(-32px); z-index:3; }
      .product-proof__video-card:nth-child(3) { transform:rotate(5deg); z-index:2; }
      .product-proof__video-card:hover { transform:rotate(0deg) scale(1.04); z-index:10; }
      .product-proof__video-card video { position:absolute; top:0; left:0; width:100%; height:100%; object-fit:cover; display:block; }
'''
s=re.compile(r'(<section class=\"product-proof\"[^>]*>\s*<style>)([\s\S]*?)(\s*</style>)')
m=s.search(h)
assert m
h=h[:m.end(2)]+'\n'+c+h[m.start(3):]
open('index.html','w').write(h)
print('SUCCESS')
" && vercel --prod
m=[s.search](http://s.search)(h)
