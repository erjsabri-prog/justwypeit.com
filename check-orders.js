#!/usr/bin/env node
require('dotenv').config({ path: '.env.local' });
require('dotenv').config();
const { neon } = require('@neondatabase/serverless');
const sql = neon(process.env.DATABASE_URL);

async function main() {
  const orders = await sql`
    SELECT order_number, first_name, last_name, email, items, subtotal, delivery, total,
           discount_code, discount_amount, created_at
    FROM wype_orders
    ORDER BY created_at DESC
    LIMIT 10
  `;
  orders.forEach(o => {
    console.log(`\n#${o.order_number} — ${o.first_name} ${o.last_name} <${o.email}>`);
    console.log(`  Total: £${o.total}  Subtotal: £${o.subtotal}  Delivery: £${o.delivery}`);
    console.log(`  Discount: ${o.discount_code || 'none'} / £${o.discount_amount || '0'}`);
    const items = Array.isArray(o.items) ? o.items : JSON.parse(o.items || '[]');
    items.forEach(i => console.log(`  • ${i}`));
    console.log(`  Date: ${o.created_at}`);
  });
}
main().catch(err => { console.error(err); process.exit(1); });
