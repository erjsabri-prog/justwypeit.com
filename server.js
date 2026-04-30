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

app.use(express.json());
app.use(express.static(path.join(__dirname)));

// Apple Pay domain verification
app.get('/.well-known/apple-developer-merchantid-domain-association', (req, res) => {
  res.sendFile(path.join(__dirname, '.well-known', 'apple-developer-merchantid-domain-association'));
});

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/wype-plus', (req, res) => res.sendFile(path.join(__dirname, 'wype-plus.html')));

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
  const rows = order.items.map(i =>
    `<tr><td style="padding:8px 12px;border-bottom:1px solid #eee">${i}</td></tr>`
  ).join('');

  return `<!DOCTYPE html><html><head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#f5f5f5;font-family:Arial,sans-serif">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f5f5f5;padding:32px 0">
<tr><td align="center">
<table width="600" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:8px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.08)">
  <tr><td style="background:#E01E1E;padding:24px 32px">
    <p style="margin:0;font-size:26px;font-weight:900;color:#fff;letter-spacing:2px">wype®</p>
    <p style="margin:4px 0 0;font-size:13px;color:rgba(255,255,255,0.75);letter-spacing:1px">NEW ORDER — ${order.orderNumber}</p>
  </td></tr>
  <tr><td style="padding:28px 32px 0">
    <p style="margin:0 0 16px;font-size:16px;font-weight:700;color:#111;border-bottom:2px solid #E01E1E;padding-bottom:8px">Customer Details</p>
    <table cellpadding="0" cellspacing="0" width="100%">
      <tr><td style="padding:4px 0;font-size:14px;color:#555;width:130px">Name</td><td style="padding:4px 0;font-size:14px;color:#111;font-weight:600">${order.firstName} ${order.lastName}</td></tr>
      <tr><td style="padding:4px 0;font-size:14px;color:#555">Email</td><td style="padding:4px 0;font-size:14px;color:#111;font-weight:600">${order.email}</td></tr>
      <tr><td style="padding:4px 0;font-size:14px;color:#555">Phone</td><td style="padding:4px 0;font-size:14px;color:#111;font-weight:600">${order.phone || 'Not provided'}</td></tr>
      <tr><td style="padding:4px 0;font-size:14px;color:#555">Account</td><td style="padding:4px 0;font-size:14px;color:#111;font-weight:600">${order.userId ? 'Registered' : 'Guest'}</td></tr>
    </table>
  </td></tr>
  <tr><td style="padding:20px 32px 0">
    <p style="margin:0 0 12px;font-size:16px;font-weight:700;color:#111;border-bottom:2px solid #E01E1E;padding-bottom:8px">Delivery Address</p>
    <p style="margin:0;font-size:14px;color:#111;line-height:1.8">
      ${order.address1}${order.address2 ? '<br>' + order.address2 : ''}<br>
      ${order.city}<br>${order.postcode}<br>United Kingdom
    </p>
  </td></tr>
  <tr><td style="padding:20px 32px 0">
    <p style="margin:0 0 12px;font-size:16px;font-weight:700;color:#111;border-bottom:2px solid #E01E1E;padding-bottom:8px">Order Items</p>
    <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #eee;border-radius:6px;overflow:hidden">${rows}</table>
  </td></tr>
  <tr><td style="padding:20px 32px">
    <table width="100%" cellpadding="0" cellspacing="0">
      <tr><td style="padding:4px 0;font-size:14px;color:#555">Subtotal</td><td align="right" style="font-size:14px;color:#111">£${order.subtotal}</td></tr>
      <tr><td style="padding:4px 0;font-size:14px;color:#555">Delivery</td><td align="right" style="font-size:14px;color:#111">${order.delivery === '0.00' ? 'FREE' : '£' + order.delivery}</td></tr>
      <tr><td style="padding:8px 0 0;font-size:17px;font-weight:700;color:#111;border-top:2px solid #111">TOTAL</td><td align="right" style="padding:8px 0 0;font-size:17px;font-weight:700;color:#E01E1E;border-top:2px solid #111">£${order.total}</td></tr>
    </table>
  </td></tr>
  ${order.notes ? `<tr><td style="padding:0 32px 20px">
    <p style="margin:0 0 8px;font-size:13px;font-weight:700;color:#555;text-transform:uppercase;letter-spacing:1px">Order Notes</p>
    <p style="margin:0;font-size:14px;color:#111;background:#f9f9f9;padding:12px;border-radius:6px">${order.notes}</p>
  </td></tr>` : ''}
  <tr><td style="background:#f9f9f9;padding:16px 32px;text-align:center">
    <p style="margin:0;font-size:12px;color:#999">Order placed via wype.co.uk · ${new Date().toLocaleString('en-GB')}</p>
  </td></tr>
</table>
</td></tr>
</table>
</body></html>`;
}

/* Customer confirmation email */
function buildCustomerConfirmEmail(order) {
  const BASE = 'https://www.justwypeit.com/assets';
  function productImg(itemStr) {
    const s = (itemStr || '').toLowerCase();
    if (s.includes('micro')) return `${BASE}/micro-flat.jpg`;
    return `${BASE}/nano-folded-side.jpg`;
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

  const address = [order.address1, order.address2, order.city, order.postcode]
    .filter(Boolean).join(', ');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>wype® — Order Confirmed</title>
</head>
<body style="margin:0;padding:0;background:#f0f0f0;font-family:Arial,sans-serif;color:#1a1a1a">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f0f0f0;padding:40px 0">
<tr><td align="center">
<table width="600" cellpadding="0" cellspacing="0" style="background:#ffffff;max-width:600px;width:100%">

  <!-- HEADER -->
  <tr>
    <td style="background:#CC0000;padding:24px 36px 20px">
      <span style="font-size:26px;font-weight:900;color:#ffffff;letter-spacing:2px;font-family:Arial,sans-serif">wype<sup style="font-size:13px;vertical-align:super">®</sup></span>
      <p style="margin:8px 0 0;font-size:11px;font-weight:700;color:#ffffff;letter-spacing:3.5px;text-transform:uppercase">Order Confirmation</p>
    </td>
  </tr>

  <!-- BODY -->
  <tr>
    <td style="padding:40px 36px">

      <!-- Section label -->
      <p style="margin:0 0 8px;font-size:11px;font-weight:700;letter-spacing:3px;text-transform:uppercase;color:#CC0000">Order Confirmed</p>
      <div style="height:1px;background:#CC0000;margin-bottom:28px"></div>

      <p style="margin:0 0 20px;font-size:17px;font-weight:700;color:#1a1a1a;font-family:Arial,sans-serif"><strong>Hi ${order.firstName},</strong></p>

      <p style="margin:0 0 18px;font-size:15px;line-height:1.8;color:#333333">
        Thank you for your order — it means a lot. Your pre-order is confirmed and will ship at the <strong>start of June 2026</strong>.
      </p>

      <!-- Highlight block -->
      <div style="border-left:3px solid #CC0000;padding:14px 18px;background:#fdf5f5;margin:28px 0;font-size:15px;line-height:1.75;color:#444444">
        <strong style="color:#CC0000">You'll receive a separate shipping email</strong> the moment your order is dispatched, with your Royal Mail tracking number so you can follow it every step of the way.
      </div>

      <!-- Order number -->
      <p style="margin:0 0 8px;font-size:11px;font-weight:700;letter-spacing:3px;text-transform:uppercase;color:#CC0000">Your Order</p>
      <div style="height:1px;background:#CC0000;margin-bottom:20px"></div>

      <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:16px">
        <tr>
          <td style="padding:4px 0;font-size:13px;color:#888888;text-transform:uppercase;letter-spacing:1px">Order Number</td>
          <td align="right" style="font-size:18px;font-weight:700;color:#CC0000">#${order.orderNumber}</td>
        </tr>
      </table>

      <!-- Pre-order notice -->
      <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:20px">
        <tr>
          <td style="background:#CC0000;border-radius:8px;padding:14px 20px">
            <p style="margin:0 0 2px;font-size:11px;font-weight:700;letter-spacing:3px;text-transform:uppercase;color:rgba(255,255,255,0.75)">Pre-Order</p>
            <p style="margin:0;font-size:15px;font-weight:700;color:#ffffff;line-height:1.5">Expected to ship <strong>start of June 2026</strong></p>
          </td>
        </tr>
      </table>

      <!-- Items -->
      <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:8px">
        ${itemRows}
      </table>

      <!-- Totals -->
      <table width="100%" cellpadding="0" cellspacing="0" style="margin-top:8px">
        <tr>
          <td style="padding:4px 0;font-size:14px;color:#555555">Subtotal</td>
          <td align="right" style="font-size:14px;color:#111111">£${order.subtotal}</td>
        </tr>
        <tr>
          <td style="padding:4px 0;font-size:14px;color:#555555">Delivery</td>
          <td align="right" style="font-size:14px;color:#111111">${deliveryLine}</td>
        </tr>
        <tr>
          <td style="padding:14px 0 0;font-size:16px;font-weight:700;color:#1a1a1a;border-top:1.5px solid #dddddd">Total Paid</td>
          <td align="right" style="padding:14px 0 0;font-size:16px;font-weight:700;color:#CC0000;border-top:1.5px solid #dddddd">£${order.total}</td>
        </tr>
      </table>

      <!-- Delivery address -->
      <p style="margin:32px 0 8px;font-size:11px;font-weight:700;letter-spacing:3px;text-transform:uppercase;color:#CC0000">Delivering To</p>
      <div style="height:1px;background:#CC0000;margin-bottom:16px"></div>
      <p style="margin:0;font-size:15px;color:#444444;line-height:1.8">
        ${order.firstName} ${order.lastName}<br>${address}
      </p>

      <!-- Track link -->
      <p style="margin:28px 0 0;font-size:15px;line-height:1.8;color:#333333">
        You can track your order at any time using your order number <strong>#${order.orderNumber}</strong> at
        <a href="https://www.justwypeit.com/track.html?order=${order.orderNumber}" style="color:#CC0000;text-decoration:none;font-weight:600">justwypeit.com/track</a>.
      </p>

      <p style="margin:16px 0 0;font-size:15px;line-height:1.8;color:#333333">
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
        &nbsp;·&nbsp; wype® order &nbsp;·&nbsp; © 2026 Wype
      </p>
    </td>
  </tr>

</table>
</td></tr>
</table>
</body>
</html>`;
}

async function sendOrderEmails(order) {
  // 1. Notify business
  try {
    await sendEmail({
      from:    '"wype Orders" <customer@justwypeit.com>',
      to:      BUSINESS_EMAIL,
      subject: `New Order #${order.orderNumber} — ${order.firstName} ${order.lastName} — £${order.total}`,
      html:    buildInternalOrderEmail(order),
    });
    console.log(`📧  Internal order email sent → ${BUSINESS_EMAIL}`);
  } catch (err) {
    console.error('Internal email error:', err.message);
  }

  // 2. Customer confirmation
  try {
    await sendEmail({
      from:    '"wype®" <customer@justwypeit.com>',
      to:      order.email,
      subject: `Thank you for your order, ${order.firstName} — #${order.orderNumber}`,
      html:    buildCustomerConfirmEmail(order),
    });
    console.log(`📧  Customer confirmation sent → ${order.email}`);
  } catch (err) {
    console.error('Customer email error:', err.message);
  }
}

/* ─────────────────────────────────────────────
   ROUTE: Submit order
───────────────────────────────────────────── */
app.post('/submit-order', async (req, res) => {
  const {
    firstName, lastName, email, phone,
    address1, address2, city, postcode,
    notes, items, subtotal, delivery, total,
    authToken,
  } = req.body;

  if (!firstName || !lastName || !email || !address1 || !city || !postcode) {
    return res.status(400).json({ error: 'Missing required fields.' });
  }
  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'No items in order.' });
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
      subtotal:  parseFloat(subtotal).toFixed(2),
      delivery:  parseFloat(delivery).toFixed(2),
      total:     parseFloat(total).toFixed(2),
    };

    await sql`
      INSERT INTO wype_orders
        (order_number, user_id, first_name, last_name, email, phone,
         address1, address2, city, postcode, notes, items,
         subtotal, delivery, total)
      VALUES
        (${order.orderNumber}, ${order.userId}, ${order.firstName}, ${order.lastName},
         ${order.email}, ${order.phone}, ${order.address1}, ${order.address2},
         ${order.city}, ${order.postcode}, ${order.notes}, ${JSON.stringify(order.items)},
         ${order.subtotal}, ${order.delivery}, ${order.total})
    `;

    // Mark checkout intent as converted so no abandoned-checkout email fires
    sql`UPDATE wype_checkout_intents SET converted_at = NOW() WHERE email = ${email.toLowerCase().trim()} AND converted_at IS NULL`
      .catch(() => {});

    // Await emails before responding — serverless kills the process after res.json()
    try {
      await sendOrderEmails({ ...order, createdAt: new Date().toISOString() });
    } catch (emailErr) {
      console.error('Email send error:', emailErr.message);
      // Don't fail the order if email fails — order is already saved
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
      let itemsHtml = '';
      try {
        const parsed = JSON.parse(intent.items_json || '[]');
        if (Array.isArray(parsed) && parsed.length) {
          itemsHtml = parsed.map(i => `<li>${i}</li>`).join('');
        }
      } catch {}

      const name = [intent.first_name, intent.last_name].filter(Boolean).join(' ') || 'Unknown';
      const total = intent.total ? `£${intent.total}` : 'unknown';
      const time  = new Date(intent.created_at).toLocaleString('en-GB', { timeZone: 'Europe/London' });

      const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"></head>
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
    <p style="margin:0 0 24px;font-size:13px;color:#777">They entered their email — worth a follow-up.</p>
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
        subject: `Abandoned checkout — ${name} (${intent.email}) · ${total}`,
        html,
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
<title>wype® — Trade Application Received</title>
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
        Thanks for applying — we've received your application for <strong>${businessName}</strong> and will be in touch shortly.
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
            <p style="margin:6px 0 0;font-size:12px;color:rgba(255,255,255,0.7)">15% off — applies to all orders</p>
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
        <div class="vibe-score">${vibeLabel || 'Not set'} — ${vibeScore || '?'}/5</div>
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
      subject: `Customer Feedback — ${vibeLabel || 'Score ' + vibeScore}${orderNumber ? ' — Order ' + orderNumber : ''}`,
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
      subject: `Trade Application — ${businessName} (Code: ${discountCode})`,
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
      subject: `Trade application received — your 15% code, ${firstName}`,
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
      subject: `wype® email test — ${new Date().toISOString()}`,
      html:    '<p>Test email from wype server via Resend. If you see this, email is working.</p>',
    });
    res.json({ ok: true, sentTo: BUSINESS_EMAIL });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
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
  const { amount } = req.body;
  if (!Number.isInteger(amount) || amount < 30) {
    return res.status(400).json({ error: 'Invalid amount' });
  }
  try {
    const intent = await stripe.paymentIntents.create({
      amount,
      currency: 'gbp',
      automatic_payment_methods: { enabled: true },
    });
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
