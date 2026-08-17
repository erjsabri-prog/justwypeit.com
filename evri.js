/* ──────────────────────────────────────────────────────────────
   Evri parcel tracking — uses Evri's public tracking API (the same
   endpoint evri.com's track page calls). No account/login required.

   This is an UNOFFICIAL endpoint with a public embedded apiKey baked
   into Evri's own tracking site. It can change/rotate without notice,
   so both the key and base host are env-overridable:

     EVRI_API_KEY     overrides the embedded public key (optional)
     EVRI_API_HOST    overrides host (default api.hermesworld.co.uk)

   Flow (per Evri's own site):
     1) GET /enterprise-tracking-api/v1/parcels/search/{trackingNumber}
        → array of unique parcel IDs
     2) GET /enterprise-tracking-api/v1/parcels/?uniqueIds={id}&postcode={pc}
        → tracking body containing trackingStageCode
     Delivered when trackingStageCode is 5_COURIER (delivered) or
     5_SHOP (collected from ParcelShop).
   ────────────────────────────────────────────────────────────── */

const API_HOST = process.env.EVRI_API_HOST || 'https://api.hermesworld.co.uk';
const API_KEY  = process.env.EVRI_API_KEY  || 'RGVplG9He66OnnAjnGKz7Ovol9dKbSAr';
const HEADERS  = { apiKey: API_KEY, Accept: 'application/json' };

const DELIVERED_CODES = ['5_COURIER', '5_SHOP'];

function isConfigured() {
  return !!API_KEY; // public key shipped by default, so effectively always on
}

/* Recursively collect every trackingStageCode value found in the payload. */
function collectStageCodes(node, out) {
  if (!node || typeof node !== 'object') return out;
  if (Array.isArray(node)) {
    for (const item of node) collectStageCodes(item, out);
    return out;
  }
  for (const [k, v] of Object.entries(node)) {
    if (k === 'trackingStageCode' && v != null) out.push(String(v));
    else if (v && typeof v === 'object') collectStageCodes(v, out);
  }
  return out;
}

function isDelivered(payload) {
  const codes = collectStageCodes(payload, []);
  if (codes.some(c => DELIVERED_CODES.includes(c))) return true;
  // Fallback: payload literally contains a "delivered" status string
  try { return JSON.stringify(payload).toLowerCase().includes('"delivered"'); }
  catch { return false; }
}

/* Returns { delivered, stageCodes, raw }. Throws on transport error. */
async function getTrackingStatus(trackingNumber, postcode) {
  if (!trackingNumber) throw new Error('Evri: tracking number required.');

  const searchUrl = `${API_HOST}/enterprise-tracking-api/v1/parcels/search/${encodeURIComponent(trackingNumber)}`;
  const sRes = await fetch(searchUrl, { headers: HEADERS });
  if (sRes.status === 404) return { delivered: false, notFound: true, raw: null };
  if (!sRes.ok) throw new Error(`Evri search failed ${sRes.status}: ${await sRes.text()}`);
  const ids = await sRes.json();
  const uniqueId = Array.isArray(ids) ? ids[0] : (ids && (ids.uniqueId || ids.results?.[0]));
  if (!uniqueId) return { delivered: false, notFound: true, raw: ids };

  const pc = String(postcode || '').replace(/\s+/g, '');
  const infoUrl = `${API_HOST}/enterprise-tracking-api/v1/parcels/?uniqueIds=${encodeURIComponent(uniqueId)}&postcode=${encodeURIComponent(pc)}`;
  const iRes = await fetch(infoUrl, { headers: HEADERS });
  if (!iRes.ok) throw new Error(`Evri tracking failed ${iRes.status}: ${await iRes.text()}`);
  const raw = await iRes.json();
  const stageCodes = collectStageCodes(raw, []);
  return { delivered: isDelivered(raw), stageCodes, raw };
}

module.exports = { isConfigured, getTrackingStatus, isDelivered, DELIVERED_CODES };
