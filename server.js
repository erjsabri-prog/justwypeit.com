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

if (!process.env.JWT_SECRET) throw new Error('JWT_SECRET env var is required but not set');
const JWT_SECRET     = process.env.JWT_SECRET;
const BUSINESS_EMAIL = process.env.ORDERS_TO_EMAIL || 'customer@justwypeit.com';
const PUBLIC_SITE_URL = (process.env.PUBLIC_SITE_URL || 'https://www.justwypeit.com').replace(/\/+$/, '');
const ASSET_BASE_URL  = `${PUBLIC_SITE_URL}/assets`;

/* ── Retry with exponential backoff ── */
async function withRetry(fn, maxAttempts = 3, baseDelayMs = 500) {
  let lastErr;
  for (let i = 0; i < maxAttempts; i++) {
    try { return await fn(); } catch (err) {
      lastErr = err;
      if (i < maxAttempts - 1) await new Promise(r => setTimeout(r, baseDelayMs * Math.pow(2, i)));
    }
  }
  throw lastErr;
}

/* ── Send failure alert email + write to failed_orders table ── */
async function sendFailureAlert(err, context, orderData) {
  const alertTo = [BUSINESS_EMAIL];
  const piId = orderData?.paymentIntentId || orderData?.payment_intent_id || 'unknown';
  try {
    await sendEmail({
      from:    '"wype® Alerts" <customer@justwypeit.com>',
      to:      alertTo,
      subject: `[ORDER_FAIL] ${context} — action required`,
      html: `<!DOCTYPE html><html><body style="font-family:Arial,sans-serif;padding:32px;color:#1a1a1a">
<h2 style="color:#CC0000">⚠️ Order Processing Failure</h2>
<p><strong>Context:</strong> ${context}</p>
<p><strong>Error:</strong> <code>${String(err?.message || err)}</code></p>
<p><strong>Payment Intent:</strong> <a href="https://dashboard.stripe.com/payments/${piId}">${piId}</a></p>
<p><strong>Customer:</strong> ${orderData?.firstName || ''} ${orderData?.lastName || ''} &lt;${orderData?.email || 'unknown'}&gt;</p>
<p><strong>Total:</strong> £${orderData?.total || '?'}</p>
<pre style="background:#f5f5f5;padding:16px;border-radius:8px;overflow:auto;font-size:12px">${JSON.stringify(orderData, null, 2)}</pre>
<p style="color:#888;font-size:12px">Check admin portal and Stripe dashboard immediately.</p>
</body></html>`,
    });
  } catch (alertErr) {
    console.error('[ORDER_FAIL] Failed to send alert email:', alertErr.message);
  }
  try {
    await sql`
      INSERT INTO wype_failed_orders (error_message, order_data, payment_intent_id)
      VALUES (${String(err?.message || err)}, ${JSON.stringify(orderData)}, ${piId})
    `;
  } catch (dbErr) {
    console.error('[ORDER_FAIL] Failed to write to failed_orders:', dbErr.message);
  }
}

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
      // Supplement missing fields from Stripe charge billing details (Apple Pay / Google Pay
      // wallets often pay before the customer fills our form).
      let chargeBilling = null;
      if (!od.firstName || !od.email || !od.address1) {
        try {
          const charge = await stripe.charges.retrieve(pi.latest_charge || pi.id).catch(() => null);
          chargeBilling = charge?.billing_details || null;
        } catch {}
      }
      const cb = chargeBilling || {};
      const cbAddr = cb.address || {};
      const cbNameParts = (cb.name || '').trim().split(' ');
      const orderNumber = await getNextOrderNumber();
      const order = {
        orderNumber,
        userId:         od.userId || null,
        firstName:      od.firstName || cbNameParts[0] || null,
        lastName:       od.lastName  || cbNameParts.slice(1).join(' ') || null,
        email:          od.email     || cb.email  || null,
        phone:          od.phone     || cb.phone  || null,
        address1:       od.address1  || cbAddr.line1       || null,
        address2:       od.address2  || cbAddr.line2       || null,
        city:           od.city      || cbAddr.city        || null,
        postcode:       od.postcode  || cbAddr.postal_code || null,
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
      if (order.email) {
        sql`UPDATE wype_checkout_intents SET converted_at = NOW() WHERE email = ${order.email.toLowerCase().trim()} AND converted_at IS NULL`.catch(() => {});
      }
      stripe.paymentIntents.update(pi.id, { metadata: {
        order_number:  order.orderNumber,
        customer_name: `${order.firstName} ${order.lastName}`,
        customer_email: order.email,
        items_summary: order.items.slice(0,3).join(' | ').slice(0,490),
      }}).catch(e => console.warn('Stripe metadata update failed:', e.message));
      await withRetry(() => sendOrderEmails({ ...order, createdAt: new Date().toISOString() }));
      console.log(`✅ Webhook: order ${orderNumber} created + emails sent for ${order.email}`);
    } catch (err) {
      console.error('[ORDER_FAIL] Webhook order processing error:', err.message, 'PI:', pi.id);
      await sendFailureAlert(err, 'Stripe webhook handler', { ...order, paymentIntentId: pi.id }).catch(() => {});
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
      res.setHeader('Cache-Control', 'no-store, max-age=0');
    }
  }
}));

// Apple Pay domain verification (content inlined: bundler drops non-js files)
const APPLE_PAY_DOMAIN_ASSOCIATION = '7B227073704964223A2239373943394538343346343131343044463144313834343232393232313734313034353044314339464446394437384337313531303944334643463542433731222C2276657273696F6E223A312C22637265617465644F6E223A313731353230333737303832312C227369676E6174757265223A223330383030363039326138363438383666373064303130373032613038303330383030323031303133313064333030623036303936303836343830313635303330343032303133303830303630393261383634383836663730643031303730313030303061303830333038323033653333303832303338386130303330323031303230323038313636333463386230653330353731373330306130363038326138363438636533643034303330323330376133313265333032633036303335353034303330633235343137303730366336353230343137303730366336393633363137343639366636653230343936653734363536373732363137343639366636653230343334313230326432303437333333313236333032343036303335353034306230633164343137303730366336353230343336353732373436393636363936333631373436393666366532303431373537343638366637323639373437393331313333303131303630333535303430613063306134313730373036633635323034393665363332653331306233303039303630333535303430363133303235353533333031653137306433323334333033343332333933313337333433373332333735613137306433323339333033343332333833313337333433373332333635613330356633313235333032333036303335353034303330633163363536333633326437333664373032643632373236663662363537323264373336393637366535663535343333343264353035323466343433313134333031323036303335353034306230633062363934663533323035333739373337343635366437333331313333303131303630333535303430613063306134313730373036633635323034393665363332653331306233303039303630333535303430363133303235353533333035393330313330363037326138363438636533643032303130363038326138363438636533643033303130373033343230303034633231353737656465626436633762323231386636386464373039306131323138646337623062643666326332383364383436303935643934616634613534313162383334323065643831316633343037653833333331663163353463336637656233323230643662616435643465666634393238393839336537633066313361333832303231313330383230323064333030633036303335353164313330313031666630343032333030303330316630363033353531643233303431383330313638303134323366323439633434663933653465663237653663346636323836633366613262626664326534623330343530363038326230363031303530353037303130313034333933303337333033353036303832623036303130353035303733303031383632393638373437343730336132663266366636333733373032653631373037303663363532653633366636643266366636333733373033303334326436313730373036633635363136393633363133333330333233303832303131643036303335353164323030343832303131343330383230313130333038323031306330363039326138363438383666373633363430353031333038316665333038316333303630383262303630313035303530373032303233303831623630633831623335323635366336393631366536333635323036663665323037343638363937333230363336353732373436393636363936333631373436353230363237393230363136653739323037303631373237343739323036313733373337353664363537333230363136333633363537303734363136653633363532303666363632303734363836353230373436383635366532303631373037303663363936333631363236633635323037333734363136653634363137323634323037343635373236643733323036313665363432303633366636653634363937343639366636653733323036663636323037353733363532633230363336353732373436393636363936333631373436353230373036663663363936333739323036313665363432303633363537323734363936363639363336313734363936663665323037303732363136333734363936333635323037333734363137343635366436353665373437333265333033363036303832623036303130353035303730323031313632613638373437343730336132663266373737373737326536313730373036633635326536333666366432663633363537323734363936363639363336313734363536313735373436383666373236393734373932663330333430363033353531643166303432643330326233303239613032376130323538363233363837343734373033613266326636333732366332653631373037303663363532653633366636643266363137303730366336353631363936333631333332653633373236633330316430363033353531643065303431363034313439343537646236666435373438313836383938393736326637653537383530376537396235383234333030653036303335353164306630313031666630343034303330323037383033303066303630393261383634383836663736333634303631643034303230353030333030613036303832613836343863653364303430333032303334393030333034363032323130306336663032336362323631346262333033383838613136323938336531613933663130353666353066613738636462396261346361323431636331346532356530323231303062653363643064666431363234376636343934343735333830653964343463323238613130383930613361316463373234623862346362383838393831386263333038323032656533303832303237356130303330323031303230323038343936643266626633613938646139373330306130363038326138363438636533643034303330323330363733313162333031393036303335353034303330633132343137303730366336353230353236663666373432303433343132303264323034373333333132363330323430363033353530343062306331643431373037303663363532303433363537323734363936363639363336313734363936663665323034313735373436383666373236393734373933313133333031313036303335353034306130633061343137303730366336353230343936653633326533313062333030393036303335353034303631333032353535333330316531373064333133343330333533303336333233333334333633333330356131373064333233393330333533303336333233333334333633333330356133303761333132653330326330363033353530343033306332353431373037303663363532303431373037303663363936333631373436393666366532303439366537343635363737323631373436393666366532303433343132303264323034373333333132363330323430363033353530343062306331643431373037303663363532303433363537323734363936363639363336313734363936663665323034313735373436383666373236393734373933313133333031313036303335353034306130633061343137303730366336353230343936653633326533313062333030393036303335353034303631333032353535333330353933303133303630373261383634386365336430323031303630383261383634386365336430333031303730333432303030346630313731313834313964373634383564353161356532353831303737366538383061326566646537626165346465303864666334623933653133333536643536363562333561653232643039373736306432323465376262613038666437363137636538386362373662623636373062656338653832393834666635343435613338316637333038316634333034363036303832623036303130353035303730313031303433613330333833303336303630383262303630313035303530373330303138363261363837343734373033613266326636663633373337303265363137303730366336353265363336663664326636663633373337303330333432643631373037303663363537323666366637343633363136373333333031643036303335353164306530343136303431343233663234396334346639336534656632376536633466363238366333666132626266643265346233303066303630333535316431333031303166663034303533303033303130316666333031663036303335353164323330343138333031363830313462626230646561313538333338383961613438613939646562656264656261666461636232346162333033373036303335353164316630343330333032653330326361303261613032383836323636383734373437303361326632663633373236633265363137303730366336353265363336663664326636313730373036633635373236663666373436333631363733333265363337323663333030653036303335353164306630313031666630343034303330323031303633303130303630613261383634383836663736333634303630323065303430323035303033303061303630383261383634386365336430343033303230333637303033303634303233303361636637323833353131363939623138366662333563333536636136326266663431376564643930663735346461323865626566313963383135653432623738396638393866373962353939663938643534313064386639646539633266653032333033323264643534343231623061333035373736633564663333383362393036376664313737633263323136643936346663363732363938323132366635346638376137643162393963623962303938393231363130363939306630393932316430303030333138323031383833303832303138343032303130313330383138363330376133313265333032633036303335353034303330633235343137303730366336353230343137303730366336393633363137343639366636653230343936653734363536373732363137343639366636653230343334313230326432303437333333313236333032343036303335353034306230633164343137303730366336353230343336353732373436393636363936333631373436393666366532303431373537343638366637323639373437393331313333303131303630333535303430613063306134313730373036633635323034393665363332653331306233303039303630333535303430363133303235353533303230383136363334633862306533303537313733303062303630393630383634383031363530333034303230316130383139333330313830363039326138363438383666373064303130393033333130623036303932613836343838366637306430313037303133303163303630393261383634383836663730643031303930353331306631373064333233343330333533303338333233313332333933333330356133303238303630393261383634383836663730643031303933343331316233303139333030623036303936303836343830313635303330343032303161313061303630383261383634386365336430343033303233303266303630393261383634383836663730643031303930343331323230343230333232323236336439393239313365333235663163306437643761363331346230343535303337343561363032346633633930313232366166333530626332653330306130363038326138363438636533643034303330323034343733303435303232303537386536353236623062356233306465323562346231343865366632336530626438383631353335613666623865633461396465373338343333633262653530323231303062653834323635333334393162303965376330306437333565323762643865623236373964653462366433613138666434636564386261376565306166383161303030303030303030303030227D';
app.get('/.well-known/apple-developer-merchantid-domain-association', (req, res) => {
  res.type('text/plain').send(APPLE_PAY_DOMAIN_ASSOCIATION);
});

function noCache(res) {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
}
app.get('/', (req, res) => { noCache(res); res.sendFile(path.join(__dirname, 'index.html')); });
app.get('/wype-plus', (req, res) => { noCache(res); res.sendFile(path.join(__dirname, 'wype-plus.html')); });
app.get('/nanowype-plus', (req, res) => { noCache(res); res.sendFile(path.join(__dirname, 'nanowype-plus.html')); });
app.get('/multiwype-plus', (req, res) => { noCache(res); res.sendFile(path.join(__dirname, 'multiwype-plus.html')); });
app.get('/airwype-plus', (req, res) => { noCache(res); res.sendFile(path.join(__dirname, 'airwype-plus.html')); });
app.get('/collections/airwype-plus', (req, res) => { noCache(res); res.sendFile(path.join(__dirname, 'airwype-collection.html')); });
app.get(/^\/products\/airwype-[a-z0-9-]+$/, (req, res) => { noCache(res); res.sendFile(path.join(__dirname, 'airwype-plus.html')); });
app.get('/admin', (req, res) => { noCache(res); res.sendFile(path.join(__dirname, 'admin.html')); });
app.get('/affiliate', (req, res) => { noCache(res); res.sendFile(path.join(__dirname, 'affiliate.html')); });
app.get('/order-confirmed', (req, res) => { noCache(res); res.sendFile(path.join(__dirname, 'order-confirmed.html')); });
 app.get('/news', (req, res) => { noCache(res); res.sendFile(path.join(__dirname, 'news.html')); });
 app.get('/track', (req, res) => { noCache(res); res.sendFile(path.join(__dirname, 'track.html')); });

/* SEO: robots + sitemap (served inline; static files are not bundled into the function) */
app.get('/robots.txt', (req, res) => {
  res.type('text/plain').send(
`User-agent: *
Allow: /
Disallow: /admin
Disallow: /account.html
Disallow: /checkout.html
Disallow: /order-confirmed
Disallow: /affiliate
Disallow: /api/

Sitemap: https://justwypeit.com/sitemap.xml
`);
});

app.get('/sitemap.xml', (req, res) => {
  const base = 'https://justwypeit.com';
  const pages = [
    { loc: '/',                pri: '1.0' },
    { loc: '/nanowype-plus',   pri: '0.9' },
    { loc: '/wype-plus',       pri: '0.9' },
    { loc: '/about.html',      pri: '0.6' },
    { loc: '/faq.html',        pri: '0.6' },
    { loc: '/trade.html',      pri: '0.6' },
    { loc: '/news',            pri: '0.5' },
    { loc: '/track.html',      pri: '0.3' },
    { loc: '/privacy.html',    pri: '0.2' },
    { loc: '/complaints.html', pri: '0.2' },
  ];
  const urls = pages.map(p =>
    `  <url><loc>${base}${p.loc}</loc><priority>${p.pri}</priority></url>`).join('\n');
  res.type('application/xml').send(
`<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls}
</urlset>
`);
});

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
  await sql`ALTER TABLE wype_discount_codes ADD COLUMN IF NOT EXISTS active BOOLEAN DEFAULT TRUE`;
  await sql`ALTER TABLE wype_orders ADD COLUMN IF NOT EXISTS payment_intent_id TEXT`;
  await sql`ALTER TABLE wype_orders ADD COLUMN IF NOT EXISTS admin_note TEXT`;
  await sql`ALTER TABLE wype_orders ADD COLUMN IF NOT EXISTS carrier TEXT`;
  await sql`ALTER TABLE wype_orders ADD COLUMN IF NOT EXISTS flagged BOOLEAN DEFAULT FALSE`;
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS wype_orders_payment_intent_idx ON wype_orders (payment_intent_id) WHERE payment_intent_id IS NOT NULL`;
  await sql`
    CREATE TABLE IF NOT EXISTS wype_pending_orders (
      payment_intent_id TEXT PRIMARY KEY,
      order_data        JSONB NOT NULL,
      created_at        TIMESTAMPTZ DEFAULT NOW()
    )
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS wype_failed_orders (
      id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      error_message     TEXT,
      order_data        JSONB,
      payment_intent_id TEXT,
      created_at        TIMESTAMPTZ DEFAULT NOW()
    )
  `;
  // ── Affiliate programme ──
  await sql`
    CREATE TABLE IF NOT EXISTS wype_affiliates (
      id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name               TEXT NOT NULL,
      email              TEXT UNIQUE NOT NULL,
      password_hash      TEXT,
      code               TEXT NOT NULL,
      commission_pct     NUMERIC(5,2) NOT NULL DEFAULT 10,
      set_password_token TEXT,
      active             BOOLEAN DEFAULT TRUE,
      created_at         TIMESTAMPTZ DEFAULT NOW()
    )
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS wype_affiliate_payouts (
      id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      affiliate_id UUID NOT NULL,
      amount       NUMERIC(10,2) NOT NULL,
      note         TEXT,
      created_at   TIMESTAMPTZ DEFAULT NOW()
    )
  `;
  // Ensure discount-code columns the affiliate flow relies on exist
  await sql`ALTER TABLE wype_discount_codes ADD COLUMN IF NOT EXISTS type TEXT NOT NULL DEFAULT 'trade'`;
  await sql`ALTER TABLE wype_discount_codes ADD COLUMN IF NOT EXISTS business_name TEXT`;
  await sql`ALTER TABLE wype_discount_codes ADD COLUMN IF NOT EXISTS email TEXT`;
  await sql`ALTER TABLE wype_orders ADD COLUMN IF NOT EXISTS discount_code TEXT`;
  await sql`ALTER TABLE wype_orders ADD COLUMN IF NOT EXISTS discount_amount NUMERIC(10,2)`;
  await sql`
    CREATE TABLE IF NOT EXISTS wype_subscribers (
      id            SERIAL PRIMARY KEY,
      email         TEXT UNIQUE NOT NULL,
      source        TEXT,
      discount_code TEXT,
      created_at    TIMESTAMPTZ DEFAULT NOW()
    )
  `;
  await sql`ALTER TABLE wype_subscribers ADD COLUMN IF NOT EXISTS unsubscribed BOOLEAN DEFAULT FALSE`;
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
   AFFILIATE MIDDLEWARE
───────────────────────────────────────────── */
async function affiliateMiddleware(req, res, next) {
  const header = req.headers.authorization || '';
  const token  = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Not authenticated.' });
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    if (decoded.role !== 'affiliate') return res.status(403).json({ error: 'Forbidden.' });
    const rows = await sql`SELECT * FROM wype_affiliates WHERE id = ${decoded.id} LIMIT 1`;
    if (!rows.length)          return res.status(401).json({ error: 'Account not found.' });
    if (rows[0].active === false) return res.status(403).json({ error: 'Account disabled.' });
    req.affiliate = rows[0];
    next();
  } catch {
    res.status(401).json({ error: 'Token invalid or expired.' });
  }
}

/* ─────────────────────────────────────────────
   ADMIN MIDDLEWARE + ROUTES
───────────────────────────────────────────── */
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'jaysargent2014@gmail.com';

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
  const plainMatch = password === adminPw;
  if (!match && !plainMatch) return res.status(401).json({ error: 'Invalid credentials.' });
  const token = jwt.sign({ role: 'admin', email: ADMIN_EMAIL }, JWT_SECRET, { expiresIn: '12h' });
  res.json({ token });
});

/* ── Admin PIN verification (second factor) ── */
const ADMIN_PIN_HASH = '$2b$12$lpwUqwNpojDthgrOrFubJufidWpA9meK3BBKgLdj8zeWUtlaguor6';
app.post('/api/admin/verify-pin', adminMiddleware, async (req, res) => {
  const { pin } = req.body;
  if (!pin) return res.status(400).json({ error: 'PIN required.' });
  const ok = await bcrypt.compare(String(pin), ADMIN_PIN_HASH).catch(() => false);
  if (!ok) return res.status(401).json({ error: 'Incorrect PIN.' });
  const pinToken = jwt.sign({ role: 'admin-pin', email: ADMIN_EMAIL }, JWT_SECRET, { expiresIn: '12h' });
  res.json({ pinToken });
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

app.get('/api/admin/stripe-stats', adminMiddleware, async (req, res) => {
  try {
    const [balance, txns] = await Promise.all([
      stripe.balance.retrieve(),
      stripe.balanceTransactions.list({ limit: 100, type: 'charge' }),
    ]);
    const grossPence = txns.data.reduce((s, t) => s + t.amount, 0);
    const feePence   = txns.data.reduce((s, t) => s + t.fee, 0);
    const netPence   = txns.data.reduce((s, t) => s + t.net, 0);
    const available  = balance.available.find(b => b.currency === 'gbp');
    const pending    = balance.pending.find(b => b.currency === 'gbp');
    res.json({
      grossVolume: (grossPence / 100).toFixed(2),
      stripeFees:  (feePence  / 100).toFixed(2),
      netVolume:   (netPence  / 100).toFixed(2),
      available:   available ? (available.amount / 100).toFixed(2) : '0.00',
      pending:     pending   ? (pending.amount   / 100).toFixed(2) : '0.00',
      txnCount:    txns.data.length,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/admin/orders', adminMiddleware, async (req, res) => {
  try {
    const orders = await sql`
      SELECT id, order_number, first_name, last_name, email, phone,
             address1, address2, city, postcode, notes, items,
             subtotal, delivery, total, status, created_at,
             COALESCE(tracking_number, '') as tracking_number,
             dispatched_at, admin_note, flagged,
             discount_code, discount_amount
      FROM wype_orders
      ORDER BY created_at DESC
    `.catch(() => sql`
      SELECT id, order_number, first_name, last_name, email, phone,
             address1, address2, city, postcode, notes, items,
             subtotal, delivery, total, status, created_at,
             '' as tracking_number, NULL as dispatched_at,
             NULL as admin_note, false as flagged,
             NULL as discount_code, NULL as discount_amount
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
      SET status = 'Dispatched', tracking_number = ${trackingNumber}, dispatched_at = NOW(), carrier = ${carrier || 'Royal Mail'}
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

app.patch('/api/admin/orders/:id/note', adminMiddleware, async (req, res) => {
  const { note } = req.body;
  try {
    await sql`UPDATE wype_orders SET admin_note = ${note || null} WHERE id = ${req.params.id}`;
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.patch('/api/admin/orders/:id/flag', adminMiddleware, async (req, res) => {
  try {
    const rows = await sql`UPDATE wype_orders SET flagged = NOT COALESCE(flagged, false) WHERE id = ${req.params.id} RETURNING flagged`;
    res.json({ ok: true, flagged: rows[0]?.flagged });
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

/* ─────────────────────────────────────────────
   ROUTE: Admin — list abandoned checkouts
───────────────────────────────────────────── */
app.get('/api/admin/abandoned-carts', adminMiddleware, async (req, res) => {
  try {
    const rows = await sql`
      SELECT id, email, first_name, last_name, items_json, total,
             created_at, updated_at, emailed_at, converted_at
      FROM wype_checkout_intents
      ORDER BY created_at DESC
    `;
    res.json({ carts: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ─────────────────────────────────────────────
   ROUTE: Admin — resend recovery email to abandoned cart
───────────────────────────────────────────── */
app.post('/api/admin/abandoned-carts/:id/resend', adminMiddleware, async (req, res) => {
  try {
    const rows = await sql`SELECT * FROM wype_checkout_intents WHERE id = ${req.params.id}`;
    if (!rows.length) return res.status(404).json({ error: 'Not found.' });
    const intent = rows[0];
    await sendEmail({
      from:    '"wype®" <customer@justwypeit.com>',
      to:      intent.email,
      bcc:     BUSINESS_EMAIL,
      subject: `${intent.first_name || 'Your'} basket is still waiting · Use code TRSDE911C63`,
      html:    buildAbandonedCheckoutCustomerEmail(intent),
    });
    await sql`UPDATE wype_checkout_intents SET emailed_at = NOW() WHERE id = ${intent.id}`;
    res.json({ ok: true });
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
    if (s.includes('airwype')) {
      const m = itemStr.match(/\(([^)]+)\)/);
      const slug = m ? m[1].toLowerCase().replace(/\s+/g,'-').replace(/[^a-z0-9-]/g,'') : 'black-ice';
      return `${ASSET_BASE_URL}/airwype-${slug}.jpg`;
    }
    if (s.includes('micro')) return `${ASSET_BASE_URL}/micro-folded-studio.png`;
    if (s.includes('multi')) return `${ASSET_BASE_URL}/multiwype-pack-front-opt.jpg`;
    return `${ASSET_BASE_URL}/nano-folded-studio.png`;
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

/* ── Affiliate set-password invite ── */
async function sendAffiliateInvite(affiliate, token) {
  const link = `https://www.justwypeit.com/affiliate.html?setup=${token}`;
  const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#f5f5f5;font-family:Arial,sans-serif">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f5f5f5;padding:32px 0">
<tr><td align="center">
<table width="560" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:10px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.08)">
  <tr><td style="background:#800020;padding:28px 32px;text-align:center">
    <p style="margin:0;font-size:28px;font-weight:900;color:#fff;letter-spacing:3px">wype®</p>
    <p style="margin:8px 0 0;font-size:14px;color:rgba(255,255,255,0.8)">Affiliate programme</p>
  </td></tr>
  <tr><td style="padding:36px 40px;text-align:center">
    <p style="margin:0 0 12px;font-size:22px;font-weight:700;color:#111">Welcome, ${affiliate.name}!</p>
    <p style="margin:0 0 8px;font-size:15px;color:#555;line-height:1.6">
      You're now a wype affiliate. Your discount code is
      <strong style="color:#800020">${affiliate.code}</strong> and you'll earn
      <strong>${Number(affiliate.commission_pct)}%</strong> commission on every sale it brings in.
    </p>
    <p style="margin:0 0 28px;font-size:15px;color:#555;line-height:1.6">
      Set your password to log in and track your earnings.
    </p>
    <a href="${link}" style="display:inline-block;background:#800020;color:#fff;font-family:Arial,sans-serif;font-size:15px;font-weight:700;letter-spacing:1px;padding:14px 36px;border-radius:8px;text-decoration:none;">Set Your Password</a>
    <p style="margin:28px 0 0;font-size:12px;color:#aaa;line-height:1.6">
      If you weren't expecting this you can ignore this email.
    </p>
  </td></tr>
  <tr><td style="background:#f9f9f9;padding:16px 32px;text-align:center">
    <p style="margin:0;font-size:11px;color:#bbb">© 2026 wype® · justwypeit.com</p>
  </td></tr>
</table>
</td></tr>
</table>
</body></html>`;

  await sendEmail({
    from:    '"wype® Affiliates" <customer@justwypeit.com>',
    replyTo: 'customer@justwypeit.com',
    to:      affiliate.email,
    subject: 'Your wype affiliate account is ready',
    html,
  });
  console.log(`📧  Affiliate invite sent → ${affiliate.email}`);
}

/* ── Affiliate welcome email (with login credentials set by admin) ── */
function esc(s){ return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }
async function sendAffiliateWelcome(affiliate, password) {
  const loginUrl = 'https://www.justwypeit.com/affiliate';
  const pct = Number(affiliate.commission_pct);
  const firstName = esc((String(affiliate.name || '').trim().split(/\s+/)[0]) || affiliate.name || 'there');
  const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#eceae7;font-family:'Helvetica Neue',Arial,sans-serif;-webkit-font-smoothing:antialiased">
<table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="background:#eceae7;padding:34px 12px">
<tr><td align="center">
<table width="600" cellpadding="0" cellspacing="0" role="presentation" style="width:600px;max-width:600px;background:#ffffff;border-radius:14px;overflow:hidden;box-shadow:0 18px 50px rgba(60,0,15,0.14)">
  <tr><td style="background:#120a0d;background-image:radial-gradient(120% 95% at 50% -12%, #6e0020 0%, #38040f 42%, #120a0d 74%);padding:32px 52px 46px;text-align:center">
    <table width="100%" cellpadding="0" cellspacing="0" role="presentation"><tr>
      <td align="left" style="font-family:Arial;font-size:20px;font-weight:900;letter-spacing:2px;color:#ffffff">wype<span style="font-size:11px;vertical-align:super">&reg;</span></td>
      <td align="right"><span style="display:inline-block;border:1px solid rgba(255,255,255,0.32);color:#f2c9d2;border-radius:999px;padding:6px 14px;font-family:'Courier New',monospace;font-size:10px;font-weight:700;letter-spacing:2.5px">EXCLUSIVE INVITE</span></td>
    </tr></table>
    <img src="https://www.justwypeit.com/assets/mascot-wype.png" width="210" alt="wype mascot" style="width:210px;height:auto;display:block;margin:24px auto 18px">
    <p style="margin:0 0 16px;font-family:'Courier New',monospace;font-size:11px;letter-spacing:5px;text-transform:uppercase;color:#e79aad">you're in</p>
    <p style="margin:0;font-size:52px;line-height:1;font-weight:300;color:#ffffff;letter-spacing:-1.5px">Welcome,<br><span style="font-weight:700">${firstName}.</span></p>
  </td></tr>
  <tr><td style="padding:44px 64px 0;text-align:center">
    <p style="margin:0;font-size:17px;color:#555;line-height:1.75">
      You've been <strong style="color:#111">hand-selected</strong> for an exclusive circle we open to only a few. Our way of saying <strong style="color:#111">thank you</strong> for championing wype.
    </p>
  </td></tr>
  <tr><td style="padding:40px 52px 0"><div style="border-top:1px solid #efeceb"></div></td></tr>
  <tr><td style="padding:34px 52px 0;text-align:center">
    <p style="margin:0 0 6px;font-family:'Courier New',monospace;font-size:11px;letter-spacing:3px;text-transform:uppercase;color:#b3a7a9">Your commission</p>
    <p style="margin:0;font-size:74px;font-weight:700;color:#800020;line-height:1;letter-spacing:-2px">${pct}%</p>
    <p style="margin:8px 0 0;font-size:15px;color:#888">on every order your code brings in</p>
  </td></tr>
  <tr><td style="padding:40px 52px 0"><div style="border-top:1px solid #efeceb"></div></td></tr>
  <tr><td style="padding:34px 52px 0">
    <p style="margin:0 0 20px;font-family:'Courier New',monospace;font-size:11px;letter-spacing:3px;text-transform:uppercase;color:#b3a7a9;text-align:center">Your private login</p>
    <table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="font-family:Arial">
      <tr><td style="padding:13px 0;border-bottom:1px solid #f3f0ef;font-size:13px;color:#999;width:120px">Login page</td><td style="padding:13px 0;border-bottom:1px solid #f3f0ef;font-size:15px;text-align:right"><a href="${loginUrl}" style="color:#800020;text-decoration:none;font-weight:600">justwypeit.com/affiliate</a></td></tr>
      <tr><td style="padding:13px 0;border-bottom:1px solid #f3f0ef;font-size:13px;color:#999">Email</td><td style="padding:13px 0;border-bottom:1px solid #f3f0ef;font-size:15px;color:#222;font-weight:600;text-align:right">${esc(affiliate.email)}</td></tr>
      <tr><td style="padding:13px 0;font-size:13px;color:#999">Password</td><td style="padding:13px 0;text-align:right"><span style="display:inline-block;font-family:'Courier New',monospace;background:#f8f4f5;border:1px solid #ecdfe2;border-radius:7px;padding:7px 15px;font-size:16px;color:#111;font-weight:700;letter-spacing:1px">${esc(password)}</span></td></tr>
    </table>
    <table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="margin-top:24px"><tr>
      <td width="50%" style="padding-right:11px;text-align:center;border-right:1px solid #f0f0f0"><p style="margin:0;font-family:'Courier New',monospace;font-size:10px;letter-spacing:2px;text-transform:uppercase;color:#bbb">Code</p><p style="margin:7px 0 0;font-size:24px;font-weight:800;letter-spacing:1.5px;color:#800020">${esc(affiliate.code)}</p></td>
      <td width="50%" style="padding-left:11px;text-align:center"><p style="margin:0;font-family:'Courier New',monospace;font-size:10px;letter-spacing:2px;text-transform:uppercase;color:#bbb">Rate</p><p style="margin:7px 0 0;font-size:24px;font-weight:800;color:#800020">${pct}%</p></td>
    </tr></table>
  </td></tr>
  <tr><td style="padding:36px 52px 6px;text-align:center">
    <table cellpadding="0" cellspacing="0" role="presentation" style="margin:0 auto"><tr><td style="background:#800020;border-radius:11px">
      <a href="${loginUrl}" style="display:inline-block;padding:18px 54px;font-family:Arial;font-size:14px;font-weight:700;letter-spacing:1.2px;text-transform:uppercase;color:#fff;text-decoration:none">Log in to your dashboard</a>
    </td></tr></table>
  </td></tr>
  <tr><td style="padding:38px 52px 0"><div style="border-top:1px solid #efeceb"></div></td></tr>
  <tr><td style="padding:30px 52px 6px">
    <p style="margin:0 0 24px;font-family:'Courier New',monospace;font-size:11px;letter-spacing:3px;text-transform:uppercase;color:#b3a7a9;text-align:center">How it works</p>
    <table width="100%" cellpadding="0" cellspacing="0" role="presentation">
      <tr><td style="padding:0 0 20px"><table width="100%" cellpadding="0" cellspacing="0" role="presentation"><tr><td width="54" valign="top" style="font-family:'Courier New',monospace;font-size:22px;font-weight:700;color:#800020">01</td><td valign="top"><p style="margin:0 0 2px;font-size:15px;font-weight:700;color:#111">Share your code</p><p style="margin:0;font-size:14px;color:#888;line-height:1.55">Post it, link it, tell your audience. They get money off.</p></td></tr></table></td></tr>
      <tr><td style="padding:0 0 20px"><table width="100%" cellpadding="0" cellspacing="0" role="presentation"><tr><td width="54" valign="top" style="font-family:'Courier New',monospace;font-size:22px;font-weight:700;color:#800020">02</td><td valign="top"><p style="margin:0 0 2px;font-size:15px;font-weight:700;color:#111">We track everything</p><p style="margin:0;font-size:14px;color:#888;line-height:1.55">Every sale with your code is logged automatically.</p></td></tr></table></td></tr>
      <tr><td><table width="100%" cellpadding="0" cellspacing="0" role="presentation"><tr><td width="54" valign="top" style="font-family:'Courier New',monospace;font-size:22px;font-weight:700;color:#800020">03</td><td valign="top"><p style="margin:0 0 2px;font-size:15px;font-weight:700;color:#111">Get paid</p><p style="margin:0;font-size:14px;color:#888;line-height:1.55">Watch earnings grow and cash out any time. No fees.</p></td></tr></table></td></tr>
    </table>
  </td></tr>
  <tr><td style="padding:26px 52px 40px;text-align:center"><p style="margin:0;font-size:12px;color:#bbb;line-height:1.6">Keep these details safe. Questions? Just reply to this email.</p></td></tr>
  <tr><td style="background:#120a0d;padding:26px 52px;text-align:center">
    <p style="margin:0;font-family:'Courier New',monospace;font-size:11px;letter-spacing:2px;color:#9a8288">WYPE&reg; &middot; JUSTWYPEIT.COM</p>
  </td></tr>
</table>
</td></tr>
</table>
</body></html>`;

  await sendEmail({
    from:    '"wype® Affiliates" <customer@justwypeit.com>',
    replyTo: 'customer@justwypeit.com',
    to:      affiliate.email,
    subject: `Welcome to the wype Affiliate Programme 🎉`,
    html,
  });
  console.log(`📧  Affiliate welcome sent → ${affiliate.email}`);
}

/* Internal notification to customer@justwypeit.com */
function buildInternalOrderEmail(order) {
  function productImg(itemStr) {
    const s = (itemStr || '').toLowerCase();
    if (s.includes('airwype')) {
      const m = itemStr.match(/\(([^)]+)\)/);
      const slug = m ? m[1].toLowerCase().replace(/\s+/g,'-').replace(/[^a-z0-9-]/g,'') : 'black-ice';
      return `${ASSET_BASE_URL}/airwype-${slug}.jpg`;
    }
    if (s.includes('micro')) return `${ASSET_BASE_URL}/micro-folded-studio.png`;
    if (s.includes('multi')) return `${ASSET_BASE_URL}/multiwype-pack-front-opt.jpg`;
    return `${ASSET_BASE_URL}/nano-folded-studio.png`;
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
    if (s.includes('airwype')) {
      const scentMatch = itemStr.match(/\(([^)]+)\)/);
      const slug = scentMatch ? scentMatch[1].toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '') : 'black-ice';
      return { img: `${ASSET_BASE_URL}/airwype-${slug}.jpg`, label: 'AIRWYPE+' };
    }
    if (s.includes('micro')) return { img: `${ASSET_BASE_URL}/micro-folded-studio.png`, label: 'MICRO WYPE+' };
    if (s.includes('nano'))  return { img: `${ASSET_BASE_URL}/nano-folded-studio.png`,  label: 'NANO WYPE+' };
    if (s.includes('multi')) return { img: `${ASSET_BASE_URL}/multiwype-pack-front-opt.jpg`, label: 'MULTI WYPE+' };
    return                          { img: `${ASSET_BASE_URL}/nano-folded-studio.png`,  label: 'WYPE' };
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
    if (s.includes('airwype')) {
      const m = itemStr.match(/\(([^)]+)\)/);
      const slug = m ? m[1].toLowerCase().replace(/\s+/g,'-').replace(/[^a-z0-9-]/g,'') : 'black-ice';
      return { img: `${ASSET_BASE_URL}/airwype-${slug}.jpg`, label: 'AIRWYPE+' };
    }
    if (s.includes('micro')) return { img: `${ASSET_BASE_URL}/micro-folded-studio.png`, label: 'MICRO WYPE+' };
    if (s.includes('nano')) return { img: `${ASSET_BASE_URL}/nano-folded-studio.png`, label: 'NANO WYPE+' };
    if (s.includes('multi')) return { img: `${ASSET_BASE_URL}/multiwype-pack-front-opt.jpg`, label: 'MULTI WYPE+' };
    return { img: `${ASSET_BASE_URL}/nano-folded-studio.png`, label: 'WYPE' };
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
    const itemsList = (order.items || []).map(i => {
      if (typeof i === 'string') return i;
      const qty = i.qty || i.quantity || 1;
      return `${qty}x ${i.name}${i.price ? ` — £${Number(i.price * qty).toFixed(2)}` : ''}`;
    }).join('<br>');
    const shipTo = [order.address1, order.address2, order.city, order.postcode].filter(Boolean).join(', ');
    await sendEmail({
      from:    '"wype® Orders" <customer@justwypeit.com>',
      to:      BUSINESS_EMAIL,
      subject: `New Order #${order.orderNumber} — ${order.firstName} ${order.lastName} (£${Number(order.total).toFixed(2)})`,
      html:    `
        <h2 style="margin:0 0 16px">New order received</h2>
        <p><strong>Order:</strong> #${order.orderNumber}</p>
        <p><strong>Customer:</strong> ${order.firstName} ${order.lastName} &lt;${order.email}&gt;</p>
        <p><strong>Items:</strong><br>${itemsList}</p>
        <p><strong>Total:</strong> £${Number(order.total).toFixed(2)}${order.discountCode ? ` (code: ${order.discountCode}, −£${order.discountAmount || ''})` : ''}</p>
        <p><strong>Ship to:</strong> ${shipTo || 'address not captured'}</p>
        <p style="margin-top:16px;font-size:12px;color:#888">wype® order management</p>
      `,
    });
    console.log(`📧  Business notification sent → ${BUSINESS_EMAIL}`);
  } catch (err) {
    console.error('[ORDER_FAIL] Business notification email error:', err.message);
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
  if (!paymentIntentId) {
    return res.status(400).json({ error: 'Missing paymentIntentId.' });
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
      stripe.paymentIntents.update(paymentIntentId, { metadata: {
        order_number:   order.orderNumber,
        customer_name:  `${order.firstName} ${order.lastName}`,
        customer_email: order.email,
        items_summary:  order.items.slice(0,3).join(' | ').slice(0,490),
      }}).catch(e => console.warn('Stripe metadata update failed:', e.message));
    }

    sql`UPDATE wype_checkout_intents SET converted_at = NOW() WHERE email = ${email.toLowerCase().trim()} AND converted_at IS NULL`
      .catch(() => {});

    // Await emails before responding — serverless kills the process after res.json()
    try {
      await withRetry(() => sendOrderEmails({ ...order, createdAt: new Date().toISOString() }));
    } catch (emailErr) {
      console.error('[ORDER_FAIL] Email send failed after 3 attempts:', emailErr.message);
      await sendFailureAlert(emailErr, '/submit-order email failure', order).catch(() => {});
    }

    res.json({ success: true, orderNumber: order.orderNumber });
  } catch (err) {
    console.error('[ORDER_FAIL] Submit order DB error:', err.message);
    await sendFailureAlert(err, '/submit-order DB write failure', { firstName, lastName, email, items, total, paymentIntentId }).catch(() => {});
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
      SELECT id, code, discount_pct, type, business_name, email, COALESCE(active, TRUE) AS active, created_at
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
   ADMIN: create a discount code (with chosen percentage)
───────────────────────────────────────────── */
app.post('/api/admin/discount-codes', adminMiddleware, async (req, res) => {
  try {
    let { code, discountPct, type, businessName, email } = req.body || {};
    code = (code || '').trim().toUpperCase().replace(/\s+/g, '');
    const pct = parseInt(discountPct, 10);
    type = (type || 'promo').trim().toLowerCase();

    if (!code || !/^[A-Z0-9._-]{2,40}$/.test(code)) {
      return res.status(400).json({ error: 'Code must be 2-40 chars (letters, numbers, . _ -).' });
    }
    if (!(pct >= 1 && pct <= 90)) {
      return res.status(400).json({ error: 'Percentage must be between 1 and 90.' });
    }

    const exists = await sql`SELECT 1 FROM wype_discount_codes WHERE code = ${code} LIMIT 1`;
    if (exists.length) return res.status(409).json({ error: 'That code already exists.' });

    const rows = await sql`
      INSERT INTO wype_discount_codes (code, discount_pct, type, business_name, email, active)
      VALUES (${code}, ${pct}, ${type}, ${businessName || null}, ${email || null}, TRUE)
      RETURNING id, code, discount_pct, type, business_name, email, active, created_at
    `;
    res.json({ ok: true, code: rows[0] });
  } catch (err) {
    console.error('Create discount code error:', err.message);
    res.status(500).json({ error: 'Server error.' });
  }
});

/* ─────────────────────────────────────────────
   ADMIN: update a discount code (percentage / active)
───────────────────────────────────────────── */
app.patch('/api/admin/discount-codes/:code', adminMiddleware, async (req, res) => {
  try {
    const code = String(req.params.code || '').trim().toUpperCase();
    const { discountPct, active } = req.body || {};

    if (discountPct !== undefined) {
      const pct = parseInt(discountPct, 10);
      if (!(pct >= 1 && pct <= 90)) return res.status(400).json({ error: 'Percentage must be between 1 and 90.' });
      await sql`UPDATE wype_discount_codes SET discount_pct = ${pct} WHERE code = ${code}`;
    }
    if (active !== undefined) {
      await sql`UPDATE wype_discount_codes SET active = ${!!active} WHERE code = ${code}`;
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('Update discount code error:', err.message);
    res.status(500).json({ error: 'Server error.' });
  }
});

/* ─────────────────────────────────────────────
   ADMIN: delete a discount code
───────────────────────────────────────────── */
app.delete('/api/admin/discount-codes/:code', adminMiddleware, async (req, res) => {
  try {
    const code = String(req.params.code || '').trim().toUpperCase();
    await sql`DELETE FROM wype_discount_codes WHERE code = ${code}`;
    res.json({ ok: true });
  } catch (err) {
    console.error('Delete discount code error:', err.message);
    res.status(500).json({ error: 'Server error.' });
  }
});

/* ═════════════════════════════════════════════
   AFFILIATE PROGRAMME
   ═════════════════════════════════════════════ */

/* Compute an affiliate's sales + earnings.
   Commission basis = NET sale per order = subtotal − discount (excl delivery),
   over orders that used their code and were not cancelled. */
async function affiliateStats(affiliate) {
  const code = String(affiliate.code || '').toUpperCase();
  const pct  = Number(affiliate.commission_pct) || 0;
  const rows = await sql`
    SELECT order_number, created_at,
           COALESCE(subtotal, 0)        AS subtotal,
           COALESCE(discount_amount, 0) AS discount_amount,
           COALESCE(total, 0)           AS total
    FROM wype_orders
    WHERE UPPER(discount_code) = ${code} AND status != 'Cancelled'
    ORDER BY created_at DESC
  `;
  let grossSales = 0, netSales = 0;
  const orders = rows.map(r => {
    const net = Math.max(0, Number(r.subtotal) - Number(r.discount_amount));
    grossSales += Number(r.total);
    netSales   += net;
    return {
      orderNumber: r.order_number,
      date:        r.created_at,
      subtotal:    Number(r.subtotal),
      discount:    Number(r.discount_amount),
      net:         +net.toFixed(2),
      commission:  +(net * pct / 100).toFixed(2),
    };
  });
  const earned     = +(netSales * pct / 100).toFixed(2);
  const payoutRows = await sql`SELECT COALESCE(SUM(amount), 0) AS paid FROM wype_affiliate_payouts WHERE affiliate_id = ${affiliate.id}`;
  const paid       = Number(payoutRows[0].paid);
  return {
    code,
    commissionPct: pct,
    orderCount:    orders.length,
    grossSales:    +grossSales.toFixed(2),
    netSales:      +netSales.toFixed(2),
    earned,
    paid:          +paid.toFixed(2),
    outstanding:   +(earned - paid).toFixed(2),
    orders:        orders.slice(0, 50),
  };
}

/* AFFILIATE: login */
app.post('/api/affiliate/login', async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'Email and password are required.' });
  try {
    const rows = await sql`SELECT * FROM wype_affiliates WHERE email = ${String(email).toLowerCase().trim()} LIMIT 1`;
    if (!rows.length) return res.status(401).json({ error: 'No affiliate account with that email.' });
    const aff = rows[0];
    if (aff.active === false)  return res.status(403).json({ error: 'Account disabled. Contact wype.' });
    if (!aff.password_hash)    return res.status(403).json({ error: 'Password not set yet. Use the link in your invite email.' });
    const match = await bcrypt.compare(password, aff.password_hash);
    if (!match) return res.status(401).json({ error: 'Incorrect password.' });
    const token = jwt.sign({ id: aff.id, email: aff.email, role: 'affiliate' }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ token, name: aff.name, code: aff.code });
  } catch (err) {
    console.error('Affiliate login error:', err.message);
    res.status(500).json({ error: 'Login failed. Please try again.' });
  }
});

/* AFFILIATE: set initial / reset password via token */
app.post('/api/affiliate/set-password/:token', async (req, res) => {
  const token = String(req.params.token || '');
  const { password } = req.body || {};
  if (!token)              return res.status(400).json({ error: 'Invalid link.' });
  if (!password || password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' });
  try {
    const rows = await sql`SELECT * FROM wype_affiliates WHERE set_password_token = ${token} LIMIT 1`;
    if (!rows.length) return res.status(400).json({ error: 'This link is invalid or has already been used.' });
    const aff  = rows[0];
    const hash = await bcrypt.hash(password, 12);
    await sql`UPDATE wype_affiliates SET password_hash = ${hash}, set_password_token = NULL WHERE id = ${aff.id}`;
    const jwtToken = jwt.sign({ id: aff.id, email: aff.email, role: 'affiliate' }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ ok: true, token: jwtToken, name: aff.name, code: aff.code });
  } catch (err) {
    console.error('Affiliate set-password error:', err.message);
    res.status(500).json({ error: 'Server error.' });
  }
});

/* AFFILIATE: profile */
app.get('/api/affiliate/me', affiliateMiddleware, async (req, res) => {
  const aff = req.affiliate;
  let discountPct = null;
  try {
    const dc = await sql`SELECT discount_pct FROM wype_discount_codes WHERE code = ${String(aff.code).toUpperCase()} LIMIT 1`;
    if (dc.length) discountPct = dc[0].discount_pct;
  } catch {}
  res.json({
    name:          aff.name,
    email:         aff.email,
    code:          aff.code,
    commissionPct: Number(aff.commission_pct),
    discountPct,
  });
});

/* AFFILIATE: sales + earnings */
app.get('/api/affiliate/stats', affiliateMiddleware, async (req, res) => {
  try {
    res.json(await affiliateStats(req.affiliate));
  } catch (err) {
    console.error('Affiliate stats error:', err.message);
    res.status(500).json({ error: 'Server error.' });
  }
});

/* ── ADMIN: affiliate management ── */

/* List all affiliates with summary earnings */
app.get('/api/admin/affiliates', adminMiddleware, async (req, res) => {
  try {
    const affs = await sql`SELECT * FROM wype_affiliates ORDER BY created_at DESC`;
    const out  = [];
    for (const a of affs) {
      const s = await affiliateStats(a);
      out.push({
        id: a.id, name: a.name, email: a.email, code: a.code,
        commissionPct: Number(a.commission_pct),
        active: a.active !== false,
        passwordSet: !!a.password_hash,
        orderCount: s.orderCount, grossSales: s.grossSales, netSales: s.netSales,
        earned: s.earned, paid: s.paid, outstanding: s.outstanding,
        createdAt: a.created_at,
      });
    }
    res.json({ affiliates: out });
  } catch (err) {
    console.error('List affiliates error:', err.message);
    res.status(500).json({ error: 'Server error.' });
  }
});

/* Create an affiliate (assigns/creates the discount code, emails invite) */
app.post('/api/admin/affiliates', adminMiddleware, async (req, res) => {
  try {
    let { name, email, code, commissionPct, discountPct, password } = req.body || {};
    name  = (name || '').trim();
    email = (email || '').toLowerCase().trim();
    code  = (code || '').trim().toUpperCase().replace(/\s+/g, '');
    password = (password || '').trim();
    const commPct = parseFloat(commissionPct);
    const discPct = parseInt(discountPct, 10);

    if (!name)  return res.status(400).json({ error: 'Name is required.' });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Valid email is required.' });
    if (!code || !/^[A-Z0-9._-]{2,40}$/.test(code)) return res.status(400).json({ error: 'Code must be 2-40 chars (letters, numbers, . _ -).' });
    if (!(commPct >= 0 && commPct <= 100)) return res.status(400).json({ error: 'Commission must be between 0 and 100.' });
    if (!(discPct >= 1 && discPct <= 90))  return res.status(400).json({ error: 'Customer discount must be between 1 and 90.' });
    if (password && password.length < 8)   return res.status(400).json({ error: 'Password must be at least 8 characters.' });

    const dupe = await sql`SELECT 1 FROM wype_affiliates WHERE email = ${email} LIMIT 1`;
    if (dupe.length) return res.status(409).json({ error: 'An affiliate with that email already exists.' });

    // Upsert the discount code as an affiliate code
    await sql`
      INSERT INTO wype_discount_codes (code, discount_pct, type, business_name, email, active)
      VALUES (${code}, ${discPct}, 'affiliate', ${name}, ${email}, TRUE)
      ON CONFLICT (code) DO UPDATE
        SET discount_pct = ${discPct}, type = 'affiliate', business_name = ${name}, email = ${email}, active = TRUE
    `;

    // If admin set a password, store it and send the welcome email with credentials.
    // Otherwise fall back to the set-your-own-password invite link.
    const token = password ? null : require('crypto').randomBytes(32).toString('hex');
    const hash  = password ? await bcrypt.hash(password, 12) : null;
    const rows  = await sql`
      INSERT INTO wype_affiliates (name, email, code, commission_pct, password_hash, set_password_token, active)
      VALUES (${name}, ${email}, ${code}, ${commPct}, ${hash}, ${token}, TRUE)
      RETURNING *
    `;
    const aff = rows[0];

    let emailSent = true, emailKind = password ? 'welcome' : 'invite';
    try {
      if (password) await sendAffiliateWelcome(aff, password);
      else          await sendAffiliateInvite(aff, token);
    } catch (e) {
      emailSent = false;
      console.error('Affiliate email failed:', e.message);
    }
    const setupLink = token ? `/affiliate.html?setup=${token}` : null;
    res.json({ ok: true, affiliate: { id: aff.id, name: aff.name, email: aff.email, code: aff.code, commissionPct: Number(aff.commission_pct) }, emailSent, emailKind, setupLink });
  } catch (err) {
    console.error('Create affiliate error:', err.message);
    res.status(500).json({ error: 'Server error.' });
  }
});

/* Update commission / active */
app.patch('/api/admin/affiliates/:id', adminMiddleware, async (req, res) => {
  try {
    const id = String(req.params.id || '');
    const { commissionPct, active } = req.body || {};
    if (commissionPct !== undefined) {
      const p = parseFloat(commissionPct);
      if (!(p >= 0 && p <= 100)) return res.status(400).json({ error: 'Commission must be between 0 and 100.' });
      await sql`UPDATE wype_affiliates SET commission_pct = ${p} WHERE id = ${id}`;
    }
    if (active !== undefined) {
      await sql`UPDATE wype_affiliates SET active = ${!!active} WHERE id = ${id}`;
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('Update affiliate error:', err.message);
    res.status(500).json({ error: 'Server error.' });
  }
});

/* Delete affiliate (keeps the discount code + orders intact) */
app.delete('/api/admin/affiliates/:id', adminMiddleware, async (req, res) => {
  try {
    const id = String(req.params.id || '');
    await sql`DELETE FROM wype_affiliate_payouts WHERE affiliate_id = ${id}`;
    await sql`DELETE FROM wype_affiliates WHERE id = ${id}`;
    res.json({ ok: true });
  } catch (err) {
    console.error('Delete affiliate error:', err.message);
    res.status(500).json({ error: 'Server error.' });
  }
});

/* Record a payout */
app.post('/api/admin/affiliates/:id/payouts', adminMiddleware, async (req, res) => {
  try {
    const id = String(req.params.id || '');
    const amount = parseFloat((req.body || {}).amount);
    const note   = ((req.body || {}).note || '').trim() || null;
    if (!(amount > 0)) return res.status(400).json({ error: 'Amount must be greater than 0.' });
    const exists = await sql`SELECT 1 FROM wype_affiliates WHERE id = ${id} LIMIT 1`;
    if (!exists.length) return res.status(404).json({ error: 'Affiliate not found.' });
    await sql`INSERT INTO wype_affiliate_payouts (affiliate_id, amount, note) VALUES (${id}, ${amount}, ${note})`;
    res.json({ ok: true });
  } catch (err) {
    console.error('Record payout error:', err.message);
    res.status(500).json({ error: 'Server error.' });
  }
});

/* Admin: set / reset an affiliate's password directly */
app.post('/api/admin/affiliates/:id/set-password', adminMiddleware, async (req, res) => {
  try {
    const id = String(req.params.id || '');
    const { password } = req.body || {};
    if (!password || password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' });
    const rows = await sql`SELECT 1 FROM wype_affiliates WHERE id = ${id} LIMIT 1`;
    if (!rows.length) return res.status(404).json({ error: 'Affiliate not found.' });
    const hash = await bcrypt.hash(password, 12);
    await sql`UPDATE wype_affiliates SET password_hash = ${hash}, set_password_token = NULL WHERE id = ${id}`;
    res.json({ ok: true });
  } catch (err) {
    console.error('Admin set affiliate password error:', err.message);
    res.status(500).json({ error: 'Server error.' });
  }
});

/* Admin: set a password AND send the welcome email with those credentials */
app.post('/api/admin/affiliates/:id/welcome', adminMiddleware, async (req, res) => {
  try {
    const id = String(req.params.id || '');
    const { password } = req.body || {};
    if (!password || password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' });
    const rows = await sql`SELECT * FROM wype_affiliates WHERE id = ${id} LIMIT 1`;
    if (!rows.length) return res.status(404).json({ error: 'Affiliate not found.' });
    const hash = await bcrypt.hash(password, 12);
    await sql`UPDATE wype_affiliates SET password_hash = ${hash}, set_password_token = NULL WHERE id = ${id}`;
    let emailSent = true;
    try { await sendAffiliateWelcome(rows[0], password); }
    catch (e) { emailSent = false; console.error('Affiliate welcome email failed:', e.message); }
    res.json({ ok: true, emailSent });
  } catch (err) {
    console.error('Admin affiliate welcome error:', err.message);
    res.status(500).json({ error: 'Server error.' });
  }
});

/* Resend the set-password invite */
app.post('/api/admin/affiliates/:id/resend-invite', adminMiddleware, async (req, res) => {
  try {
    const id    = String(req.params.id || '');
    const rows  = await sql`SELECT * FROM wype_affiliates WHERE id = ${id} LIMIT 1`;
    if (!rows.length) return res.status(404).json({ error: 'Affiliate not found.' });
    const token = require('crypto').randomBytes(32).toString('hex');
    await sql`UPDATE wype_affiliates SET set_password_token = ${token} WHERE id = ${id}`;
    let emailSent = true;
    try { await sendAffiliateInvite(rows[0], token); }
    catch (e) { emailSent = false; console.error('Resend invite failed:', e.message); }
    res.json({ ok: true, emailSent, setupLink: `/affiliate.html?setup=${token}` });
  } catch (err) {
    console.error('Resend invite error:', err.message);
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
      WHERE code = ${code} AND COALESCE(active, TRUE) = TRUE
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
   EMAIL SUBSCRIBERS (welcome 10% code + waitlists)
───────────────────────────────────────────── */
async function sendWelcomeCode(email, code) {
  const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#eceae7;font-family:'Helvetica Neue',Arial,sans-serif;-webkit-font-smoothing:antialiased">
<table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="background:#eceae7;padding:34px 12px">
<tr><td align="center">
<table width="600" cellpadding="0" cellspacing="0" role="presentation" style="width:600px;max-width:600px;background:#ffffff;border-radius:14px;overflow:hidden;box-shadow:0 18px 50px rgba(60,0,15,0.14)">
  <tr><td style="background:#120a0d;background-image:radial-gradient(120% 95% at 50% -12%, #6e0020 0%, #38040f 42%, #120a0d 74%);padding:36px 52px 44px;text-align:center">
    <p style="margin:0 0 6px;font-family:Arial;font-size:20px;font-weight:900;letter-spacing:2px;color:#ffffff">wype<span style="font-size:11px;vertical-align:super">&reg;</span></p>
    <p style="margin:18px 0 10px;font-family:'Courier New',monospace;font-size:11px;letter-spacing:5px;text-transform:uppercase;color:#e79aad">welcome offer</p>
    <p style="margin:0;font-size:46px;line-height:1.05;font-weight:300;color:#ffffff;letter-spacing:-1.5px">10% off your<br><span style="font-weight:700">first order.</span></p>
  </td></tr>
  <tr><td style="padding:38px 56px 8px;text-align:center">
    <p style="margin:0;font-size:16px;color:#555;line-height:1.7">Thanks for joining the list. Use this code at checkout and it comes straight off your first order:</p>
  </td></tr>
  <tr><td style="padding:20px 56px 6px;text-align:center">
    <span style="display:inline-block;background:#f6f1f2;border:2px dashed #6e0020;border-radius:10px;padding:16px 34px;font-family:'Courier New',monospace;font-size:22px;font-weight:700;letter-spacing:3px;color:#38040f">${esc(code)}</span>
  </td></tr>
  <tr><td style="padding:26px 56px 40px;text-align:center">
    <a href="https://justwypeit.com/" style="display:inline-block;background:#E01E1E;color:#ffffff;text-decoration:none;font-size:14px;font-weight:800;letter-spacing:1px;text-transform:uppercase;border-radius:8px;padding:15px 36px">Shop wype&reg;</a>
    <p style="margin:22px 0 0;font-size:12px;color:#999;line-height:1.6">You are receiving this because you signed up at justwypeit.com.<br>Changed your mind? Just ignore this email.</p>
  </td></tr>
</table>
</td></tr></table></body></html>`;
  await sendEmail({
    from:    '"wype®" <customer@justwypeit.com>',
    to:      email,
    subject: 'Your 10% welcome code',
    html,
  });
}

app.post('/api/subscribe', async (req, res) => {
  try {
    const email  = String(req.body?.email || '').trim().toLowerCase();
    const source = String(req.body?.source || 'site').slice(0, 40);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
      return res.status(400).json({ ok: false, error: 'Please enter a valid email address.' });
    }
    const existing = await sql`SELECT id FROM wype_subscribers WHERE email = ${email} LIMIT 1`;
    if (existing.length) return res.json({ ok: true, already: true });

    const code = 'WELCOME10-' + require('crypto').randomBytes(3).toString('hex').toUpperCase();
    await sql`INSERT INTO wype_subscribers (email, source, discount_code) VALUES (${email}, ${source}, ${code})`;
    await sql`
      INSERT INTO wype_discount_codes (code, discount_pct, type, business_name, email)
      VALUES (${code}, 10, 'welcome', NULL, ${email})
    `;
    let emailSent = true;
    try { await sendWelcomeCode(email, code); }
    catch (e) { emailSent = false; console.error('Welcome code email failed:', e.message); }

    /* Notify the shop inbox about the new signup (never blocks the response) */
    try {
      const [{ count }] = await sql`SELECT COUNT(*)::int AS count FROM wype_subscribers`;
      await sendEmail({
        from:    '"wype® Alerts" <customer@justwypeit.com>',
        to:      'customer@justwypeit.com',
        subject: `New newsletter signup: ${email}`,
        html: `<div style="font-family:Arial,sans-serif;font-size:14px;color:#222;line-height:1.7">
          <p><strong>New newsletter subscriber</strong></p>
          <p>Email: <a href="mailto:${esc(email)}">${esc(email)}</a><br>
          Source: ${esc(source)}<br>
          Welcome code: ${esc(code)}<br>
          Total subscribers: ${count}</p>
          <p style="color:#888;font-size:12px">View the full list in the admin portal → Newsletter tab.</p>
        </div>`,
      });
    } catch (e) { console.error('Signup notification email failed:', e.message); }

    res.json({ ok: true, emailSent });
  } catch (err) {
    console.error('Subscribe error:', err.message);
    res.status(500).json({ ok: false, error: 'Server error. Please try again.' });
  }
});

/* Admin: list subscribers (newest first) */
app.get('/api/admin/subscribers', adminMiddleware, async (req, res) => {
  try {
    const rows = await sql`
      SELECT id, email, source, discount_code, unsubscribed, created_at
      FROM wype_subscribers ORDER BY created_at DESC LIMIT 1000
    `;
    res.json(rows);
  } catch (err) {
    console.error('List subscribers error:', err.message);
    res.status(500).json({ error: 'Server error.' });
  }
});

/* ── Newsletter: unsubscribe (signed link in every campaign email) ── */
function unsubToken(email) {
  return require('crypto').createHmac('sha256', JWT_SECRET).update(email.toLowerCase()).digest('hex').slice(0, 32);
}

app.get('/api/unsubscribe', async (req, res) => {
  const email = String(req.query.e || '').trim().toLowerCase();
  const token = String(req.query.t || '');
  const page = (msg) => `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>wype®</title></head>
<body style="margin:0;background:#eceae7;font-family:'Helvetica Neue',Arial,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh">
<div style="background:#fff;border-radius:14px;padding:40px 48px;text-align:center;max-width:420px;box-shadow:0 18px 50px rgba(60,0,15,0.14)">
<p style="font-size:20px;font-weight:900;letter-spacing:2px;margin:0 0 18px">wype<span style="font-size:11px;vertical-align:super">&reg;</span></p>
<p style="font-size:15px;color:#444;line-height:1.7;margin:0">${msg}</p>
<a href="https://www.justwypeit.com/" style="display:inline-block;margin-top:22px;color:#6e0020;font-size:13px">Back to justwypeit.com</a>
</div></body></html>`;
  try {
    if (!email || token !== unsubToken(email)) return res.status(400).send(page('That unsubscribe link is not valid.'));
    await sql`UPDATE wype_subscribers SET unsubscribed = TRUE WHERE email = ${email}`;
    res.send(page('You have been unsubscribed. You will no longer receive marketing emails from wype&reg;.'));
  } catch (err) {
    console.error('Unsubscribe error:', err.message);
    res.status(500).send(page('Something went wrong. Please try again later.'));
  }
});

/* ── Newsletter: brand wrapper for campaign emails ── */
function newsletterHtml(subject, bodyHtml, email) {
  const unsubLink = `https://www.justwypeit.com/api/unsubscribe?e=${encodeURIComponent(email)}&t=${unsubToken(email)}`;
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#eceae7;font-family:'Helvetica Neue',Arial,sans-serif;-webkit-font-smoothing:antialiased">
<table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="background:#eceae7;padding:34px 12px">
<tr><td align="center">
<table width="600" cellpadding="0" cellspacing="0" role="presentation" style="width:600px;max-width:600px;background:#ffffff;border-radius:14px;overflow:hidden;box-shadow:0 18px 50px rgba(60,0,15,0.14)">
  <tr><td style="background:#120a0d;background-image:radial-gradient(120% 95% at 50% -12%, #6e0020 0%, #38040f 42%, #120a0d 74%);padding:30px 52px;text-align:center">
    <p style="margin:0;font-family:Arial;font-size:20px;font-weight:900;letter-spacing:2px;color:#ffffff">wype<span style="font-size:11px;vertical-align:super">&reg;</span></p>
  </td></tr>
  <tr><td style="padding:36px 48px 30px;font-size:15px;color:#333;line-height:1.75">${bodyHtml}</td></tr>
  <tr><td style="padding:0 48px 36px;text-align:center">
    <a href="https://justwypeit.com/" style="display:inline-block;background:#E01E1E;color:#ffffff;text-decoration:none;font-size:14px;font-weight:800;letter-spacing:1px;text-transform:uppercase;border-radius:8px;padding:14px 34px">Shop wype&reg;</a>
  </td></tr>
  <tr><td style="padding:0 48px 34px;text-align:center">
    <p style="margin:0;font-size:11px;color:#999;line-height:1.7">You are receiving this because you signed up or shopped at justwypeit.com.<br>
    <a href="${unsubLink}" style="color:#999">Unsubscribe</a></p>
  </td></tr>
</table>
</td></tr></table></body></html>`;
}

/* Admin: send a newsletter/campaign email */
app.post('/api/admin/newsletter/send', adminMiddleware, async (req, res) => {
  try {
    const subject  = String(req.body?.subject || '').trim();
    const message  = String(req.body?.message || '').trim();
    const audience = String(req.body?.audience || 'test');
    if (!subject || !message) return res.status(400).json({ error: 'Subject and message are required.' });

    /* Plain text is fine — convert bare newlines to <br> unless it already looks like HTML */
    const bodyHtml = /<[a-z][\s\S]*>/i.test(message) ? message : esc(message).replace(/\n/g, '<br>');

    let recipients = [];
    if (audience === 'test') {
      recipients = ['customer@justwypeit.com'];
    } else if (audience === 'subscribers') {
      const rows = await sql`SELECT email FROM wype_subscribers WHERE unsubscribed IS NOT TRUE`;
      recipients = rows.map(r => r.email);
    } else if (audience === 'customers') {
      const rows = await sql`
        SELECT DISTINCT LOWER(o.email) AS email FROM wype_orders o
        WHERE o.email IS NOT NULL AND o.email <> ''
        AND NOT EXISTS (SELECT 1 FROM wype_subscribers s WHERE LOWER(s.email) = LOWER(o.email) AND s.unsubscribed IS TRUE)
      `;
      recipients = rows.map(r => r.email);
    } else if (audience === 'both') {
      const rows = await sql`
        SELECT email FROM wype_subscribers WHERE unsubscribed IS NOT TRUE
        UNION
        SELECT DISTINCT LOWER(o.email) FROM wype_orders o
        WHERE o.email IS NOT NULL AND o.email <> ''
        AND NOT EXISTS (SELECT 1 FROM wype_subscribers s WHERE LOWER(s.email) = LOWER(o.email) AND s.unsubscribed IS TRUE)
      `;
      recipients = rows.map(r => r.email);
    } else {
      return res.status(400).json({ error: 'Unknown audience.' });
    }

    recipients = [...new Set(recipients.filter(Boolean))];
    if (!recipients.length) return res.status(400).json({ error: 'No recipients for that audience.' });

    let sent = 0; const failed = [];
    for (const email of recipients) {
      try {
        await sendEmail({
          from:    '"wype®" <customer@justwypeit.com>',
          to:      email,
          subject,
          html:    newsletterHtml(subject, bodyHtml, email),
        });
        sent++;
      } catch (e) {
        failed.push(email);
        console.error('Newsletter send failed for', email, '-', e.message);
      }
      /* Resend allows ~2 requests/sec — pace the loop */
      if (recipients.length > 1) await new Promise(r => setTimeout(r, 600));
    }
    res.json({ ok: true, audience, total: recipients.length, sent, failed });
  } catch (err) {
    console.error('Newsletter send error:', err.message);
    res.status(500).json({ error: 'Server error.' });
  }
});

/* ─────────────────────────────────────────────
   STRIPE
───────────────────────────────────────────── */
app.get('/stripe-config', (req, res) => {
  res.json({ publishableKey: process.env.STRIPE_PUBLISHABLE_KEY || '' });
});

app.post('/create-payment-intent', async (req, res) => {
  const { amount, currency, country, itemsSummary, discountCode } = req.body;
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
        ...(itemsSummary && { items: String(itemsSummary).slice(0, 490) }),
        ...(discountCode  && { discount_code: String(discountCode).slice(0, 40) }),
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
  const raw = (req.query.number || '').trim();
  if (!raw) return res.status(400).json({ error: 'Please enter an order number.' });

  // Order numbers are pure digits (e.g. 1042). Customers often type "#1042"
  // or "WYPE 1042" straight from their email, so strip everything else.
  const digits = raw.replace(/\D/g, '');
  const num = digits || raw;

  try {
    const rows = await sql`
      SELECT order_number, first_name, last_name, email,
             address1, address2, city, postcode,
             items, subtotal, delivery, total,
             status, created_at,
             tracking_number, carrier, dispatched_at
      FROM wype_orders
      WHERE order_number = ${num}
      LIMIT 1
    `;
    if (rows.length === 0) {
      return res.status(404).json({ error: 'No order found with that number. Please check and try again.' });
    }
    const o = rows[0];
    const trackingNumber = o.tracking_number || '';
    const carrier = o.carrier || '';
    const trackUrl = !trackingNumber ? '' :
      carrier === 'Royal Mail'  ? `https://www.royalmail.com/track-your-item#/tracking-results/${trackingNumber}` :
      carrier === 'Parcelforce' ? `https://www.parcelforce.com/track-trace?trackNumber=${trackingNumber}` :
      carrier === 'DPD'         ? `https://track.dpd.co.uk/search?reference=${trackingNumber}` :
      carrier === 'Evri'        ? `https://www.evri.com/track-a-parcel#/parcel/${trackingNumber}` :
                                  `https://www.dhl.com/gb-en/home/tracking.html?tracking-id=${trackingNumber}`;
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
      trackingNumber,
      carrier,
      trackUrl,
      dispatchedAt: o.dispatched_at,
    });
  } catch (err) {
    console.error('Track order error:', err.message);
    res.status(500).json({ error: 'Could not look up your order. Please try again.' });
  }
});

/* Real recent-order counts for on-page social proof — no fabricated numbers. */
app.get('/api/social-proof', async (req, res) => {
  try {
    const rows = await sql`
      SELECT items FROM wype_orders
      WHERE created_at >= NOW() - INTERVAL '7 days' AND status != 'Cancelled'
    `;
    let nanoOrders = 0, microOrders = 0;
    rows.forEach((row) => {
      let items = row.items;
      if (typeof items === 'string') { try { items = JSON.parse(items); } catch { items = []; } }
      if (!Array.isArray(items)) return;
      const text = items.join(' ').toLowerCase();
      if (text.includes('nanowype')) nanoOrders += 1;
      if (text.includes('microwype')) microOrders += 1;
    });
    res.json({ windowDays: 7, nanowype: nanoOrders, wypeplus: microOrders });
  } catch (err) {
    console.error('Social proof error:', err.message);
    res.status(500).json({ error: 'unavailable' });
  }
});

if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => console.log(`wype server → http://localhost:${PORT}`));
}

module.exports = app;
