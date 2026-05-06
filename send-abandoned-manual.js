require('dotenv').config({ path: '.env.local' });
require('dotenv').config();

const apiKey = process.env.RESEND_API_KEY;
if (!apiKey) throw new Error('RESEND_API_KEY not set');

const base = 'https://justwypeit.com/assets';
const site = 'https://justwypeit.com';

const recipients = [
  { name: 'Tyler Kehres', email: 'tck.13579hi.no@gmail.com', total: '£43.24' },
  { name: 'Ad Joha', email: 'adjoha26@gmail.com', total: '£28.80' },
  { name: 'Nathan Croon', email: 'nathanswerk@gmail.com', total: '£26.85' },
];

function buildHtml(name, total) {
  const firstName = name.split(' ')[0];
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1.0">
  <title>Still thinking it over?</title>
</head>
<body style="margin:0;padding:0;background:#f2f2f2;font-family:Arial,sans-serif;color:#1a1a1a">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f2f2f2;padding:40px 0">
<tr><td align="center">
<table width="600" cellpadding="0" cellspacing="0" style="background:#ffffff;max-width:600px;width:100%;overflow:hidden;box-shadow:0 4px 32px rgba(0,0,0,0.1)">

  <tr>
    <td style="background:#0d0d0d;padding:22px 36px;text-align:center">
      <img src="${base}/logo.png" width="140" alt="wype" style="width:140px;height:auto;display:inline-block;border:0">
    </td>
  </tr>

  <tr>
    <td background="${base}/nano-porsche-bonnet.jpg"
        style="background-image:url('${base}/nano-porsche-bonnet.jpg');background-size:cover;background-position:center 80%;padding:0">
      <table width="100%" cellpadding="0" cellspacing="0">
        <tr><td style="height:250px"></td></tr>
        <tr>
          <td style="background:linear-gradient(to bottom,rgba(0,0,0,0) 0%,rgba(0,0,0,0.78) 100%);padding:28px 36px 36px">
            <p style="margin:0 0 8px;font-size:11px;font-weight:700;letter-spacing:4px;text-transform:uppercase;color:rgba(255,255,255,0.75)">DON'T MISS IT</p>
            <h1 style="margin:0;font-size:40px;font-weight:900;color:#ffffff;line-height:1.08;font-family:Arial,sans-serif;text-transform:uppercase;letter-spacing:-0.5px">YOUR BASKET<br>IS STILL WAITING</h1>
          </td>
        </tr>
      </table>
    </td>
  </tr>

  <tr>
    <td style="padding:32px 48px 26px;text-align:center">
      <p style="margin:0 0 14px;font-size:30px;font-weight:900;color:#111111;font-family:Arial,sans-serif;line-height:1.1">Hey ${firstName},</p>
      <p style="margin:0 auto 18px;font-size:16px;color:#555555;line-height:1.8;max-width:470px">
        You left something behind worth <strong style="color:#111">${total}</strong>. To give you a reason to come back, we've unlocked a discount code just for you.
      </p>
      <div style="display:inline-block;background:#0d0d0d;color:#CC0000;font-size:28px;font-weight:900;letter-spacing:5px;padding:16px 30px;border-radius:8px;font-family:Arial,sans-serif;margin:6px 0 16px">
        TRSDE911C63
      </div>
      <p style="margin:0 auto;font-size:15px;color:#777777;line-height:1.7;max-width:420px">
        This is normally our friends &amp; family code, but because we're in pre-orders we're giving it to our first 100 customers. Use it tonight for <strong style="color:#111">20% off</strong> your order.
      </p>
    </td>
  </tr>

  <tr><td style="padding:0 48px"><div style="height:3px;background:#CC0000;border-radius:2px"></div></td></tr>

  <tr>
    <td style="padding:28px 48px 8px">
      <table width="100%" cellpadding="0" cellspacing="0" style="background:#fafafa;border-radius:10px;border:1px solid #eeeeee">
        <tr>
          <td style="padding:24px 24px 26px;text-align:center">
            <p style="margin:0 0 8px;font-size:11px;font-weight:700;letter-spacing:3px;text-transform:uppercase;color:#CC0000">Why buy now?</p>
            <p style="margin:0 auto 18px;font-size:15px;color:#444444;line-height:1.8;max-width:420px">
              Premium microfibre, paint-safe contact, and fast tracked delivery. The code expires tonight, so if you want to lock in the offer, now is the time.
            </p>
            <a href="${site}/checkout.html?discount=TRSDE911C63" style="display:inline-block;background:#CC0000;color:#ffffff;font-size:14px;font-weight:700;padding:14px 30px;border-radius:8px;text-decoration:none;letter-spacing:1px;text-transform:uppercase">Return to Checkout</a>
          </td>
        </tr>
      </table>
    </td>
  </tr>

  <tr>
    <td style="padding:20px 48px 36px">
      <table width="100%" cellpadding="0" cellspacing="0" style="background:#f7f7f7;border-radius:10px;border:1px solid #eeeeee">
        <tr>
          <td style="padding:20px 24px">
            <p style="margin:0 0 6px;font-size:13px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;color:#888888">Need help?</p>
            <p style="margin:0 0 12px;font-size:15px;color:#444444;line-height:1.7">Reply to this email or message us directly if you want help choosing the right cloth before you order.</p>
            <a href="mailto:customer@justwypeit.com" style="display:inline-block;background:#1a1a1a;color:#ffffff;font-size:14px;font-weight:700;padding:12px 24px;border-radius:8px;text-decoration:none;letter-spacing:0.3px">&#9993;&nbsp; customer@justwypeit.com</a>
          </td>
        </tr>
      </table>
    </td>
  </tr>

  <tr>
    <td style="background:#0d0d0d;padding:20px 36px;text-align:center">
      <p style="margin:0;font-size:11px;color:#666666;letter-spacing:1px">
        <a href="${site}" style="color:#CC0000;text-decoration:none">justwypeit.com</a>
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

async function sendEmail(to, name, total) {
  const body = {
    from: '"wype®" <customer@justwypeit.com>',
    to: [to],
    bcc: ['customer@justwypeit.com'],
    subject: `${name.split(' ')[0]}, your basket is still waiting · Use code TRSDE911C63 tonight`,
    html: buildHtml(name, total),
  };

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  const text = await res.text();
  if (!res.ok) throw new Error(`${to}: ${res.status} ${text}`);
  console.log(`sent ${to}: ${text}`);
}

(async () => {
  for (const recipient of recipients) {
    await sendEmail(recipient.email, recipient.name, recipient.total);
  }
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
