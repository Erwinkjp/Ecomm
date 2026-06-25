'use strict';

/**
 * Live shipping rate calculator — FedEx + UPS APIs.
 *
 * At checkout Shopify calls /shipping-rates with the cart contents and
 * destination. We query FedEx and UPS in parallel using the TD Synnex
 * warehouse nearest to the customer as the shipment origin, then return
 * all available services ranked by price.
 *
 * Falls back to the hardcoded zone/weight table if both APIs fail or
 * credentials are not configured.
 *
 * Required env vars:
 *   FEDEX_CLIENT_ID, FEDEX_CLIENT_SECRET   — from developer.fedex.com
 *   UPS_CLIENT_ID, UPS_CLIENT_SECRET       — from developer.ups.com
 *
 * TD Synnex warehouse origin ZIPs:
 *   Fremont CA    94538  — West
 *   Fort Worth TX 76117  — Southwest
 *   Romeoville IL 60446  — Midwest
 *   Southaven MS  38671  — South
 *   Swedesboro NJ 08085  — Northeast
 */

const https = require('https');
const zlib = require('zlib');

// ── Warehouse origin ZIPs by destination state ────────────────────────────────

const STATE_ORIGIN_ZIP = {
  CA: '94538', OR: '94538', WA: '94538', NV: '94538', AK: '94538', HI: '94538',
  AZ: '94538', UT: '94538', ID: '94538', MT: '94538', WY: '94538', CO: '94538', NM: '94538',
  TX: '76117', OK: '76117', AR: '76117', LA: '76117',
  IL: '60446', IN: '60446', OH: '60446', MI: '60446', WI: '60446',
  MN: '60446', IA: '60446', MO: '60446', KS: '60446', NE: '60446',
  SD: '60446', ND: '60446',
  MS: '38671', AL: '38671', TN: '38671', KY: '38671',
  GA: '38671', FL: '38671', SC: '38671', NC: '38671',
  NJ: '08085', NY: '08085', PA: '08085', CT: '08085', DE: '08085',
  MD: '08085', DC: '08085', VA: '08085', MA: '08085', RI: '08085',
  WV: '08085', VT: '08085', NH: '08085', ME: '08085',
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function httpsPost(hostname, path, headers, body) {
  return new Promise((resolve, reject) => {
    const payload = typeof body === 'string' ? body : JSON.stringify(body);
    const req = https.request({
      hostname, path, method: 'POST',
      headers: { 'Content-Length': Buffer.byteLength(payload), ...headers },
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        let buf = Buffer.concat(chunks);
        // FedEx gzips responses regardless of Accept-Encoding; decompress before parsing.
        const enc = (res.headers['content-encoding'] || '').toLowerCase();
        try {
          if (enc === 'gzip') buf = zlib.gunzipSync(buf);
          else if (enc === 'deflate') buf = zlib.inflateSync(buf);
          else if (enc === 'br') buf = zlib.brotliDecompressSync(buf);
        } catch (_) { /* fall through to parse attempt */ }
        const text = buf.toString('utf8');
        try { resolve(JSON.parse(text)); } catch (e) { reject(new Error(text.slice(0, 300))); }
      });
    });
    req.on('error', reject);
    req.setTimeout(8000, () => { req.destroy(); reject(new Error('timeout')); });
    req.write(payload);
    req.end();
  });
}

function estimateDimensions(weightLbs) {
  if (weightLbs <= 0.5) return { length: 6,  width: 4,  height: 2  };
  if (weightLbs <= 2)   return { length: 10, width: 8,  height: 4  };
  if (weightLbs <= 5)   return { length: 12, width: 10, height: 6  };
  if (weightLbs <= 15)  return { length: 16, width: 12, height: 8  };
  if (weightLbs <= 40)  return { length: 20, width: 16, height: 12 };
  return                       { length: 24, width: 20, height: 16 };
}

function addBusinessDays(days) {
  const d = new Date();
  let added = 0;
  while (added < days) {
    d.setDate(d.getDate() + 1);
    if (d.getDay() !== 0 && d.getDay() !== 6) added++;
  }
  return d.toISOString().split('T')[0];
}

function centsStr(dollars) {
  return String(Math.round(dollars * 100));
}

// Freight buffer — our FedEx/UPS quote can come in below TD Synnex's actual freight
// bill (different negotiated rates / dim-weight), so pad the quoted rate to avoid
// undercharging at checkout. Percentage covers heavier shipments; flat adds handling.
// Tunable via SHIPPING_FREIGHT_BUFFER_PCT (default 12%) and SHIPPING_HANDLING_FEE ($).
function applyFreightBuffer(price) {
  const pct  = parseFloat(process.env.SHIPPING_FREIGHT_BUFFER_PCT || '12') || 0;
  const flat = parseFloat(process.env.SHIPPING_HANDLING_FEE || '0') || 0;
  return Math.round((price * (1 + pct / 100) + flat) * 100) / 100;
}

// ── FedEx API ─────────────────────────────────────────────────────────────────

let fedexTokenCache = null;

async function getFedExToken() {
  const { FEDEX_CLIENT_ID: clientId, FEDEX_CLIENT_SECRET: clientSecret } = process.env;
  if (!clientId || !clientSecret) return null;
  if (fedexTokenCache && fedexTokenCache.expiresAt > Date.now()) return fedexTokenCache.token;

  const body = `grant_type=client_credentials&client_id=${encodeURIComponent(clientId)}&client_secret=${encodeURIComponent(clientSecret)}`;
  const data = await httpsPost('apis.fedex.com', '/oauth/token',
    { 'Content-Type': 'application/x-www-form-urlencoded' }, body);

  if (!data.access_token) throw new Error(`FedEx auth failed: ${JSON.stringify(data)}`);
  fedexTokenCache = { token: data.access_token, expiresAt: Date.now() + (data.expires_in - 60) * 1000 };
  return fedexTokenCache.token;
}

async function fetchFedExRates(fromZip, toZip, weightLbs, dims) {
  const token = await getFedExToken();
  if (!token) return [];

  // FedEx rate API accepts only LB or KG (NOT OZ — that returns 422 invalid-enum).
  const lb = Math.max(0.1, Math.round(weightLbs * 10) / 10);
  const d = dims || estimateDimensions(weightLbs);

  const payload = {
    accountNumber: { value: process.env.FEDEX_ACCOUNT_NUMBER || '' },
    requestedShipment: {
      shipper:    { address: { postalCode: fromZip, countryCode: 'US' } },
      recipient:  { address: { postalCode: toZip,   countryCode: 'US', residential: true } },
      pickupType: 'DROPOFF_AT_FEDEX_LOCATION',
      // ACCOUNT = our negotiated rates. Requesting LIST too returns 422 on this account
      // (no published-rate access), which killed the whole FedEx response.
      rateRequestType: ['ACCOUNT'],
      requestedPackageLineItems: [{
        weight:     { units: 'LB', value: lb },
        dimensions: { length: d.length, width: d.width, height: d.height, units: 'IN' },
      }],
    },
  };

  const data = await httpsPost('apis.fedex.com', '/rate/v1/rates/quotes',
    // Accept-Encoding: identity — FedEx gzips large rate responses and our httpsPost
    // doesn't decompress, which made successful responses unparseable.
    { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}`, 'X-locale': 'en_US', 'Accept-Encoding': 'identity' },
    payload);

  const details = data?.output?.rateReplyDetails || [];
  const results = [];

  const SERVICE_MAP = {
    FEDEX_GROUND:           { name: 'FedEx Ground',    code: 'FEDX_GRD' },
    GROUND_HOME_DELIVERY:   { name: 'FedEx Ground',    code: 'FEDX_GRD' },
    FEDEX_2_DAY:            { name: 'FedEx 2Day',      code: 'FEDX_2DA' },
    FEDEX_2_DAY_AM:         { name: 'FedEx 2Day AM',   code: 'FEDX_2DA' },
    STANDARD_OVERNIGHT:     { name: 'FedEx Overnight', code: 'FEDX_1DA' },
    PRIORITY_OVERNIGHT:     { name: 'FedEx Overnight', code: 'FEDX_1DA' },
    FIRST_OVERNIGHT:        { name: 'FedEx Overnight', code: 'FEDX_1DA' },
  };

  const seen = new Set();
  for (const detail of details) {
    const svc = SERVICE_MAP[detail.serviceType];
    if (!svc || seen.has(svc.code)) continue;
    const ratedShipment = detail.ratedShipmentDetails?.find(r => r.rateType === 'ACCOUNT') ||
                          detail.ratedShipmentDetails?.[0];
    const total = parseFloat(ratedShipment?.totalNetFedExCharge || ratedShipment?.totalNetCharge || 0);
    if (!total) continue;
    const transit = parseInt(detail.commit?.dateDetail?.dayFormat) || null;
    results.push({ ...svc, price: total, transit });
    seen.add(svc.code);
  }
  return results;
}

// ── UPS API ───────────────────────────────────────────────────────────────────

let upsTokenCache = null;

async function getUPSToken() {
  const { UPS_CLIENT_ID: clientId, UPS_CLIENT_SECRET: clientSecret } = process.env;
  if (!clientId || !clientSecret) return null;
  if (upsTokenCache && upsTokenCache.expiresAt > Date.now()) return upsTokenCache.token;

  const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  const body = 'grant_type=client_credentials';
  const data = await httpsPost('onlinetools.ups.com', '/security/v1/oauth/token',
    { 'Content-Type': 'application/x-www-form-urlencoded', 'Authorization': `Basic ${credentials}` }, body);

  if (!data.access_token) throw new Error(`UPS auth failed: ${JSON.stringify(data)}`);
  upsTokenCache = { token: data.access_token, expiresAt: Date.now() + (data.expires_in - 60) * 1000 };
  return upsTokenCache.token;
}

async function fetchUPSRates(fromZip, toZip, weightLbs, dims) {
  const token = await getUPSToken();
  if (!token) return [];

  const d = dims || estimateDimensions(weightLbs);
  const weightOz = Math.max(0.1, weightLbs).toFixed(1);

  const payload = {
    RateRequest: {
      Request: { RequestOption: 'Shop' },
      Shipment: {
        Shipper:    { Address: { PostalCode: fromZip, CountryCode: 'US' } },
        ShipTo:     { Address: { PostalCode: toZip,   CountryCode: 'US' } },
        ShipFrom:   { Address: { PostalCode: fromZip, CountryCode: 'US' } },
        Package: {
          PackagingType: { Code: '02' },
          Dimensions: {
            UnitOfMeasurement: { Code: 'IN' },
            Length: String(d.length), Width: String(d.width), Height: String(d.height),
          },
          PackageWeight: {
            UnitOfMeasurement: { Code: 'LBS' },
            Weight: weightOz,
          },
        },
      },
    },
  };

  const data = await httpsPost('onlinetools.ups.com', '/api/rating/v2205/Shop',
    { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}`, 'transId': Date.now().toString(), 'transactionSrc': 'UniwideMerchandise' },
    payload);

  // UPS returns RatedShipment as an array (multiple services) OR a single object.
  const raw = data?.RateResponse?.RatedShipment;
  const rated = Array.isArray(raw) ? raw : (raw ? [raw] : []);
  if (rated.length === 0) {
    // Surface why UPS returned nothing (error response, alerts, etc.) instead of silently dropping it.
    console.warn('[shipping] UPS no rates:', JSON.stringify(data?.response?.errors || data?.RateResponse?.Response?.ResponseStatus || data).slice(0, 400));
    return [];
  }

  const SERVICE_MAP = {
    '03': { name: 'UPS Ground',       code: 'UPS_GRD' },
    '02': { name: 'UPS 2nd Day Air',  code: 'UPS_2DA' },
    '01': { name: 'UPS Next Day Air', code: 'UPS_1DA' },
    '13': { name: 'UPS Next Day Air Saver', code: 'UPS_1DA' },
    '59': { name: 'UPS 2nd Day Air AM', code: 'UPS_2DA' },
  };

  const seen = new Set();
  const results = [];
  for (const r of rated) {
    const code = r.Service?.Code;
    const svc = SERVICE_MAP[code];
    if (!svc || seen.has(svc.code)) continue;
    const price = parseFloat(r.TotalCharges?.MonetaryValue || 0);
    if (!price) continue;
    const days = parseInt(r.GuaranteedDelivery?.BusinessDaysInTransit || r.TimeInTransit?.PickupDayCount || 0) || null;
    results.push({ ...svc, price, transit: days });
    seen.add(svc.code);
  }
  return results;
}

// ── Fallback hardcoded table ──────────────────────────────────────────────────

const STATE_ZONE = {
  CA: 1, OR: 1, WA: 1, NV: 1, AK: 2, HI: 3,
  AZ: 2, UT: 2, ID: 2, MT: 2, WY: 2, CO: 2, NM: 2,
  TX: 1, OK: 2, AR: 2, LA: 2,
  IL: 1, IN: 1, OH: 1, MI: 1, WI: 1, MN: 1, IA: 1, MO: 1,
  KS: 2, NE: 2, SD: 2, ND: 2,
  MS: 1, AL: 1, TN: 1, KY: 1, GA: 2, FL: 2, SC: 2, NC: 2,
  NJ: 1, NY: 1, PA: 1, CT: 1, DE: 1, MD: 1, DC: 1, VA: 1,
  MA: 2, RI: 2, WV: 2, VT: 2, NH: 2, ME: 2,
};

const GROUND_RATE_TABLE = [
  { maxLbs: 1,   rates: [8.99,  10.99, 14.99] },
  { maxLbs: 2,   rates: [9.49,  11.99, 15.99] },
  { maxLbs: 3,   rates: [9.99,  12.99, 16.99] },
  { maxLbs: 5,   rates: [10.99, 14.49, 18.99] },
  { maxLbs: 10,  rates: [13.49, 17.99, 22.99] },
  { maxLbs: 20,  rates: [17.49, 22.99, 28.99] },
  { maxLbs: 40,  rates: [24.99, 31.99, 39.99] },
  { maxLbs: 70,  rates: [34.99, 44.99, 54.99] },
  { maxLbs: 150, rates: [49.99, 63.99, 79.99] },
];

function fallbackRates(weightLbs, zone) {
  const col = Math.min(zone, 3) - 1;
  const tier = GROUND_RATE_TABLE.find(r => weightLbs <= r.maxLbs) || GROUND_RATE_TABLE[GROUND_RATE_TABLE.length - 1];
  const ground = tier.rates[col];
  const [tMin, tMax] = { 1: [2,4], 2: [3,5], 3: [5,7] }[zone] || [3,6];
  return [
    { name: 'FedEx Ground',    code: 'FEDX_GRD', price: ground,                             transitMin: tMin, transitMax: tMax },
    { name: 'FedEx 2Day',      code: 'FEDX_2DA', price: Math.round(ground * 2.8 * 100)/100, transitMin: 2,    transitMax: 2    },
    { name: 'FedEx Overnight', code: 'FEDX_1DA', price: Math.round(ground * 5.2 * 100)/100, transitMin: 1,    transitMax: 1    },
  ];
}

// ── Main: calculateRates ──────────────────────────────────────────────────────

async function calculateRates(rateRequest) {
  const { destination, items } = rateRequest?.rate || {};
  if (!destination || !items?.length) return [];

  const destState = (destination.province || destination.province_code || '').toUpperCase().trim();
  // Shopify's carrier-service request uses `postal_code`; keep `zip` as a fallback.
  const toZip     = (destination.postal_code || destination.zip || '').replace(/\s/g, '');

  const totalGrams = items.reduce((sum, item) =>
    sum + (Number(item.grams) || 500) * (Number(item.quantity) || 1), 0);
  const weightLbs = Math.max(0.5, totalGrams / 453.592);
  const dims      = estimateDimensions(weightLbs);
  const fromZip   = STATE_ORIGIN_ZIP[destState] || '60446';

  // Query FedEx and UPS in parallel
  const [fedexRates, upsRates] = await Promise.all([
    fetchFedExRates(fromZip, toZip, weightLbs, dims).catch(e => {
      console.warn('[shipping] FedEx error:', e.message); return [];
    }),
    fetchUPSRates(fromZip, toZip, weightLbs, dims).catch(e => {
      console.warn('[shipping] UPS error:', e.message); return [];
    }),
  ]);

  const allRates = [...fedexRates, ...upsRates];

  if (allRates.length === 0) {
    // Both APIs failed or unconfigured — use fallback table
    const zone = STATE_ZONE[destState] || 2;
    return fallbackRates(weightLbs, zone).map(r => ({
      service_name: r.name,
      service_code: r.code,
      total_price:  centsStr(applyFreightBuffer(r.price)),
      description:  'Ships from nearest TD Synnex warehouse',
      currency:     'USD',
      min_delivery_date: addBusinessDays(r.transitMin),
      max_delivery_date: addBusinessDays(r.transitMax),
    }));
  }

  // Sort by price, deduplicate by service code
  allRates.sort((a, b) => a.price - b.price);
  const seen = new Set();
  return allRates
    .filter(r => { if (seen.has(r.code)) return false; seen.add(r.code); return true; })
    .map(r => ({
      service_name: r.name,
      service_code: r.code,
      total_price:  centsStr(applyFreightBuffer(r.price)),
      description:  'Ships from nearest TD Synnex warehouse',
      currency:     'USD',
      min_delivery_date: addBusinessDays(r.transit || 3),
      max_delivery_date: addBusinessDays(r.transit ? r.transit + 1 : 5),
    }));
}

// ── resolveShipMethod ─────────────────────────────────────────────────────────

const SERVICE_CODE_MAP = {
  FEDX_GRD: 'FEDX_GRD',
  FEDX_2DA: 'FEDX_2DA',
  FEDX_1DA: 'FEDX_1DA',
  UPS_GRD:  'UPS_GRD',
  UPS_2DA:  'UPS_2DA',
  UPS_1DA:  'UPS_1DA',
};

function resolveShipMethod(shippingLines) {
  if (!Array.isArray(shippingLines) || shippingLines.length === 0) return 'FEDX_GRD';
  const code = shippingLines[0]?.code || '';
  return SERVICE_CODE_MAP[code] || 'FEDX_GRD';
}

module.exports = { calculateRates, resolveShipMethod };
