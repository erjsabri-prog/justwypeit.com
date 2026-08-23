/* ─────────────────────────────────────────────
   WYPE MARKETPLACE
   Seller hub + listings + Buy-It-Now checkout.
   eBay-style: sellers list car-care products, buyers pay wype via Stripe,
   wype keeps a commission (default 10% of item + postage) and pays the
   seller the remainder ONLY after: seller uploads tracking → buyer confirms
   the item arrived and they're happy → admin checks the tracking and
   approves the payout in the portal. Nothing is released automatically.

   Payout paths:
     • Stripe Connect Express — seller onboards, we transfer their share
       (separate charges & transfers, transfer_group = order number).
     • Manual — seller gives bank details, admin records payouts in the
       portal. Used when Connect isn't set up or the seller skips it.
───────────────────────────────────────────── */
const path = require('path');

const COMMISSION_PCT = Number(process.env.MARKETPLACE_COMMISSION_PCT || 10);
const MAX_IMAGES     = 8;
const PAGE_SIZE      = 24;

const CATEGORIES = [
  { id: 'drying-towels',   label: 'Drying Towels' },
  { id: 'microfibre',      label: 'Microfibre & Cloths' },
  { id: 'wash',            label: 'Wash & Shampoo' },
  { id: 'polish-wax',      label: 'Polish, Wax & Coatings' },
  { id: 'interior',        label: 'Interior Care' },
  { id: 'wheels-tyres',    label: 'Wheels & Tyres' },
  { id: 'glass',           label: 'Glass & Screens' },
  { id: 'machines',        label: 'Polishers & Machines' },
  { id: 'pressure-washers',label: 'Pressure Washers & Foam' },
  { id: 'accessories',     label: 'Brushes, Buckets & Accessories' },
  { id: 'kits',            label: 'Kits & Bundles' },
  { id: 'parts',           label: 'Parts & Exterior' },
  { id: 'other',           label: 'Other' },
];
const CATEGORY_IDS = new Set(CATEGORIES.map(c => c.id));

const CONDITIONS = {
  new:           'Brand new',
  open_box:      'New — open box',
  used_like_new: 'Used — like new',
  used_good:     'Used — good',
  used_fair:     'Used — fair',
  for_parts:     'For parts / not working',
};

const SHIPS_TO = { UK: 'United Kingdom only', UK_EU: 'UK & Europe', WORLD: 'Worldwide' };

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = n => '£' + Number(n || 0).toFixed(2);
const round2 = n => Math.round(Number(n) * 100) / 100;

function slugify(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'shop';
}

module.exports = function mountMarketplace(app, deps) {
  const {
    express, sql, stripe, jwt, JWT_SECRET, authMiddleware, adminMiddleware,
    sendEmail, internalFrom, internalTo, BUSINESS_EMAIL, PUBLIC_SITE_URL,
    noCache, sendWhatsApp, rootDir,
  } = deps;

  const bigJson = express.json({ limit: '14mb' });
  app.use('/api/mp/seller', bigJson);

  /* ═════════════════ SCHEMA ═════════════════ */
  async function initMarketplaceDB() {
    await sql`
      CREATE TABLE IF NOT EXISTS wype_mp_sellers (
        id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id            UUID UNIQUE NOT NULL,
        shop_name          TEXT NOT NULL,
        slug               TEXT UNIQUE NOT NULL,
        bio                TEXT,
        location           TEXT,
        logo_url           TEXT,
        contact_email      TEXT,
        phone              TEXT,
        stripe_account_id  TEXT,
        stripe_onboarded   BOOLEAN DEFAULT FALSE,
        payout_method      TEXT DEFAULT 'manual',
        bank_details       JSONB,
        status             TEXT DEFAULT 'active',
        created_at         TIMESTAMPTZ DEFAULT NOW(),
        updated_at         TIMESTAMPTZ DEFAULT NOW()
      )
    `;
    await sql`
      CREATE TABLE IF NOT EXISTS wype_mp_listings (
        id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        seller_id        UUID NOT NULL,
        title            TEXT NOT NULL,
        description      TEXT,
        category         TEXT NOT NULL DEFAULT 'other',
        condition        TEXT NOT NULL DEFAULT 'new',
        brand            TEXT,
        part_number      TEXT,
        fitment          TEXT,
        price            NUMERIC(10,2) NOT NULL,
        shipping_price   NUMERIC(10,2) NOT NULL DEFAULT 0,
        ships_to         TEXT NOT NULL DEFAULT 'UK',
        dispatch_days    INTEGER NOT NULL DEFAULT 2,
        returns_accepted BOOLEAN DEFAULT TRUE,
        quantity         INTEGER NOT NULL DEFAULT 1,
        quantity_sold    INTEGER NOT NULL DEFAULT 0,
        images           JSONB NOT NULL DEFAULT '[]',
        status           TEXT NOT NULL DEFAULT 'active',
        views            INTEGER NOT NULL DEFAULT 0,
        created_at       TIMESTAMPTZ DEFAULT NOW(),
        updated_at       TIMESTAMPTZ DEFAULT NOW()
      )
    `;
    await sql`CREATE INDEX IF NOT EXISTS wype_mp_listings_seller_idx ON wype_mp_listings (seller_id)`;
    await sql`CREATE INDEX IF NOT EXISTS wype_mp_listings_status_idx ON wype_mp_listings (status, created_at DESC)`;
    await sql`
      CREATE TABLE IF NOT EXISTS wype_mp_order_counter (
        id       INTEGER PRIMARY KEY DEFAULT 1,
        next_val INTEGER NOT NULL DEFAULT 1
      )
    `;
    await sql`INSERT INTO wype_mp_order_counter (id, next_val) VALUES (1, 1) ON CONFLICT (id) DO NOTHING`;
    await sql`
      CREATE TABLE IF NOT EXISTS wype_mp_orders (
        id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        order_number       TEXT UNIQUE NOT NULL,
        listing_id         UUID NOT NULL,
        seller_id          UUID NOT NULL,
        buyer_user_id      UUID,
        listing_title      TEXT,
        listing_image      TEXT,
        first_name         TEXT,
        last_name          TEXT,
        email              TEXT,
        phone              TEXT,
        address1           TEXT,
        address2           TEXT,
        city               TEXT,
        postcode           TEXT,
        country            TEXT,
        buyer_note         TEXT,
        qty                INTEGER NOT NULL DEFAULT 1,
        unit_price         NUMERIC(10,2) NOT NULL,
        item_total         NUMERIC(10,2) NOT NULL,
        shipping           NUMERIC(10,2) NOT NULL DEFAULT 0,
        total              NUMERIC(10,2) NOT NULL,
        commission_pct     NUMERIC(5,2) NOT NULL,
        commission_amount  NUMERIC(10,2) NOT NULL,
        seller_payout      NUMERIC(10,2) NOT NULL,
        status             TEXT NOT NULL DEFAULT 'Paid',
        tracking_number    TEXT,
        carrier            TEXT,
        dispatched_at      TIMESTAMPTZ,
        delivered_at       TIMESTAMPTZ,
        payment_intent_id  TEXT UNIQUE,
        stripe_transfer_id TEXT,
        payout_status      TEXT NOT NULL DEFAULT 'pending',
        paid_out_at        TIMESTAMPTZ,
        refunded_at        TIMESTAMPTZ,
        buyer_confirmed    BOOLEAN DEFAULT FALSE,
        buyer_confirmed_at TIMESTAMPTZ,
        payout_approved_at TIMESTAMPTZ,
        payout_approved_by TEXT,
        created_at         TIMESTAMPTZ DEFAULT NOW()
      )
    `;
    await sql`ALTER TABLE wype_mp_orders ADD COLUMN IF NOT EXISTS buyer_confirmed BOOLEAN DEFAULT FALSE`;
    await sql`ALTER TABLE wype_mp_orders ADD COLUMN IF NOT EXISTS buyer_confirmed_at TIMESTAMPTZ`;
    await sql`ALTER TABLE wype_mp_orders ADD COLUMN IF NOT EXISTS payout_approved_at TIMESTAMPTZ`;
    await sql`ALTER TABLE wype_mp_orders ADD COLUMN IF NOT EXISTS payout_approved_by TEXT`;
    await sql`CREATE INDEX IF NOT EXISTS wype_mp_orders_seller_idx ON wype_mp_orders (seller_id, created_at DESC)`;
    await sql`
      CREATE TABLE IF NOT EXISTS wype_mp_pending (
        payment_intent_id TEXT PRIMARY KEY,
        order_data        JSONB NOT NULL,
        created_at        TIMESTAMPTZ DEFAULT NOW()
      )
    `;
    await sql`
      CREATE TABLE IF NOT EXISTS wype_mp_reviews (
        id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        order_id    UUID UNIQUE NOT NULL,
        listing_id  UUID NOT NULL,
        seller_id   UUID NOT NULL,
        rating      INTEGER NOT NULL,
        comment     TEXT,
        buyer_name  TEXT,
        created_at  TIMESTAMPTZ DEFAULT NOW()
      )
    `;
    await sql`
      CREATE TABLE IF NOT EXISTS wype_mp_payouts (
        id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        seller_id  UUID NOT NULL,
        amount     NUMERIC(10,2) NOT NULL,
        method     TEXT NOT NULL DEFAULT 'manual',
        reference  TEXT,
        note       TEXT,
        order_ids  JSONB,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `;
    await sql`
      CREATE TABLE IF NOT EXISTS wype_mp_messages (
        id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        listing_id  UUID,
        order_id    UUID,
        seller_id   UUID NOT NULL,
        from_name   TEXT,
        from_email  TEXT,
        body        TEXT NOT NULL,
        created_at  TIMESTAMPTZ DEFAULT NOW()
      )
    `;
  }
  initMarketplaceDB().catch(err => console.error('Marketplace DB init error:', err.message));

  /* ═════════════════ HELPERS ═════════════════ */
  async function nextOrderNumber() {
    const rows = await sql`UPDATE wype_mp_order_counter SET next_val = next_val + 1 WHERE id = 1 RETURNING next_val - 1 AS num`;
    return 'MP-' + String(1000 + rows[0].num);
  }

  function publicSeller(s, extra = {}) {
    return {
      id: s.id, shopName: s.shop_name, slug: s.slug, bio: s.bio, location: s.location,
      logoUrl: s.logo_url, createdAt: s.created_at, status: s.status, ...extra,
    };
  }

  function publicListing(l, seller) {
    const images = Array.isArray(l.images) ? l.images : [];
    return {
      id: l.id, title: l.title, description: l.description, category: l.category,
      categoryLabel: (CATEGORIES.find(c => c.id === l.category) || {}).label || 'Other',
      condition: l.condition, conditionLabel: CONDITIONS[l.condition] || l.condition,
      brand: l.brand, partNumber: l.part_number, fitment: l.fitment,
      price: Number(l.price), shippingPrice: Number(l.shipping_price),
      shipsTo: l.ships_to, shipsToLabel: SHIPS_TO[l.ships_to] || l.ships_to,
      dispatchDays: l.dispatch_days, returnsAccepted: l.returns_accepted,
      quantity: l.quantity, quantitySold: l.quantity_sold,
      available: Math.max(0, l.quantity - l.quantity_sold),
      images, image: images[0] || null, status: l.status, views: l.views,
      createdAt: l.created_at, updatedAt: l.updated_at,
      seller: seller ? publicSeller(seller, {
        rating: seller.rating != null ? Number(seller.rating) : null,
        reviewCount: Number(seller.review_count || 0),
        salesCount: Number(seller.sales_count || 0),
      }) : undefined,
    };
  }

  async function sellerStats(sellerId) {
    const [r] = await sql`
      SELECT
        (SELECT COUNT(*) FROM wype_mp_listings WHERE seller_id = ${sellerId} AND status = 'active') AS active_listings,
        (SELECT COUNT(*) FROM wype_mp_orders   WHERE seller_id = ${sellerId} AND status <> 'Refunded') AS orders_count,
        (SELECT COALESCE(SUM(total),0)         FROM wype_mp_orders WHERE seller_id = ${sellerId} AND status <> 'Refunded') AS gross_sales,
        (SELECT COALESCE(SUM(seller_payout),0) FROM wype_mp_orders WHERE seller_id = ${sellerId} AND status <> 'Refunded') AS net_earnings,
        (SELECT COALESCE(SUM(commission_amount),0) FROM wype_mp_orders WHERE seller_id = ${sellerId} AND status <> 'Refunded') AS fees_paid,
        (SELECT COALESCE(SUM(seller_payout),0) FROM wype_mp_orders WHERE seller_id = ${sellerId} AND status <> 'Refunded' AND payout_status = 'pending') AS pending_payout,
        (SELECT COALESCE(SUM(seller_payout),0) FROM wype_mp_orders WHERE seller_id = ${sellerId} AND status <> 'Refunded' AND payout_status <> 'pending') AS paid_out,
        (SELECT COUNT(*) FROM wype_mp_orders WHERE seller_id = ${sellerId} AND status = 'Paid') AS awaiting_dispatch,
        (SELECT AVG(rating) FROM wype_mp_reviews WHERE seller_id = ${sellerId}) AS rating,
        (SELECT COUNT(*) FROM wype_mp_reviews WHERE seller_id = ${sellerId}) AS review_count,
        (SELECT COALESCE(SUM(views),0) FROM wype_mp_listings WHERE seller_id = ${sellerId}) AS views
    `;
    return {
      activeListings:  Number(r.active_listings),
      ordersCount:     Number(r.orders_count),
      grossSales:      Number(r.gross_sales),
      netEarnings:     Number(r.net_earnings),
      feesPaid:        Number(r.fees_paid),
      pendingPayout:   Number(r.pending_payout),
      paidOut:         Number(r.paid_out),
      awaitingDispatch:Number(r.awaiting_dispatch),
      rating:          r.rating != null ? round2(r.rating) : null,
      reviewCount:     Number(r.review_count),
      views:           Number(r.views),
    };
  }

  /* Seller middleware: must be a logged-in user with a seller profile */
  async function sellerMiddleware(req, res, next) {
    const header = req.headers.authorization || '';
    const token  = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) return res.status(401).json({ error: 'Not authenticated.' });
    let decoded;
    try { decoded = jwt.verify(token, JWT_SECRET); } catch { return res.status(401).json({ error: 'Token invalid or expired.' }); }
    try {
      const rows = await sql`SELECT * FROM wype_mp_sellers WHERE user_id = ${decoded.id} LIMIT 1`;
      if (!rows.length) return res.status(403).json({ error: 'No seller account yet.', needsSetup: true });
      if (rows[0].status === 'suspended') return res.status(403).json({ error: 'Your seller account is suspended. Contact customer@justwypeit.com.' });
      req.user   = decoded;
      req.seller = rows[0];
      next();
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }

  function validateListing(b, partial = false) {
    const out = {};
    const errs = [];
    const has = k => b[k] !== undefined;
    if (!partial || has('title')) {
      const t = String(b.title || '').trim();
      if (t.length < 5 || t.length > 120) errs.push('Title must be 5–120 characters.');
      out.title = t;
    }
    if (!partial || has('description')) out.description = String(b.description || '').trim().slice(0, 6000);
    if (!partial || has('category')) {
      out.category = CATEGORY_IDS.has(b.category) ? b.category : null;
      if (!out.category) errs.push('Pick a category.');
    }
    if (!partial || has('condition')) {
      out.condition = CONDITIONS[b.condition] ? b.condition : null;
      if (!out.condition) errs.push('Pick a condition.');
    }
    if (!partial || has('brand'))      out.brand       = String(b.brand || '').trim().slice(0, 80) || null;
    if (!partial || has('partNumber')) out.part_number = String(b.partNumber || '').trim().slice(0, 80) || null;
    if (!partial || has('fitment'))    out.fitment     = String(b.fitment || '').trim().slice(0, 400) || null;
    if (!partial || has('price')) {
      const p = Number(b.price);
      if (!(p >= 0.5 && p <= 50000)) errs.push('Price must be between £0.50 and £50,000.');
      out.price = round2(p);
    }
    if (!partial || has('shippingPrice')) {
      const s = Number(b.shippingPrice || 0);
      if (!(s >= 0 && s <= 500)) errs.push('Postage must be between £0 and £500.');
      out.shipping_price = round2(s);
    }
    if (!partial || has('shipsTo')) out.ships_to = SHIPS_TO[b.shipsTo] ? b.shipsTo : 'UK';
    if (!partial || has('dispatchDays')) {
      const d = parseInt(b.dispatchDays, 10);
      out.dispatch_days = Number.isInteger(d) && d >= 1 && d <= 30 ? d : 2;
    }
    if (!partial || has('returnsAccepted')) out.returns_accepted = !!b.returnsAccepted;
    if (!partial || has('quantity')) {
      const q = parseInt(b.quantity, 10);
      if (!(Number.isInteger(q) && q >= 0 && q <= 10000)) errs.push('Quantity must be 0–10,000.');
      out.quantity = q;
    }
    if (!partial || has('images')) {
      const imgs = Array.isArray(b.images) ? b.images.filter(u => typeof u === 'string' && (u.startsWith('https://') || u.startsWith('data:image/'))).slice(0, MAX_IMAGES) : [];
      if (!partial && !imgs.length) errs.push('Add at least one photo.');
      out.images = imgs;
    }
    return { out, errs };
  }

  /* ═════════════════ IMAGE UPLOAD ═════════════════
     Vercel Blob when BLOB_READ_WRITE_TOKEN is set, otherwise the compressed
     data URL is stored straight in Postgres (client shrinks to ≤1400px). */
  async function storeImage(dataUrl, prefix) {
    const m = /^data:(image\/(?:jpeg|png|webp));base64,(.+)$/.exec(dataUrl || '');
    if (!m) throw new Error('Unsupported image format. Use JPEG, PNG or WebP.');
    const buf = Buffer.from(m[2], 'base64');
    if (buf.length > 2.5 * 1024 * 1024) throw new Error('Image too large (max 2.5 MB after compression).');
    if (process.env.BLOB_READ_WRITE_TOKEN) {
      const ext = m[1].split('/')[1].replace('jpeg', 'jpg');
      const key = `marketplace/${prefix}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
      const r = await fetch(`https://blob.vercel-storage.com/${key}`, {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${process.env.BLOB_READ_WRITE_TOKEN}`,
          'x-api-version': '7',
          'x-content-type': m[1],
          'x-add-random-suffix': '0',
          'x-cache-control-max-age': '31536000',
        },
        body: buf,
      });
      if (!r.ok) throw new Error('Blob upload failed: HTTP ' + r.status);
      const j = await r.json();
      return j.url;
    }
    return dataUrl;
  }

  /* ═════════════════ PAGES ═════════════════ */
  const page = f => (req, res) => { noCache(res); res.sendFile(path.join(rootDir, f)); };
  app.get('/marketplace',             page('marketplace.html'));
  app.get('/marketplace/listing/:id', page('listing.html'));
  app.get('/marketplace/seller/:slug',page('marketplace.html'));
  app.get('/marketplace/checkout',    page('mp-checkout.html'));
  app.get('/marketplace/order',       page('mp-order.html'));
  app.get('/seller-hub',              page('seller-hub.html'));
  app.get('/sell',                    (req, res) => res.redirect(301, '/seller-hub'));

  app.get('/api/mp/meta', (req, res) => {
    res.json({ categories: CATEGORIES, conditions: CONDITIONS, shipsTo: SHIPS_TO, commissionPct: COMMISSION_PCT, maxImages: MAX_IMAGES });
  });

  /* ═════════════════ PUBLIC: LISTINGS ═════════════════ */
  app.get('/api/mp/listings', async (req, res) => {
    try {
      const q         = String(req.query.q || '').trim().slice(0, 100);
      const category  = CATEGORY_IDS.has(req.query.category) ? req.query.category : null;
      const condition = CONDITIONS[req.query.condition] ? req.query.condition : null;
      const seller    = String(req.query.seller || '').trim() || null;
      const minPrice  = req.query.minPrice ? Number(req.query.minPrice) : null;
      const maxPrice  = req.query.maxPrice ? Number(req.query.maxPrice) : null;
      const sort      = String(req.query.sort || 'newest');
      const pageNum   = Math.max(1, parseInt(req.query.page, 10) || 1);
      const limit     = Math.min(48, parseInt(req.query.limit, 10) || PAGE_SIZE);

      const where = [`l.status = 'active'`, `l.quantity > l.quantity_sold`, `s.status = 'active'`];
      const params = [];
      const add = v => { params.push(v); return '$' + params.length; };
      if (q)         where.push(`(l.title ILIKE ${add('%' + q + '%')} OR l.brand ILIKE ${add('%' + q + '%')} OR l.description ILIKE ${add('%' + q + '%')} OR l.fitment ILIKE ${add('%' + q + '%')} OR l.part_number ILIKE ${add('%' + q + '%')})`);
      if (category)  where.push(`l.category = ${add(category)}`);
      if (condition) where.push(`l.condition = ${add(condition)}`);
      if (seller)    where.push(`s.slug = ${add(seller)}`);
      if (minPrice != null && !isNaN(minPrice)) where.push(`l.price >= ${add(minPrice)}`);
      if (maxPrice != null && !isNaN(maxPrice)) where.push(`l.price <= ${add(maxPrice)}`);

      const orderBy = {
        newest:     'l.created_at DESC',
        price_asc:  'l.price + l.shipping_price ASC, l.created_at DESC',
        price_desc: 'l.price + l.shipping_price DESC, l.created_at DESC',
        popular:    'l.views DESC, l.quantity_sold DESC, l.created_at DESC',
        best_selling:'l.quantity_sold DESC, l.created_at DESC',
      }[sort] || 'l.created_at DESC';

      const base = `
        FROM wype_mp_listings l
        JOIN wype_mp_sellers s ON s.id = l.seller_id
        WHERE ${where.join(' AND ')}`;
      const countRows = await sql.query(`SELECT COUNT(*)::int AS n ${base}`, params);
      const total = countRows[0].n;
      const rows = await sql.query(`
        SELECT l.id, l.title, l.category, l.condition, l.brand, l.price, l.shipping_price, l.ships_to,
               l.quantity, l.quantity_sold, l.views, l.created_at, l.updated_at, l.dispatch_days,
               (l.images->0) AS first_image,
               s.id AS s_id, s.shop_name, s.slug, s.location, s.logo_url, s.created_at AS s_created, s.status AS s_status,
               (SELECT AVG(rating) FROM wype_mp_reviews r WHERE r.seller_id = s.id) AS rating,
               (SELECT COUNT(*) FROM wype_mp_reviews r WHERE r.seller_id = s.id) AS review_count
        ${base}
        ORDER BY ${orderBy}
        LIMIT ${limit} OFFSET ${(pageNum - 1) * limit}`, params);

      const listings = rows.map(r => publicListing(
        { ...r, images: r.first_image ? [r.first_image] : [], description: undefined },
        { id: r.s_id, shop_name: r.shop_name, slug: r.slug, location: r.location, logo_url: r.logo_url, created_at: r.s_created, status: r.s_status, rating: r.rating, review_count: r.review_count }
      ));
      res.json({ listings, total, page: pageNum, pages: Math.max(1, Math.ceil(total / limit)), categories: CATEGORIES });
    } catch (err) {
      console.error('MP listings error:', err.message);
      res.status(500).json({ error: 'Could not load listings.' });
    }
  });

  app.get('/api/mp/listings/:id', async (req, res) => {
    try {
      const rows = await sql`
        SELECT l.*, s.id AS s_id, s.shop_name, s.slug, s.bio, s.location, s.logo_url, s.created_at AS s_created, s.status AS s_status,
               (SELECT AVG(rating) FROM wype_mp_reviews r WHERE r.seller_id = s.id) AS rating,
               (SELECT COUNT(*)    FROM wype_mp_reviews r WHERE r.seller_id = s.id) AS review_count,
               (SELECT COUNT(*)    FROM wype_mp_orders o  WHERE o.seller_id = s.id AND o.status <> 'Refunded') AS sales_count
        FROM wype_mp_listings l JOIN wype_mp_sellers s ON s.id = l.seller_id
        WHERE l.id = ${req.params.id}::uuid LIMIT 1`;
      if (!rows.length) return res.status(404).json({ error: 'Listing not found.' });
      const r = rows[0];
      if (r.status === 'removed') return res.status(404).json({ error: 'Listing not found.' });
      sql`UPDATE wype_mp_listings SET views = views + 1 WHERE id = ${r.id}`.catch(() => {});
      const seller = { id: r.s_id, shop_name: r.shop_name, slug: r.slug, bio: r.bio, location: r.location, logo_url: r.logo_url, created_at: r.s_created, status: r.s_status, rating: r.rating, review_count: r.review_count, sales_count: r.sales_count };
      const reviews = await sql`SELECT rating, comment, buyer_name, created_at FROM wype_mp_reviews WHERE seller_id = ${r.s_id} ORDER BY created_at DESC LIMIT 10`;
      const more = await sql`
        SELECT id, title, price, shipping_price, condition, (images->0) AS first_image
        FROM wype_mp_listings WHERE seller_id = ${r.s_id} AND id <> ${r.id} AND status = 'active' AND quantity > quantity_sold
        ORDER BY created_at DESC LIMIT 6`;
      res.json({
        listing: publicListing(r, seller),
        reviews,
        moreFromSeller: more.map(m => ({ id: m.id, title: m.title, price: Number(m.price), shippingPrice: Number(m.shipping_price), condition: m.condition, image: m.first_image })),
      });
    } catch (err) {
      if (/invalid input syntax for type uuid/.test(err.message)) return res.status(404).json({ error: 'Listing not found.' });
      console.error('MP listing error:', err.message);
      res.status(500).json({ error: 'Could not load listing.' });
    }
  });

  app.get('/api/mp/sellers/:slug', async (req, res) => {
    try {
      const rows = await sql`SELECT * FROM wype_mp_sellers WHERE slug = ${req.params.slug} LIMIT 1`;
      if (!rows.length) return res.status(404).json({ error: 'Seller not found.' });
      const s = rows[0];
      const stats = await sellerStats(s.id);
      const reviews = await sql`SELECT rating, comment, buyer_name, created_at FROM wype_mp_reviews WHERE seller_id = ${s.id} ORDER BY created_at DESC LIMIT 20`;
      res.json({ seller: publicSeller(s, { rating: stats.rating, reviewCount: stats.reviewCount, salesCount: stats.ordersCount, activeListings: stats.activeListings }), reviews });
    } catch (err) {
      res.status(500).json({ error: 'Could not load seller.' });
    }
  });

  /* Contact seller — relays through email so seller addresses stay private */
  app.post('/api/mp/listings/:id/contact', async (req, res) => {
    const { name, email, message } = req.body || {};
    if (!name || !email || !message) return res.status(400).json({ error: 'Name, email and message are required.' });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Invalid email address.' });
    try {
      const rows = await sql`
        SELECT l.id, l.title, s.id AS seller_id, s.shop_name, s.contact_email, u.email AS user_email, u.first_name
        FROM wype_mp_listings l JOIN wype_mp_sellers s ON s.id = l.seller_id JOIN wype_users u ON u.id = s.user_id
        WHERE l.id = ${req.params.id}::uuid LIMIT 1`;
      if (!rows.length) return res.status(404).json({ error: 'Listing not found.' });
      const l = rows[0];
      await sql`INSERT INTO wype_mp_messages (listing_id, seller_id, from_name, from_email, body) VALUES (${l.id}, ${l.seller_id}, ${String(name).slice(0, 80)}, ${String(email).toLowerCase()}, ${String(message).slice(0, 3000)})`;
      // Message is saved to the seller's hub inbox first; the email relay is best-effort
      sendEmail({
        from: internalFrom('Marketplace'),
        to: l.contact_email || l.user_email,
        replyTo: email,
        subject: `Question about your listing: ${l.title}`,
        html: emailShell('New buyer question', `
          <p style="margin:0 0 14px;font-size:15px;color:#333">Hi ${esc(l.first_name)}, a buyer has a question about <strong>${esc(l.title)}</strong>.</p>
          <div style="background:#f7f7f7;border-radius:10px;padding:16px 18px;font-size:14px;color:#222;white-space:pre-wrap">${esc(message)}</div>
          <p style="margin:16px 0 0;font-size:13px;color:#666">From <strong>${esc(name)}</strong> &lt;${esc(email)}&gt; — just reply to this email to answer them.</p>
          ${btn(`${PUBLIC_SITE_URL}/marketplace/listing/${l.id}`, 'View listing')}`),
      }).catch(e => console.error('MP contact email failed:', e.message));
      res.json({ ok: true });
    } catch (err) {
      console.error('MP contact error:', err.message);
      res.status(500).json({ error: 'Could not send your message. Try again.' });
    }
  });

  /* ═════════════════ PUBLIC: CHECKOUT ═════════════════ */
  function quote(listing, qty) {
    const unit      = Number(listing.price);
    const itemTotal = round2(unit * qty);
    const shipping  = round2(Number(listing.shipping_price));
    const total     = round2(itemTotal + shipping);
    const commission= round2(total * COMMISSION_PCT / 100);
    const payout    = round2(total - commission);
    return { unit, itemTotal, shipping, total, commission, payout };
  }

  app.post('/api/mp/checkout/intent', async (req, res) => {
    const { listingId, qty, reuseIntentId } = req.body || {};
    const quantity = Math.max(1, Math.min(50, parseInt(qty, 10) || 1));
    try {
      const rows = await sql`
        SELECT l.*, s.status AS s_status, s.shop_name FROM wype_mp_listings l JOIN wype_mp_sellers s ON s.id = l.seller_id
        WHERE l.id = ${listingId}::uuid LIMIT 1`;
      if (!rows.length) return res.status(404).json({ error: 'Listing not found.' });
      const l = rows[0];
      if (l.status !== 'active' || l.s_status !== 'active') return res.status(409).json({ error: 'This listing is no longer available.' });
      const available = l.quantity - l.quantity_sold;
      if (available < quantity) return res.status(409).json({ error: available <= 0 ? 'Sold out.' : `Only ${available} left.` });
      const q = quote(l, quantity);
      const amount = Math.round(q.total * 100);
      if (amount < 30) return res.status(400).json({ error: 'Order total too small.' });
      const metadata = {
        marketplace: '1', site: 'justwypeit.com',
        listing_id: l.id, seller_id: l.seller_id, qty: String(quantity),
        listing_title: String(l.title).slice(0, 200), shop: String(l.shop_name).slice(0, 100),
      };
      let intent = null;
      if (/^pi_[A-Za-z0-9]+$/.test(reuseIntentId || '')) {
        try {
          const existing = await stripe.paymentIntents.retrieve(reuseIntentId);
          if (existing.metadata?.marketplace === '1' && ['requires_payment_method', 'requires_confirmation', 'requires_action'].includes(existing.status)) {
            intent = await stripe.paymentIntents.update(reuseIntentId, { amount, metadata });
          }
        } catch {}
      }
      if (!intent) {
        intent = await stripe.paymentIntents.create({
          amount, currency: 'gbp',
          automatic_payment_methods: { enabled: true },
          description: `Marketplace: ${quantity}x ${l.title}`.slice(0, 900),
          transfer_group: 'mp_' + l.id.slice(0, 8) + '_' + Date.now(),
          metadata,
        });
      }
      res.json({ clientSecret: intent.client_secret, paymentIntentId: intent.id, quote: q, qty: quantity, commissionPct: COMMISSION_PCT });
    } catch (err) {
      console.error('MP intent error:', err.message);
      res.status(500).json({ error: 'Could not start checkout.' });
    }
  });

  app.post('/api/mp/checkout/register-pending', async (req, res) => {
    const b = req.body || {};
    if (!/^pi_[A-Za-z0-9]+$/.test(b.paymentIntentId || '')) return res.status(400).json({ error: 'Invalid payment reference.' });
    let buyerUserId = null;
    const header = req.headers.authorization || '';
    if (header.startsWith('Bearer ')) { try { buyerUserId = jwt.verify(header.slice(7), JWT_SECRET).id; } catch {} }
    const data = {
      listingId: b.listingId, qty: b.qty, buyerUserId,
      firstName: b.firstName, lastName: b.lastName, email: b.email, phone: b.phone,
      address1: b.address1, address2: b.address2, city: b.city, postcode: b.postcode, country: b.country || 'GB',
      note: b.note,
    };
    try {
      await sql`INSERT INTO wype_mp_pending (payment_intent_id, order_data) VALUES (${b.paymentIntentId}, ${JSON.stringify(data)})
                ON CONFLICT (payment_intent_id) DO UPDATE SET order_data = EXCLUDED.order_data, created_at = NOW()`;
      if (b.email) {
        stripe.paymentIntents.update(b.paymentIntentId, { receipt_email: b.email, metadata: { customer_email: b.email, customer_name: `${b.firstName || ''} ${b.lastName || ''}`.trim() } }).catch(() => {});
      }
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  /* Called from the Stripe webhook for payment_intent.succeeded with metadata.marketplace === '1'.
     Also callable from the confirmation page as a fallback (verifies PI with Stripe first). */
  async function finalizeMarketplaceOrder(pi) {
    const existing = await sql`SELECT * FROM wype_mp_orders WHERE payment_intent_id = ${pi.id} LIMIT 1`;
    if (existing.length) return existing[0];

    const pend = await sql`SELECT order_data FROM wype_mp_pending WHERE payment_intent_id = ${pi.id}`;
    const od = pend.length ? pend[0].order_data : {};
    const listingId = od.listingId || pi.metadata?.listing_id;
    const qty = Math.max(1, parseInt(od.qty || pi.metadata?.qty || '1', 10));
    const lrows = await sql`SELECT l.*, s.user_id AS seller_user_id FROM wype_mp_listings l JOIN wype_mp_sellers s ON s.id = l.seller_id WHERE l.id = ${listingId}::uuid`;
    if (!lrows.length) throw new Error('Listing missing for paid marketplace intent ' + pi.id);
    const l = lrows[0];

    // Fill buyer details from Stripe when the wallet paid before the form was registered
    let cb = {};
    if (!od.email || !od.address1) {
      try { const ch = await stripe.charges.retrieve(pi.latest_charge); cb = ch?.billing_details || {}; } catch {}
    }
    const ship = pi.shipping || {};
    const addr = ship.address || cb.address || {};
    const nameParts = String(ship.name || cb.name || '').trim().split(' ');

    // Use the amount Stripe actually captured for the money split so a price edit mid-checkout can't skew it
    const paid = round2(pi.amount_received / 100);
    const shipping = round2(Number(l.shipping_price));
    const itemTotal = round2(paid - shipping);
    const unit = round2(itemTotal / qty);
    const commission = round2(paid * COMMISSION_PCT / 100);
    const payout = round2(paid - commission);

    const orderNumber = await nextOrderNumber();
    const rows = await sql`
      INSERT INTO wype_mp_orders
        (order_number, listing_id, seller_id, buyer_user_id, listing_title, listing_image,
         first_name, last_name, email, phone, address1, address2, city, postcode, country, buyer_note,
         qty, unit_price, item_total, shipping, total, commission_pct, commission_amount, seller_payout,
         payment_intent_id)
      VALUES
        (${orderNumber}, ${l.id}, ${l.seller_id}, ${od.buyerUserId || null}, ${l.title}, ${(l.images || [])[0] || null},
         ${od.firstName || nameParts[0] || null}, ${od.lastName || nameParts.slice(1).join(' ') || null},
         ${(od.email || cb.email || pi.receipt_email || '').toLowerCase() || null}, ${od.phone || cb.phone || null},
         ${od.address1 || addr.line1 || null}, ${od.address2 || addr.line2 || null}, ${od.city || addr.city || null},
         ${od.postcode || addr.postal_code || null}, ${od.country || addr.country || 'GB'}, ${od.note || null},
         ${qty}, ${unit}, ${itemTotal}, ${shipping}, ${paid}, ${COMMISSION_PCT}, ${commission}, ${payout},
         ${pi.id})
      RETURNING *`;
    const order = rows[0];
    await sql`UPDATE wype_mp_listings SET quantity_sold = quantity_sold + ${qty},
              status = CASE WHEN quantity <= quantity_sold + ${qty} THEN 'sold_out' ELSE status END, updated_at = NOW()
              WHERE id = ${l.id}`;
    await sql`DELETE FROM wype_mp_pending WHERE payment_intent_id = ${pi.id}`;
    stripe.paymentIntents.update(pi.id, { metadata: { order_number: orderNumber } }).catch(() => {});

    sendSaleEmails(order, l).catch(e => console.error('MP sale emails failed:', e.message));
    sendWhatsApp && sendWhatsApp(`🛒 Marketplace sale ${orderNumber}: ${qty}x ${l.title} — ${money(paid)} (fee ${money(commission)})`);
    return order;
  }

  app.get('/api/mp/order-by-intent', async (req, res) => {
    const piId = String(req.query.pi || '');
    if (!/^pi_[A-Za-z0-9]+$/.test(piId)) return res.status(400).json({ error: 'Invalid reference.' });
    try {
      let rows = await sql`SELECT * FROM wype_mp_orders WHERE payment_intent_id = ${piId} LIMIT 1`;
      if (!rows.length) {
        const pi = await stripe.paymentIntents.retrieve(piId);
        if (pi.metadata?.marketplace !== '1') return res.status(404).json({ error: 'Not a marketplace payment.' });
        if (pi.status !== 'succeeded') return res.status(202).json({ pending: true, status: pi.status });
        const order = await finalizeMarketplaceOrder(pi);
        rows = [order];
      }
      res.json({ order: buyerOrderView(rows[0]) });
    } catch (err) {
      console.error('MP order-by-intent error:', err.message);
      res.status(500).json({ error: 'Could not load order.' });
    }
  });

  function buyerOrderView(o, extra = {}) {
    return {
      orderNumber: o.order_number, status: o.status, createdAt: o.created_at,
      listingId: o.listing_id, title: o.listing_title, image: o.listing_image,
      qty: o.qty, unitPrice: Number(o.unit_price), itemTotal: Number(o.item_total), shipping: Number(o.shipping), total: Number(o.total),
      firstName: o.first_name, lastName: o.last_name, email: o.email,
      address: [o.address1, o.address2, o.city, o.postcode, o.country].filter(Boolean).join(', '),
      trackingNumber: o.tracking_number, carrier: o.carrier, dispatchedAt: o.dispatched_at, deliveredAt: o.delivered_at,
      buyerConfirmed: !!o.buyer_confirmed,
      ...extra,
    };
  }

  /* Buyer order lookup + review (by order number + email) */
  app.get('/api/mp/order', async (req, res) => {
    const num = String(req.query.orderNumber || '').trim().toUpperCase();
    const email = String(req.query.email || '').trim().toLowerCase();
    if (!num || !email) return res.status(400).json({ error: 'Order number and email required.' });
    try {
      const rows = await sql`SELECT o.*, s.shop_name, s.slug FROM wype_mp_orders o JOIN wype_mp_sellers s ON s.id = o.seller_id WHERE o.order_number = ${num} AND LOWER(o.email) = ${email} LIMIT 1`;
      if (!rows.length) return res.status(404).json({ error: 'No order found for that number and email.' });
      const o = rows[0];
      const rev = await sql`SELECT rating, comment FROM wype_mp_reviews WHERE order_id = ${o.id}`;
      res.json({ order: buyerOrderView(o, { shopName: o.shop_name, sellerSlug: o.slug, review: rev[0] || null }) });
    } catch (err) { res.status(500).json({ error: 'Could not load order.' }); }
  });

  /* Buyer confirms the parcel arrived and they're happy — required before any payout */
  app.post('/api/mp/order/confirm', async (req, res) => {
    const { orderNumber, email } = req.body || {};
    try {
      const rows = await sql`SELECT * FROM wype_mp_orders WHERE order_number = ${String(orderNumber || '').toUpperCase()} AND LOWER(email) = ${String(email || '').toLowerCase()} LIMIT 1`;
      if (!rows.length) return res.status(404).json({ error: 'Order not found.' });
      const o = rows[0];
      if (o.status === 'Refunded') return res.status(409).json({ error: 'This order was refunded.' });
      if (o.status === 'Paid') return res.status(409).json({ error: 'The seller has not dispatched this order yet.' });
      const upd = await sql`UPDATE wype_mp_orders SET buyer_confirmed = TRUE, buyer_confirmed_at = COALESCE(buyer_confirmed_at, NOW()),
                            status = 'Delivered', delivered_at = COALESCE(delivered_at, NOW()) WHERE id = ${o.id} RETURNING *`;
      const s = await sql`SELECT shop_name FROM wype_mp_sellers WHERE id = ${o.seller_id}`;
      sendEmail({ from: internalFrom('Marketplace'), to: internalTo(),
        subject: `✅ Buyer confirmed ${o.order_number} — payout ready for approval (${money(o.seller_payout)})`,
        html: emailShell('Payout ready for approval', `<p style="font-size:14px;color:#333">Buyer ${esc(o.email)} confirmed <strong>${esc(o.listing_title)}</strong> from <strong>${esc(s[0]?.shop_name || '')}</strong> arrived and they're happy. Check tracking <strong>${esc(o.carrier || '')} ${esc(o.tracking_number || '')}</strong> shows delivered, then approve the ${money(o.seller_payout)} payout in admin.</p>${btn(`${PUBLIC_SITE_URL}/admin`, 'Review in admin')}`) }).catch(() => {});
      res.json({ ok: true, order: buyerOrderView(upd[0]) });
    } catch (err) { res.status(500).json({ error: 'Could not confirm order.' }); }
  });

  app.post('/api/mp/order/review', async (req, res) => {
    const { orderNumber, email, rating, comment } = req.body || {};
    const r = parseInt(rating, 10);
    if (!(r >= 1 && r <= 5)) return res.status(400).json({ error: 'Rating must be 1–5.' });
    try {
      const rows = await sql`SELECT * FROM wype_mp_orders WHERE order_number = ${String(orderNumber || '').toUpperCase()} AND LOWER(email) = ${String(email || '').toLowerCase()} LIMIT 1`;
      if (!rows.length) return res.status(404).json({ error: 'Order not found.' });
      const o = rows[0];
      if (o.status === 'Refunded') return res.status(409).json({ error: 'Refunded orders cannot be reviewed.' });
      await sql`INSERT INTO wype_mp_reviews (order_id, listing_id, seller_id, rating, comment, buyer_name)
                VALUES (${o.id}, ${o.listing_id}, ${o.seller_id}, ${r}, ${String(comment || '').slice(0, 1000) || null}, ${(o.first_name || 'Buyer') + ' ' + (o.last_name ? o.last_name[0] + '.' : '')})
                ON CONFLICT (order_id) DO UPDATE SET rating = EXCLUDED.rating, comment = EXCLUDED.comment, created_at = NOW()`;
      res.json({ ok: true });
    } catch (err) { res.status(500).json({ error: 'Could not save review.' }); }
  });

  /* Logged-in buyers: their marketplace purchases */
  app.get('/api/mp/my-purchases', authMiddleware, async (req, res) => {
    try {
      const rows = await sql`SELECT o.*, s.shop_name, s.slug FROM wype_mp_orders o JOIN wype_mp_sellers s ON s.id = o.seller_id
                             WHERE o.buyer_user_id = ${req.user.id} OR LOWER(o.email) = ${String(req.user.email || '').toLowerCase()}
                             ORDER BY o.created_at DESC LIMIT 100`;
      res.json({ orders: rows.map(o => buyerOrderView(o, { shopName: o.shop_name, sellerSlug: o.slug })) });
    } catch (err) { res.status(500).json({ error: 'Could not load purchases.' }); }
  });

  /* ═════════════════ SELLER HUB ═════════════════ */
  app.get('/api/mp/seller/status', authMiddleware, async (req, res) => {
    try {
      const rows = await sql`SELECT * FROM wype_mp_sellers WHERE user_id = ${req.user.id} LIMIT 1`;
      if (!rows.length) return res.json({ hasSeller: false });
      res.json({ hasSeller: true, seller: sellerSelfView(rows[0]) });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.post('/api/mp/seller/register', authMiddleware, async (req, res) => {
    const { shopName, bio, location, contactEmail, phone } = req.body || {};
    const name = String(shopName || '').trim();
    if (name.length < 2 || name.length > 60) return res.status(400).json({ error: 'Shop name must be 2–60 characters.' });
    try {
      const existing = await sql`SELECT id FROM wype_mp_sellers WHERE user_id = ${req.user.id}`;
      if (existing.length) return res.status(409).json({ error: 'You already have a seller account.' });
      let slug = slugify(name);
      const clash = await sql`SELECT 1 FROM wype_mp_sellers WHERE slug = ${slug}`;
      if (clash.length) slug = slug + '-' + Math.random().toString(36).slice(2, 6);
      const rows = await sql`
        INSERT INTO wype_mp_sellers (user_id, shop_name, slug, bio, location, contact_email, phone)
        VALUES (${req.user.id}, ${name}, ${slug}, ${String(bio || '').slice(0, 1500) || null}, ${String(location || '').slice(0, 80) || null},
                ${String(contactEmail || '').toLowerCase().slice(0, 120) || null}, ${String(phone || '').slice(0, 30) || null})
        RETURNING *`;
      const u = await sql`SELECT first_name, email FROM wype_users WHERE id = ${req.user.id}`;
      sendEmail({
        from: internalFrom('Marketplace'), to: u[0].email, replyTo: BUSINESS_EMAIL,
        subject: `Welcome to the wype® Marketplace, ${name}!`,
        html: emailShell('Your shop is live', `
          <p style="margin:0 0 14px;font-size:15px;color:#333">Hi ${esc(u[0].first_name)}, your seller account <strong>${esc(name)}</strong> is ready.</p>
          <ul style="margin:0 0 18px;padding-left:20px;font-size:14px;color:#444;line-height:1.7">
            <li>List car-care products in minutes from the Seller Hub</li>
            <li>We take a ${COMMISSION_PCT}% fee on each sale (item + postage) — no listing fees</li>
            <li>Upload tracking when you ship. Payouts are released by wype® once the parcel shows delivered and the buyer confirms they're happy</li>
            <li>Connect Stripe in <em>Payouts</em> for automatic transfers, or add bank details for manual payouts</li>
          </ul>
          ${btn(`${PUBLIC_SITE_URL}/seller-hub`, 'Open Seller Hub')}`),
      }).catch(() => {});
      sendEmail({ from: internalFrom('Marketplace'), to: internalTo(), subject: `🆕 New marketplace seller: ${name}`, html: `<p>${esc(name)} (${esc(u[0].email)}) just opened a shop. <a href="${PUBLIC_SITE_URL}/admin">Admin</a></p>` }).catch(() => {});
      res.json({ seller: sellerSelfView(rows[0]) });
    } catch (err) {
      console.error('MP register seller error:', err.message);
      res.status(500).json({ error: 'Could not create seller account.' });
    }
  });

  function sellerSelfView(s) {
    const bank = s.bank_details || null;
    return {
      ...publicSeller(s),
      contactEmail: s.contact_email, phone: s.phone,
      stripeConnected: !!s.stripe_account_id, stripeOnboarded: !!s.stripe_onboarded,
      payoutMethod: s.payout_method,
      bankDetails: bank ? { accountName: bank.accountName, sortCode: bank.sortCode, accountNumber: bank.accountNumber ? '••••' + String(bank.accountNumber).slice(-4) : null } : null,
      commissionPct: COMMISSION_PCT,
    };
  }

  app.get('/api/mp/seller/me', sellerMiddleware, async (req, res) => {
    try {
      const stats = await sellerStats(req.seller.id);
      // Recent 30 days sales for the sparkline
      const daily = await sql`
        SELECT DATE(created_at) AS d, COALESCE(SUM(total),0) AS v, COUNT(*) AS n
        FROM wype_mp_orders WHERE seller_id = ${req.seller.id} AND status <> 'Refunded' AND created_at > NOW() - INTERVAL '30 days'
        GROUP BY 1 ORDER BY 1`;
      res.json({ seller: sellerSelfView(req.seller), stats, daily: daily.map(r => ({ date: r.d, value: Number(r.v), count: Number(r.n) })), stripeConnectAvailable: !!process.env.STRIPE_SECRET_KEY });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.put('/api/mp/seller/me', sellerMiddleware, async (req, res) => {
    const { shopName, bio, location, contactEmail, phone, logoUrl } = req.body || {};
    try {
      const name = shopName !== undefined ? String(shopName).trim() : req.seller.shop_name;
      if (name.length < 2 || name.length > 60) return res.status(400).json({ error: 'Shop name must be 2–60 characters.' });
      let logo = req.seller.logo_url;
      if (logoUrl !== undefined) logo = logoUrl ? (logoUrl.startsWith('data:') ? await storeImage(logoUrl, req.seller.id) : logoUrl) : null;
      const rows = await sql`
        UPDATE wype_mp_sellers SET
          shop_name = ${name},
          bio = ${bio !== undefined ? String(bio).slice(0, 1500) || null : req.seller.bio},
          location = ${location !== undefined ? String(location).slice(0, 80) || null : req.seller.location},
          contact_email = ${contactEmail !== undefined ? String(contactEmail).toLowerCase().slice(0, 120) || null : req.seller.contact_email},
          phone = ${phone !== undefined ? String(phone).slice(0, 30) || null : req.seller.phone},
          logo_url = ${logo}, updated_at = NOW()
        WHERE id = ${req.seller.id} RETURNING *`;
      res.json({ seller: sellerSelfView(rows[0]) });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.post('/api/mp/seller/upload', sellerMiddleware, bigJson, async (req, res) => {
    try {
      const url = await storeImage(req.body?.dataUrl, req.seller.id);
      res.json({ url });
    } catch (err) { res.status(400).json({ error: err.message }); }
  });

  /* ── Payouts: Stripe Connect ── */
  app.post('/api/mp/seller/stripe/onboard', sellerMiddleware, async (req, res) => {
    try {
      let acct = req.seller.stripe_account_id;
      if (!acct) {
        const u = await sql`SELECT email FROM wype_users WHERE id = ${req.seller.user_id}`;
        const account = await stripe.accounts.create({
          type: 'express', country: 'GB', email: u[0]?.email,
          capabilities: { transfers: { requested: true } },
          business_profile: { name: req.seller.shop_name, url: `${PUBLIC_SITE_URL}/marketplace/seller/${req.seller.slug}`, mcc: '5533' },
          metadata: { seller_id: req.seller.id, site: 'justwypeit.com' },
        });
        acct = account.id;
        await sql`UPDATE wype_mp_sellers SET stripe_account_id = ${acct}, updated_at = NOW() WHERE id = ${req.seller.id}`;
      }
      const link = await stripe.accountLinks.create({
        account: acct, type: 'account_onboarding',
        refresh_url: `${PUBLIC_SITE_URL}/seller-hub?view=payouts&stripe=refresh`,
        return_url:  `${PUBLIC_SITE_URL}/seller-hub?view=payouts&stripe=return`,
      });
      res.json({ url: link.url });
    } catch (err) {
      console.error('MP stripe onboard error:', err.message);
      const msg = /Connect/i.test(err.message) || /platform/i.test(err.message)
        ? 'Stripe Connect is not enabled on the wype Stripe account yet. Add your bank details below instead and we will pay you manually.'
        : err.message;
      res.status(500).json({ error: msg });
    }
  });

  app.get('/api/mp/seller/stripe/status', sellerMiddleware, async (req, res) => {
    if (!req.seller.stripe_account_id) return res.json({ connected: false, onboarded: false });
    try {
      const a = await stripe.accounts.retrieve(req.seller.stripe_account_id);
      const onboarded = !!(a.details_submitted && a.payouts_enabled);
      if (onboarded !== !!req.seller.stripe_onboarded) {
        await sql`UPDATE wype_mp_sellers SET stripe_onboarded = ${onboarded}, payout_method = ${onboarded ? 'stripe' : req.seller.payout_method}, updated_at = NOW() WHERE id = ${req.seller.id}`;
      }
      res.json({ connected: true, onboarded, payoutsEnabled: !!a.payouts_enabled, detailsSubmitted: !!a.details_submitted, requirements: a.requirements?.currently_due || [] });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.post('/api/mp/seller/stripe/dashboard', sellerMiddleware, async (req, res) => {
    if (!req.seller.stripe_account_id) return res.status(400).json({ error: 'Stripe not connected.' });
    try {
      const link = await stripe.accounts.createLoginLink(req.seller.stripe_account_id);
      res.json({ url: link.url });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.put('/api/mp/seller/bank-details', sellerMiddleware, async (req, res) => {
    const { accountName, sortCode, accountNumber } = req.body || {};
    const sc = String(sortCode || '').replace(/\D/g, '');
    const an = String(accountNumber || '').replace(/\D/g, '');
    if (!accountName || sc.length !== 6 || an.length !== 8) return res.status(400).json({ error: 'Enter account name, 6-digit sort code and 8-digit account number.' });
    try {
      const rows = await sql`UPDATE wype_mp_sellers SET bank_details = ${JSON.stringify({ accountName: String(accountName).slice(0, 80), sortCode: sc.replace(/(\d{2})(\d{2})(\d{2})/, '$1-$2-$3'), accountNumber: an })},
                             payout_method = CASE WHEN stripe_onboarded THEN 'stripe' ELSE 'manual' END, updated_at = NOW()
                             WHERE id = ${req.seller.id} RETURNING *`;
      res.json({ seller: sellerSelfView(rows[0]) });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.get('/api/mp/seller/payouts', sellerMiddleware, async (req, res) => {
    try {
      const payouts = await sql`SELECT * FROM wype_mp_payouts WHERE seller_id = ${req.seller.id} ORDER BY created_at DESC LIMIT 100`;
      const pending = await sql`SELECT order_number, listing_title, total, commission_amount, seller_payout, status, created_at, payout_status, paid_out_at, stripe_transfer_id
                                FROM wype_mp_orders WHERE seller_id = ${req.seller.id} AND status <> 'Refunded' ORDER BY created_at DESC LIMIT 200`;
      res.json({
        payouts: payouts.map(p => ({ id: p.id, amount: Number(p.amount), method: p.method, reference: p.reference, note: p.note, createdAt: p.created_at })),
        ledger: pending.map(o => ({ orderNumber: o.order_number, title: o.listing_title, total: Number(o.total), fee: Number(o.commission_amount), payout: Number(o.seller_payout), status: o.status, payoutStatus: o.payout_status, paidOutAt: o.paid_out_at, transferId: o.stripe_transfer_id, createdAt: o.created_at })),
      });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  /* ── Listings CRUD ── */
  app.get('/api/mp/seller/listings', sellerMiddleware, async (req, res) => {
    try {
      const rows = await sql`SELECT * FROM wype_mp_listings WHERE seller_id = ${req.seller.id} AND status <> 'removed' ORDER BY created_at DESC`;
      res.json({ listings: rows.map(l => publicListing(l)) });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.post('/api/mp/seller/listings', sellerMiddleware, bigJson, async (req, res) => {
    const { out, errs } = validateListing(req.body || {});
    if (errs.length) return res.status(400).json({ error: errs[0], errors: errs });
    try {
      const images = [];
      for (const img of out.images) images.push(img.startsWith('data:') ? await storeImage(img, req.seller.id) : img);
      const rows = await sql`
        INSERT INTO wype_mp_listings
          (seller_id, title, description, category, condition, brand, part_number, fitment, price, shipping_price, ships_to, dispatch_days, returns_accepted, quantity, images, status)
        VALUES
          (${req.seller.id}, ${out.title}, ${out.description}, ${out.category}, ${out.condition}, ${out.brand}, ${out.part_number}, ${out.fitment},
           ${out.price}, ${out.shipping_price}, ${out.ships_to}, ${out.dispatch_days}, ${out.returns_accepted}, ${out.quantity}, ${JSON.stringify(images)},
           ${req.body.status === 'draft' ? 'draft' : (out.quantity > 0 ? 'active' : 'sold_out')})
        RETURNING *`;
      res.json({ listing: publicListing(rows[0]) });
    } catch (err) {
      console.error('MP create listing error:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  app.put('/api/mp/seller/listings/:id', sellerMiddleware, bigJson, async (req, res) => {
    const { out, errs } = validateListing(req.body || {}, true);
    if (errs.length) return res.status(400).json({ error: errs[0], errors: errs });
    try {
      const cur = await sql`SELECT * FROM wype_mp_listings WHERE id = ${req.params.id}::uuid AND seller_id = ${req.seller.id}`;
      if (!cur.length) return res.status(404).json({ error: 'Listing not found.' });
      const l = cur[0];
      let images = l.images;
      if (out.images) {
        images = [];
        for (const img of out.images) images.push(img.startsWith('data:') ? await storeImage(img, req.seller.id) : img);
        if (!images.length) return res.status(400).json({ error: 'Add at least one photo.' });
      }
      const next = { ...l, ...out, images };
      let status = l.status;
      if (req.body.status && ['active', 'draft', 'ended'].includes(req.body.status)) status = req.body.status;
      if (status === 'active' && next.quantity <= next.quantity_sold) status = 'sold_out';
      if (status === 'sold_out' && next.quantity > next.quantity_sold) status = 'active';
      const rows = await sql`
        UPDATE wype_mp_listings SET
          title = ${next.title}, description = ${next.description}, category = ${next.category}, condition = ${next.condition},
          brand = ${next.brand}, part_number = ${next.part_number}, fitment = ${next.fitment}, price = ${next.price},
          shipping_price = ${next.shipping_price}, ships_to = ${next.ships_to}, dispatch_days = ${next.dispatch_days},
          returns_accepted = ${next.returns_accepted}, quantity = ${next.quantity}, images = ${JSON.stringify(images)},
          status = ${status}, updated_at = NOW()
        WHERE id = ${l.id} RETURNING *`;
      res.json({ listing: publicListing(rows[0]) });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.delete('/api/mp/seller/listings/:id', sellerMiddleware, async (req, res) => {
    try {
      const rows = await sql`UPDATE wype_mp_listings SET status = 'removed', updated_at = NOW() WHERE id = ${req.params.id}::uuid AND seller_id = ${req.seller.id} RETURNING id`;
      if (!rows.length) return res.status(404).json({ error: 'Listing not found.' });
      res.json({ ok: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  /* ── Seller orders ── */
  function sellerOrderView(o) {
    return {
      id: o.id, orderNumber: o.order_number, status: o.status, createdAt: o.created_at,
      listingId: o.listing_id, title: o.listing_title, image: o.listing_image,
      buyer: { name: `${o.first_name || ''} ${o.last_name || ''}`.trim(), email: o.email, phone: o.phone,
               address1: o.address1, address2: o.address2, city: o.city, postcode: o.postcode, country: o.country, note: o.buyer_note },
      qty: o.qty, unitPrice: Number(o.unit_price), itemTotal: Number(o.item_total), shipping: Number(o.shipping), total: Number(o.total),
      commissionPct: Number(o.commission_pct), fee: Number(o.commission_amount), payout: Number(o.seller_payout),
      trackingNumber: o.tracking_number, carrier: o.carrier, dispatchedAt: o.dispatched_at, deliveredAt: o.delivered_at,
      payoutStatus: o.payout_status, paidOutAt: o.paid_out_at, transferId: o.stripe_transfer_id,
      buyerConfirmed: !!o.buyer_confirmed, buyerConfirmedAt: o.buyer_confirmed_at,
      payoutApprovedAt: o.payout_approved_at, payoutEligible: o.status === 'Delivered' && !!o.buyer_confirmed && o.payout_status === 'pending',
    };
  }

  app.get('/api/mp/seller/orders', sellerMiddleware, async (req, res) => {
    try {
      const rows = await sql`SELECT * FROM wype_mp_orders WHERE seller_id = ${req.seller.id} ORDER BY created_at DESC LIMIT 500`;
      res.json({ orders: rows.map(sellerOrderView) });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  /* Admin-approved release. Stripe transfer when the seller is onboarded, otherwise
     the order is marked paid_manual and the admin pays the bank details by hand. */
  async function releasePayout(order, seller, { approvedBy, reference, note } = {}) {
    if (order.payout_status !== 'pending') throw new Error('Payout already released for ' + order.order_number);
    if (!(order.status === 'Delivered' && order.buyer_confirmed)) throw new Error('Order must be delivered and confirmed by the buyer before payout.');
    const amount = Math.round(Number(order.seller_payout) * 100);
    if (amount <= 0) throw new Error('Nothing to pay out.');
    if (!seller.stripe_account_id || !seller.stripe_onboarded) {
      await sql`UPDATE wype_mp_orders SET payout_status = 'paid_manual', paid_out_at = NOW(), payout_approved_at = NOW(), payout_approved_by = ${approvedBy || 'admin'} WHERE id = ${order.id}`;
      await sql`INSERT INTO wype_mp_payouts (seller_id, amount, method, reference, note, order_ids) VALUES (${seller.id}, ${order.seller_payout}, 'manual', ${reference || null}, ${note || ('Manual payout for ' + order.order_number)}, ${JSON.stringify([order.id])})`;
      return { method: 'manual' };
    }
    const pi = await stripe.paymentIntents.retrieve(order.payment_intent_id);
    const transfer = await stripe.transfers.create({
      amount, currency: 'gbp', destination: seller.stripe_account_id,
      transfer_group: pi.transfer_group || undefined,
      source_transaction: pi.latest_charge || undefined,
      description: `Payout for ${order.order_number}`,
      metadata: { order_number: order.order_number, seller_id: seller.id },
    });
    await sql`UPDATE wype_mp_orders SET stripe_transfer_id = ${transfer.id}, payout_status = 'transferred', paid_out_at = NOW(), payout_approved_at = NOW(), payout_approved_by = ${approvedBy || 'admin'} WHERE id = ${order.id}`;
    await sql`INSERT INTO wype_mp_payouts (seller_id, amount, method, reference, note, order_ids) VALUES (${seller.id}, ${order.seller_payout}, 'stripe', ${transfer.id}, ${note || ('Stripe transfer for ' + order.order_number)}, ${JSON.stringify([order.id])})`;
    return { method: 'stripe', transfer };
  }

  app.post('/api/mp/seller/orders/:id/dispatch', sellerMiddleware, async (req, res) => {
    const { trackingNumber, carrier } = req.body || {};
    const tn = String(trackingNumber || '').trim();
    if (tn.length < 4) return res.status(400).json({ error: 'Enter a tracking number.' });
    try {
      const rows = await sql`
        UPDATE wype_mp_orders SET status = 'Dispatched', tracking_number = ${tn.slice(0, 80)}, carrier = ${String(carrier || 'Royal Mail').slice(0, 40)}, dispatched_at = NOW()
        WHERE id = ${req.params.id}::uuid AND seller_id = ${req.seller.id} AND status IN ('Paid', 'Dispatched') RETURNING *`;
      if (!rows.length) return res.status(404).json({ error: 'Order not found or cannot be dispatched.' });
      const order = rows[0];
      sendDispatchEmailMP(order, req.seller).catch(e => console.error('MP dispatch email error:', e.message));
      res.json({ ok: true, order: sellerOrderView(order) });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.post('/api/mp/seller/orders/:id/delivered', sellerMiddleware, async (req, res) => {
    try {
      const rows = await sql`UPDATE wype_mp_orders SET status = 'Delivered', delivered_at = NOW() WHERE id = ${req.params.id}::uuid AND seller_id = ${req.seller.id} AND status = 'Dispatched' RETURNING *`;
      if (!rows.length) return res.status(404).json({ error: 'Order not found or not dispatched yet.' });
      res.json({ ok: true, order: sellerOrderView(rows[0]) });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.get('/api/mp/seller/messages', sellerMiddleware, async (req, res) => {
    try {
      const rows = await sql`SELECT m.*, l.title FROM wype_mp_messages m LEFT JOIN wype_mp_listings l ON l.id = m.listing_id WHERE m.seller_id = ${req.seller.id} ORDER BY m.created_at DESC LIMIT 100`;
      res.json({ messages: rows.map(m => ({ id: m.id, listingId: m.listing_id, listingTitle: m.title, fromName: m.from_name, fromEmail: m.from_email, body: m.body, createdAt: m.created_at })) });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  /* ═════════════════ ADMIN ═════════════════ */
  app.get('/api/admin/mp/overview', adminMiddleware, async (req, res) => {
    try {
      const [r] = await sql`
        SELECT
          (SELECT COUNT(*) FROM wype_mp_sellers) AS sellers,
          (SELECT COUNT(*) FROM wype_mp_sellers WHERE stripe_onboarded) AS sellers_stripe,
          (SELECT COUNT(*) FROM wype_mp_listings WHERE status = 'active') AS active_listings,
          (SELECT COUNT(*) FROM wype_mp_orders WHERE status <> 'Refunded') AS orders,
          (SELECT COALESCE(SUM(total),0) FROM wype_mp_orders WHERE status <> 'Refunded') AS gmv,
          (SELECT COALESCE(SUM(commission_amount),0) FROM wype_mp_orders WHERE status <> 'Refunded') AS commission,
          (SELECT COALESCE(SUM(commission_amount),0) FROM wype_mp_orders WHERE status <> 'Refunded' AND created_at > NOW() - INTERVAL '30 days') AS commission_30d,
          (SELECT COALESCE(SUM(seller_payout),0) FROM wype_mp_orders WHERE status <> 'Refunded' AND payout_status = 'pending') AS payouts_owed,
          (SELECT COALESCE(SUM(seller_payout),0) FROM wype_mp_orders WHERE status <> 'Refunded' AND payout_status = 'pending' AND status = 'Delivered' AND buyer_confirmed) AS payouts_due,
          (SELECT COUNT(*) FROM wype_mp_orders WHERE status = 'Paid' AND created_at < NOW() - INTERVAL '3 days') AS late_dispatch`;
      res.json({
        sellers: Number(r.sellers), sellersStripe: Number(r.sellers_stripe), activeListings: Number(r.active_listings), orders: Number(r.orders),
        gmv: Number(r.gmv), commission: Number(r.commission), commission30d: Number(r.commission_30d),
        payoutsOwed: Number(r.payouts_owed), payoutsDue: Number(r.payouts_due), lateDispatch: Number(r.late_dispatch), commissionPct: COMMISSION_PCT,
      });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.get('/api/admin/mp/sellers', adminMiddleware, async (req, res) => {
    try {
      const rows = await sql`
        SELECT s.*, u.email AS user_email, u.first_name, u.last_name,
          (SELECT COUNT(*) FROM wype_mp_listings l WHERE l.seller_id = s.id AND l.status = 'active') AS active_listings,
          (SELECT COUNT(*) FROM wype_mp_orders o WHERE o.seller_id = s.id AND o.status <> 'Refunded') AS orders,
          (SELECT COALESCE(SUM(total),0) FROM wype_mp_orders o WHERE o.seller_id = s.id AND o.status <> 'Refunded') AS gmv,
          (SELECT COALESCE(SUM(commission_amount),0) FROM wype_mp_orders o WHERE o.seller_id = s.id AND o.status <> 'Refunded') AS commission,
          (SELECT COALESCE(SUM(seller_payout),0) FROM wype_mp_orders o WHERE o.seller_id = s.id AND o.status <> 'Refunded' AND o.payout_status = 'pending') AS owed,
          (SELECT COALESCE(SUM(seller_payout),0) FROM wype_mp_orders o WHERE o.seller_id = s.id AND o.status <> 'Refunded' AND o.payout_status = 'pending' AND o.status = 'Delivered' AND o.buyer_confirmed) AS due,
          (SELECT AVG(rating) FROM wype_mp_reviews r WHERE r.seller_id = s.id) AS rating
        FROM wype_mp_sellers s JOIN wype_users u ON u.id = s.user_id ORDER BY s.created_at DESC`;
      res.json({ sellers: rows.map(s => ({
        id: s.id, shopName: s.shop_name, slug: s.slug, status: s.status, location: s.location, createdAt: s.created_at,
        owner: `${s.first_name} ${s.last_name}`, email: s.user_email, contactEmail: s.contact_email, phone: s.phone,
        stripeAccountId: s.stripe_account_id, stripeOnboarded: !!s.stripe_onboarded, payoutMethod: s.payout_method, bankDetails: s.bank_details,
        activeListings: Number(s.active_listings), orders: Number(s.orders), gmv: Number(s.gmv), commission: Number(s.commission), owed: Number(s.owed), due: Number(s.due),
        rating: s.rating != null ? round2(s.rating) : null,
      })) });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.patch('/api/admin/mp/sellers/:id', adminMiddleware, async (req, res) => {
    const status = req.body?.status === 'suspended' ? 'suspended' : 'active';
    try {
      const rows = await sql`UPDATE wype_mp_sellers SET status = ${status}, updated_at = NOW() WHERE id = ${req.params.id}::uuid RETURNING id, status`;
      if (!rows.length) return res.status(404).json({ error: 'Seller not found.' });
      res.json({ ok: true, status: rows[0].status });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  /* Approve + release one order's payout (Stripe transfer or manual mark-paid) */
  app.post('/api/admin/mp/orders/:id/approve-payout', adminMiddleware, async (req, res) => {
    const { reference, note } = req.body || {};
    try {
      const rows = await sql`SELECT * FROM wype_mp_orders WHERE id = ${req.params.id}::uuid`;
      if (!rows.length) return res.status(404).json({ error: 'Order not found.' });
      const o = rows[0];
      if (o.status === 'Refunded') return res.status(409).json({ error: 'Order was refunded.' });
      const s = await sql`SELECT * FROM wype_mp_sellers WHERE id = ${o.seller_id}`;
      const result = await releasePayout(o, s[0], { approvedBy: req.admin?.email || 'admin', reference: String(reference || '').slice(0, 120) || null, note: String(note || '').slice(0, 300) || null });
      const u = await sql`SELECT email, first_name FROM wype_users WHERE id = ${s[0].user_id}`;
      sendEmail({
        from: internalFrom('Marketplace'), to: u[0].email, replyTo: BUSINESS_EMAIL,
        subject: `Payout approved: ${money(o.seller_payout)} for ${o.order_number}`,
        html: emailShell('Payout approved', `<p style="font-size:15px;color:#333">Hi ${esc(u[0].first_name)}, your payout of <strong>${money(o.seller_payout)}</strong> for order <strong>${o.order_number}</strong> (${esc(o.listing_title)}) has been approved and ${result.method === 'stripe' ? 'transferred to your Stripe account — it will land in your bank per your Stripe payout schedule.' : 'sent to your bank account.' + (reference ? ` Reference: <strong>${esc(reference)}</strong>.` : '')}</p>${btn(`${PUBLIC_SITE_URL}/seller-hub?view=payouts`, 'View payouts')}`),
      }).catch(() => {});
      const fresh = await sql`SELECT * FROM wype_mp_orders WHERE id = ${o.id}`;
      res.json({ ok: true, method: result.method, order: sellerOrderView(fresh[0]) });
    } catch (err) { res.status(400).json({ error: err.message }); }
  });

  /* Admin override: mark buyer-confirmed (e.g. buyer emailed instead of using the page) */
  app.post('/api/admin/mp/orders/:id/mark-delivered', adminMiddleware, async (req, res) => {
    try {
      const rows = await sql`UPDATE wype_mp_orders SET status = 'Delivered', delivered_at = COALESCE(delivered_at, NOW()), buyer_confirmed = TRUE, buyer_confirmed_at = COALESCE(buyer_confirmed_at, NOW())
                             WHERE id = ${req.params.id}::uuid AND status IN ('Dispatched','Delivered') RETURNING *`;
      if (!rows.length) return res.status(404).json({ error: 'Order not found or not dispatched yet.' });
      res.json({ ok: true, order: sellerOrderView(rows[0]) });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.get('/api/admin/mp/listings', adminMiddleware, async (req, res) => {
    try {
      const rows = await sql`SELECT l.*, s.shop_name, s.slug FROM wype_mp_listings l JOIN wype_mp_sellers s ON s.id = l.seller_id ORDER BY l.created_at DESC LIMIT 500`;
      res.json({ listings: rows.map(l => ({ ...publicListing({ ...l, images: (l.images || []).slice(0, 1) }), shopName: l.shop_name, sellerSlug: l.slug })) });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.patch('/api/admin/mp/listings/:id', adminMiddleware, async (req, res) => {
    const status = ['active', 'removed', 'ended'].includes(req.body?.status) ? req.body.status : 'removed';
    try {
      const rows = await sql`UPDATE wype_mp_listings SET status = ${status}, updated_at = NOW() WHERE id = ${req.params.id}::uuid RETURNING id, status`;
      if (!rows.length) return res.status(404).json({ error: 'Listing not found.' });
      res.json({ ok: true, status: rows[0].status });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.get('/api/admin/mp/orders', adminMiddleware, async (req, res) => {
    try {
      const rows = await sql`SELECT o.*, s.shop_name FROM wype_mp_orders o JOIN wype_mp_sellers s ON s.id = o.seller_id ORDER BY o.created_at DESC LIMIT 500`;
      res.json({ orders: rows.map(o => ({ ...sellerOrderView(o), sellerId: o.seller_id, shopName: o.shop_name, paymentIntentId: o.payment_intent_id, refundedAt: o.refunded_at })) });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.post('/api/admin/mp/orders/:id/refund', adminMiddleware, async (req, res) => {
    try {
      const rows = await sql`SELECT * FROM wype_mp_orders WHERE id = ${req.params.id}::uuid`;
      if (!rows.length) return res.status(404).json({ error: 'Order not found.' });
      const o = rows[0];
      if (o.status === 'Refunded') return res.status(409).json({ error: 'Already refunded.' });
      await stripe.refunds.create({ payment_intent: o.payment_intent_id, reason: 'requested_by_customer', metadata: { order_number: o.order_number } });
      if (o.stripe_transfer_id) {
        try { await stripe.transfers.createReversal(o.stripe_transfer_id, { description: 'Refund ' + o.order_number }); }
        catch (e) { console.error('MP transfer reversal failed:', e.message); }
      }
      await sql`UPDATE wype_mp_orders SET status = 'Refunded', refunded_at = NOW() WHERE id = ${o.id}`;
      await sql`UPDATE wype_mp_listings SET quantity_sold = GREATEST(0, quantity_sold - ${o.qty}), status = CASE WHEN status = 'sold_out' THEN 'active' ELSE status END WHERE id = ${o.listing_id}`;
      if (o.email) {
        sendEmail({ from: internalFrom('Marketplace'), to: o.email, replyTo: BUSINESS_EMAIL, subject: `Refund issued for order ${o.order_number}`,
          html: emailShell('Refund issued', `<p style="font-size:15px;color:#333">Your marketplace order <strong>${o.order_number}</strong> (${esc(o.listing_title)}) has been refunded in full — <strong>${money(o.total)}</strong>. It can take 5–10 working days to show on your statement.</p>`) }).catch(() => {});
      }
      res.json({ ok: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  /* ═════════════════ EMAILS ═════════════════ */
  function emailShell(heading, body, sub = 'Marketplace') {
    return `<!DOCTYPE html><html><head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#f5f5f5;font-family:Arial,Helvetica,sans-serif">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f5f5f5;padding:32px 0"><tr><td align="center">
<table width="580" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.08);max-width:94%">
  <tr><td style="background:#111;padding:26px 32px">
    <p style="margin:0;font-size:26px;font-weight:900;color:#fff;letter-spacing:2px">wype<span style="font-size:12px;vertical-align:super">®</span> <span style="font-weight:400;color:#E01E1E">${esc(sub)}</span></p>
    <p style="margin:6px 0 0;font-size:14px;color:rgba(255,255,255,0.7)">${esc(heading)}</p>
  </td></tr>
  <tr><td style="padding:30px 32px">${body}</td></tr>
  <tr><td style="padding:18px 32px;background:#fafafa;font-size:12px;color:#999;line-height:1.6">wype® Marketplace · justwypeit.com · Questions? <a href="mailto:${BUSINESS_EMAIL}" style="color:#666">${BUSINESS_EMAIL}</a></td></tr>
</table></td></tr></table></body></html>`;
  }
  function btn(href, label) {
    return `<p style="margin:22px 0 0"><a href="${href}" style="display:inline-block;background:#E01E1E;color:#fff;font-size:14px;font-weight:700;letter-spacing:.5px;padding:13px 28px;border-radius:8px;text-decoration:none">${esc(label)}</a></p>`;
  }
  function orderTable(o) {
    return `<table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #eee;border-radius:10px;overflow:hidden;font-size:14px">
      <tr><td style="padding:14px 16px;border-bottom:1px solid #eee" colspan="2">
        ${o.listing_image ? `<img src="${o.listing_image}" width="64" height="64" style="border-radius:8px;object-fit:cover;vertical-align:middle;margin-right:12px">` : ''}
        <strong>${esc(o.listing_title)}</strong> × ${o.qty}</td></tr>
      <tr><td style="padding:8px 16px;color:#666">Items</td><td style="padding:8px 16px;text-align:right">${money(o.item_total)}</td></tr>
      <tr><td style="padding:8px 16px;color:#666">Postage</td><td style="padding:8px 16px;text-align:right">${Number(o.shipping) ? money(o.shipping) : 'Free'}</td></tr>
      <tr><td style="padding:12px 16px;font-weight:700;background:#fafafa">Total paid</td><td style="padding:12px 16px;text-align:right;font-weight:700;background:#fafafa">${money(o.total)}</td></tr>
    </table>`;
  }

  async function sendSaleEmails(o, listing) {
    const sellerRows = await sql`SELECT s.*, u.email AS user_email, u.first_name FROM wype_mp_sellers s JOIN wype_users u ON u.id = s.user_id WHERE s.id = ${o.seller_id}`;
    const s = sellerRows[0];
    const addr = [o.address1, o.address2, o.city, o.postcode, o.country].filter(Boolean).join('<br>');
    const trackUrl = `${PUBLIC_SITE_URL}/marketplace/order?order=${encodeURIComponent(o.order_number)}&email=${encodeURIComponent(o.email || '')}`;
    const jobs = [];
    if (o.email) {
      jobs.push(sendEmail({
        from: internalFrom('Marketplace'), to: o.email, replyTo: BUSINESS_EMAIL,
        subject: `Order confirmed: ${o.order_number} — ${listing.title}`,
        html: emailShell(`Order ${o.order_number} confirmed`, `
          <p style="margin:0 0 16px;font-size:15px;color:#333">Thanks ${esc(o.first_name || '')}! Your order from <strong>${esc(s.shop_name)}</strong> is confirmed. They'll dispatch within ${listing.dispatch_days} working day${listing.dispatch_days === 1 ? '' : 's'} and you'll get tracking by email.</p>
          ${orderTable(o)}
          <p style="margin:18px 0 0;font-size:13px;color:#666"><strong>Delivering to</strong><br>${addr || 'Address on file'}</p>
          <p style="margin:14px 0 0;font-size:13px;color:#666">Payment was taken securely by wype®. If anything goes wrong with your order, reply to this email — you're covered by the wype® Marketplace guarantee.</p>
          ${btn(trackUrl, 'Track your order')}`),
      }));
    }
    jobs.push(sendEmail({
      from: internalFrom('Marketplace'), to: s.contact_email || s.user_email, replyTo: BUSINESS_EMAIL,
      subject: `🎉 You made a sale! ${o.order_number} — ${listing.title}`,
      html: emailShell('New order to dispatch', `
        <p style="margin:0 0 16px;font-size:15px;color:#333">Hi ${esc(s.first_name)}, <strong>${esc(o.first_name || 'a buyer')}</strong> just bought <strong>${o.qty}× ${esc(listing.title)}</strong>.</p>
        ${orderTable(o)}
        <table width="100%" cellpadding="0" cellspacing="0" style="margin-top:14px;font-size:14px">
          <tr><td style="padding:6px 0;color:#666">wype® fee (${Number(o.commission_pct)}%)</td><td style="text-align:right;color:#c0392b">− ${money(o.commission_amount)}</td></tr>
          <tr><td style="padding:6px 0;font-weight:700">Your payout</td><td style="text-align:right;font-weight:700;color:#1e8449">${money(o.seller_payout)}</td></tr>
        </table>
        <p style="margin:18px 0 0;font-size:13px;color:#333"><strong>Ship to</strong><br>${esc(o.first_name || '')} ${esc(o.last_name || '')}<br>${addr}${o.phone ? '<br>' + esc(o.phone) : ''}</p>
        ${o.buyer_note ? `<p style="margin:12px 0 0;font-size:13px;color:#666"><strong>Buyer note:</strong> ${esc(o.buyer_note)}</p>` : ''}
        <p style="margin:16px 0 0;font-size:13px;color:#666">Dispatch within ${listing.dispatch_days} working day${listing.dispatch_days === 1 ? '' : 's'} and upload the tracking number in your Seller Hub. Your payout is released by wype® once the parcel shows delivered and the buyer confirms they're happy.</p>
        ${btn(`${PUBLIC_SITE_URL}/seller-hub?view=orders`, 'Upload tracking')}`),
    }));
    jobs.push(sendEmail({
      from: internalFrom('Marketplace'), to: internalTo(),
      subject: `💰 Marketplace sale ${o.order_number}: ${money(o.total)} (fee ${money(o.commission_amount)})`,
      html: emailShell('Marketplace sale', `<p style="font-size:14px;color:#333"><strong>${esc(s.shop_name)}</strong> sold ${o.qty}× ${esc(listing.title)} to ${esc(o.email || 'unknown')} for ${money(o.total)}. Commission ${money(o.commission_amount)}. Seller payout ${money(o.seller_payout)} (${s.stripe_onboarded ? 'Stripe transfer on approval' : 'manual bank payout on approval'}) — approve in admin after delivery + buyer confirmation.</p>${btn(`${PUBLIC_SITE_URL}/admin`, 'Open admin')}`),
    }));
    await Promise.allSettled(jobs);
  }

  async function sendDispatchEmailMP(o, seller) {
    if (!o.email) return;
    const trackUrl = `${PUBLIC_SITE_URL}/marketplace/order?order=${encodeURIComponent(o.order_number)}&email=${encodeURIComponent(o.email)}`;
    const carrierLinks = {
      'Royal Mail': n => `https://www.royalmail.com/track-your-item#/tracking-results/${encodeURIComponent(n)}`,
      'Evri':       n => `https://www.evri.com/track/parcel/${encodeURIComponent(n)}`,
      'DPD':        n => `https://track.dpd.co.uk/search?reference=${encodeURIComponent(n)}`,
      'UPS':        n => `https://www.ups.com/track?tracknum=${encodeURIComponent(n)}`,
      'DHL':        n => `https://www.dhl.com/gb-en/home/tracking.html?tracking-id=${encodeURIComponent(n)}`,
      'Parcelforce':n => `https://www.parcelforce.com/track-trace?trackNumber=${encodeURIComponent(n)}`,
      'Yodel':      n => `https://www.yodel.co.uk/track/${encodeURIComponent(n)}`,
      'Amazon':     n => `https://track.amazon.co.uk/tracking/${encodeURIComponent(n)}`,
    };
    const link = (carrierLinks[o.carrier] || (() => trackUrl))(o.tracking_number);
    await sendEmail({
      from: internalFrom('Marketplace'), to: o.email, replyTo: BUSINESS_EMAIL,
      subject: `📦 Dispatched: ${o.order_number} — ${o.listing_title}`,
      html: emailShell('Your order is on its way', `
        <p style="margin:0 0 14px;font-size:15px;color:#333">Good news ${esc(o.first_name || '')} — <strong>${esc(seller.shop_name)}</strong> has dispatched your order.</p>
        <div style="background:#f7f7f7;border-radius:10px;padding:16px 18px;font-size:14px">
          <div style="color:#666;font-size:12px;text-transform:uppercase;letter-spacing:1px">${esc(o.carrier)} tracking</div>
          <div style="font-size:20px;font-weight:700;font-family:monospace;margin-top:4px">${esc(o.tracking_number)}</div>
        </div>
        ${btn(link, 'Track parcel')}
        <p style="margin:18px 0 0;font-size:13px;color:#666">Once it arrives, please confirm you've received it and leave ${esc(seller.shop_name)} a rating from your <a href="${trackUrl}" style="color:#E01E1E">order page</a> — the seller is only paid after you confirm.</p>`),
    });
  }

  return { finalizeMarketplaceOrder };
};
