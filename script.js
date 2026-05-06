/* ===========================
   WYPE — script.js
   =========================== */

// ── NAV scroll ──────────────────────────────
const nav = document.getElementById('nav');
if (nav) {
  window.addEventListener('scroll', () => {
    nav.classList.toggle('scrolled', window.scrollY > 40);
  });
}

// ── Mobile hamburger ────────────────────────
const hamburger = document.getElementById('hamburger');
const navLinks  = document.getElementById('navLinks');
if (hamburger && navLinks) {
  hamburger.addEventListener('click', () => navLinks.classList.toggle('open'));
  navLinks.querySelectorAll('a').forEach(l => l.addEventListener('click', () => navLinks.classList.remove('open')));
}

// ── Sticky CTA ──────────────────────────────
const stickyCta = document.getElementById('stickyCta');
const heroEl    = document.getElementById('hero');
if (stickyCta && heroEl) {
  new IntersectionObserver(([e]) => {
    stickyCta.classList.toggle('visible', !e.isIntersecting);
  }, { threshold: 0.1 }).observe(heroEl);
}

// ── Draggable sticky CTA ────────────────────
(function () {
  if (!stickyCta) return;
  let dragging = false, startX, startY, origLeft, origTop, hasDragged = false;

  function getPos() {
    const r = stickyCta.getBoundingClientRect();
    return { left: r.left, top: r.top };
  }

  function startDrag(x, y) {
    dragging  = true;
    hasDragged = false;
    const pos = getPos();
    // Switch from centered transform to absolute left/top
    stickyCta.style.left      = pos.left + 'px';
    stickyCta.style.top       = pos.top  + 'px';
    stickyCta.style.bottom    = 'auto';
    stickyCta.style.transform = 'none';
    origLeft = pos.left;
    origTop  = pos.top;
    startX   = x;
    startY   = y;
    stickyCta.style.transition = 'none';
    stickyCta.style.cursor     = 'grabbing';
  }

  function moveDrag(x, y) {
    if (!dragging) return;
    const dx = x - startX, dy = y - startY;
    if (Math.abs(dx) > 3 || Math.abs(dy) > 3) hasDragged = true;
    const newLeft = Math.min(Math.max(0, origLeft + dx), window.innerWidth  - stickyCta.offsetWidth);
    const newTop  = Math.min(Math.max(0, origTop  + dy), window.innerHeight - stickyCta.offsetHeight);
    stickyCta.style.left = newLeft + 'px';
    stickyCta.style.top  = newTop  + 'px';
  }

  function endDrag(e) {
    if (!dragging) return;
    dragging = false;
    stickyCta.style.transition = '';
    stickyCta.style.cursor     = 'grab';
    // Suppress the click if the user actually dragged
    if (hasDragged) e.stopPropagation();
  }

  stickyCta.style.cursor = 'grab';
  stickyCta.addEventListener('mousedown',  e => { e.preventDefault(); startDrag(e.clientX, e.clientY); });
  window.addEventListener   ('mousemove',  e => moveDrag(e.clientX, e.clientY));
  window.addEventListener   ('mouseup',    e => endDrag(e), true);

  stickyCta.addEventListener('touchstart', e => { startDrag(e.touches[0].clientX, e.touches[0].clientY); }, { passive: true });
  window.addEventListener   ('touchmove',  e => { moveDrag(e.touches[0].clientX, e.touches[0].clientY); }, { passive: true });
  window.addEventListener   ('touchend',   e => endDrag(e), true);
})();


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
const _closeBtn    = document.getElementById('closePaymentModal');
const _overlay     = document.getElementById('paymentOverlay');
const _payNowBtn   = document.getElementById('payNowBtn');
if (_closeBtn)  _closeBtn.addEventListener('click', closePaymentModal);
if (_overlay)   _overlay.addEventListener('click', (e) => { if (e.target === e.currentTarget) closePaymentModal(); });
if (_payNowBtn) _payNowBtn.addEventListener('click', handlePayNow);

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
   HERO VIDEO — sequential loop
   ===================================================== */

(function () {
  const videos = ['assets/hero-video-2.mp4', 'assets/hero-video-1.mp4'];
  let current = 0;
  const vid = document.getElementById('heroBgVideo');
  if (!vid) return;
  vid.addEventListener('ended', () => {
    current = (current + 1) % videos.length;
    vid.src = videos[current];
    vid.play();
  });
})();

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


/* =====================================================
   SCRUB DEMO — canvas reveal
   ===================================================== */

function initScrub() {
  const canvas   = document.getElementById('scrubCanvas');
  const hint     = document.getElementById('scrubHint');
  const resetBtn = document.getElementById('scrubReset');
  if (!canvas) return;

  const ctx     = canvas.getContext('2d', { willReadFrequently: false });
  const wrapper = document.getElementById('scrubWrapper');

  let active = false;
  let last   = null;
  let queued = [];
  let rafId  = null;

  /* ── Setup ── */
  function setup() {
    if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
    canvas.width  = wrapper.offsetWidth;
    canvas.height = wrapper.offsetHeight;
    drawGrime();
    active = false;
    last   = null;
    queued = [];
    hint.style.opacity     = '1';
    hint.style.transition  = 'opacity 0.4s ease';
    resetBtn.style.display = 'none';
  }

  /* ── Draw grime — richer wave texture, no GPU readback ── */
  function drawGrime() {
    const W = canvas.width;
    const H = canvas.height;
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    ctx.shadowBlur  = 0;

    // Base dark gradient
    const g = ctx.createLinearGradient(0, 0, W, H);
    g.addColorStop(0,    '#120b03');
    g.addColorStop(0.35, '#1e1106');
    g.addColorStop(0.7,  '#160d04');
    g.addColorStop(1,    '#0e0902');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);

    // Wide wave streaks — primary grime layer
    for (let i = 0; i < 35; i++) {
      ctx.save();
      ctx.globalAlpha = 0.12 + Math.random() * 0.22;
      ctx.beginPath();
      ctx.ellipse(
        Math.random() * W,
        Math.random() * H,
        180 + Math.random() * (W * 0.5),
        4 + Math.random() * 10,
        (Math.random() - 0.5) * 0.35,
        0, Math.PI * 2
      );
      ctx.fillStyle = `rgb(
        ${48 + (Math.random() * 22 | 0)},
        ${30 + (Math.random() * 14 | 0)},
        ${6  + (Math.random() * 8  | 0)})`;
      ctx.fill();
      ctx.restore();
    }

    // Thin bright highlight streaks (simulates light catching grime)
    for (let i = 0; i < 12; i++) {
      ctx.save();
      ctx.globalAlpha = 0.05 + Math.random() * 0.09;
      ctx.beginPath();
      ctx.ellipse(
        Math.random() * W,
        Math.random() * H,
        80 + Math.random() * 260,
        1 + Math.random() * 3,
        (Math.random() - 0.5) * 0.15,
        0, Math.PI * 2
      );
      ctx.fillStyle = `rgb(
        ${100 + (Math.random() * 40 | 0)},
        ${65  + (Math.random() * 25 | 0)},
        ${18  + (Math.random() * 12 | 0)})`;
      ctx.fill();
      ctx.restore();
    }

    // Sparse noise texture
    ctx.globalAlpha = 0.055;
    ctx.fillStyle = '#fff';
    for (let i = 0; i < 900; i++) {
      ctx.fillRect(Math.random() * W | 0, Math.random() * H | 0, 1, 1);
    }

    // Switch to soft erase mode — set once for the whole session
    ctx.globalCompositeOperation = 'destination-out';
    ctx.globalAlpha = 1;
    ctx.lineCap     = 'round';
    ctx.lineJoin    = 'round';
    ctx.lineWidth   = 100;
    ctx.strokeStyle = 'rgba(0,0,0,1)';
    // shadowBlur in destination-out creates feathered soft edges
    ctx.shadowBlur  = 28;
    ctx.shadowColor = 'rgba(0,0,0,1)';
  }

  setup();
  window.addEventListener('resize', setup);

  /* ── RAF draw loop — smooth bezier curves via midpoint algorithm ── */
  function drawFrame() {
    rafId = null;
    if (!queued.length) return;

    const pts = queued;
    queued = [];

    // Build segment: [last, ...newPts] so curves connect seamlessly
    const all = last ? [last, ...pts] : pts;

    ctx.beginPath();

    if (all.length === 1) {
      // Single tap — draw a dot
      ctx.arc(all[0].x, all[0].y, ctx.lineWidth / 2, 0, Math.PI * 2);
      ctx.fill();
    } else if (all.length === 2) {
      ctx.moveTo(all[0].x, all[0].y);
      ctx.lineTo(all[1].x, all[1].y);
      ctx.stroke();
    } else {
      // Midpoint-smoothed bezier — eliminates angular joints at any speed
      ctx.moveTo(
        (all[0].x + all[1].x) / 2,
        (all[0].y + all[1].y) / 2
      );
      for (let i = 1; i < all.length - 1; i++) {
        const mx = (all[i].x + all[i + 1].x) / 2;
        const my = (all[i].y + all[i + 1].y) / 2;
        ctx.quadraticCurveTo(all[i].x, all[i].y, mx, my);
      }
      ctx.lineTo(all[all.length - 1].x, all[all.length - 1].y);
      ctx.stroke();
    }

    last = pts[pts.length - 1];
  }

  function scheduleFrame() {
    if (!rafId) rafId = requestAnimationFrame(drawFrame);
  }

  function getCoords(e) {
    const r = canvas.getBoundingClientRect();
    const s = e.touches ? e.touches[0] : e;
    return { x: s.clientX - r.left, y: s.clientY - r.top };
  }

  function start(e) {
    active = true;
    last   = null;
    queued = [];
    hint.style.opacity     = '0';
    resetBtn.style.display = 'block';
    queued.push(getCoords(e));
    scheduleFrame();
  }

  function move(e) {
    if (!active) return;
    queued.push(getCoords(e));
    scheduleFrame();
  }

  function stop() {
    active = false;
    last   = null;
    queued = [];
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

/* ─────────────────────────────────────────────
   ACCOUNT NAV INJECTION
   Adds an account icon/link to the nav__actions
   on every page that has the nav element.
───────────────────────────────────────────── */
(function injectAccountNav() {
  const navActions = document.querySelector('.nav__actions');
  if (!navActions) return;

  function getUser() {
    try { return JSON.parse(localStorage.getItem('wype_user')); } catch { return null; }
  }

  const user = getUser();
  const link = document.createElement('a');
  link.href  = 'account.html';
  link.style.cssText = 'display:flex;align-items:center;gap:6px;text-decoration:none;color:inherit;margin-right:4px;';
  link.setAttribute('aria-label', 'My Account');

  if (user) {
    const initials = (user.firstName[0] + user.lastName[0]).toUpperCase();
    link.innerHTML = `<span style="width:32px;height:32px;border-radius:50%;background:#E01E1E;color:#fff;font-family:'Rajdhani',sans-serif;font-size:13px;font-weight:700;display:flex;align-items:center;justify-content:center;">${initials}</span>`;
    link.title = user.firstName + ' ' + user.lastName;
  } else {
    link.innerHTML = `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>`;
    link.title = 'Sign in / Create account';
  }

  // Insert before the Order Now button
  const orderBtn = navActions.querySelector('.btn');
  if (orderBtn) navActions.insertBefore(link, orderBtn);
  else navActions.appendChild(link);
})();

/* ─────────────────────────────────────────────
   PRODUCTS DROPDOWN
   Shared nav initializer for pages that use the
   portal-style products menu.
───────────────────────────────────────────── */
(function initSharedProductsDropdown() {
  function init() {
    const btn = document.getElementById('navProductsBtn');
    const dd = document.getElementById('navDropdown');
    if (!btn || !dd || btn.dataset.navDropdownReady === 'true') return;
    if (btn.getAttribute('onclick')) return;
    btn.dataset.navDropdownReady = 'true';
    btn.setAttribute('aria-expanded', 'false');
    btn.setAttribute('aria-controls', 'navDropdown');
    const isNestedDropdown = dd.closest('.nav__products-wrap') === btn.closest('.nav__products-wrap');

    function positionDropdown() {
      if (isNestedDropdown) return;
      const r = btn.getBoundingClientRect();
      dd.style.top = (r.bottom + 10) + 'px';
      dd.style.left = Math.min(r.left, window.innerWidth - dd.offsetWidth - 16) + 'px';
    }

    function openDropdown() {
      positionDropdown();
      dd.classList.add('open');
      btn.setAttribute('aria-expanded', 'true');
    }

    function closeDropdown() {
      dd.classList.remove('open');
      btn.setAttribute('aria-expanded', 'false');
    }

    window.toggleNavDrop = function toggleNavDrop() {
      if (dd.classList.contains('open')) closeDropdown();
      else openDropdown();
    };

    btn.addEventListener('click', function (e) {
      e.preventDefault();
      e.stopPropagation();
      window.toggleNavDrop();
    });

    dd.addEventListener('click', function (e) {
      if (e.target.closest('a')) closeDropdown();
    });

    document.addEventListener('click', function (e) {
      if (!btn.contains(e.target) && !dd.contains(e.target)) closeDropdown();
    });

    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') closeDropdown();
    });

    window.addEventListener('resize', function () {
      if (dd.classList.contains('open')) positionDropdown();
    });

    window.addEventListener('scroll', function () {
      if (dd.classList.contains('open')) positionDropdown();
    }, { passive: true });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
