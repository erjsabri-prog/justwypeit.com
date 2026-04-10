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

// ── Form submission ──────────────────────────
async function submitOrder(e) {
  e.preventDefault();

  const lines = getOrderLines();
  if (lines.length === 0) {
    alert('Please add at least one product to your order.');
    return;
  }

  const btn = document.getElementById('submitBtn');
  btn.disabled = true;
  btn.textContent = 'Placing order…';

  const firstName = document.getElementById('firstName').value.trim();
  const lastName  = document.getElementById('lastName').value.trim();
  const email     = document.getElementById('email').value.trim();
  const phone     = document.getElementById('phone').value.trim();
  const address1  = document.getElementById('address1').value.trim();
  const address2  = document.getElementById('address2').value.trim();
  const city      = document.getElementById('city').value.trim();
  const postcode  = document.getElementById('postcode').value.trim();
  const notes     = document.getElementById('notes').value.trim();
  const { sub, delivery, total } = calcOrderTotal();

  try {
    const res = await fetch('/submit-order', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        firstName, lastName, email, phone,
        address1, address2, city, postcode, notes,
        items: lines,
        subtotal: sub.toFixed(2),
        delivery: delivery.toFixed(2),
        total:    total.toFixed(2),
      }),
    });

    const data = await res.json();
    if (!res.ok || !data.success) throw new Error(data.error || 'Server error');

    // Show success
    document.getElementById('orderForm').style.display = 'none';
    const successEl = document.getElementById('orderSuccess');
    successEl.style.display = 'block';
    document.getElementById('successEmail').textContent = email;
    document.getElementById('successOrderNumber').textContent = data.orderNumber;

  } catch (err) {
    console.error('Order submission failed:', err);
    alert('Sorry, something went wrong placing your order. Please try again or contact us directly.');
    btn.disabled = false;
    btn.innerHTML = `Proceed to Payment — <span id="btnTotal">£${total.toFixed(2)}</span>`;
  }
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

// ── Show success if redirected back from Stripe ─
if (new URLSearchParams(window.location.search).get('payment') === 'success') {
  window.addEventListener('DOMContentLoaded', () => {
    document.getElementById('orderForm').style.display = 'none';
    document.getElementById('orderSuccess').style.display = 'block';
  });
}

stripeInit();


/* =====================================================
   HERO WIPE — slow-motion condensation reveal
   ===================================================== */

function initHeroWipe() {
  const canvas = document.getElementById('heroWipeCanvas');
  if (!canvas) return;

  const hero = document.getElementById('hero');
  const ctx  = canvas.getContext('2d');
  const dpr  = window.devicePixelRatio || 1;
  const W    = hero.offsetWidth;
  const H    = hero.offsetHeight;

  canvas.width        = W * dpr;
  canvas.height       = H * dpr;
  canvas.style.width  = W + 'px';
  canvas.style.height = H + 'px';
  ctx.scale(dpr, dpr);

  /* ── 1. High-quality condensation fog ── */
  // Solid dark base — deep charcoal
  ctx.globalCompositeOperation = 'source-over';
  ctx.globalAlpha = 1;
  ctx.fillStyle = 'rgba(5, 10, 20, 1)';
  ctx.fillRect(0, 0, W, H);

  // Layer 1: large overlapping soft blobs — creates uneven cloud-like condensation
  // Each blob is a wide radial gradient at very low alpha
  for (let i = 0; i < 60; i++) {
    const x  = Math.random() * W * 1.2 - W * 0.1;
    const y  = Math.random() * H * 1.2 - H * 0.1;
    const r  = 120 + Math.random() * 280;
    const a  = 0.04 + Math.random() * 0.07;
    const gr = ctx.createRadialGradient(x, y, 0, x, y, r);
    // Slight colour variation: some blobs lean warm (grey-white), some cool (blue-grey)
    const warm = Math.random() > 0.5;
    const cr = warm ? 200 + (Math.random() * 20 | 0) : 160 + (Math.random() * 20 | 0);
    const cg = warm ? 205 + (Math.random() * 15 | 0) : 180 + (Math.random() * 20 | 0);
    const cb = warm ? 210 + (Math.random() * 20 | 0) : 220 + (Math.random() * 30 | 0);
    gr.addColorStop(0,   `rgba(${cr},${cg},${cb},${a})`);
    gr.addColorStop(0.5, `rgba(${cr},${cg},${cb},${a * 0.4})`);
    gr.addColorStop(1,   `rgba(${cr},${cg},${cb},0)`);
    ctx.fillStyle = gr;
    ctx.fillRect(0, 0, W, H);
  }

  // Layer 2: medium blobs at slightly higher alpha for depth
  for (let i = 0; i < 35; i++) {
    const x  = Math.random() * W;
    const y  = Math.random() * H;
    const r  = 50 + Math.random() * 130;
    const a  = 0.025 + Math.random() * 0.045;
    const gr = ctx.createRadialGradient(x, y, 0, x, y, r);
    gr.addColorStop(0,   `rgba(190,200,225,${a})`);
    gr.addColorStop(1,   'rgba(190,200,225,0)');
    ctx.fillStyle = gr;
    ctx.fillRect(0, 0, W, H);
  }

  // Layer 3: fine pixel grain — adds photographic texture, not visible shapes
  const imgData = ctx.getImageData(0, 0, W, H);
  const px      = imgData.data;
  for (let i = 0; i < px.length; i += 4) {
    const noise = (Math.random() - 0.5) * 14;
    px[i]     = Math.max(0, Math.min(255, px[i]     + noise));
    px[i + 1] = Math.max(0, Math.min(255, px[i + 1] + noise));
    px[i + 2] = Math.max(0, Math.min(255, px[i + 2] + noise));
  }
  ctx.putImageData(imgData, 0, 0);

  // Ready for erasing
  ctx.globalCompositeOperation = 'destination-out';

  /* ── 2. Three slow bezier wipe strokes ── */
  const brush = Math.min(W, H) * 0.24;

  // Control points give each stroke a gentle natural curve
  function makeCurvePoints(sx, sy, ex, ey) {
    return {
      cp1x: sx + (ex - sx) * 0.3 + (Math.random() - 0.5) * 40,
      cp1y: sy + (ey - sy) * 0.3 + (Math.random() - 0.5) * 28,
      cp2x: sx + (ex - sx) * 0.7 + (Math.random() - 0.5) * 40,
      cp2y: sy + (ey - sy) * 0.7 + (Math.random() - 0.5) * 28,
    };
  }

  function cubicAt(t, p0, cp1, cp2, p1) {
    const mt = 1 - t;
    return mt*mt*mt*p0 + 3*mt*mt*t*cp1 + 3*mt*t*t*cp2 + t*t*t*p1;
  }

  // Smooth ease-in-out cubic
  function ease(t) { return t < 0.5 ? 4*t*t*t : 1 - Math.pow(-2*t+2,3)/2; }

  function animateStroke(sx, sy, ex, ey, delay, dur) {
    setTimeout(() => {
      const { cp1x, cp1y, cp2x, cp2y } = makeCurvePoints(sx, sy, ex, ey);
      let px = sx, py = sy;
      const t0 = performance.now();

      function frame(now) {
        const raw = Math.min((now - t0) / dur, 1);
        const e   = ease(raw);
        const x   = cubicAt(e, sx, cp1x, cp2x, ex);
        const y   = cubicAt(e, sy, cp1y, cp2y, ey);

        ctx.globalCompositeOperation = 'destination-out';
        ctx.globalAlpha = 1;
        ctx.lineCap     = 'round';
        ctx.lineJoin    = 'round';
        ctx.lineWidth   = brush * 2.4;
        ctx.strokeStyle = 'rgba(0,0,0,1)';
        ctx.beginPath();
        ctx.moveTo(px, py);
        ctx.lineTo(x, y);
        ctx.stroke();

        px = x; py = y;
        if (raw < 1) requestAnimationFrame(frame);
      }
      requestAnimationFrame(frame);
    }, delay);
  }

  animateStroke(-brush, H * 0.15, W + brush, H * 0.38, 700,  1800);
  animateStroke(W + brush, H * 0.40, -brush,  H * 0.60, 2200, 1800);
  animateStroke(-brush, H * 0.62, W + brush, H * 0.85, 3700, 1800);

  const totalMs = 3700 + 1800;

  setTimeout(() => {
    hero.classList.add('wipe-revealed');
    const content = document.querySelector('.hero__content');
    if (content) content.classList.add('wipe-done');
  }, totalMs - 200);

  setTimeout(() => {
    canvas.style.transition = 'opacity 1.4s ease';
    canvas.style.opacity    = '0';
    setTimeout(() => { canvas.remove(); }, 1500);
  }, totalMs + 100);
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
