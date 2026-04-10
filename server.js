require('dotenv').config();
const express    = require('express');
const Stripe     = require('stripe');
const nodemailer = require('nodemailer');
const fs         = require('fs');
const path       = require('path');

const app    = express();
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

app.use(express.json());
app.use(express.static(path.join(__dirname)));

/* ─────────────────────────────────────────────
   ORDER NUMBER — persisted in order-counter.json
   Starts at 1, increments with every order.
───────────────────────────────────────────── */
const COUNTER_FILE = path.join(__dirname, 'order-counter.json');

function getNextOrderNumber() {
  let data = { next: 1 };
  try {
    if (fs.existsSync(COUNTER_FILE)) {
      data = JSON.parse(fs.readFileSync(COUNTER_FILE, 'utf8'));
    }
  } catch {}
  const num = data.next;
  fs.writeFileSync(COUNTER_FILE, JSON.stringify({ next: num + 1 }));
  return num;
}

/* ─────────────────────────────────────────────
   EMAIL — configure these in .env when ready:
     ORDERS_TO_EMAIL=orders@wype.co.uk
     SMTP_HOST=smtp.gmail.com
     SMTP_USER=your@gmail.com
     SMTP_PASS=your-app-password
───────────────────────────────────────────── */
function buildEmailHtml(order) {
  const rows = order.items.map(i =>
    `<tr><td style="padding:8px 12px;border-bottom:1px solid #eee">${i}</td></tr>`
  ).join('');

  return `
<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#f5f5f5;font-family:Arial,sans-serif">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f5f5f5;padding:32px 0">
    <tr><td align="center">
      <table width="600" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:8px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.08)">

        <!-- Header -->
        <tr><td style="background:#E01E1E;padding:24px 32px">
          <p style="margin:0;font-size:26px;font-weight:900;color:#fff;letter-spacing:2px">wype®</p>
          <p style="margin:4px 0 0;font-size:13px;color:rgba(255,255,255,0.75);letter-spacing:1px">NEW ORDER — ${order.orderNumber}</p>
        </td></tr>

        <!-- Customer -->
        <tr><td style="padding:28px 32px 0">
          <p style="margin:0 0 16px;font-size:16px;font-weight:700;color:#111;border-bottom:2px solid #E01E1E;padding-bottom:8px">Customer Details</p>
          <table cellpadding="0" cellspacing="0" width="100%">
            <tr><td style="padding:4px 0;font-size:14px;color:#555;width:130px">Name</td><td style="padding:4px 0;font-size:14px;color:#111;font-weight:600">${order.firstName} ${order.lastName}</td></tr>
            <tr><td style="padding:4px 0;font-size:14px;color:#555">Email</td><td style="padding:4px 0;font-size:14px;color:#111;font-weight:600">${order.email}</td></tr>
            <tr><td style="padding:4px 0;font-size:14px;color:#555">Phone</td><td style="padding:4px 0;font-size:14px;color:#111;font-weight:600">${order.phone || 'Not provided'}</td></tr>
          </table>
        </td></tr>

        <!-- Address -->
        <tr><td style="padding:20px 32px 0">
          <p style="margin:0 0 12px;font-size:16px;font-weight:700;color:#111;border-bottom:2px solid #E01E1E;padding-bottom:8px">Delivery Address</p>
          <p style="margin:0;font-size:14px;color:#111;line-height:1.8">
            ${order.address1}${order.address2 ? '<br>' + order.address2 : ''}<br>
            ${order.city}<br>
            ${order.postcode}<br>
            United Kingdom
          </p>
        </td></tr>

        <!-- Order Items -->
        <tr><td style="padding:20px 32px 0">
          <p style="margin:0 0 12px;font-size:16px;font-weight:700;color:#111;border-bottom:2px solid #E01E1E;padding-bottom:8px">Order Items</p>
          <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #eee;border-radius:6px;overflow:hidden">
            ${rows}
          </table>
        </td></tr>

        <!-- Totals -->
        <tr><td style="padding:20px 32px">
          <table width="100%" cellpadding="0" cellspacing="0">
            <tr><td style="padding:4px 0;font-size:14px;color:#555">Subtotal</td><td align="right" style="font-size:14px;color:#111">£${order.subtotal}</td></tr>
            <tr><td style="padding:4px 0;font-size:14px;color:#555">Delivery</td><td align="right" style="font-size:14px;color:#111">${order.delivery === '0.00' ? 'FREE' : '£' + order.delivery}</td></tr>
            <tr><td style="padding:8px 0 0;font-size:17px;font-weight:700;color:#111;border-top:2px solid #111">TOTAL</td><td align="right" style="padding:8px 0 0;font-size:17px;font-weight:700;color:#E01E1E;border-top:2px solid #111">£${order.total}</td></tr>
          </table>
        </td></tr>

        ${order.notes ? `
        <tr><td style="padding:0 32px 20px">
          <p style="margin:0 0 8px;font-size:13px;font-weight:700;color:#555;text-transform:uppercase;letter-spacing:1px">Order Notes</p>
          <p style="margin:0;font-size:14px;color:#111;background:#f9f9f9;padding:12px;border-radius:6px">${order.notes}</p>
        </td></tr>` : ''}

        <!-- Footer -->
        <tr><td style="background:#f9f9f9;padding:16px 32px;text-align:center">
          <p style="margin:0;font-size:12px;color:#999">Order placed via wype.co.uk · ${new Date().toLocaleString('en-GB')}</p>
        </td></tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

async function sendOrderEmail(order) {
  const toEmail   = process.env.ORDERS_TO_EMAIL;
  const smtpUser  = process.env.SMTP_USER;
  const smtpPass  = process.env.SMTP_PASS;
  const smtpHost  = process.env.SMTP_HOST || 'smtp.gmail.com';
  const smtpPort  = parseInt(process.env.SMTP_PORT || '587');

  if (!toEmail || !smtpUser || !smtpPass) {
    console.warn('⚠️  Email not configured — add ORDERS_TO_EMAIL, SMTP_USER, SMTP_PASS to .env');
    return;
  }

  const transporter = nodemailer.createTransport({
    host:   smtpHost,
    port:   smtpPort,
    secure: smtpPort === 465,
    auth:   { user: smtpUser, pass: smtpPass },
  });

  await transporter.sendMail({
    from:    `"wype Orders" <${smtpUser}>`,
    to:      toEmail,
    subject: `New Order ${order.orderNumber} — ${order.firstName} ${order.lastName} — £${order.total}`,
    html:    buildEmailHtml(order),
  });

  console.log(`📧  Order ${order.orderNumber} email sent to ${toEmail}`);
}

/* ─────────────────────────────────────────────
   ROUTE: Submit order
───────────────────────────────────────────── */
app.post('/submit-order', async (req, res) => {
  const {
    firstName, lastName, email, phone,
    address1, address2, city, postcode,
    notes, items, subtotal, delivery, total
  } = req.body;

  if (!firstName || !lastName || !email || !address1 || !city || !postcode) {
    return res.status(400).json({ error: 'Missing required fields.' });
  }
  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'No items in order.' });
  }

  const orderNum   = getNextOrderNumber();
  const orderNumber = `#${orderNum}`;

  const order = {
    orderNumber, firstName, lastName, email, phone,
    address1, address2, city, postcode, notes, items,
    subtotal: parseFloat(subtotal).toFixed(2),
    delivery: parseFloat(delivery).toFixed(2),
    total:    parseFloat(total).toFixed(2),
  };

  try {
    await sendOrderEmail(order);
  } catch (err) {
    console.error('Email error:', err.message);
    // Order still succeeds even if email fails
  }

  res.json({ success: true, orderNumber });
});

/* ─────────────────────────────────────────────
   STRIPE (kept for future payment integration)
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () =>
  console.log(`wype server → http://localhost:${PORT}`)
);
