require('dotenv').config({ path: '.env.local' });
require('dotenv').config();
const express    = require('express');
const Stripe     = require('stripe');
const bcrypt     = require('bcryptjs');
const jwt        = require('jsonwebtoken');
const path       = require('path');
const { neon }   = require('@neondatabase/serverless');

const app    = express();
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const sql    = neon(process.env.DATABASE_URL);

const JWT_SECRET     = process.env.JWT_SECRET || 'wype-jwt-secret-change-in-production';
const BUSINESS_EMAIL = process.env.ORDERS_TO_EMAIL || 'customer@justwypeit.com';
const PUBLIC_SITE_URL = (process.env.PUBLIC_SITE_URL || 'https://www.justwypeit.com').replace(/\/+$/, '');
const ASSET_BASE_URL  = `${PUBLIC_SITE_URL}/assets`;

/* ── WhatsApp notification via CallMeBot (free, no business account needed)
   Setup: add +34 644 71 88 02 to contacts, send "I allow callmebot to send me messages"
   then set WHATSAPP_PHONE and WHATSAPP_APIKEY in Vercel env vars ── */
async function sendWhatsApp(message) {
  const phone  = process.env.WHATSAPP_PHONE;   // e.g. 447700900000 (no + or spaces)
  const apiKey = process.env.WHATSAPP_APIKEY;
  if (!phone || !apiKey) return;
  const url = `https://api.callmebot.com/whatsapp.php?phone=${phone}&text=${encodeURIComponent(message)}&apikey=${apiKey}`;
  try {
    const res = await fetch(url);
    const txt = await res.text();
    console.log('📱 WhatsApp sent:', txt.includes('Message queued') ? 'OK' : txt.slice(0, 80));
  } catch (err) {
    console.warn('WhatsApp notify failed:', err.message);
  }
}

/* ── Stripe webhook — must be registered BEFORE express.json() to get raw body ── */
app.post('/api/stripe-webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig           = req.headers['stripe-signature'];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!webhookSecret) {
    console.error('STRIPE_WEBHOOK_SECRET not set — webhook ignored');
    return res.status(400).send('Webhook secret not configured');
  }
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
  } catch (err) {
    console.error('Stripe webhook signature error:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'payment_intent.succeeded') {
    const pi = event.data.object;
    try {
      const existing = await sql`SELECT id FROM wype_orders WHERE payment_intent_id = ${pi.id} LIMIT 1`;
      if (existing.length > 0) {
        console.log(`Webhook: order already saved for ${pi.id} — skip`);
        return res.json({ received: true });
      }
      const rows = await sql`SELECT order_data FROM wype_pending_orders WHERE payment_intent_id = ${pi.id}`;
      if (rows.length === 0) {
        console.log(`Webhook: no pending order found for ${pi.id} — sending admin alert`);
        try {
          const charge = await stripe.charges.retrieve(pi.latest_charge || pi.id).catch(() => null);
          const billing = charge?.billing_details || {};
          const addr = billing.address || {};
          const amountStr = '£' + (pi.amount / 100).toFixed(2);
          await sendEmail({
            from:    '"wype® Alerts" <customer@justwypeit.com>',
            to:      BUSINESS_EMAIL,
            subject: `⚠️ MISSED ORDER — Payment received but order data lost (${amountStr})`,
            html: `<!DOCTYPE html><html><body style="font-family:Arial,sans-serif;color:#1a1a1a;padding:32px">
<h2 style="color:#CC0000">⚠️ Missed Order Alert</h2>
<p>A payment was received but the order data was not registered before payment completed. <strong>You must manually fulfill this order.</strong></p>
<table style="border-collapse:collapse;width:100%;max-width:560px">
  <tr><td style="padding:8px 12px;background:#f5f5f5;font-weight:700;width:160px">Payment Intent</td><td style="padding:8px 12px;border:1px solid #ddd;font-family:monospace">${pi.id}</td></tr>
  <tr><td style="padding:8px 12px;background:#f5f5f5;font-weight:700">Amount Paid</td><td style="padding:8px 12px;border:1px solid #ddd;color:#CC0000;font-weight:700">${amountStr}</td></tr>
  <tr><td style="padding:8px 12px;background:#f5f5f5;font-weight:700">Name</td><td style="padding:8px 12px;border:1px solid #ddd">${billing.name || 'Unknown'}</td></tr>
  <tr><td style="padding:8px 12px;background:#f5f5f5;font-weight:700">Email</td><td style="padding:8px 12px;border:1px solid #ddd">${billing.email || 'Not captured'}</td></tr>
  <tr><td style="padding:8px 12px;background:#f5f5f5;font-weight:700">Phone</td><td style="padding:8px 12px;border:1px solid #ddd">${billing.phone || 'Not captured'}</td></tr>
  <tr><td style="padding:8px 12px;background:#f5f5f5;font-weight:700">Address</td><td style="padding:8px 12px;border:1px solid #ddd">${[addr.line1, addr.line2, addr.city, addr.postal_code, addr.country].filter(Boolean).join(', ') || 'Not captured'}</td></tr>
</table>
<p style="margin-top:24px">Check Stripe dashboard for full details: <a href="https://dashboard.stripe.com/payments/${pi.id}">dashboard.stripe.com/payments/${pi.id}</a></p>
<p style="color:#888;font-size:13px">This alert fires when a customer pays via Apple Pay or Google Pay before order data is registered. A fix has been deployed to prevent future occurrences.</p>
</body></html>`,
          });
        } catch (alertErr) {
          console.error('Failed to send missed order alert:', alertErr.message);
        }
        return res.json({ received: true });
      }
      const od = rows[0].order_data;
      const orderNumber = await getNextOrderNumber();
      const order = {
        orderNumber,
        userId:         od.userId || null,
        firstName:      od.firstName,
        lastName:       od.lastName,
        email:          od.email,
        phone:          od.phone || null,
        address1:       od.address1,
        address2:       od.address2 || null,
        city:           od.city,
        postcode:       od.postcode,
        notes:          od.notes || null,
        items:          od.items,
        subtotal:       parseFloat(od.subtotal).toFixed(2),
        delivery:       parseFloat(od.delivery).toFixed(2),
        total:          parseFloat(od.total).toFixed(2),
        deliveryMethod: od.deliveryMethod || null,
        discountCode:   od.discountCode || null,
        discountAmount: od.discountAmt ? parseFloat(od.discountAmt).toFixed(2) : null,
      };
      await sql`
        INSERT INTO wype_orders
          (order_number, user_id, first_name, last_name, email, phone,
           address1, address2, city, postcode, notes, items,
           subtotal, delivery, total, delivery_method, discount_code, discount_amount, payment_intent_id)
        VALUES
          (${order.orderNumber}, ${order.userId}, ${order.firstName}, ${order.lastName},
           ${order.email}, ${order.phone}, ${order.address1}, ${order.address2},
           ${order.city}, ${order.postcode}, ${order.notes}, ${JSON.stringify(order.items)},
           ${order.subtotal}, ${order.delivery}, ${order.total}, ${order.deliveryMethod},
           ${order.discountCode}, ${order.discountAmount}, ${pi.id})
      `;
      await sql`DELETE FROM wype_pending_orders WHERE payment_intent_id = ${pi.id}`;
      sql`UPDATE wype_checkout_intents SET converted_at = NOW() WHERE email = ${order.email.toLowerCase().trim()} AND converted_at IS NULL`.catch(() => {});
      await sendOrderEmails({ ...order, createdAt: new Date().toISOString() });
      console.log(`✅ Webhook: order ${orderNumber} created + emails sent for ${order.email}`);
    } catch (err) {
      console.error('Webhook order processing error:', err.message);
      return res.status(500).send('Internal error');
    }
  }

  res.json({ received: true });
});

app.use(express.json());
app.use(express.static(path.join(__dirname), {
  setHeaders(res, filePath) {
    if (/\.(jpg|jpeg|png|gif|webp|svg|mp4|mov|woff2?)$/i.test(filePath)) {
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    } else if (/\.(html?)$/i.test(filePath)) {
      res.setHeader('Cache-Control', 'no-store, max-age=0');
    } else {
      res.setHeader('Cache-Control', 'no-cache');
    }
  }
}));

// Apple Pay domain verification
app.get('/.well-known/apple-developer-merchantid-domain-association', (req, res) => {
  res.sendFile(path.join(__dirname, '.well-known', 'apple-developer-merchantid-domain-association'));
});

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/wype-plus', (req, res) => res.sendFile(path.join(__dirname, 'wype-plus.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'admin.html')));
app.get('/order-confirmed', (req, res) => res.sendFile(path.join(__dirname, 'order-confirmed.html')));

/* ─────────────────────────────────────────────
   DATABASE INITIALISATION
───────────────────────────────────────────── */
async function initDB() {
  await sql`
    CREATE TABLE IF NOT EXISTS wype_users (
      id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      first_name         TEXT NOT NULL,
      last_name          TEXT NOT NULL,
      email              TEXT UNIQUE NOT NULL,
      password_hash      TEXT NOT NULL,
      company            TEXT,
      avatar_url         TEXT,
      email_verified     BOOLEAN DEFAULT FALSE,
      verification_token TEXT,
      created_at         TIMESTAMPTZ DEFAULT NOW()
    )
  `;
  await sql`ALTER TABLE wype_users ADD COLUMN IF NOT EXISTS company TEXT`;
  await sql`ALTER TABLE wype_users ADD COLUMN IF NOT EXISTS avatar_url TEXT`;
  await sql`ALTER TABLE wype_users ADD COLUMN IF NOT EXISTS email_verified BOOLEAN DEFAULT FALSE`;
  await sql`ALTER TABLE wype_users ADD COLUMN IF NOT EXISTS verification_token TEXT`;
  await sql`
    CREATE TABLE IF NOT EXISTS wype_orders (
      id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      order_number TEXT UNIQUE NOT NULL,
      user_id      UUID,
      first_name   TEXT,
      last_name    TEXT,
      email        TEXT,
      phone        TEXT,
      address1     TEXT,
      address2     TEXT,
      city         TEXT,
      postcode     TEXT,
      notes        TEXT,
      items        JSONB,
      subtotal     NUMERIC(10,2),
      delivery     NUMERIC(10,2),
      total        NUMERIC(10,2),
      status       TEXT DEFAULT 'Processing',
      created_at   TIMESTAMPTZ DEFAULT NOW()
    )
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS wype_order_counter (
      id       INTEGER PRIMARY KEY DEFAULT 1,
      next_val INTEGER NOT NULL DEFAULT 1
    )
  `;
  await sql`
    INSERT INTO wype_order_counter (id, next_val)
    VALUES (1, 1)
    ON CONFLICT (id) DO NOTHING
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS wype_discount_codes (
      id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      code          TEXT UNIQUE NOT NULL,
      discount_pct  INTEGER NOT NULL DEFAULT 15,
      type          TEXT NOT NULL DEFAULT 'trade',
      business_name TEXT,
      email         TEXT,
      created_at    TIMESTAMPTZ DEFAULT NOW()
    )
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS wype_feedback (
      id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      vibe_score   INTEGER,
      vibe_label   TEXT,
      ratings      JSONB,
      uses         JSONB,
      recommend    TEXT,
      order_number TEXT,
      comment      TEXT,
      emailed      BOOLEAN DEFAULT FALSE,
      created_at   TIMESTAMPTZ DEFAULT NOW()
    )
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS wype_trade_applications (
      id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      first_name    TEXT,
      last_name     TEXT,
      business_name TEXT,
      business_type TEXT,
      email         TEXT,
      phone         TEXT,
      monthly_order TEXT,
      message       TEXT,
      discount_code TEXT,
      emailed       BOOLEAN DEFAULT FALSE,
      created_at    TIMESTAMPTZ DEFAULT NOW()
    )
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS wype_checkout_intents (
      id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      email        TEXT NOT NULL,
      first_name   TEXT,
      last_name    TEXT,
      items_json   TEXT,
      total        TEXT,
      created_at   TIMESTAMPTZ DEFAULT NOW(),
      updated_at   TIMESTAMPTZ DEFAULT NOW(),
      converted_at TIMESTAMPTZ,
      emailed_at   TIMESTAMPTZ
    )
  `;
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS wype_checkout_intents_email_idx ON wype_checkout_intents (email)`;
  await sql`ALTER TABLE wype_orders ADD COLUMN IF NOT EXISTS tracking_number TEXT`;
  await sql`ALTER TABLE wype_orders ADD COLUMN IF NOT EXISTS dispatched_at TIMESTAMPTZ`;
  await sql`ALTER TABLE wype_orders ADD COLUMN IF NOT EXISTS delivery_method TEXT`;
  await sql`ALTER TABLE wype_orders ADD COLUMN IF NOT EXISTS discount_code TEXT`;
  await sql`ALTER TABLE wype_orders ADD COLUMN IF NOT EXISTS discount_amount NUMERIC(10,2)`;
  await sql`ALTER TABLE wype_orders ADD COLUMN IF NOT EXISTS payment_intent_id TEXT`;
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS wype_orders_payment_intent_idx ON wype_orders (payment_intent_id) WHERE payment_intent_id IS NOT NULL`;
  await sql`
    CREATE TABLE IF NOT EXISTS wype_pending_orders (
      payment_intent_id TEXT PRIMARY KEY,
      order_data        JSONB NOT NULL,
      created_at        TIMESTAMPTZ DEFAULT NOW()
    )
  `;
}
initDB().catch(err => console.error('DB init error:', err.message));

/* ─────────────────────────────────────────────
   ORDER NUMBER
───────────────────────────────────────────── */
async function getNextOrderNumber() {
  const rows = await sql`
    UPDATE wype_order_counter
    SET next_val = next_val + 1
    WHERE id = 1
    RETURNING next_val - 1 AS num
  `;
  // Pure numeric starting from 1001
  return String(1000 + rows[0].num);
}

/* ─────────────────────────────────────────────
   AUTH MIDDLEWARE
───────────────────────────────────────────── */
function authMiddleware(req, res, next) {
  const header = req.headers.authorization || '';
  const token  = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Not authenticated.' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Token invalid or expired.' });
  }
}

/* ─────────────────────────────────────────────
   ADMIN MIDDLEWARE + ROUTES
───────────────────────────────────────────── */
const ADMIN_EMAIL = 'customer@justwypeit.com';

function adminMiddleware(req, res, next) {
  const header = req.headers.authorization || '';
  const token  = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Not authenticated.' });
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    if (decoded.role !== 'admin') return res.status(403).json({ error: 'Forbidden.' });
    req.admin = decoded;
    next();
  } catch {
    res.status(401).json({ error: 'Token invalid or expired.' });
  }
}

app.post('/api/admin/login', async (req, res) => {
  const { email, password } = req.body;
  const adminPw = process.env.ADMIN_PASSWORD;
  if (!adminPw) return res.status(500).json({ error: 'Admin password not configured.' });
  if (!email || !password) return res.status(400).json({ error: 'Email and password required.' });
  if (email.toLowerCase().trim() !== ADMIN_EMAIL) return res.status(401).json({ error: 'Invalid credentials.' });
  const match = await bcrypt.compare(password, adminPw).catch(() => false);
  // Also allow plaintext match for simple env var setup
  const plainMatch = password === adminPw;
  if (!match && !plainMatch) return res.status(401).json({ error: 'Invalid credentials.' });
  const token = jwt.sign({ role: 'admin', email: ADMIN_EMAIL }, JWT_SECRET, { expiresIn: '12h' });
  res.json({ token });
});

/* One-time seed endpoint — inserts orders with specific order numbers */
app.post('/api/admin/orders/seed', adminMiddleware, async (req, res) => {
  const orders = req.body.orders;
  if (!Array.isArray(orders)) return res.status(400).json({ error: 'orders array required' });
  const results = [];
  for (const o of orders) {
    try {
      await sql`
        INSERT INTO wype_orders
          (order_number, first_name, last_name, email, phone,
           address1, address2, city, postcode, items,
           subtotal, delivery, total, status, created_at)
        VALUES
          (${o.order_number}, ${o.first_name}, ${o.last_name}, ${o.email}, ${o.phone||null},
           ${o.address1}, ${o.address2||null}, ${o.city}, ${o.postcode}, ${JSON.stringify(o.items)},
           ${o.subtotal}, ${o.delivery||'0.00'}, ${o.total}, ${o.status||'Processing'}, ${o.created_at})
        ON CONFLICT (order_number) DO NOTHING
      `;
      /* Advance counter past highest seeded number */
      const num = parseInt(o.order_number, 10) - 1000;
      await sql`
        UPDATE wype_order_counter SET next_val = GREATEST(next_val, ${num + 1}) WHERE id = 1
      `;
      results.push({ order_number: o.order_number, ok: true });
    } catch (err) {
      results.push({ order_number: o.order_number, error: err.message });
    }
  }
  res.json({ results });
});

app.get('/api/admin/orders', adminMiddleware, async (req, res) => {
  try {
    const orders = await sql`
      SELECT id, order_number, first_name, last_name, email, phone,
             address1, address2, city, postcode, notes, items,
             subtotal, delivery, total, status, created_at,
             COALESCE(tracking_number, '') as tracking_number,
             dispatched_at
      FROM wype_orders
      ORDER BY created_at DESC
    `.catch(() => sql`
      SELECT id, order_number, first_name, last_name, email, phone,
             address1, address2, city, postcode, notes, items,
             subtotal, delivery, total, status, created_at,
             '' as tracking_number, NULL as dispatched_at
      FROM wype_orders
      ORDER BY created_at DESC
    `);
    res.json({ orders });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.patch('/api/admin/orders/:id/status', adminMiddleware, async (req, res) => {
  const { status } = req.body;
  const allowed = ['Processing', 'Dispatched', 'Delivered', 'Cancelled'];
  if (!allowed.includes(status)) return res.status(400).json({ error: 'Invalid status.' });
  try {
    await sql`UPDATE wype_orders SET status = ${status} WHERE id = ${req.params.id}`;
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/orders/:id/dispatch', adminMiddleware, async (req, res) => {
  const { trackingNumber, carrier } = req.body;
  if (!trackingNumber) return res.status(400).json({ error: 'Tracking number required.' });
  try {
    const rows = await sql`
      UPDATE wype_orders
      SET status = 'Dispatched', tracking_number = ${trackingNumber}, dispatched_at = NOW()
      WHERE id = ${req.params.id}
      RETURNING *
    `;
    if (!rows.length) return res.status(404).json({ error: 'Order not found.' });
    const order = rows[0];

    // Send dispatch email to customer
    try {
      await sendDispatchEmail(order, trackingNumber, carrier || 'Royal Mail');
    } catch (emailErr) {
      console.error('Dispatch email error:', emailErr.message);
    }

    res.json({ ok: true, order });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/orders/:id/resend-confirmation', adminMiddleware, async (req, res) => {
  try {
    const rows = await sql`SELECT * FROM wype_orders WHERE id = ${req.params.id}`;
    if (!rows.length) return res.status(404).json({ error: 'Order not found.' });
    const r = rows[0];
    const order = {
      orderNumber: r.order_number,
      firstName:   r.first_name,
      lastName:    r.last_name,
      email:       r.email,
      phone:       r.phone,
      address1:    r.address1,
      address2:    r.address2,
      city:        r.city,
      postcode:    r.postcode,
      notes:       r.notes,
      items:          Array.isArray(r.items) ? r.items : JSON.parse(r.items || '[]'),
      subtotal:       r.subtotal,
      delivery:       r.delivery,
      total:          r.total,
      userId:         r.user_id,
      discountCode:   r.discount_code || null,
      discountAmount: r.discount_amount ? parseFloat(r.discount_amount).toFixed(2) : null,
    };
    const businessOnly = req.body && req.body.businessOnly;
    const to = businessOnly ? BUSINESS_EMAIL : order.email;
    await sendEmail({
      from:    '"wype®" <customer@justwypeit.com>',
      to,
      bcc:     businessOnly ? undefined : BUSINESS_EMAIL,
      subject: `Thank you for your order, ${order.firstName} - Order #${order.orderNumber}`,
      html:    buildCustomerConfirmEmail(order),
    });
    res.json({ ok: true, orderNumber: order.orderNumber, sentTo: to });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

function sendDispatchEmail(order, trackingNumber, carrier) {
  const trackUrl = carrier === 'Royal Mail'
    ? `https://www.royalmail.com/track-your-item#/tracking-results/${trackingNumber}`
    : carrier === 'Parcelforce'
    ? `https://www.parcelforce.com/track-trace?trackNumber=${trackingNumber}`
    : carrier === 'DPD'
    ? `https://track.dpd.co.uk/search?reference=${trackingNumber}`
    : carrier === 'Evri'
    ? `https://www.evri.com/track-a-parcel#/parcel/${trackingNumber}`
    : `https://www.dhl.com/gb-en/home/tracking.html?tracking-id=${trackingNumber}`;

  const address = [order.address1, order.address2, order.city, order.postcode].filter(Boolean).join(', ');
  const items   = Array.isArray(order.items) ? order.items : JSON.parse(order.items || '[]');
  const dispatchDate = new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });

  function productImg(itemStr) {
    const s = (itemStr || '').toLowerCase();
    if (s.includes('micro')) return `${ASSET_BASE_URL}/nano-folded-studio.png`;
    return `${ASSET_BASE_URL}/micro-folded-studio.png`;
  }

  const itemRows = items.map(i => `
    <tr>
      <td style="padding:14px 0;border-bottom:1px solid #eeeeee">
        <table cellpadding="0" cellspacing="0" width="100%"><tr>
          <td style="width:72px;padding-right:14px;vertical-align:middle">
            <img src="${productImg(i)}" width="72" height="72" alt=""
                 style="width:72px;height:72px;object-fit:cover;border-radius:8px;display:block;border:0">
          </td>
          <td style="vertical-align:middle;font-size:15px;color:#333;line-height:1.5">${i}</td>
        </tr></table>
      </td>
    </tr>`).join('');

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<style>
@keyframes wype-truck{from{left:-90px}to{left:660px}}
@keyframes wype-pop{0%,100%{transform:scale(1)}50%{transform:scale(1.1)}}
.wt{position:absolute;top:15px;font-size:42px;animation:wype-truck 2.5s linear infinite}
.wp{display:inline-block;animation:wype-pop 1.6s ease-in-out infinite}
</style>
</head>
<body style="margin:0;padding:0;background:#f0f0f0;font-family:Arial,sans-serif;color:#1a1a1a">
<style>
@keyframes wype-truck{from{left:-90px}to{left:660px}}
@keyframes wype-pop{0%,100%{transform:scale(1)}50%{transform:scale(1.1)}}
.wt{position:absolute;top:15px;font-size:42px;animation:wype-truck 2.5s linear infinite}
.wp{display:inline-block;animation:wype-pop 1.6s ease-in-out infinite}
</style>
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f0f0f0;padding:40px 0">
<tr><td align="center">
<table width="600" cellpadding="0" cellspacing="0" style="background:#fff;max-width:600px;width:100%;border-radius:12px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.08)">

  <!-- LOGO HEADER -->
  <tr>
    <td style="background:#0d0d0d;padding:24px 36px 20px;text-align:center">
      <img src="${ASSET_BASE_URL}/logo.png" width="160" alt="wype" style="width:160px;height:auto;display:inline-block;border:0">
    </td>
  </tr>

  <!-- RED SHIPPED BANNER -->
  <tr>
    <td style="background:#CC0000;padding:26px 36px 22px;text-align:center">
      <p style="margin:0;font-size:32px;font-weight:900;color:#fff;letter-spacing:0.5px;font-family:Arial,sans-serif;line-height:1.2">YOUR ORDER<br>HAS SHIPPED!</p>
    </td>
  </tr>

  <!-- TRUCK ANIMATION STRIP -->
  <tr>
    <td style="background:#111111;padding:0;line-height:0;border-top:3px solid #CC0000;border-bottom:3px solid #CC0000">
      <div style="position:relative;overflow:hidden;height:74px;background:#111111">
        <span class="wt">🚚</span>
      </div>
    </td>
  </tr>

  <!-- ORDER STATUS BLOCK -->
  <tr>
    <td style="background:#1a1a1a;padding:28px 36px 36px">
      <p style="margin:0 0 2px;font-size:11px;font-weight:700;letter-spacing:3px;text-transform:uppercase;color:rgba(255,255,255,0.35)">ORDER #${order.order_number}</p>
      <p style="margin:0 0 6px;font-size:28px;font-weight:900;color:#fff;letter-spacing:0.5px;font-family:Arial,sans-serif">The wait is nearly over!</p>
      <p style="margin:0 0 32px;font-size:14px;color:rgba(255,255,255,0.45);line-height:1.6">Dispatched ${dispatchDate}</p>

      <!-- 4-step tracker -->
      <table width="100%" cellpadding="0" cellspacing="0">
        <tr>

          <!-- STEP 1: Order Placed — tick -->
          <td align="center" style="width:20%;vertical-align:top;padding:0 2px">
            <div style="width:56px;height:56px;border-radius:28px;background:#7a0000;line-height:56px;text-align:center;color:#fff;font-size:26px;margin:0 auto">&#10003;</div>
            <p style="margin:10px 0 0;font-size:10px;font-weight:700;color:rgba(255,255,255,0.5);text-align:center;line-height:1.5;text-transform:uppercase;letter-spacing:0.3px">Order<br>Placed</p>
          </td>

          <!-- LINE 1→2 (done) -->
          <td style="vertical-align:top;padding-top:28px">
            <div style="height:3px;background:#CC0000;border-radius:2px"></div>
          </td>

          <!-- STEP 2: Dispatched — pill with smoke LEFT of truck (exhaust from rear) -->
          <td align="center" style="width:26%;vertical-align:top;padding:0 2px">
            <div class="wp" style="width:80px;height:56px;border-radius:28px;background:#CC0000;line-height:56px;text-align:center;font-size:22px;margin:0 auto;letter-spacing:-3px;padding-left:4px">&#128168;&#128666;</div>
            <p style="margin:10px 0 0;font-size:10px;font-weight:700;color:#FF5555;text-align:center;line-height:1.5;text-transform:uppercase;letter-spacing:0.3px">Order<br>Dispatched</p>
          </td>

          <!-- LINE 2→3 (pending) -->
          <td style="vertical-align:top;padding-top:28px">
            <div style="height:3px;background:rgba(255,255,255,0.1);border-radius:2px"></div>
          </td>

          <!-- STEP 3: On Its Way — pill with speed dashes LEFT of truck -->
          <td align="center" style="width:26%;vertical-align:top;padding:0 2px">
            <div style="width:80px;height:56px;border-radius:28px;border:2px solid rgba(255,255,255,0.14);line-height:52px;text-align:center;font-size:22px;margin:0 auto;opacity:0.32;letter-spacing:-2px">~&#128666;</div>
            <p style="margin:10px 0 0;font-size:10px;color:rgba(255,255,255,0.28);text-align:center;line-height:1.5;text-transform:uppercase;letter-spacing:0.3px">On Its<br>Way</p>
          </td>

          <!-- LINE 3→4 (pending) -->
          <td style="vertical-align:top;padding-top:28px">
            <div style="height:3px;background:rgba(255,255,255,0.1);border-radius:2px"></div>
          </td>

          <!-- STEP 4: Delivered — home -->
          <td align="center" style="width:20%;vertical-align:top;padding:0 2px">
            <div style="width:56px;height:56px;border-radius:28px;border:2px solid rgba(255,255,255,0.14);line-height:52px;text-align:center;font-size:28px;margin:0 auto;opacity:0.32">&#127968;</div>
            <p style="margin:10px 0 0;font-size:10px;color:rgba(255,255,255,0.28);text-align:center;line-height:1.5;text-transform:uppercase;letter-spacing:0.3px">Delivered</p>
          </td>

        </tr>
      </table>
    </td>
  </tr>

  <!-- BODY -->
  <tr>
    <td style="padding:36px 36px 32px">
      <p style="margin:0 0 20px;font-size:17px;font-weight:700;color:#1a1a1a">Hi ${order.first_name},</p>
      <p style="margin:0 0 28px;font-size:15px;line-height:1.8;color:#444">
        Your wype is packed, sealed and flying your way via <strong>${carrier}</strong>. Use the tracking number below to follow it every step of the way.
      </p>

      <!-- Tracking CTA -->
      <table width="100%" cellpadding="0" cellspacing="0" style="background:#fff8f8;border:2px solid #CC0000;border-radius:10px;margin-bottom:32px">
        <tr>
          <td style="padding:22px 24px">
            <p style="margin:0 0 4px;font-size:11px;font-weight:700;letter-spacing:2px;text-transform:uppercase;color:#CC0000">Tracking Number</p>
            <p style="margin:0 0 18px;font-size:24px;font-weight:900;color:#1a1a1a;letter-spacing:2px;font-family:'Courier New',monospace">${trackingNumber}</p>
            <a href="${trackUrl}"
               style="display:inline-block;background:#CC0000;color:#fff;font-size:15px;font-weight:700;padding:14px 32px;border-radius:8px;text-decoration:none;letter-spacing:0.5px">
              Track My Order →
            </a>
            <p style="margin:10px 0 0;font-size:12px;color:#999">via ${carrier}</p>
          </td>
        </tr>
      </table>

      <!-- Items with photos -->
      <p style="margin:0 0 8px;font-size:11px;font-weight:700;letter-spacing:3px;text-transform:uppercase;color:#CC0000">Your Order</p>
      <div style="height:1px;background:#CC0000;margin-bottom:4px"></div>
      <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:8px">
        ${itemRows}
      </table>
      <table width="100%" cellpadding="0" cellspacing="0" style="margin-top:8px">
        <tr>
          <td style="padding:4px 0;font-size:14px;color:#888">Delivery</td>
          <td align="right" style="font-size:14px;color:#111">${parseFloat(order.delivery||0)===0?'<strong style="color:#1a8a1a">FREE</strong>':'£'+parseFloat(order.delivery).toFixed(2)}</td>
        </tr>
        <tr>
          <td style="padding:12px 0 0;font-size:16px;font-weight:700;color:#1a1a1a;border-top:1.5px solid #ddd">Total Paid</td>
          <td align="right" style="padding:12px 0 0;font-size:16px;font-weight:700;color:#CC0000;border-top:1.5px solid #ddd">£${parseFloat(order.total).toFixed(2)}</td>
        </tr>
      </table>

      <!-- Address -->
      <p style="margin:28px 0 8px;font-size:11px;font-weight:700;letter-spacing:3px;text-transform:uppercase;color:#CC0000">Delivering To</p>
      <div style="height:1px;background:#CC0000;margin-bottom:12px"></div>
      <p style="margin:0;font-size:15px;color:#444;line-height:1.9">${order.first_name} ${order.last_name}<br>${address}</p>

      <!-- Contact block -->
      <table width="100%" cellpadding="0" cellspacing="0" style="margin-top:28px;background:#f7f7f7;border-radius:10px;border:1px solid #eeeeee">
        <tr>
          <td style="padding:20px 24px">
            <p style="margin:0 0 6px;font-size:13px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;color:#888">Need help?</p>
            <p style="margin:0 0 12px;font-size:15px;color:#444;line-height:1.7">For any questions or concerns, contact us directly and we'll get back to you as soon as possible.</p>
            <a href="mailto:customer@justwypeit.com" style="display:inline-block;background:#1a1a1a;color:#fff;font-size:14px;font-weight:700;padding:12px 24px;border-radius:8px;text-decoration:none;letter-spacing:0.3px">&#9993;&nbsp; customer@justwypeit.com</a>
          </td>
        </tr>
      </table>

      <div style="margin-top:32px;padding-top:20px;border-top:1px solid #eee">
        <p style="margin:0 0 4px;font-size:15px;color:#555">Sab &amp; Kaya</p>
        <p style="margin:0;font-size:13px;color:#999">wype® &nbsp;·&nbsp; justwypeit.com</p>
      </div>
    </td>
  </tr>

  <!-- FOOTER -->
  <tr>
    <td style="background:#1a1a1a;padding:18px 36px;text-align:center">
      <p style="margin:0;font-size:11px;color:#888;letter-spacing:1px">
        <a href="https://www.justwypeit.com" style="color:#CC0000;text-decoration:none">justwypeit.com</a>
        &nbsp;·&nbsp; wype® &nbsp;·&nbsp; © 2026 Wype
      </p>
    </td>
  </tr>

</table>
</td></tr>
</table>
</body></html>`;

  return sendEmail({
    from:    '"wype®" <customer@justwypeit.com>',
    to:      order.email,
    replyTo: 'customer@justwypeit.com',
    subject: `Your wype order #${order.order_number} has been dispatched 🚚`,
    html,
  });
}

/* ─────────────────────────────────────────────
   AUTH ROUTES
───────────────────────────────────────────── */
app.post('/api/auth/register', async (req, res) => {
  const { firstName, lastName, email, password, company } = req.body;
  if (!firstName || !lastName || !email || !password) {
    return res.status(400).json({ error: 'All fields are required.' });
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'Invalid email address.' });
  }
  if (password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters.' });
  }

  try {
    const existing = await sql`SELECT id FROM wype_users WHERE email = ${email.toLowerCase().trim()}`;
    if (existing.length > 0) {
      return res.status(409).json({ error: 'An account with that email already exists.' });
    }

    const crypto = require('crypto');
    const passwordHash      = await bcrypt.hash(password, 12);
    const verificationToken = crypto.randomBytes(32).toString('hex');

    const rows = await sql`
      INSERT INTO wype_users (first_name, last_name, email, password_hash, company, verification_token)
      VALUES (
        ${firstName.trim()}, ${lastName.trim()}, ${email.toLowerCase().trim()},
        ${passwordHash}, ${company ? company.trim() : null}, ${verificationToken}
      )
      RETURNING id, first_name, last_name, email, company, email_verified, created_at
    `;
    const user  = rows[0];
    const token = jwt.sign({ id: user.id, email: user.email }, JWT_SECRET, { expiresIn: '30d' });

    // Send verification email (non-blocking)
    sendVerificationEmail(user.email, user.first_name, verificationToken)
      .catch(err => console.error('Verification email error:', err.message));

    res.json({
      token,
      user: {
        id:            user.id,
        firstName:     user.first_name,
        lastName:      user.last_name,
        email:         user.email,
        company:       user.company,
        emailVerified: user.email_verified,
      },
    });
  } catch (err) {
    console.error('Register error:', err.message);
    res.status(500).json({ error: 'Registration failed. Please try again.' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password are required.' });

  try {
    const rows = await sql`SELECT * FROM wype_users WHERE email = ${email.toLowerCase().trim()}`;
    if (rows.length === 0) return res.status(401).json({ error: 'No account found with that email.' });

    const user  = rows[0];
    const match = await bcrypt.compare(password, user.password_hash);
    if (!match) return res.status(401).json({ error: 'Incorrect password.' });

    const token = jwt.sign({ id: user.id, email: user.email }, JWT_SECRET, { expiresIn: '30d' });
    res.json({
      token,
      user: {
        id:            user.id,
        firstName:     user.first_name,
        lastName:      user.last_name,
        email:         user.email,
        company:       user.company,
        avatarUrl:     user.avatar_url,
        emailVerified: user.email_verified,
      },
    });
  } catch (err) {
    console.error('Login error:', err.message);
    res.status(500).json({ error: 'Login failed. Please try again.' });
  }
});

app.get('/api/auth/me', authMiddleware, async (req, res) => {
  try {
    const rows = await sql`SELECT * FROM wype_users WHERE id = ${req.user.id}`;
    if (rows.length === 0) return res.status(404).json({ error: 'Account not found.' });
    const user = rows[0];
    res.json({
      id:            user.id,
      firstName:     user.first_name,
      lastName:      user.last_name,
      email:         user.email,
      company:       user.company,
      avatarUrl:     user.avatar_url,
      emailVerified: user.email_verified,
      createdAt:     user.created_at,
    });
  } catch (err) {
    console.error('Me error:', err.message);
    res.status(500).json({ error: 'Could not load account.' });
  }
});

app.put('/api/auth/me', authMiddleware, async (req, res) => {
  const { firstName, lastName, currentPassword, newPassword } = req.body;

  try {
    const rows = await sql`SELECT * FROM wype_users WHERE id = ${req.user.id}`;
    if (rows.length === 0) return res.status(404).json({ error: 'Account not found.' });
    const user = rows[0];

    let newHash = user.password_hash;
    if (newPassword) {
      if (!currentPassword) return res.status(400).json({ error: 'Current password required to set a new one.' });
      const match = await bcrypt.compare(currentPassword, user.password_hash);
      if (!match) return res.status(401).json({ error: 'Current password is incorrect.' });
      if (newPassword.length < 8) return res.status(400).json({ error: 'New password must be at least 8 characters.' });
      newHash = await bcrypt.hash(newPassword, 12);
    }

    const { company } = req.body;
    const updated = await sql`
      UPDATE wype_users
      SET first_name    = ${firstName ? firstName.trim() : user.first_name},
          last_name     = ${lastName  ? lastName.trim()  : user.last_name},
          company       = ${company !== undefined ? (company ? company.trim() : null) : user.company},
          password_hash = ${newHash}
      WHERE id = ${req.user.id}
      RETURNING id, first_name, last_name, email, company, avatar_url, email_verified
    `;
    const u = updated[0];
    res.json({
      id:            u.id,
      firstName:     u.first_name,
      lastName:      u.last_name,
      email:         u.email,
      company:       u.company,
      avatarUrl:     u.avatar_url,
      emailVerified: u.email_verified,
    });
  } catch (err) {
    console.error('Update me error:', err.message);
    res.status(500).json({ error: 'Could not update account.' });
  }
});

/* ─────────────────────────────────────────────
   EMAIL VERIFICATION
───────────────────────────────────────────── */
app.get('/api/auth/verify/:token', async (req, res) => {
  try {
    const rows = await sql`
      UPDATE wype_users
      SET email_verified = TRUE, verification_token = NULL
      WHERE verification_token = ${req.params.token}
      RETURNING id
    `;
    if (rows.length === 0) return res.status(400).json({ error: 'Invalid or expired verification link.' });
    res.json({ success: true });
  } catch (err) {
    console.error('Verify error:', err.message);
    res.status(500).json({ error: 'Verification failed.' });
  }
});

app.post('/api/auth/resend-verification', authMiddleware, async (req, res) => {
  try {
    const crypto = require('crypto');
    const token  = crypto.randomBytes(32).toString('hex');
    const rows   = await sql`
      UPDATE wype_users
      SET verification_token = ${token}
      WHERE id = ${req.user.id} AND email_verified = FALSE
      RETURNING email, first_name
    `;
    if (rows.length === 0) return res.json({ success: true }); // already verified or not found
    await sendVerificationEmail(rows[0].email, rows[0].first_name, token);
    res.json({ success: true });
  } catch (err) {
    console.error('Resend verification error:', err.message);
    res.status(500).json({ error: 'Could not resend verification.' });
  }
});

/* ─────────────────────────────────────────────
   AVATAR UPLOAD
───────────────────────────────────────────── */
app.put('/api/auth/avatar', authMiddleware, async (req, res) => {
  const { avatarUrl } = req.body;
  if (!avatarUrl) return res.status(400).json({ error: 'No image data provided.' });
  // Allow data URLs (base64) or plain https URLs
  if (!avatarUrl.startsWith('data:image/') && !avatarUrl.startsWith('https://')) {
    return res.status(400).json({ error: 'Invalid image format.' });
  }
  // Limit base64 size to ~500 KB
  if (avatarUrl.length > 700000) {
    return res.status(400).json({ error: 'Image too large. Please use a smaller photo.' });
  }
  try {
    await sql`UPDATE wype_users SET avatar_url = ${avatarUrl} WHERE id = ${req.user.id}`;
    res.json({ success: true, avatarUrl });
  } catch (err) {
    console.error('Avatar error:', err.message);
    res.status(500).json({ error: 'Could not save avatar.' });
  }
});

/* ─────────────────────────────────────────────
   ORDERS API
───────────────────────────────────────────── */
app.get('/api/orders', authMiddleware, async (req, res) => {
  try {
    const rows = await sql`
      SELECT * FROM wype_orders
      WHERE user_id = ${req.user.id}
      ORDER BY created_at DESC
    `;
    const orders = rows.map(o => ({
      id:          o.id,
      orderNumber: o.order_number,
      userId:      o.user_id,
      firstName:   o.first_name,
      lastName:    o.last_name,
      email:       o.email,
      items:       o.items,
      subtotal:    o.subtotal,
      delivery:    o.delivery,
      total:       o.total,
      status:      o.status,
      createdAt:   o.created_at,
    }));
    res.json({ orders });
  } catch (err) {
    console.error('Orders error:', err.message);
    res.status(500).json({ error: 'Could not load orders.' });
  }
});

/* ─────────────────────────────────────────────
   EMAIL HELPERS
───────────────────────────────────────────── */
async function sendEmail({ from, to, bcc, replyTo, subject, html }) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) throw new Error('RESEND_API_KEY not set');
  const body = { from, to: Array.isArray(to) ? to : [to], subject, html };
  if (bcc)     body.bcc      = Array.isArray(bcc) ? bcc : [bcc];
  if (replyTo) body.reply_to = replyTo;
  const res = await fetch('https://api.resend.com/emails', {
    method:  'POST',
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body:    JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.message || `Resend HTTP ${res.status}`);
  }
  return res.json();
}

/* ── Verification email ── */
async function sendVerificationEmail(email, firstName, token) {
  const link = `https://www.justwypeit.com/account.html?verify=${token}`;
  const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#f5f5f5;font-family:Arial,sans-serif">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f5f5f5;padding:32px 0">
<tr><td align="center">
<table width="560" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:10px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.08)">
  <tr><td style="background:#E01E1E;padding:28px 32px;text-align:center">
    <p style="margin:0;font-size:28px;font-weight:900;color:#fff;letter-spacing:3px">wype®</p>
    <p style="margin:8px 0 0;font-size:14px;color:rgba(255,255,255,0.8)">Verify your email address</p>
  </td></tr>
  <tr><td style="padding:36px 40px;text-align:center">
    <p style="margin:0 0 12px;font-size:22px;font-weight:700;color:#111">Hi ${firstName}!</p>
    <p style="margin:0 0 28px;font-size:15px;color:#555;line-height:1.6">
      Thanks for creating your wype account. Please verify your email address to complete your registration.
    </p>
    <a href="${link}" style="display:inline-block;background:#E01E1E;color:#fff;font-family:Arial,sans-serif;font-size:15px;font-weight:700;letter-spacing:1px;padding:14px 36px;border-radius:8px;text-decoration:none;">Verify Email Address</a>
    <p style="margin:28px 0 0;font-size:12px;color:#aaa;line-height:1.6">
      If you didn't create this account you can ignore this email.<br>
      This link expires in 7 days.
    </p>
  </td></tr>
  <tr><td style="background:#f9f9f9;padding:16px 32px;text-align:center">
    <p style="margin:0;font-size:11px;color:#bbb">© 2026 wype® · Made in the UK · wype.co.uk</p>
  </td></tr>
</table>
</td></tr>
</table>
</body></html>`;

  await sendEmail({
    from:    '"wype®" <customer@justwypeit.com>',
    replyTo: 'customer@justwypeit.com',
    to:      email,
    subject: 'Verify your wype account',
    html,
  });
  console.log(`📧  Verification email sent → ${email}`);
}

/* Internal notification to customer@justwypeit.com */
function buildInternalOrderEmail(order) {
  function productImg(itemStr) {
    const s = (itemStr || '').toLowerCase();
    if (s.includes('micro')) return `${ASSET_BASE_URL}/nano-folded-studio.png`;
    return `${ASSET_BASE_URL}/micro-folded-studio.png`;
  }

  const itemRows = order.items.map(i =>
    `<tr>
      <td style="padding:14px 0;border-bottom:1px solid #eeeeee">
        <table cellpadding="0" cellspacing="0" width="100%">
          <tr>
            <td style="width:80px;padding-right:16px;vertical-align:middle">
              <img src="${productImg(i)}" alt="wype product" width="80" height="80"
                   style="width:80px;height:80px;object-fit:cover;border-radius:10px;display:block">
            </td>
            <td style="vertical-align:middle;font-size:15px;color:#333;line-height:1.5">${i}</td>
          </tr>
        </table>
      </td>
    </tr>`
  ).join('');

  const deliveryLine = order.delivery === '0.00' || order.delivery === '0'
    ? '<strong style="color:#CC0000">FREE</strong>'
    : `£${order.delivery}`;

  const address = [order.address1, order.address2, order.city, order.postcode, 'United Kingdom']
    .filter(Boolean).join('<br>');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>New Order #${order.orderNumber}</title>
</head>
<body style="margin:0;padding:0;background:#f2f2f2;font-family:Arial,sans-serif;color:#1a1a1a">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f2f2f2;padding:40px 0">
<tr><td align="center">
<table width="600" cellpadding="0" cellspacing="0" style="background:#ffffff;max-width:600px;width:100%;overflow:hidden;box-shadow:0 4px 32px rgba(0,0,0,0.1)">

  <!-- LOGO HEADER -->
  <tr>
    <td style="background:#0d0d0d;padding:22px 36px;text-align:center">
      <img src="${ASSET_BASE_URL}/logo.png" width="140" alt="wype" style="width:140px;height:auto;display:inline-block;border:0">
    </td>
  </tr>

  <!-- NEW ORDER BANNER -->
  <tr>
    <td style="background:#CC0000;padding:20px 36px">
      <p style="margin:0 0 4px;font-size:11px;font-weight:700;letter-spacing:4px;text-transform:uppercase;color:rgba(255,255,255,0.75)">INTERNAL NOTIFICATION</p>
      <p style="margin:0;font-size:28px;font-weight:900;color:#ffffff;line-height:1.1;letter-spacing:-0.5px">NEW ORDER #${order.orderNumber}</p>
    </td>
  </tr>

  <!-- ORDER SUMMARY BAR -->
  <tr>
    <td style="padding:24px 48px 20px;text-align:center;background:#fafafa;border-bottom:3px solid #CC0000">
      <p style="margin:0;font-size:22px;font-weight:900;color:#111">${order.firstName} ${order.lastName}</p>
      <p style="margin:6px 0 0;font-size:15px;color:#555">${order.email} &nbsp;·&nbsp; ${order.phone || 'No phone'}</p>
      <p style="margin:4px 0 0;font-size:13px;color:#888">${order.userId ? 'Registered account' : 'Guest'} &nbsp;·&nbsp; ${new Date().toLocaleString('en-GB')}</p>
      ${order.discountCode ? `<p style="margin:10px 0 0;display:inline-block;background:#CC0000;color:#fff;font-size:13px;font-weight:800;letter-spacing:1.5px;padding:5px 14px;border-radius:4px">CODE: ${order.discountCode}${order.discountAmount ? ' &nbsp;−£' + order.discountAmount : ''}</p>` : ''}
    </td>
  </tr>

  <!-- DELIVERY ADDRESS -->
  <tr>
    <td style="padding:28px 48px 0">
      <p style="margin:0 0 14px;font-size:11px;font-weight:700;letter-spacing:3px;text-transform:uppercase;color:#CC0000">Delivering To</p>
      <table width="100%" cellpadding="0" cellspacing="0" style="background:#f7f7f7;border-radius:10px">
        <tr>
          <td style="padding:18px 22px;font-size:15px;color:#333;line-height:1.9">
            <strong>${order.firstName} ${order.lastName}</strong><br>${address}
          </td>
        </tr>
      </table>
    </td>
  </tr>

  <!-- ORDER ITEMS -->
  <tr>
    <td style="padding:28px 48px 0">
      <p style="margin:0 0 14px;font-size:11px;font-weight:700;letter-spacing:3px;text-transform:uppercase;color:#CC0000">Order Items</p>
      <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:8px">
        ${itemRows}
      </table>
      <table width="100%" cellpadding="0" cellspacing="0" style="margin-top:4px">
        <tr>
          <td style="padding:6px 0;font-size:14px;color:#888">Subtotal</td>
          <td align="right" style="font-size:14px;color:#333">£${order.subtotal}</td>
        </tr>
        <tr>
          <td style="padding:6px 0;font-size:14px;color:#888">Delivery</td>
          <td align="right" style="font-size:14px;color:#333">${deliveryLine}</td>
        </tr>
        <tr>
          <td style="padding:6px 0;font-size:12px;color:#bbb">VAT (20% incl.)</td>
          <td align="right" style="font-size:12px;color:#bbb">£${(parseFloat(order.total) / 6).toFixed(2)}</td>
        </tr>
        <tr>
          <td style="padding:16px 0 0;font-size:18px;font-weight:900;color:#111;border-top:2px solid #eee">Total Paid</td>
          <td align="right" style="padding:16px 0 0;font-size:18px;font-weight:900;color:#CC0000;border-top:2px solid #eee">£${order.total}</td>
        </tr>
      </table>
    </td>
  </tr>

  ${order.notes ? `
  <!-- ORDER NOTES -->
  <tr>
    <td style="padding:24px 48px 0">
      <p style="margin:0 0 10px;font-size:11px;font-weight:700;letter-spacing:3px;text-transform:uppercase;color:#CC0000">Customer Note</p>
      <table width="100%" cellpadding="0" cellspacing="0" style="background:#fff8f8;border:1px solid #f0d0d0;border-radius:8px">
        <tr><td style="padding:14px 18px;font-size:14px;color:#333;line-height:1.6">${order.notes}</td></tr>
      </table>
    </td>
  </tr>` : ''}

  <!-- SPACER -->
  <tr><td style="height:32px"></td></tr>

  <!-- FOOTER -->
  <tr>
    <td style="background:#0d0d0d;padding:20px 36px;text-align:center">
      <p style="margin:0;font-size:11px;color:#666;letter-spacing:1px">
        <a href="https://www.justwypeit.com" style="color:#CC0000;text-decoration:none">justwypeit.com</a>
        &nbsp;·&nbsp; wype® &nbsp;·&nbsp; Internal Order Notification
      </p>
    </td>
  </tr>

</table>
</td></tr>
</table>
</body>
</html>`;
}

/* Customer confirmation email */
function buildCustomerConfirmEmail(order) {
  function productInfo(itemStr) {
    const s = (itemStr || '').toLowerCase();
    if (s.includes('micro')) return { img: `${ASSET_BASE_URL}/nano-folded-studio.png`, label: 'MICRO WYPE+' };
    if (s.includes('nano'))  return { img: `${ASSET_BASE_URL}/micro-folded-studio.png`,  label: 'NANO WYPE+' };
    return                          { img: `${ASSET_BASE_URL}/micro-folded-studio.png`,  label: 'WYPE' };
  }

  const itemRows = order.items.map(i => {
    const { img } = productInfo(i);
    return `<tr>
      <td style="padding:14px 0;border-bottom:1px solid #eeeeee">
        <table cellpadding="0" cellspacing="0" width="100%">
          <tr>
            <td style="width:80px;padding-right:16px;vertical-align:middle">
              <img src="${img}" alt="wype product" width="80" height="80"
                   style="width:80px;height:80px;object-fit:cover;border-radius:10px;display:block;border:0">
            </td>
            <td style="vertical-align:middle;font-size:15px;color:#333;line-height:1.5">${i}</td>
          </tr>
        </table>
      </td>
    </tr>`;
  }).join('');

  const deliveryLine = order.delivery === '0.00' || order.delivery === '0'
    ? '<strong style="color:#CC0000">FREE</strong>'
    : `£${order.delivery}`;

  const address = [order.address1, order.address2, order.city, order.postcode]
    .filter(Boolean).join(', ');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>wype® Order Confirmed</title>
</head>
<body style="margin:0;padding:0;background:#f2f2f2;font-family:Arial,sans-serif;color:#1a1a1a">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f2f2f2;padding:40px 0">
<tr><td align="center">
<table width="600" cellpadding="0" cellspacing="0" style="background:#ffffff;max-width:600px;width:100%;border-radius:0;overflow:hidden;box-shadow:0 4px 32px rgba(0,0,0,0.1)">

  <!-- LOGO HEADER -->
  <tr>
    <td style="background:#0d0d0d;padding:22px 36px;text-align:center">
      <img src="${ASSET_BASE_URL}/logo.png" width="140" alt="wype" style="width:140px;height:auto;display:inline-block;border:0">
    </td>
  </tr>

  <!-- HERO IMAGE WITH TEXT OVERLAY -->
  <tr>
    <td background="${ASSET_BASE_URL}/nano-porsche-bonnet.jpg"
        style="background-image:url('${ASSET_BASE_URL}/nano-porsche-bonnet.jpg');background-size:cover;background-position:center 80%;padding:0">
      <table width="100%" cellpadding="0" cellspacing="0">
        <tr><td style="height:260px"></td></tr>
        <tr>
          <td style="background:linear-gradient(to bottom,rgba(0,0,0,0) 0%,rgba(0,0,0,0.78) 100%);padding:28px 36px 36px">
            <p style="margin:0 0 8px;font-size:11px;font-weight:700;letter-spacing:4px;text-transform:uppercase;color:rgba(255,255,255,0.75)">THANK YOU!</p>
            <h1 style="margin:0;font-size:40px;font-weight:900;color:#ffffff;line-height:1.1;font-family:Arial,sans-serif;text-transform:uppercase;letter-spacing:-0.5px">ORDER IS<br>CONFIRMED!</h1>
          </td>
        </tr>
      </table>
    </td>
  </tr>

  <!-- ORDER INFO BELOW HERO -->
  <tr>
    <td style="padding:32px 48px 28px;text-align:center">
      <p style="margin:0 0 10px;font-size:36px;font-weight:900;letter-spacing:1px;color:#CC0000;font-family:Arial,sans-serif">Order #${order.orderNumber}</p>
      <h2 style="margin:0 0 14px;font-size:32px;font-weight:900;color:#111111;font-family:Arial,sans-serif;line-height:1.1">${order.firstName} ${order.lastName}</h2>
      <p style="margin:0 auto;font-size:16px;color:#555555;line-height:1.8;max-width:460px">
        Your order is confirmed and we're getting it ready. We'll send a separate email the moment it ships with your tracking number.
      </p>
    </td>
  </tr>

  <!-- RED DIVIDER -->
  <tr><td style="padding:0 48px"><div style="height:3px;background:#CC0000;border-radius:2px"></div></td></tr>

  <!-- FOUNDERS MESSAGE -->
  <tr>
    <td style="padding:32px 48px 28px;background:#fafafa">
      <p style="margin:0 0 14px;font-size:11px;font-weight:700;letter-spacing:3px;text-transform:uppercase;color:#CC0000">A message from us</p>
      <p style="margin:0 0 16px;font-size:15px;line-height:1.85;color:#444444">
        We started wype® because of a genuine passion for cars, and an obsession with keeping them looking their best. Before this, Sab and I were both Amazon delivery drivers. We spent years delivering parcels for someone else's dream, pulling up to incredible cars on driveways and watching them go unlooked after.
      </p>
      <p style="margin:0 0 20px;font-size:15px;line-height:1.85;color:#444444">
        That's what lit the spark. We knew there had to be a better way to care for a car you're proud of: something quick, effective, and built for people who actually love what they drive. wype® is that product, and every order like yours is what makes this journey real.
      </p>
      <p style="margin:0;font-size:15px;line-height:1.6;color:#111111;font-weight:700">Thank you for believing in us. It genuinely means everything.</p>
      <p style="margin:14px 0 0;font-size:14px;color:#888888">Sab &amp; Kaya, founders of wype®</p>
    </td>
  </tr>

  <!-- RED DIVIDER -->
  <tr><td style="padding:0 48px"><div style="height:3px;background:#CC0000;border-radius:2px"></div></td></tr>

  <!-- ORDER DETAILS -->
  <tr>
    <td style="padding:32px 48px 0">
      <p style="margin:0 0 20px;font-size:11px;font-weight:700;letter-spacing:3px;text-transform:uppercase;color:#CC0000">Your Order</p>

      <!-- Items -->
      <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:8px">
        ${itemRows}
      </table>

      <!-- Totals -->
      <table width="100%" cellpadding="0" cellspacing="0" style="margin-top:4px">
        <tr>
          <td style="padding:6px 0;font-size:14px;color:#888888">Subtotal</td>
          <td align="right" style="font-size:14px;color:#333333">£${order.subtotal}</td>
        </tr>
        <tr>
          <td style="padding:6px 0;font-size:14px;color:#888888">Delivery</td>
          <td align="right" style="font-size:14px;color:#333333">${deliveryLine}</td>
        </tr>
        <tr>
          <td style="padding:6px 0;font-size:12px;color:#bbbbbb">VAT (20% incl.)</td>
          <td align="right" style="font-size:12px;color:#bbbbbb">£${(parseFloat(order.total) / 6).toFixed(2)}</td>
        </tr>
        <tr>
          <td style="padding:16px 0 0;font-size:17px;font-weight:900;color:#111111;border-top:2px solid #eeeeee">Total Paid</td>
          <td align="right" style="padding:16px 0 0;font-size:17px;font-weight:900;color:#CC0000;border-top:2px solid #eeeeee">£${order.total}</td>
        </tr>
      </table>
    </td>
  </tr>

  <!-- DELIVERY ADDRESS -->
  <tr>
    <td style="padding:28px 48px">
      <table width="100%" cellpadding="0" cellspacing="0" style="background:#f7f7f7;border-radius:10px">
        <tr>
          <td style="padding:20px 24px">
            <p style="margin:0 0 4px;font-size:11px;font-weight:700;letter-spacing:2px;text-transform:uppercase;color:#CC0000">Delivering To</p>
            <p style="margin:0;font-size:15px;color:#333333;line-height:1.9">${order.firstName} ${order.lastName}<br>${address}</p>
          </td>
        </tr>
      </table>
    </td>
  </tr>

  <!-- CONTACT BLOCK -->
  <tr>
    <td style="padding:0 48px 36px">
      <table width="100%" cellpadding="0" cellspacing="0" style="background:#f7f7f7;border-radius:10px;border:1px solid #eeeeee">
        <tr>
          <td style="padding:20px 24px">
            <p style="margin:0 0 6px;font-size:13px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;color:#888888">Need help?</p>
            <p style="margin:0 0 12px;font-size:15px;color:#444444;line-height:1.7">For any questions or concerns, contact us directly and we'll get back to you as soon as possible.</p>
            <a href="mailto:customer@justwypeit.com" style="display:inline-block;background:#1a1a1a;color:#ffffff;font-size:14px;font-weight:700;padding:12px 24px;border-radius:8px;text-decoration:none;letter-spacing:0.3px">&#9993;&nbsp; customer@justwypeit.com</a>
          </td>
        </tr>
      </table>
    </td>
  </tr>

  <!-- FOOTER -->
  <tr>
    <td style="background:#0d0d0d;padding:20px 36px;text-align:center">
      <p style="margin:0;font-size:11px;color:#666666;letter-spacing:1px">
        <a href="${PUBLIC_SITE_URL}" style="color:#CC0000;text-decoration:none">justwypeit.com</a>
        &nbsp;·&nbsp; wype® &nbsp;·&nbsp; &copy; 2026 Wype
      </p>
    </td>
  </tr>

</table>
</td></tr>
</table>
</body>
</html>`;
}

function buildAbandonedCheckoutCustomerEmail(intent) {
  const firstName = intent.first_name || 'there';
  let items = [];
  try {
    const parsed = JSON.parse(intent.items_json || '[]');
    if (Array.isArray(parsed)) items = parsed;
  } catch {}

  function productInfo(itemStr) {
    const s = (itemStr || '').toLowerCase();
    if (s.includes('micro')) return { img: `${ASSET_BASE_URL}/nano-folded-studio.png`, label: 'MICRO WYPE+' };
    if (s.includes('nano')) return { img: `${ASSET_BASE_URL}/micro-folded-studio.png`, label: 'NANO WYPE+' };
    return { img: `${ASSET_BASE_URL}/micro-folded-studio.png`, label: 'WYPE' };
  }

  const itemRows = items.map(i => {
    const { img } = productInfo(i);
    return `<tr>
      <td style="padding:14px 0;border-bottom:1px solid #eeeeee">
        <table cellpadding="0" cellspacing="0" width="100%">
          <tr>
            <td style="width:80px;padding-right:16px;vertical-align:middle">
              <img src="${img}" alt="wype product" width="80" height="80"
                   style="width:80px;height:80px;object-fit:cover;border-radius:10px;display:block;border:0">
            </td>
            <td style="vertical-align:middle;font-size:15px;color:#333;line-height:1.5">${i}</td>
          </tr>
        </table>
      </td>
    </tr>`;
  }).join('');

  const offerCode = 'TRSDE911C63';
  const orderValue = intent.total ? `£${intent.total}` : null;
  const ctaUrl = `${PUBLIC_SITE_URL}/checkout.html?discount=${offerCode}`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>Still thinking it over?</title>
</head>
<body style="margin:0;padding:0;background-color:#f2f2f2;font-family:Arial,sans-serif;color:#1a1a1a">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#f2f2f2;margin:0;padding:24px 0;width:100%">
  <tr>
    <td align="center">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px;max-width:600px;background-color:#ffffff;border:1px solid #e7e7e7">
        <tr>
          <td align="center" style="background-color:#111111;padding:22px 24px">
            <img src="${ASSET_BASE_URL}/logo.png" width="140" alt="wype" style="display:block;width:140px;height:auto;border:0;color:#ffffff;font-size:28px;font-weight:700">
          </td>
        </tr>
        <tr>
          <td align="center" style="background-color:#cc0000;padding:18px 24px">
            <div style="font-size:11px;line-height:16px;font-weight:700;letter-spacing:3px;color:#ffd6d6;text-transform:uppercase">Don't Miss It</div>
            <div style="font-size:34px;line-height:40px;font-weight:900;color:#ffffff;text-transform:uppercase;padding-top:8px">Your Basket Is Still Waiting</div>
          </td>
        </tr>
        <tr>
          <td style="padding:32px 40px 10px 40px">
            <div style="font-size:28px;line-height:34px;font-weight:900;color:#111111;text-align:center">Hey ${firstName},</div>
            <div style="font-size:16px;line-height:28px;color:#444444;text-align:center;padding-top:16px">
              You left something behind${orderValue ? ` worth <strong style="color:#111111">${orderValue}</strong>` : ''}. To give you a reason to come back, we've unlocked a discount code just for you.
            </div>
          </td>
        </tr>
        <tr>
          <td align="center" style="padding:8px 40px 8px 40px">
            <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 auto">
              <tr>
                <td align="center" style="background-color:#111111;color:#cc0000;font-size:28px;line-height:32px;font-weight:900;letter-spacing:5px;padding:16px 24px">
                  ${offerCode}
                </td>
              </tr>
            </table>
          </td>
        </tr>
        <tr>
          <td style="padding:8px 40px 24px 40px">
            <div style="font-size:15px;line-height:26px;color:#555555;text-align:center">
              This is normally our friends &amp; family code, but because we're in pre-orders we're giving it to our first 100 customers. Use it tonight for <strong style="color:#111111">20% off</strong> your order.
            </div>
          </td>
        </tr>
        <tr>
          <td style="padding:0 40px">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
              <tr><td style="height:3px;background-color:#cc0000;font-size:0;line-height:0">&nbsp;</td></tr>
            </table>
          </td>
        </tr>
        <tr>
          <td style="padding:28px 40px 6px 40px">
            <div style="font-size:11px;line-height:16px;font-weight:700;letter-spacing:3px;color:#cc0000;text-transform:uppercase">Your Basket</div>
          </td>
        </tr>
        <tr>
          <td style="padding:0 40px 6px 40px">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
              ${itemRows || `<tr><td style="padding:0 0 12px;font-size:15px;line-height:24px;color:#444444">Your saved basket is ready for you at checkout.</td></tr>`}
            </table>
          </td>
        </tr>
        <tr>
          <td style="padding:20px 40px 8px 40px">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#fafafa;border:1px solid #e8e8e8">
              <tr>
                <td style="padding:24px">
                  <div style="font-size:11px;line-height:16px;font-weight:700;letter-spacing:3px;color:#cc0000;text-transform:uppercase;text-align:center">Why Buy Now?</div>
                  <div style="font-size:15px;line-height:26px;color:#444444;text-align:center;padding-top:10px">
                    Premium microfibre, paint-safe contact, and fast tracked delivery. The code expires tonight, so if you want to lock in the offer, now is the time.
                  </div>
                  <table role="presentation" align="center" cellpadding="0" cellspacing="0" border="0" style="margin:18px auto 0 auto">
                    <tr>
                      <td align="center" style="background-color:#cc0000;padding:14px 28px">
                        <a href="${ctaUrl}" style="color:#ffffff;font-size:14px;line-height:14px;font-weight:700;letter-spacing:1px;text-transform:uppercase;text-decoration:none;display:block">Return to Checkout</a>
                      </td>
                    </tr>
                  </table>
                </td>
              </tr>
            </table>
          </td>
        </tr>
        <tr>
          <td style="padding:20px 40px 36px 40px">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#f7f7f7;border:1px solid #e8e8e8">
              <tr>
                <td style="padding:20px 24px">
                  <div style="font-size:13px;line-height:18px;font-weight:700;letter-spacing:1.5px;color:#777777;text-transform:uppercase">Need Help?</div>
                  <div style="font-size:15px;line-height:25px;color:#444444;padding-top:8px;padding-bottom:12px">Reply to this email or message us directly if you want help choosing the right cloth before you order.</div>
                  <a href="mailto:customer@justwypeit.com" style="background-color:#1a1a1a;color:#ffffff;font-size:14px;line-height:14px;font-weight:700;padding:12px 24px;text-decoration:none;display:inline-block">&#9993;&nbsp; customer@justwypeit.com</a>
                </td>
              </tr>
            </table>
          </td>
        </tr>
        <tr>
          <td align="center" style="background-color:#111111;padding:18px 24px">
            <div style="font-size:11px;line-height:18px;color:#999999">
              <a href="${PUBLIC_SITE_URL}" style="color:#cc0000;text-decoration:none">justwypeit.com</a>
              &nbsp;·&nbsp; wype® &nbsp;·&nbsp; &copy; 2026 Wype
            </div>
          </td>
        </tr>
      </table>
    </td>
  </tr>
</table>
</body>
</html>`;
}

function buildManualParticipantOfferEmail(participant, variant = 0) {
  const firstName = (participant.first_name || 'there').trim();
  const total = participant.total ? `£${participant.total}` : null;
  const offerCode = 'TRSDE911C63';
  const ctaUrl = `${PUBLIC_SITE_URL}/checkout.html?discount=${offerCode}`;
  const intros = [
    `You left a basket behind${total ? ` worth <strong style="color:#111111">${total}</strong>` : ''}, so we wanted to give you a proper reason to come back and lock it in tonight.`,
    `Your basket is still sitting there${total ? ` at <strong style="color:#111111">${total}</strong>` : ''}, and before pre-orders move further on we wanted to send you something worthwhile.`,
    `Before tonight ends, we wanted to give you one more chance to finish your order${total ? ` at <strong style="color:#111111">${total}</strong>` : ''} with a code we rarely share.`,
  ];
  const urgency = [
    `This is normally our friends &amp; family code, but because we're in pre-orders we're giving it to our first 100 customers. It expires tonight.`,
    `Normally this stays as a friends &amp; family code, but while we're in pre-orders we're opening it up to our first 100 customers only. It expires tonight.`,
    `It is usually reserved as a friends &amp; family code, but because we're in pre-orders we're giving it to our first 100 customers. It only lasts until tonight.`,
  ];

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>Your basket is still waiting</title>
</head>
<body style="margin:0;padding:0;background-color:#f2f2f2;font-family:Arial,sans-serif;color:#1a1a1a">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#f2f2f2;margin:0;padding:24px 0;width:100%">
  <tr>
    <td align="center">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px;max-width:600px;background-color:#ffffff;border:1px solid #e7e7e7">
        <tr>
          <td align="center" style="background-color:#111111;padding:22px 24px">
            <img src="${ASSET_BASE_URL}/logo.png" width="140" alt="wype" style="display:block;width:140px;height:auto;border:0;color:#ffffff;font-size:28px;font-weight:700">
          </td>
        </tr>
        <tr>
          <td align="center" style="background-color:#cc0000;padding:18px 24px">
            <div style="font-size:11px;line-height:16px;font-weight:700;letter-spacing:3px;color:#ffd6d6;text-transform:uppercase">Pre-Order Offer</div>
            <div style="font-size:34px;line-height:40px;font-weight:900;color:#ffffff;text-transform:uppercase;padding-top:8px">Your Basket Is Still Waiting</div>
          </td>
        </tr>
        <tr>
          <td style="padding:32px 40px 10px 40px">
            <div style="font-size:28px;line-height:34px;font-weight:900;color:#111111;text-align:center">Hey ${firstName},</div>
            <div style="font-size:16px;line-height:28px;color:#444444;text-align:center;padding-top:16px">
              ${intros[variant % intros.length]}
            </div>
          </td>
        </tr>
        <tr>
          <td align="center" style="padding:8px 40px 8px 40px">
            <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 auto">
              <tr>
                <td align="center" style="background-color:#111111;color:#cc0000;font-size:28px;line-height:32px;font-weight:900;letter-spacing:5px;padding:16px 24px">
                  ${offerCode}
                </td>
              </tr>
            </table>
          </td>
        </tr>
        <tr>
          <td style="padding:8px 40px 24px 40px">
            <div style="font-size:15px;line-height:26px;color:#555555;text-align:center">
              ${urgency[variant % urgency.length]}
            </div>
          </td>
        </tr>
        <tr>
          <td style="padding:0 40px">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
              <tr><td style="height:3px;background-color:#cc0000;font-size:0;line-height:0">&nbsp;</td></tr>
            </table>
          </td>
        </tr>
        <tr>
          <td style="padding:20px 40px 8px 40px">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#fafafa;border:1px solid #e8e8e8">
              <tr>
                <td style="padding:24px">
                  <div style="font-size:11px;line-height:16px;font-weight:700;letter-spacing:3px;color:#cc0000;text-transform:uppercase;text-align:center">Use It Tonight</div>
                  <div style="font-size:15px;line-height:26px;color:#444444;text-align:center;padding-top:10px">
                    The code is live now and gives you a reason to finish checkout before the offer closes tonight.
                  </div>
                  <table role="presentation" align="center" cellpadding="0" cellspacing="0" border="0" style="margin:18px auto 0 auto">
                    <tr>
                      <td align="center" style="background-color:#cc0000;padding:14px 28px">
                        <a href="${ctaUrl}" style="color:#ffffff;font-size:14px;line-height:14px;font-weight:700;letter-spacing:1px;text-transform:uppercase;text-decoration:none;display:block">Return to Checkout</a>
                      </td>
                    </tr>
                  </table>
                </td>
              </tr>
            </table>
          </td>
        </tr>
        <tr>
          <td style="padding:20px 40px 36px 40px">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#f7f7f7;border:1px solid #e8e8e8">
              <tr>
                <td style="padding:20px 24px">
                  <div style="font-size:13px;line-height:18px;font-weight:700;letter-spacing:1.5px;color:#777777;text-transform:uppercase">Need Help?</div>
                  <div style="font-size:15px;line-height:25px;color:#444444;padding-top:8px;padding-bottom:12px">Reply to this email or message us directly if you want help before you place the order.</div>
                  <a href="mailto:customer@justwypeit.com" style="background-color:#1a1a1a;color:#ffffff;font-size:14px;line-height:14px;font-weight:700;padding:12px 24px;text-decoration:none;display:inline-block">&#9993;&nbsp; customer@justwypeit.com</a>
                </td>
              </tr>
            </table>
          </td>
        </tr>
        <tr>
          <td align="center" style="background-color:#111111;padding:18px 24px">
            <div style="font-size:11px;line-height:18px;color:#999999">
              <a href="${PUBLIC_SITE_URL}" style="color:#cc0000;text-decoration:none">justwypeit.com</a>
              &nbsp;·&nbsp; wype® &nbsp;·&nbsp; &copy; 2026 Wype
            </div>
          </td>
        </tr>
      </table>
    </td>
  </tr>
</table>
</body>
</html>`;
}

const INFLUENCER_CODES = {
  'MORVIUS15': { email: 'mateuszj7@icloud.com', name: 'Morvius' },
};

const PARTNER_CODE_MAP = {
  MORVIUS15: { email: 'mateuszj@icloud.com', name: 'Mateusz' },
};

function buildPartnerNotificationEmail(orderNumber, code) {
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>Your reference code was used</title></head>
<body style="margin:0;padding:0;background:#f2f2f2;font-family:Arial,sans-serif;color:#1a1a1a">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f2f2f2;padding:40px 0">
<tr><td align="center">
<table width="600" cellpadding="0" cellspacing="0" style="background:#ffffff;max-width:600px;width:100%;overflow:hidden;box-shadow:0 4px 32px rgba(0,0,0,0.1)">
  <tr>
    <td style="background:#0d0d0d;padding:22px 36px;text-align:center">
      <img src="https://www.justwypeit.com/assets/logo.png" width="140" alt="wype" style="width:140px;height:auto;display:inline-block;border:0">
    </td>
  </tr>
  <tr>
    <td style="background:#CC0000;padding:36px 48px 32px;text-align:center">
      <p style="margin:0 0 8px;font-size:11px;font-weight:700;letter-spacing:4px;text-transform:uppercase;color:rgba(255,255,255,0.75)">PARTNER REFERENCE</p>
      <h1 style="margin:0;font-size:36px;font-weight:900;color:#ffffff;line-height:1.1;font-family:Arial,sans-serif;text-transform:uppercase;letter-spacing:-0.5px">YOUR CODE<br>WAS USED!</h1>
    </td>
  </tr>
  <tr>
    <td style="padding:36px 48px 28px;text-align:center">
      <p style="margin:0 0 20px;font-size:18px;font-weight:700;color:#111111">Hi there 👋</p>
      <p style="margin:0 auto;font-size:16px;color:#555555;line-height:1.8;max-width:460px">
        A new order has been placed on <strong>justwypeit.com</strong> using your partner reference code.
      </p>
      <div style="margin:28px auto;display:inline-block;background:#0d0d0d;color:#CC0000;font-size:28px;font-weight:900;letter-spacing:6px;padding:16px 36px;border-radius:8px;font-family:Arial,sans-serif">
        ${code}
      </div>
      <table cellpadding="0" cellspacing="0" style="margin:0 auto;background:#f7f7f7;border-radius:8px;overflow:hidden;border:1px solid #e8e8e8">
        <tr>
          <td style="padding:14px 32px;text-align:center">
            <p style="margin:0 0 4px;font-size:11px;font-weight:700;letter-spacing:3px;text-transform:uppercase;color:#999999">Order Reference</p>
            <p style="margin:0;font-size:22px;font-weight:900;color:#1a1a1a;letter-spacing:1px">#${orderNumber}</p>
          </td>
        </tr>
      </table>
      <p style="margin:24px auto 0;font-size:14px;color:#999999;line-height:1.7;max-width:420px">
        No customer details are included in this notification in line with our data privacy policy.
      </p>
    </td>
  </tr>
  <tr><td style="padding:0 48px"><div style="height:3px;background:#CC0000;border-radius:2px"></div></td></tr>
  <tr>
    <td style="padding:28px 48px 32px;background:#fafafa;text-align:center">
      <p style="margin:0 auto;font-size:14px;color:#777777;line-height:1.8;max-width:440px">
        Questions? Reach out to us at <a href="mailto:customer@justwypeit.com" style="color:#CC0000;text-decoration:none;font-weight:700">customer@justwypeit.com</a>
      </p>
    </td>
  </tr>
  <tr>
    <td style="background:#0d0d0d;padding:20px 36px;text-align:center">
      <p style="margin:0;font-size:11px;color:#666666;letter-spacing:1px">
        <a href="https://www.justwypeit.com" style="color:#CC0000;text-decoration:none">justwypeit.com</a>
        &nbsp;·&nbsp; wype® &nbsp;·&nbsp; &copy; 2026 Wype
      </p>
    </td>
  </tr>
</table>
</td></tr>
</table>
</body></html>`;
}

function buildInfluencerNotificationEmail(influencerName, code) {
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>Your code was used!</title></head>
<body style="margin:0;padding:0;background:#f2f2f2;font-family:Arial,sans-serif;color:#1a1a1a">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f2f2f2;padding:40px 0">
<tr><td align="center">
<table width="600" cellpadding="0" cellspacing="0" style="background:#ffffff;max-width:600px;width:100%;overflow:hidden;box-shadow:0 4px 32px rgba(0,0,0,0.1)">
  <tr>
    <td style="background:#0d0d0d;padding:22px 36px;text-align:center">
      <img src="https://www.justwypeit.com/assets/logo.png" width="140" alt="wype" style="width:140px;height:auto;display:inline-block;border:0">
    </td>
  </tr>
  <tr>
    <td style="background:#CC0000;padding:36px 48px 32px;text-align:center">
      <p style="margin:0 0 8px;font-size:11px;font-weight:700;letter-spacing:4px;text-transform:uppercase;color:rgba(255,255,255,0.75)">YOUR CODE IS WORKING</p>
      <h1 style="margin:0;font-size:36px;font-weight:900;color:#ffffff;line-height:1.1;font-family:Arial,sans-serif;text-transform:uppercase;letter-spacing:-0.5px">SOMEONE JUST<br>USED YOUR CODE!</h1>
    </td>
  </tr>
  <tr>
    <td style="padding:36px 48px 28px;text-align:center">
      <p style="margin:0 0 20px;font-size:18px;font-weight:700;color:#111111">Hey ${influencerName} 👋</p>
      <p style="margin:0 auto;font-size:16px;color:#555555;line-height:1.8;max-width:460px">
        Someone just placed an order on <strong>justwypeit.com</strong> using your unique discount code:
      </p>
      <div style="margin:24px auto;display:inline-block;background:#0d0d0d;color:#CC0000;font-size:28px;font-weight:900;letter-spacing:6px;padding:16px 36px;border-radius:8px;font-family:Arial,sans-serif">
        ${code}
      </div>
      <p style="margin:20px auto 0;font-size:15px;color:#777777;line-height:1.7;max-width:420px">
        Keep sharing and watch your community grow. Every order through your code shows your audience trusts your recommendation.
      </p>
    </td>
  </tr>
  <tr><td style="padding:0 48px"><div style="height:3px;background:#CC0000;border-radius:2px"></div></td></tr>
  <tr>
    <td style="padding:32px 48px;background:#fafafa;text-align:center">
      <p style="margin:0 0 8px;font-size:11px;font-weight:700;letter-spacing:3px;text-transform:uppercase;color:#CC0000">Keep it going</p>
      <p style="margin:0 auto;font-size:15px;color:#444444;line-height:1.8;max-width:440px">
        Share your code with your followers and keep the momentum going. The more you share, the more your community saves — and the more they'll trust your word.
      </p>
    </td>
  </tr>
  <tr><td style="padding:0 48px"><div style="height:3px;background:#CC0000;border-radius:2px"></div></td></tr>
  <tr>
    <td style="padding:32px 48px 36px;text-align:center">
      <p style="margin:0 0 20px;font-size:14px;color:#777777">Want to see the full wype® range?</p>
      <a href="https://www.justwypeit.com" style="display:inline-block;background:#CC0000;color:#ffffff;font-family:Arial,sans-serif;font-size:14px;font-weight:700;letter-spacing:1px;padding:14px 36px;border-radius:8px;text-decoration:none;text-transform:uppercase">Visit justwypeit.com</a>
    </td>
  </tr>
  <tr>
    <td style="background:#0d0d0d;padding:20px 36px;text-align:center">
      <p style="margin:0;font-size:11px;color:#666666;letter-spacing:1px">
        <a href="https://www.justwypeit.com" style="color:#CC0000;text-decoration:none">justwypeit.com</a>
        &nbsp;·&nbsp; wype® &nbsp;·&nbsp; &copy; 2026 Wype
      </p>
    </td>
  </tr>
</table>
</td></tr>
</table>
</body></html>`;
}

async function sendOrderEmails(order) {
  // Customer confirmation
  try {
    await sendEmail({
      from:    '"wype®" <customer@justwypeit.com>',
      to:      order.email,
      subject: `Thank you for your order, ${order.firstName} - Order #${order.orderNumber}`,
      html:    buildCustomerConfirmEmail(order),
    });
    console.log(`📧  Customer confirmation sent → ${order.email}`);
  } catch (err) {
    console.error('Customer email error:', err.message);
  }

  // Business notification — direct TO so it always lands in inbox
  try {
    const itemsList = (order.items || []).map(i => `${i.qty || i.quantity}x ${i.name} — £${Number(i.price * (i.qty || i.quantity)).toFixed(2)}`).join('<br>');
    await sendEmail({
      from:    '"wype® Orders" <customer@justwypeit.com>',
      to:      BUSINESS_EMAIL,
      subject: `New Order #${order.orderNumber} — ${order.firstName} ${order.lastName} (£${Number(order.total).toFixed(2)})`,
      html:    `
        <h2 style="margin:0 0 16px">New order received</h2>
        <p><strong>Order:</strong> #${order.orderNumber}</p>
        <p><strong>Customer:</strong> ${order.firstName} ${order.lastName} &lt;${order.email}&gt;</p>
        <p><strong>Items:</strong><br>${itemsList}</p>
        <p><strong>Total:</strong> £${Number(order.total).toFixed(2)}${order.discountCode ? ` (code: ${order.discountCode})` : ''}</p>
        <p><strong>Ship to:</strong> ${order.address}, ${order.city}, ${order.postcode}</p>
        <p style="margin-top:16px;font-size:12px;color:#888">wype® order management</p>
      `,
    });
    console.log(`📧  Business notification sent → ${BUSINESS_EMAIL}`);
  } catch (err) {
    console.error('Business notification email error:', err.message);
  }

  // Influencer notification (no customer data — GDPR)
  if (order.discountCode) {
    const influencer = INFLUENCER_CODES[order.discountCode.toUpperCase()];
    if (influencer) {
      try {
        await sendEmail({
          from:    '"wype®" <customer@justwypeit.com>',
          to:      influencer.email,
          subject: `Someone used your code ${order.discountCode}! 🔴`,
          html:    buildInfluencerNotificationEmail(influencer.name, order.discountCode),
        });
        console.log(`📧  Influencer notification sent → ${influencer.email}`);
      } catch (err) {
        console.error('Influencer email error:', err.message);
      }
    }
  }

  // Partner notification (order number only — no customer data)
  if (order.discountCode) {
    const partner = PARTNER_CODE_MAP[order.discountCode.toUpperCase()];
    if (partner) {
      try {
        await sendEmail({
          from:    '"wype®" <customer@justwypeit.com>',
          to:      partner.email,
          subject: `Your wype® partner code was used — Order #${order.orderNumber}`,
          html:    buildPartnerNotificationEmail(order.orderNumber, order.discountCode.toUpperCase()),
        });
        console.log(`📧  Partner notification sent → ${partner.email}`);
      } catch (err) {
        console.error('Partner notification email error:', err.message);
      }
    }
  }
}

/* Test endpoint — sends influencer preview to business email */
app.post('/api/admin/test-influencer-email', adminMiddleware, async (req, res) => {
  const { code } = req.body;
  const upper = (code || '').toUpperCase();
  const influencer = INFLUENCER_CODES[upper];
  if (!influencer) return res.status(404).json({ error: 'Unknown code.' });
  try {
    await sendEmail({
      from:    '"wype®" <customer@justwypeit.com>',
      to:      BUSINESS_EMAIL,
      subject: `[TEST PREVIEW] Influencer notification for ${upper}`,
      html:    buildInfluencerNotificationEmail(influencer.name, upper),
    });
    res.json({ ok: true, sentTo: BUSINESS_EMAIL });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ─────────────────────────────────────────────
   ROUTE: Register pending order (called before Stripe redirect)
───────────────────────────────────────────── */
app.post('/api/register-pending-order', async (req, res) => {
  const { paymentIntentId, ...orderData } = req.body;
  if (!paymentIntentId || !orderData.email || !orderData.firstName) {
    return res.status(400).json({ error: 'Missing required fields.' });
  }
  try {
    await sql`
      INSERT INTO wype_pending_orders (payment_intent_id, order_data)
      VALUES (${paymentIntentId}, ${JSON.stringify(orderData)})
      ON CONFLICT (payment_intent_id) DO UPDATE SET order_data = EXCLUDED.order_data
    `;
    res.json({ ok: true });
  } catch (err) {
    console.error('Register pending order error:', err.message);
    res.status(500).json({ error: 'Could not save pending order.' });
  }
});

/* ─────────────────────────────────────────────
   ROUTE: Submit order
───────────────────────────────────────────── */
app.post('/submit-order', async (req, res) => {
  const {
    firstName, lastName, email, phone,
    address1, address2, city, postcode,
    notes, items, subtotal, delivery, total,
    discountCode, discountAmt,
    authToken, paymentIntentId,
  } = req.body;

  if (!firstName || !lastName || !email || !address1 || !city || !postcode) {
    return res.status(400).json({ error: 'Missing required fields.' });
  }
  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'No items in order.' });
  }

  // If webhook already saved this order, return the existing order number
  if (paymentIntentId) {
    try {
      const existing = await sql`SELECT order_number FROM wype_orders WHERE payment_intent_id = ${paymentIntentId} LIMIT 1`;
      if (existing.length > 0) {
        console.log(`/submit-order: order already exists for ${paymentIntentId} — returning existing`);
        return res.json({ success: true, orderNumber: existing[0].order_number });
      }
    } catch {}
  }

  // Optionally attach order to a user account
  let userId = null;
  if (authToken) {
    try {
      const decoded = jwt.verify(authToken, JWT_SECRET);
      userId = decoded.id;
    } catch {}
  }

  try {
    const orderNumber = await getNextOrderNumber();
    const order = {
      orderNumber,
      userId,
      firstName,  lastName, email, phone,
      address1, address2, city, postcode, notes, items,
      subtotal:       parseFloat(subtotal).toFixed(2),
      delivery:       parseFloat(delivery).toFixed(2),
      total:          parseFloat(total).toFixed(2),
      discountCode:   discountCode || null,
      discountAmount: discountAmt ? parseFloat(discountAmt).toFixed(2) : null,
      paymentIntentId: paymentIntentId || null,
    };

    await sql`
      INSERT INTO wype_orders
        (order_number, user_id, first_name, last_name, email, phone,
         address1, address2, city, postcode, notes, items,
         subtotal, delivery, total, discount_code, discount_amount, payment_intent_id)
      VALUES
        (${order.orderNumber}, ${order.userId}, ${order.firstName}, ${order.lastName},
         ${order.email}, ${order.phone}, ${order.address1}, ${order.address2},
         ${order.city}, ${order.postcode}, ${order.notes}, ${JSON.stringify(order.items)},
         ${order.subtotal}, ${order.delivery}, ${order.total},
         ${order.discountCode}, ${order.discountAmount}, ${order.paymentIntentId})
    `;

    if (paymentIntentId) {
      sql`DELETE FROM wype_pending_orders WHERE payment_intent_id = ${paymentIntentId}`.catch(() => {});
    }

    sql`UPDATE wype_checkout_intents SET converted_at = NOW() WHERE email = ${email.toLowerCase().trim()} AND converted_at IS NULL`
      .catch(() => {});

    // Await emails before responding — serverless kills the process after res.json()
    try {
      await sendOrderEmails({ ...order, createdAt: new Date().toISOString() });
    } catch (emailErr) {
      console.error('Email send error:', emailErr.message);
    }

    res.json({ success: true, orderNumber: order.orderNumber });
  } catch (err) {
    console.error('Submit order error:', err.message);
    res.status(500).json({ error: 'Could not save order. Please try again.' });
  }
});

/* ─────────────────────────────────────────────
   ROUTE: Checkout intent (abandoned checkout tracking)
───────────────────────────────────────────── */
app.post('/api/checkout-intent', async (req, res) => {
  const { email, firstName, lastName, items, total } = req.body;
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'Invalid email.' });
  }
  try {
    await sql`
      INSERT INTO wype_checkout_intents (email, first_name, last_name, items_json, total, updated_at)
      VALUES (
        ${email.toLowerCase().trim()},
        ${firstName || null},
        ${lastName  || null},
        ${items ? JSON.stringify(items) : null},
        ${total || null},
        NOW()
      )
      ON CONFLICT (email) DO UPDATE SET
        first_name = EXCLUDED.first_name,
        last_name  = EXCLUDED.last_name,
        items_json = COALESCE(EXCLUDED.items_json, wype_checkout_intents.items_json),
        total      = COALESCE(EXCLUDED.total,      wype_checkout_intents.total),
        updated_at = NOW()
      WHERE wype_checkout_intents.converted_at IS NULL
    `;
    res.json({ ok: true });
  } catch (err) {
    console.error('Checkout intent error:', err.message);
    res.status(500).json({ error: 'Could not save intent.' });
  }
});

/* ─────────────────────────────────────────────
   ROUTE: Cron — email abandoned checkouts (>60 min, not converted, not emailed)
───────────────────────────────────────────── */
app.get('/api/cron/abandoned-checkouts', async (req, res) => {
  const secret = process.env.CRON_SECRET;
  if (secret && req.headers['authorization'] !== `Bearer ${secret}`) {
    return res.status(401).json({ error: 'Unauthorized.' });
  }
  try {
    const intents = await sql`
      SELECT id, email, first_name, last_name, items_json, total, created_at
      FROM wype_checkout_intents
      WHERE converted_at IS NULL
        AND emailed_at   IS NULL
        AND updated_at < NOW() - INTERVAL '60 minutes'
      ORDER BY created_at ASC
    `;

    if (intents.length === 0) return res.json({ sent: 0 });

    for (const intent of intents) {
      const name = [intent.first_name, intent.last_name].filter(Boolean).join(' ') || 'Unknown';
      const total = intent.total ? `£${intent.total}` : 'unknown';
      const time  = new Date(intent.created_at).toLocaleString('en-GB', { timeZone: 'Europe/London' });
      let itemsHtml = '';
      try {
        const parsed = JSON.parse(intent.items_json || '[]');
        if (Array.isArray(parsed) && parsed.length) {
          itemsHtml = parsed.map(i => `<li>${i}</li>`).join('');
        }
      } catch {}

      const internalHtml = `<!DOCTYPE html><html><head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#f5f5f5;font-family:Arial,sans-serif">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f5f5f5;padding:32px 0">
<tr><td align="center">
<table width="560" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:10px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.08)">
  <tr><td style="background:#E01E1E;padding:24px 32px;text-align:center">
    <p style="margin:0;font-size:24px;font-weight:900;color:#fff;letter-spacing:3px">wype®</p>
    <p style="margin:6px 0 0;font-size:13px;color:rgba(255,255,255,0.85)">Abandoned Checkout Alert</p>
  </td></tr>
  <tr><td style="padding:32px 40px">
    <p style="margin:0 0 6px;font-size:16px;font-weight:700;color:#111">Someone started checkout but didn't complete their order.</p>
    <p style="margin:0 0 24px;font-size:13px;color:#777">They entered their email. Worth a follow-up.</p>
    <table width="100%" cellpadding="8" cellspacing="0" style="background:#f9f9f9;border-radius:8px;margin-bottom:24px">
      <tr><td style="font-size:13px;color:#555;width:120px"><strong>Name</strong></td><td style="font-size:13px;color:#222">${name}</td></tr>
      <tr><td style="font-size:13px;color:#555"><strong>Email</strong></td><td style="font-size:13px;color:#222"><a href="mailto:${intent.email}" style="color:#E01E1E">${intent.email}</a></td></tr>
      <tr><td style="font-size:13px;color:#555"><strong>Order value</strong></td><td style="font-size:13px;color:#222">${total}</td></tr>
      <tr><td style="font-size:13px;color:#555"><strong>Started at</strong></td><td style="font-size:13px;color:#222">${time}</td></tr>
      ${itemsHtml ? `<tr><td style="font-size:13px;color:#555;vertical-align:top"><strong>Items</strong></td><td style="font-size:13px;color:#222"><ul style="margin:0;padding-left:16px">${itemsHtml}</ul></td></tr>` : ''}
    </table>
    <a href="mailto:${intent.email}?subject=Your%20wype%20order&body=Hi%20${encodeURIComponent(intent.first_name || '')}%2C%0A%0AWe%20noticed%20you%20started%20an%20order%20with%20us%20recently.%20Is%20there%20anything%20we%20can%20help%20you%20with%3F%0A%0AWype%20Team"
       style="display:inline-block;background:#E01E1E;color:#fff;font-size:14px;font-weight:700;padding:12px 28px;border-radius:8px;text-decoration:none">
      Follow up →
    </a>
  </td></tr>
  <tr><td style="background:#f9f9f9;padding:14px 32px;text-align:center">
    <p style="margin:0;font-size:11px;color:#bbb">wype® internal notification · do not reply</p>
  </td></tr>
</table>
</td></tr>
</table>
</body></html>`;

      await sendEmail({
        from:    'wype® <orders@justwypeit.com>',
        to:      BUSINESS_EMAIL,
        subject: `Abandoned checkout: ${name} (${intent.email}) · ${total}`,
        html:    internalHtml,
      });

      await sendEmail({
        from:    '"wype®" <customer@justwypeit.com>',
        to:      intent.email,
        bcc:     BUSINESS_EMAIL,
        subject: `${intent.first_name || 'Your'} basket is still waiting · Use code TRSDE911C63`,
        html:    buildAbandonedCheckoutCustomerEmail(intent),
      });

      await sql`UPDATE wype_checkout_intents SET emailed_at = NOW() WHERE id = ${intent.id}`;
    }

    res.json({ sent: intents.length });
  } catch (err) {
    console.error('Abandoned checkout cron error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/* ─────────────────────────────────────────────
   ROUTE: Trade application
───────────────────────────────────────────── */

function generateTradeCode(businessName) {
  const slug = (businessName || 'TRADE')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, 8);
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let rand = '';
  for (let i = 0; i < 4; i++) rand += chars[Math.floor(Math.random() * chars.length)];
  return `WYPE-${slug}-${rand}`;
}

function buildTradeCustomerEmail(data) {
  const { firstName, businessName, discountCode } = data;
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>wype® Trade Application Received</title>
</head>
<body style="margin:0;padding:0;background:#f0f0f0;font-family:Arial,sans-serif;color:#1a1a1a">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f0f0f0;padding:40px 0">
<tr><td align="center">
<table width="600" cellpadding="0" cellspacing="0" style="background:#ffffff;max-width:600px;width:100%">

  <!-- HEADER -->
  <tr>
    <td style="background:#CC0000;padding:24px 36px 20px">
      <span style="font-size:26px;font-weight:900;color:#ffffff;letter-spacing:2px;font-family:Arial,sans-serif">wype<sup style="font-size:13px;vertical-align:super">®</sup></span>
      <p style="margin:8px 0 0;font-size:11px;font-weight:700;color:#ffffff;letter-spacing:3.5px;text-transform:uppercase">Trade Application</p>
    </td>
  </tr>

  <!-- BODY -->
  <tr>
    <td style="padding:40px 36px">

      <p style="margin:0 0 8px;font-size:11px;font-weight:700;letter-spacing:3px;text-transform:uppercase;color:#CC0000">Application Received</p>
      <div style="height:1px;background:#CC0000;margin-bottom:28px"></div>

      <p style="margin:0 0 20px;font-size:17px;font-weight:700;color:#1a1a1a"><strong>Hi ${firstName},</strong></p>

      <p style="margin:0 0 18px;font-size:15px;line-height:1.8;color:#333333">
        Thanks for applying. We've received your application for <strong>${businessName}</strong> and will be in touch shortly.
      </p>

      <!-- Discount code block -->
      <p style="margin:0 0 8px;font-size:11px;font-weight:700;letter-spacing:3px;text-transform:uppercase;color:#CC0000">Your Exclusive Trade Discount</p>
      <div style="height:1px;background:#CC0000;margin-bottom:20px"></div>

      <p style="margin:0 0 16px;font-size:15px;line-height:1.8;color:#333333">
        As a trade partner, you receive <strong>15% off</strong> all wype® products. Use your unique code at checkout:
      </p>

      <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:24px">
        <tr>
          <td align="center" style="background:#CC0000;border-radius:8px;padding:18px 24px">
            <p style="margin:0 0 4px;font-size:11px;font-weight:700;letter-spacing:3px;text-transform:uppercase;color:rgba(255,255,255,0.75)">Your Trade Code</p>
            <p style="margin:0;font-size:26px;font-weight:900;color:#ffffff;letter-spacing:4px;font-family:Arial,sans-serif">${discountCode}</p>
            <p style="margin:6px 0 0;font-size:12px;color:rgba(255,255,255,0.7)">15% off, applies to all orders</p>
          </td>
        </tr>
      </table>

      <p style="margin:0 0 0;font-size:15px;line-height:1.8;color:#333333">
        Any questions, just reply to this email.
      </p>

      <!-- Signature -->
      <div style="margin-top:36px;padding-top:24px;border-top:1px solid #eeeeee">
        <p style="margin:0 0 4px;font-size:15px;color:#555555">Sab &amp; Kaya</p>
        <p style="margin:0;font-size:13px;color:#999999">wype® &nbsp;·&nbsp; justwypeit.com</p>
      </div>

    </td>
  </tr>

  <!-- FOOTER -->
  <tr>
    <td style="background:#1a1a1a;padding:18px 36px;text-align:center">
      <p style="margin:0;font-size:11px;color:#888888;letter-spacing:1px">
        <a href="https://www.justwypeit.com" style="color:#CC0000;text-decoration:none">justwypeit.com</a>
        &nbsp;·&nbsp; wype® trade programme &nbsp;·&nbsp; © 2026 Wype
      </p>
    </td>
  </tr>

</table>
</td></tr>
</table>
</body>
</html>`;
}

function buildTradeEmailHtml(data) {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#f5f5f5;font-family:Arial,sans-serif">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f5f5f5;padding:32px 0">
<tr><td align="center">
<table width="600" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:8px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.08)">
  <tr><td style="background:#E01E1E;padding:24px 32px">
    <p style="margin:0;font-size:26px;font-weight:900;color:#fff;letter-spacing:2px">wype®</p>
    <p style="margin:4px 0 0;font-size:13px;color:rgba(255,255,255,0.75);letter-spacing:1px">TRADE APPLICATION</p>
  </td></tr>
  <tr><td style="padding:28px 32px">
    <p style="margin:0 0 16px;font-size:16px;font-weight:700;color:#111;border-bottom:2px solid #E01E1E;padding-bottom:8px">Applicant Details</p>
    <table cellpadding="0" cellspacing="0" width="100%">
      <tr><td style="padding:4px 0;font-size:14px;color:#555;width:160px">Name</td><td style="padding:4px 0;font-size:14px;color:#111;font-weight:600">${data.firstName} ${data.lastName}</td></tr>
      <tr><td style="padding:4px 0;font-size:14px;color:#555">Business</td><td style="padding:4px 0;font-size:14px;color:#111;font-weight:600">${data.businessName}</td></tr>
      <tr><td style="padding:4px 0;font-size:14px;color:#555">Business Type</td><td style="padding:4px 0;font-size:14px;color:#111;font-weight:600">${data.businessType}</td></tr>
      <tr><td style="padding:4px 0;font-size:14px;color:#555">Email</td><td style="padding:4px 0;font-size:14px;color:#111;font-weight:600">${data.email}</td></tr>
      <tr><td style="padding:4px 0;font-size:14px;color:#555">Phone</td><td style="padding:4px 0;font-size:14px;color:#111;font-weight:600">${data.phone || 'Not provided'}</td></tr>
      <tr><td style="padding:4px 0;font-size:14px;color:#555">Monthly Order</td><td style="padding:4px 0;font-size:14px;color:#111;font-weight:600">${data.monthlyOrder || 'Not specified'}</td></tr>
      ${data.discountCode ? `<tr><td style="padding:4px 0;font-size:14px;color:#555">Trade Code</td><td style="padding:4px 0;font-size:14px;color:#E01E1E;font-weight:700">${data.discountCode}</td></tr>` : ''}
    </table>
  </td></tr>
  ${data.message ? `<tr><td style="padding:0 32px 28px">
    <p style="margin:0 0 8px;font-size:13px;font-weight:700;color:#555;text-transform:uppercase;letter-spacing:1px">About Their Business</p>
    <p style="margin:0;font-size:14px;color:#111;background:#f9f9f9;padding:12px;border-radius:6px;line-height:1.6">${data.message}</p>
  </td></tr>` : ''}
  <tr><td style="background:#f9f9f9;padding:16px 32px;text-align:center">
    <p style="margin:0;font-size:12px;color:#999">Submitted via wype.co.uk · ${new Date().toLocaleString('en-GB')}</p>
  </td></tr>
</table>
</td></tr>
</table>
</body></html>`;
}

/* ── Feedback submission ── */
app.post('/submit-feedback', async (req, res) => {
  const { vibeScore, vibeLabel, ratings, uses, recommend, orderNumber, comment } = req.body;

  const pip = (n) => n ? '●'.repeat(n) + '○'.repeat(5 - n) + ` (${n}/5)` : 'Not rated';
  const usesList = uses && uses.length ? uses.join(', ') : 'Not specified';
  const recText  = recommend === 'yes' ? '👍 Yes, absolutely' : recommend === 'no' ? '🤷 Not yet' : 'Not answered';
  const emojiFor = { 5:'🔥', 4:'😊', 3:'😐', 2:'😕', 1:'😞' };

  const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>
    body{margin:0;padding:0;font-family:'Inter',Arial,sans-serif;background:#f4f4f4;color:#111;}
    .wrap{max-width:600px;margin:32px auto;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.08);}
    .hdr{background:#CC0000;padding:28px 36px;text-align:center;}
    .hdr-badge{background:#fff;display:inline-block;border-radius:6px;padding:6px 10px;}
    .hdr-badge img{height:36px;display:block;}
    .hdr h1{color:#fff;font-size:20px;margin:16px 0 0;font-family:Arial,sans-serif;letter-spacing:0.5px;}
    .body{padding:32px 36px;}
    .row{display:flex;justify-content:space-between;padding:12px 0;border-bottom:1px solid #f0f0f0;font-size:14px;}
    .row:last-child{border-bottom:none;}
    .lbl{color:#888;font-weight:600;text-transform:uppercase;font-size:11px;letter-spacing:0.8px;}
    .val{color:#111;font-weight:500;text-align:right;max-width:60%;}
    .vibe-box{background:#fff8f8;border:1px solid #f0c0c0;border-radius:10px;padding:16px 20px;margin-bottom:24px;text-align:center;}
    .vibe-emoji{font-size:40px;}
    .vibe-score{font-size:22px;font-weight:700;color:#CC0000;margin-top:4px;}
    .sec{font-size:12px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;color:#CC0000;margin:24px 0 10px;}
    .ftr{background:#f9f9f9;padding:20px 36px;text-align:center;font-size:12px;color:#999;border-top:1px solid #eee;}
  </style></head><body><div class="wrap">
    <div class="hdr">
      <div class="hdr-badge"><img src="https://justwypeit.com/assets/logo.png" alt="wype"></div>
      <h1>Customer Feedback</h1>
    </div>
    <div class="body">
      <div class="vibe-box">
        <div class="vibe-emoji">${emojiFor[vibeScore] || '😐'}</div>
        <div class="vibe-score">${vibeLabel || 'Not set'}: ${vibeScore || '?'}/5</div>
      </div>
      <div class="sec">Detail Ratings</div>
      <div class="row"><span class="lbl">Softness &amp; Feel</span><span class="val">${pip(ratings && ratings.softness)}</span></div>
      <div class="row"><span class="lbl">Streak-free Performance</span><span class="val">${pip(ratings && ratings.performance)}</span></div>
      <div class="row"><span class="lbl">Durability &amp; Washes</span><span class="val">${pip(ratings && ratings.durability)}</span></div>
      <div class="row"><span class="lbl">Value for Money</span><span class="val">${pip(ratings && ratings.value)}</span></div>
      <div class="sec">Usage &amp; Details</div>
      <div class="row"><span class="lbl">Used for</span><span class="val">${usesList}</span></div>
      <div class="row"><span class="lbl">Would recommend</span><span class="val">${recText}</span></div>
      <div class="row"><span class="lbl">Order Number</span><span class="val">${orderNumber || 'Not provided'}</span></div>
      ${comment ? `<div class="sec">Their Words</div><p style="font-size:14px;line-height:1.7;color:#333;background:#fafafa;padding:16px;border-radius:8px;border-left:3px solid #CC0000;margin:0;">"${comment}"</p>` : ''}
    </div>
    <div class="ftr">wype® · justwypeit.com · SAB &amp; KAYA</div>
  </div></body></html>`;

  // Always save to DB first — email is best-effort
  let savedId = null;
  try {
    const rows = await sql`
      INSERT INTO wype_feedback (vibe_score, vibe_label, ratings, uses, recommend, order_number, comment)
      VALUES (${vibeScore || null}, ${vibeLabel || null}, ${JSON.stringify(ratings || {})}, ${JSON.stringify(uses || [])}, ${recommend || null}, ${orderNumber || null}, ${comment || null})
      RETURNING id
    `;
    savedId = rows[0].id;
    console.log(`💾  Feedback saved to DB — id: ${savedId}`);
  } catch (dbErr) {
    console.error('Feedback DB save error:', dbErr.message);
  }

  // Send email notification
  let emailed = false;
  try {
    await sendEmail({
      from:    '"wype Feedback" <customer@justwypeit.com>',
      to:      BUSINESS_EMAIL,
      subject: `Customer Feedback: ${vibeLabel || 'Score ' + vibeScore}${orderNumber ? ' - Order ' + orderNumber : ''}`,
      html,
    });
    emailed = true;
    console.log(`📧  Feedback email sent → ${BUSINESS_EMAIL}`);
    sendWhatsApp(`wype® Feedback\nScore: ${vibeLabel || vibeScore}/5\n${comment ? 'Comment: ' + comment.slice(0, 100) : 'No comment'}${orderNumber ? '\nOrder: ' + orderNumber : ''}`).catch(() => {});
    if (savedId) {
      await sql`UPDATE wype_feedback SET emailed = TRUE WHERE id = ${savedId}`.catch(() => {});
    }
  } catch (err) {
    console.error('Feedback email error:', err.message);
  }

  res.json({ ok: true, saved: !!savedId, emailed });
});

app.post('/submit-trade', async (req, res) => {
  const { firstName, lastName, businessName, businessType, email, phone, monthlyOrder, message } = req.body;
  if (!firstName || !lastName || !businessName || !businessType || !email) {
    return res.status(400).json({ error: 'Missing required fields.' });
  }

  // Generate unique 15% trade discount code
  let discountCode;
  let attempts = 0;
  while (attempts < 10) {
    const candidate = generateTradeCode(businessName);
    try {
      await sql`
        INSERT INTO wype_discount_codes (code, discount_pct, type, business_name, email)
        VALUES (${candidate}, 15, 'trade', ${businessName}, ${email})
      `;
      discountCode = candidate;
      break;
    } catch {
      attempts++;
    }
  }
  if (!discountCode) {
    discountCode = generateTradeCode(businessName + Date.now());
    try {
      await sql`
        INSERT INTO wype_discount_codes (code, discount_pct, type, business_name, email)
        VALUES (${discountCode}, 15, 'trade', ${businessName}, ${email})
        ON CONFLICT (code) DO NOTHING
      `;
    } catch (dbErr) {
      console.error('Fallback discount code DB insert error:', dbErr.message);
    }
  }

  // Always save full application to DB first
  try {
    await sql`
      INSERT INTO wype_trade_applications
        (first_name, last_name, business_name, business_type, email, phone, monthly_order, message, discount_code)
      VALUES
        (${firstName}, ${lastName}, ${businessName}, ${businessType}, ${email}, ${phone || null}, ${monthlyOrder || null}, ${message || null}, ${discountCode})
    `;
    console.log(`💾  Trade application saved — ${businessName} (${discountCode})`);
  } catch (dbErr) {
    console.error('Trade application DB save error:', dbErr.message);
  }

  // 1. Internal notification to business
  try {
    await sendEmail({
      from:    '"wype Trade" <customer@justwypeit.com>',
      to:      BUSINESS_EMAIL,
      replyTo: email,
      subject: `Trade Application: ${businessName} (Code: ${discountCode})`,
      html:    buildTradeEmailHtml({ firstName, lastName, businessName, businessType, email, phone, monthlyOrder, message, discountCode }),
    });
    console.log(`📧  Trade application from ${businessName} → ${BUSINESS_EMAIL}`);
    sendWhatsApp(`wype® Trade Application\nBusiness: ${businessName}\nContact: ${firstName} ${lastName}\nEmail: ${email}${phone ? '\nPhone: ' + phone : ''}\nDiscount Code: ${discountCode}`).catch(() => {});
  } catch (err) {
    console.error('Trade internal email error:', err.message);
  }

  // 2. Customer confirmation with their unique discount code
  try {
    await sendEmail({
      from:    '"wype®" <customer@justwypeit.com>',
      to:      email,
      bcc:     BUSINESS_EMAIL,
      subject: `Trade application received: your 15% code, ${firstName}`,
      html:    buildTradeCustomerEmail({ firstName, lastName, businessName, discountCode }),
    });
    console.log(`📧  Trade confirmation sent → ${email} (code: ${discountCode})`);
    await sql`UPDATE wype_trade_applications SET emailed = TRUE WHERE discount_code = ${discountCode}`.catch(() => {});
  } catch (err) {
    console.error('Trade customer email error:', err.message);
  }

  res.json({ success: true, discountCode });
});

/* ─────────────────────────────────────────────
   ROUTE: Test SMTP (internal use)
───────────────────────────────────────────── */
app.get('/api/test-email', async (req, res) => {
  try {
    await sendEmail({
      from:    '"wype® Test" <customer@justwypeit.com>',
      to:      BUSINESS_EMAIL,
      subject: `wype email test ${new Date().toISOString()}`,
      html:    '<p>Test email from wype server via Resend. If you see this, email is working.</p>',
    });
    res.json({ ok: true, sentTo: BUSINESS_EMAIL });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

/* ─────────────────────────────────────────────
   ROUTE: List all discount codes (admin)
───────────────────────────────────────────── */
app.get('/api/admin/discount-codes', adminMiddleware, async (req, res) => {
  try {
    const rows = await sql`
      SELECT code, discount_pct, type, business_name, email, created_at
      FROM wype_discount_codes
      ORDER BY created_at DESC
    `;
    res.json({ codes: rows });
  } catch (err) {
    console.error('List discount codes error:', err.message);
    res.status(500).json({ error: 'Server error.' });
  }
});

/* ─────────────────────────────────────────────
   ROUTE: Generate refer-a-friend code (£5 off)
───────────────────────────────────────────── */
app.post('/api/create-refer-code', async (req, res) => {
  const { firstName, email } = req.body || {};
  if (!firstName) return res.status(400).json({ error: 'firstName required' });

  const base = (firstName.replace(/[^a-zA-Z]/g, '').toUpperCase().slice(0, 5)).padEnd(3, 'X');
  let code, attempts = 0;
  while (attempts < 10) {
    const suffix = attempts === 0 ? '' : String(attempts);
    const candidate = `WYPE${base}05${suffix}`;
    try {
      await sql`
        INSERT INTO wype_discount_codes (code, discount_pct, type, business_name, email)
        VALUES (${candidate}, 5, 'refer', ${firstName}, ${email || null})
        ON CONFLICT DO NOTHING
      `;
      const check = await sql`SELECT code FROM wype_discount_codes WHERE code = ${candidate}`;
      if (check.length) { code = candidate; break; }
    } catch { /* collision — try next */ }
    attempts++;
  }
  if (!code) return res.status(500).json({ error: 'Could not generate code' });
  res.json({ code });
});

/* ─────────────────────────────────────────────
   ROUTE: Validate discount code
───────────────────────────────────────────── */
app.get('/api/validate-discount', async (req, res) => {
  const code = (req.query.code || '').trim().toUpperCase();
  if (!code) return res.status(400).json({ valid: false, error: 'No code provided.' });

  try {
    const rows = await sql`
      SELECT discount_pct, type, business_name
      FROM wype_discount_codes
      WHERE code = ${code}
      LIMIT 1
    `;
    if (rows.length === 0) {
      return res.json({ valid: false });
    }
    res.json({ valid: true, discountPct: rows[0].discount_pct, type: rows[0].type, businessName: rows[0].business_name });
  } catch (err) {
    console.error('Validate discount error:', err.message);
    res.status(500).json({ valid: false, error: 'Server error.' });
  }
});

/* ─────────────────────────────────────────────
   STRIPE
───────────────────────────────────────────── */
app.get('/stripe-config', (req, res) => {
  res.json({ publishableKey: process.env.STRIPE_PUBLISHABLE_KEY || '' });
});

app.post('/create-payment-intent', async (req, res) => {
  const { amount, currency, country } = req.body;
  if (!Number.isInteger(amount) || amount < 30) {
    return res.status(400).json({ error: 'Invalid amount' });
  }
  const normalizedCurrency = String(currency || 'gbp').toLowerCase();
  const normalizedCountry = String(country || '').toUpperCase();
  const allowedCurrencies = new Set(['gbp', 'eur', 'usd']);
  const paymentCurrency = allowedCurrencies.has(normalizedCurrency) ? normalizedCurrency : 'gbp';
  const wantsIdeal = paymentCurrency === 'eur' || normalizedCountry === 'NL';
  try {
    const intentConfig = {
      amount,
      currency: paymentCurrency,
      metadata: {
        checkout_currency: paymentCurrency,
        site: 'justwypeit.com',
      },
    };

    if (wantsIdeal) {
      intentConfig.currency = 'eur';
      intentConfig.payment_method_types = ['card', 'ideal'];
      intentConfig.metadata.checkout_currency = 'eur';
      intentConfig.metadata.checkout_country = normalizedCountry || 'NL';
    } else {
      intentConfig.automatic_payment_methods = { enabled: true };
    }

    const intent = await stripe.paymentIntents.create(intentConfig);
    res.json({ clientSecret: intent.client_secret });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ─────────────────────────────────────────────
   ROUTE: Track order (public — by order number)
───────────────────────────────────────────── */
app.get('/api/track-order', async (req, res) => {
  const num = (req.query.number || '').trim();
  if (!num) return res.status(400).json({ error: 'Please enter an order number.' });

  try {
    const rows = await sql`
      SELECT order_number, first_name, last_name, email,
             address1, address2, city, postcode,
             items, subtotal, delivery, total,
             status, created_at
      FROM wype_orders
      WHERE order_number = ${num}
      LIMIT 1
    `;
    if (rows.length === 0) {
      return res.status(404).json({ error: 'No order found with that number. Please check and try again.' });
    }
    const o = rows[0];
    res.json({
      orderNumber:  o.order_number,
      name:         o.first_name + ' ' + o.last_name,
      address:      [o.address1, o.address2, o.city, o.postcode].filter(Boolean).join(', '),
      items:        o.items,
      subtotal:     o.subtotal,
      delivery:     o.delivery,
      total:        o.total,
      status:       o.status || 'Processing',
      placedAt:     o.created_at,
    });
  } catch (err) {
    console.error('Track order error:', err.message);
    res.status(500).json({ error: 'Could not look up your order. Please try again.' });
  }
});

if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => console.log(`wype server → http://localhost:${PORT}`));
}

module.exports = app;
