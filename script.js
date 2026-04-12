/* ===========================
   WYPE — script.js
   =========================== */

// ── NAV scroll ──────────────────────────────
const nav = document.getElementById('nav');
window.addEventListener('scroll', () => {
  nav.classList.toggle('scrolled', window.scrollY > 40);
});

// ── Mobile hamburger ────────────────────────
const hamburger = document.getElementById('hamburger');
const navLinks  = document.getElementById('navLinks');
hamburger.addEventListener('click', () => navLinks.classList.toggle('open'));
navLinks.querySelectorAll('a').forEach(l => l.addEventListener('click', () => navLinks.classList.remove('open')));

// ── Sticky CTA ──────────────────────────────
const stickyCta = document.getElementById('stickyCta');
const heroEl    = document.getElementById('hero');
new IntersectionObserver(([e]) => {
  stickyCta.classList.toggle('visible', !e.isIntersecting);
}, { threshold: 0.1 }).observe(heroEl);


/* =====================================================
   ORDER FORM — pricing & quantity
   ===================================================== */

const ORDERS_EMAIL = 'orders@wype.co.uk';

const PRICES   = { qty1: 16.00,  qty2: 25.60,  qty3: 56.00 };
const DELIVERY = { qty1: 3.99,   qty2: 0,       qty3: 0     };
const NAMES    = { qty1: 'wype+™ × 1', qty2: 'wype+™ × 2 (Save 20%)', qty3: 'wype+™ × 5 (Save 30%)' };

function changeQty(id, delta) {
  const el  = document.getElementById(id);
  const cur = parseInt(el.textContent) || 0;
  el.textContent = Math.max(0, cur + delta);
  updateTotals();
}

function calcOrderTotal() {
  let sub = 0, del = 0;
  ['qty1','qty2','qty3'].forEach(id => {
    const q = parseInt(document.getElementById(id).textContent) || 0;
    if (q > 0) { sub += q * PRICES[id]; del += q * DELIVERY[id]; }
  });
  return { sub, delivery: del, total: sub + del };
}

function getOrderLines() {
  const lines = [];
  ['qty1','qty2','qty3'].forEach(id => {
    const q = parseInt(document.getElementById(id).textContent) || 0;
    if (q > 0) lines.push(`${q}x ${NAMES[id]} @ £${PRICES[id].toFixed(2)} each`);
  });
  return lines;
}

function updateTotals() {
  const { sub, delivery, total } = calcOrderTotal();
  document.getElementById('subtotalVal').textContent = sub === 0 ? '£0.00' : `£${sub.toFixed(2)}`;
  document.getElementById('deliveryVal').textContent =
    sub === 0 ? 'Free over £25' : (delivery === 0 ? 'FREE 🎉' : `£${delivery.toFixed(2)}`);
  document.getElementById('totalVal').textContent = `£${total.toFixed(2)}`;
  document.getElementById('btnTotal').textContent  = `£${total.toFixed(2)}`;
}

function selectProduct(name) {
  if (name.includes('ClassicWype')) {
    const el = document.getElementById('qty1');
    if (parseInt(el.textContent) === 0) el.textContent = '1';
  } else if (name.includes('DetailWype')) {
    const el = document.getElementById('qty2');
    if (parseInt(el.textContent) === 0) el.textContent = '1';
  } else if (name.includes('Bundle')) {
    const el = document.getElementById('qty3');
    if (parseInt(el.textContent) === 0) el.textContent = '1';
  }
  updateTotals();
}

// ── Form submission — validate then open Stripe payment modal ───────────────
async function submitOrder(e) {
  e.preventDefault();

  const lines = getOrderLines();
  if (lines.length === 0) {
    alert('Please add at least one product to your order.');
    return;
  }

  if (!_stripe) {
    alert('Payment system is still loading. Please wait a moment and try again.');
    return;
  }

  // Save order data to sessionStorage so it survives the Stripe redirect
  const { sub, delivery, total } = calcOrderTotal();
  sessionStorage.setItem('wype_pending_order', JSON.stringify({
    firstName: document.getElementById('firstName').value.trim(),
    lastName:  document.getElementById('lastName').value.trim(),
    email:     document.getElementById('email').value.trim(),
    phone:     document.getElementById('phone').value.trim(),
    address1:  document.getElementById('address1').value.trim(),
    address2:  document.getElementById('address2').value.trim(),
    city:      document.getElementById('city').value.trim(),
    postcode:  document.getElementById('postcode').value.trim(),
    notes:     document.getElementById('notes').value.trim(),
    items:     lines,
    subtotal:  sub.toFixed(2),
    delivery:  delivery.toFixed(2),
    total:     total.toFixed(2),
  }));

  await openPaymentModal();
}


/* =====================================================
   STRIPE — Apple Pay, Google Pay, Klarna, Card
   ===================================================== */

let _stripe      = null;
let _elements    = null;
let _clientSecret = null;

// Initialise Stripe on page load by fetching the publishable key from the server.
// Required env vars on the server:
//   STRIPE_SECRET_KEY=sk_live_...
//   STRIPE_PUBLISHABLE_KEY=pk_live_...
async function stripeInit() {
  if (!window.Stripe) return;
  try {
    const res = await fetch('/stripe-config');
    if (!res.ok) return;
    const { publishableKey } = await res.json();
    if (!publishableKey || !publishableKey.startsWith('pk_')) return;
    _stripe = Stripe(publishableKey);
  } catch {
    // Server not running (e.g. opening the HTML file directly) — silent fail
  }
}

// Open the payment modal and create a payment intent
async function openPaymentModal() {
  const { total } = calcOrderTotal();
  const amountPence = Math.round(total * 100);
  if (amountPence < 30) return;

  const lines = getOrderLines();

  // Populate modal with order details
  document.getElementById('paymentModalAmount').textContent = `£${total.toFixed(2)}`;
  document.getElementById('payNowAmount').textContent = `£${total.toFixed(2)}`;
  document.getElementById('paymentOrderSummary').innerHTML =
    lines.map(l => `<div class="payment-modal__line">${l}</div>`).join('');

  // Show the overlay
  document.getElementById('paymentOverlay').style.display = 'flex';
  document.body.style.overflow = 'hidden';

  // Hide any previous errors
  const errEl = document.getElementById('payment-error');
  errEl.style.display = 'none';

  await mountStripeElements(amountPence, total);
}

async function mountStripeElements(amountPence, total) {
  if (!_stripe) { showPaymentError('Payment system unavailable. Please refresh the page and try again.'); return; }

  // Create payment intent on server
  let clientSecret;
  try {
    const res = await fetch('/create-payment-intent', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ amount: amountPence }),
    });
    const data = await res.json();
    if (data.error) { showPaymentError(data.error); return; }
    clientSecret = data.clientSecret;
  } catch {
    showPaymentError('Could not connect to the payment server. Please check your connection and try again.');
    return;
  }

  _clientSecret = clientSecret;

  _elements = _stripe.elements({
    clientSecret,
    appearance: {
      theme: 'stripe',
      variables: {
        colorPrimary: '#E01E1E',
        colorBackground: '#ffffff',
        colorText: '#111111',
        borderRadius: '8px',
        fontFamily: 'Inter, system-ui, -apple-system, sans-serif',
        fontSizeBase: '15px',
      },
      rules: {
        '.Label': { fontWeight: '600', letterSpacing: '0.5px', fontSize: '12px', textTransform: 'uppercase', color: '#555' },
      }
    }
  });

  // Express checkout (Apple Pay / Google Pay) — appears only on supported devices
  const expressEl = _elements.create('expressCheckout', {
    buttonType: { applePay: 'buy', googlePay: 'buy' },
    buttonHeight: 48,
  });

  expressEl.on('ready', ({ availablePaymentMethods }) => {
    if (availablePaymentMethods && Object.keys(availablePaymentMethods).length > 0) {
      document.getElementById('express-checkout-element').style.display = 'block';
      document.getElementById('paymentDivider').style.display = 'flex';
    }
  });

  expressEl.on('confirm', async () => {
    const { error: submitErr } = await _elements.submit();
    if (submitErr) { showPaymentError(submitErr.message); return; }

    const { error } = await _stripe.confirmPayment({
      elements: _elements,
      clientSecret: _clientSecret,
      confirmParams: { return_url: window.location.origin + '/?payment=success' },
    });
    if (error) showPaymentError(error.message);
  });

  expressEl.mount('#express-checkout-element');

  // Main payment element — handles Klarna, card, and other methods
  const paymentEl = _elements.create('payment', {
    layout: 'tabs',
    defaultValues: {
      billingDetails: {
        name: `${document.getElementById('firstName').value} ${document.getElementById('lastName').value}`.trim(),
        email: document.getElementById('email').value,
        phone: document.getElementById('phone').value,
        address: {
          line1: document.getElementById('address1').value,
          line2: document.getElementById('address2').value,
          city: document.getElementById('city').value,
          postal_code: document.getElementById('postcode').value,
          country: 'GB',
        }
      }
    }
  });

  paymentEl.mount('#payment-element');

  const payNowBtn = document.getElementById('payNowBtn');
  payNowBtn.style.display = 'block';
  payNowBtn.disabled = false;
  payNowBtn.innerHTML = `Pay <span id="payNowAmount">£${total.toFixed(2)}</span>`;
}

// Handle the Pay button inside the modal
async function handlePayNow() {
  if (!_stripe || !_elements) return;

  const btn = document.getElementById('payNowBtn');
  btn.disabled = true;
  btn.textContent = 'Processing…';

  const { error: submitErr } = await _elements.submit();
  if (submitErr) {
    showPaymentError(submitErr.message);
    btn.disabled = false;
    const { total } = calcOrderTotal();
    btn.innerHTML = `Pay <span id="payNowAmount">£${total.toFixed(2)}</span>`;
    return;
  }

  const { error } = await _stripe.confirmPayment({
    elements: _elements,
    clientSecret: _clientSecret,
    confirmParams: { return_url: window.location.origin + '/?payment=success' },
  });

  if (error) {
    showPaymentError(error.message);
    btn.disabled = false;
    const { total } = calcOrderTotal();
    btn.innerHTML = `Pay <span id="payNowAmount">£${total.toFixed(2)}</span>`;
  }
}

function showPaymentError(msg) {
  const el = document.getElementById('payment-error');
  el.textContent = msg;
  el.style.display = 'block';
}

function closePaymentModal() {
  document.getElementById('paymentOverlay').style.display = 'none';
  document.body.style.overflow = '';
  _elements = null;
  _clientSecret = null;
  document.getElementById('express-checkout-element').style.display = 'none';
  document.getElementById('paymentDivider').style.display = 'none';
  document.getElementById('payment-element').innerHTML = '';
  document.getElementById('payNowBtn').style.display = 'none';
  document.getElementById('payment-error').style.display = 'none';
}

// ── Modal controls ───────────────────────────
document.getElementById('closePaymentModal').addEventListener('click', closePaymentModal);
document.getElementById('paymentOverlay').addEventListener('click', (e) => {
  if (e.target === e.currentTarget) closePaymentModal();
});
document.getElementById('payNowBtn').addEventListener('click', handlePayNow);

// ── After Stripe redirects back with ?payment=success ───────────────────────
if (new URLSearchParams(window.location.search).get('payment') === 'success') {
  window.addEventListener('DOMContentLoaded', async () => {
    // Submit the order (sends confirmation email) using the saved form data
    const raw = sessionStorage.getItem('wype_pending_order');
    if (raw) {
      try {
        const orderData = JSON.parse(raw);
        const res  = await fetch('/submit-order', {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify(orderData),
        });
        const data = await res.json();
        sessionStorage.removeItem('wype_pending_order');
        if (data.orderNumber) {
          document.getElementById('successOrderNumber').textContent = data.orderNumber;
        }
        document.getElementById('successEmail').textContent = orderData.email;
      } catch (err) {
        console.error('Order confirmation error:', err);
      }
    }
    document.getElementById('orderForm').style.display  = 'none';
    document.getElementById('orderSuccess').style.display = 'block';
    // Scroll to the success message
    document.getElementById('orderSuccess').scrollIntoView({ behavior: 'smooth' });
  });
}

stripeInit();


/* =====================================================
   HERO WIPE — luxury microfibre cloth reveal
   ===================================================== */

function initHeroWipe() {
  const canvas = document.getElementById('heroWipeCanvas');
  if (!canvas) return;

  const hero = document.getElementById('hero');
  const ctx  = canvas.getContext('2d');
  const dpr  = Math.min(window.devicePixelRatio || 1, 2);
  const W    = hero.offsetWidth;
  const H    = hero.offsetHeight;

  canvas.width        = W * dpr;
  canvas.height       = H * dpr;
  canvas.style.width  = W + 'px';
  canvas.style.height = H + 'px';
  ctx.scale(dpr, dpr);

  /* ── 1. Draw rich grime overlay ── */
  ctx.globalCompositeOperation = 'source-over';
  ctx.globalAlpha = 1;

  // Deep warm-black base — like a dirty cloth
  ctx.fillStyle = '#100e0b';
  ctx.fillRect(0, 0, W, H);

  // Uneven dark patches — organic grime texture
  for (let i = 0; i < 28; i++) {
    const bx = Math.random() * W;
    const by = Math.random() * H;
    const br = 80 + Math.random() * 260;
    const bg = ctx.createRadialGradient(bx, by, 0, bx, by, br);
    const ri = 22 + (Math.random() * 12 | 0);
    const gi = 15 + (Math.random() * 8  | 0);
    const bi =  6 + (Math.random() * 6  | 0);
    bg.addColorStop(0,   `rgba(${ri},${gi},${bi},0.30)`);
    bg.addColorStop(0.6, `rgba(${ri},${gi},${bi},0.12)`);
    bg.addColorStop(1,   `rgba(${ri},${gi},${bi},0)`);
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, W, H);
  }

  // Fine grain — photographic, not painted
  const id  = ctx.getImageData(0, 0, W * dpr, H * dpr);
  const px  = id.data;
  for (let i = 0; i < px.length; i += 4) {
    const n = (Math.random() - 0.5) * 10;
    px[i]   = Math.max(0, Math.min(255, px[i]   + n));
    px[i+1] = Math.max(0, Math.min(255, px[i+1] + n));
    px[i+2] = Math.max(0, Math.min(255, px[i+2] + n));
  }
  ctx.putImageData(id, 0, 0);

  /* ── 2. Luxury single cloth sweep ── */
  const DELAY    = 300;
  const DURATION = 2000;
  const SOFT_W   = W * 0.13;  // soft feathered edge

  function easeInOutCubic(t) {
    return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
  }

  let startTime = null;

  function frame(now) {
    if (!startTime) startTime = now;
    const raw = Math.min((now - startTime) / DURATION, 1);
    const t   = easeInOutCubic(raw);

    // Leading edge position — starts off-screen left, ends off-screen right
    const wipeX = -SOFT_W + (W + SOFT_W * 2.2) * t;

    /* ── Erase overlay ── */
    ctx.globalCompositeOperation = 'destination-out';
    ctx.globalAlpha = 1;

    // Hard-erased region (everything fully behind the cloth)
    const hardX = wipeX - SOFT_W;
    if (hardX > 0) {
      ctx.fillStyle = 'rgba(0,0,0,1)';
      ctx.fillRect(0, 0, hardX, H);
    }

    // Feathered leading edge — soft microfibre bleed
    const g0 = Math.max(0, hardX);
    const g1 = Math.min(W, wipeX);
    if (g1 > g0) {
      const gr = ctx.createLinearGradient(g0, 0, g1, 0);
      gr.addColorStop(0,   'rgba(0,0,0,1)');
      gr.addColorStop(0.65,'rgba(0,0,0,0.92)');
      gr.addColorStop(1,   'rgba(0,0,0,0)');
      ctx.fillStyle = gr;
      ctx.fillRect(g0, 0, g1 - g0, H);
    }

    /* ── Warm cloth shimmer at leading edge ── */
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    const shineW = 90;
    const sg = ctx.createLinearGradient(wipeX - shineW * 0.5, 0, wipeX + shineW * 0.5, 0);
    sg.addColorStop(0,    'rgba(255,250,240,0)');
    sg.addColorStop(0.35, 'rgba(255,250,240,0.05)');
    sg.addColorStop(0.62, 'rgba(255,250,240,0.22)');
    sg.addColorStop(0.78, 'rgba(255,250,240,0.07)');
    sg.addColorStop(1,    'rgba(255,250,240,0)');
    ctx.fillStyle = sg;
    ctx.fillRect(wipeX - shineW * 0.5, 0, shineW, H);

    if (raw < 1) {
      requestAnimationFrame(frame);
    } else {
      /* ── Reveal complete ── */
      hero.classList.add('wipe-revealed');
      const content = document.querySelector('.hero__content');
      if (content) content.classList.add('wipe-done');

      canvas.style.transition = 'opacity 0.7s ease';
      canvas.style.opacity    = '0';
      setTimeout(() => canvas.remove(), 800);
    }
  }

  setTimeout(() => requestAnimationFrame(frame), DELAY);
}

window.addEventListener('DOMContentLoaded', initHeroWipe);


/* =====================================================
   SCRUB DEMO — canvas reveal
   ===================================================== */

function initScrub() {
  const canvas   = document.getElementById('scrubCanvas');
  const hint     = document.getElementById('scrubHint');
  const resetBtn = document.getElementById('scrubReset');
  if (!canvas) return;

  const ctx     = canvas.getContext('2d');
  const wrapper = document.getElementById('scrubWrapper');

  let active = false;
  let last   = null;   // last pointer position for gap-free lines

  /* ── Setup: size canvas exactly to wrapper in CSS pixels ── */
  function setup() {
    canvas.width  = wrapper.offsetWidth;
    canvas.height = wrapper.offsetHeight;
    drawGrime();
    active = false;
    last   = null;
    hint.style.opacity     = '1';
    resetBtn.style.display = 'none';
  }

  /* ── Draw the dirty grime surface ── */
  function drawGrime() {
    const W = canvas.width;
    const H = canvas.height;
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;

    // Deep dirty base
    const g = ctx.createLinearGradient(0, 0, W, H);
    g.addColorStop(0,   '#130c04');
    g.addColorStop(0.4, '#1c1005');
    g.addColorStop(1,   '#0e0903');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);

    // Horizontal smear streaks — dirty windscreen look
    for (let i = 0; i < 18; i++) {
      ctx.save();
      ctx.globalAlpha = 0.18 + Math.random() * 0.18;
      ctx.beginPath();
      ctx.ellipse(
        Math.random() * W, Math.random() * H,
        120 + Math.random() * 180, 5 + Math.random() * 10,
        (Math.random() - 0.5) * 0.3,
        0, Math.PI * 2
      );
      ctx.fillStyle = `rgb(${50 + (Math.random()*18|0)},${32+(Math.random()*12|0)},${8+(Math.random()*6|0)})`;
      ctx.fill();
      ctx.restore();
    }

    // Pixel grain via ImageData — makes it look photographic not painted
    const id = ctx.getImageData(0, 0, W, H);
    const d  = id.data;
    for (let i = 0; i < d.length; i += 4) {
      const n = (Math.random() - 0.5) * 18;
      d[i]   = Math.max(0, Math.min(255, d[i]   + n));
      d[i+1] = Math.max(0, Math.min(255, d[i+1] + n));
      d[i+2] = Math.max(0, Math.min(255, d[i+2] + n));
    }
    ctx.putImageData(id, 0, 0);

    // Switch to erase mode — ready for wiping
    ctx.globalCompositeOperation = 'destination-out';
    ctx.globalAlpha = 1;
  }

  setup();
  window.addEventListener('resize', setup);

  /* ── Erase: continuous stroke, no gaps even at fast swipe speed ── */
  function wipe(x, y) {
    ctx.globalCompositeOperation = 'destination-out';
    ctx.globalAlpha  = 1;
    ctx.lineCap      = 'round';
    ctx.lineJoin     = 'round';
    ctx.lineWidth    = 90;
    ctx.strokeStyle  = '#000';

    ctx.beginPath();
    ctx.moveTo(last ? last.x : x, last ? last.y : y);
    ctx.lineTo(x, y);
    ctx.stroke();

    last = { x, y };
  }

  function start(e) {
    active = true;
    last   = null;
    hint.style.opacity     = '0';
    resetBtn.style.display = 'block';
    wipe(...coords(e));
  }

  function move(e) {
    if (!active) return;
    wipe(...coords(e));
  }

  function stop() { active = false; last = null; }

  function coords(e) {
    const r = canvas.getBoundingClientRect();
    const s = e.touches ? e.touches[0] : e;
    return [s.clientX - r.left, s.clientY - r.top];
  }

  canvas.addEventListener('mousedown',  start);
  canvas.addEventListener('mousemove',  move);
  canvas.addEventListener('mouseup',    stop);
  canvas.addEventListener('mouseleave', stop);

  canvas.addEventListener('touchstart', e => { e.preventDefault(); start(e); }, { passive: false });
  canvas.addEventListener('touchmove',  e => { e.preventDefault(); move(e);  }, { passive: false });
  canvas.addEventListener('touchend',   stop);

  resetBtn.addEventListener('click', setup);
}

window.addEventListener('DOMContentLoaded', initScrub);
