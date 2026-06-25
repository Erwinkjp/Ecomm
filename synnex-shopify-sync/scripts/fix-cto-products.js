'use strict';
/**
 * fix-cto-products.js
 * One-time script: find all Shopify products whose vendor is still "APPLE CTO"
 * (or any vendor containing "CTO"), look them up in Icecat, then update:
 *   - vendor  → clean brand name (e.g. "Apple")
 *   - title   → Icecat product name if found, else strip "CTO" prefix/suffix
 *   - images  → attach Icecat images if found and product has none yet
 *
 * Usage:
 *   SHOPIFY_STORE=... SHOPIFY_ACCESS_TOKEN=... ICECAT_USERNAME=... \
 *     node scripts/fix-cto-products.js
 */

const https = require('https');

const STORE = process.env.SHOPIFY_STORE;
const TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;
const ICECAT_USER = process.env.ICECAT_USERNAME;

if (!STORE || !TOKEN) {
  console.error('SHOPIFY_STORE and SHOPIFY_ACCESS_TOKEN are required');
  process.exit(1);
}

// ── Brand normalisation (same map as transform.js) ─────────────────────────
const BRAND_MAP = {
  'apple cto': 'Apple', 'apple': 'Apple',
  'dell marketing l.p.': 'Dell', 'dell marketing lp': 'Dell', 'dell': 'Dell',
  'acer america corporation': 'Acer', 'acer america corp': 'Acer', 'acer': 'Acer',
  'logitech inc': 'Logitech', 'logitech': 'Logitech',
  'asus': 'ASUS', 'lenovo': 'Lenovo',
  'hp inc': 'HP', 'hp': 'HP',
  'microsoft corporation': 'Microsoft', 'microsoft': 'Microsoft',
};

function normalizeBrand(raw) {
  if (!raw) return raw;
  const key = raw.trim().toLowerCase();
  if (BRAND_MAP[key]) return BRAND_MAP[key];
  const stripped = key.replace(/[\s-]+cto$/i, '').trim();
  if (BRAND_MAP[stripped]) return BRAND_MAP[stripped];
  return raw.trim().replace(/\w\S*/g, w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase());
}

function cleanTitle(title) {
  if (!title) return title;
  return title
    .replace(/^CTO[\s-]+/i, '')
    .replace(/[\s-]+CTO\s*$/i, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

// Apple-specific title expansion for TD Synnex CTO product descriptions.
// These are custom-configured Apple products that Icecat won't have.
function expandAppleTitle(raw) {
  let t = raw
    .replace(/^CTO[\s-]+/i, '')           // strip leading CTO
    .replace(/[\s-]+SPLA\b/gi, '')         // strip Synnex locale suffix
    .replace(/\bW\/\s+SPANISH.*$/i, '')    // strip "W/ SPANISH (LATIN AMERICAN)"
    .replace(/\bSPANISH.*$/i, '')          // any remaining Spanish locale text
    .replace(/\(LATIN\s+AMERI[^\)]*\)/gi, '')
    .trim();

  // Product name expansions
  t = t
    .replace(/\bMBP\b/gi, 'MacBook Pro')
    .replace(/\bMBA\b/gi, 'MacBook Air')
    .replace(/\bIMAC\b/gi, 'iMac')
    .replace(/\bMAC\s+MINI\b/gi, 'Mac Mini')
    .replace(/\bMAC\s+PRO\b/gi, 'Mac Pro');

  // Colour expansions
  t = t
    .replace(/\bSLVR\b/gi, 'Silver')
    .replace(/\bSPACE\s+BLACK\b/gi, 'Space Black')
    .replace(/\bMIDNIGHT\b/gi, 'Midnight')
    .replace(/\bSTARLIGHT\b/gi, 'Starlight')
    .replace(/\bSPACE\s+GRY?\b/gi, 'Space Gray')
    .replace(/\bGLD\b/gi, 'Gold')
    .replace(/\bBLK\b/gi, 'Black');

  // Spec formatting — "18 CPU" or "18CPU" → "18-core CPU"
  t = t.replace(/(\d+)\s*CPU\b/gi, '$1-core CPU');
  t = t.replace(/(\d+)\s*GPU\b/gi, '$1-core GPU');
  // "10C" shorthand cores
  t = t.replace(/(\d+)C\b(?!\s*PU)/gi, '$1-core');

  // Screen size — add inch symbol
  t = t.replace(/(MacBook (?:Pro|Air))\s+(\d+(?:\.\d+)?)\b/gi, '$1 $2"');

  // Strip trailing wattage-only suffix like "40W" or "96W" (it's the charger, not useful in title)
  t = t.replace(/\s+\d+W\s*$/i, '');

  // Strip internal codes: TID (Touch ID), NK, TP, SL at end
  t = t.replace(/\b(TID|NK|TP|SL)\b/gi, '');

  // Strip locale suffixes: GERMAN, HEBREW, FRENCH, etc.
  t = t.replace(/\b(GERMAN|HEBREW|FRENCH|JAPANESE|KOREAN|ARABIC|CHINESE|ITALIAN|SPANISH|NORDIC)\b/gi, '');

  // Title-case colours left in uppercase: SILVER → Silver, BLACK → Black
  t = t.replace(/\b(SILVER|BLACK|GOLD|BLUE|PINK|PURPLE|RED|WHITE|GRAY|GREY)\b/g,
    w => w.charAt(0) + w.slice(1).toLowerCase());

  // Uppercase chip names stay uppercase: M5, MAX, PRO, M4 etc.
  // but "PRO" as chip tier should stay "Pro" for readability
  t = t.replace(/\b(MAX|PRO)\b/g, w => w.charAt(0) + w.slice(1).toLowerCase());

  t = t.replace(/\s{2,}/g, ' ').trim();

  return t;
}

// ── Shopify GraphQL ─────────────────────────────────────────────────────────
function gql(query, variables = {}) {
  return new Promise((res, rej) => {
    const body = JSON.stringify({ query, variables });
    const req = https.request({
      hostname: `${STORE}.myshopify.com`,
      path: '/admin/api/2024-10/graphql.json',
      method: 'POST',
      headers: {
        'X-Shopify-Access-Token': TOKEN,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    }, r => { let d = ''; r.on('data', c => d += c); r.on('end', () => res(JSON.parse(d))); });
    req.on('error', rej);
    req.write(body); req.end();
  });
}

// ── Icecat lookup ───────────────────────────────────────────────────────────
async function fetchIcecat(brand, partNumber) {
  if (!ICECAT_USER) return null;
  const qs = new URLSearchParams({ UserName: ICECAT_USER, lang: 'en', Brand: brand, ProductCode: partNumber });
  try {
    const resp = await fetch(`https://live.icecat.biz/api?${qs}`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(10_000),
    });
    if (!resp.ok) return null;
    const body = await resp.json();
    if (body?.StatusCode && body.StatusCode !== 1) return null;
    const data = body?.data;
    if (!data) return null;
    const title = (data.GeneralInfo?.Title || data.Title || '').trim() || null;
    const gallery = Array.isArray(data.Gallery) ? data.Gallery : [];
    const images = gallery.map(g => g.PicMax || g.Pic500x500 || g.Pic).filter(Boolean).slice(0, 10);
    return { title, images };
  } catch (_) { return null; }
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function getAllCtoProducts() {
  const products = [];
  let cursor = null;
  do {
    // Query Apple products — these are the ones with abbreviated titles (MBP, MBA, etc.)
    const d = await gql(`query($cursor: String) {
      products(first: 50, after: $cursor, query: "vendor:Apple") {
        pageInfo { hasNextPage endCursor }
        nodes {
          id
          title
          vendor
          totalInventory
          variants(first: 1) { nodes { id sku barcode } }
          media(first: 1) { nodes { id } }
        }
      }
    }`, { cursor });
    const page = d?.data?.products;
    if (!page) break;
    // Only include products whose titles still look like Synnex abbreviations
    const abbreviated = page.nodes.filter(p =>
      /\b(MBP|MBA|IMAC|SLVR|SPLA)\b/i.test(p.title)
    );
    products.push(...abbreviated);
    cursor = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
    if (cursor) await new Promise(r => setTimeout(r, 250));
  } while (cursor);
  return products;
}

async function updateProduct(id, patch) {
  const r = await gql(`mutation($input: ProductInput!) {
    productUpdate(input: $input) {
      product { id title vendor }
      userErrors { field message }
    }
  }`, { input: { id, ...patch } });
  const errs = r?.data?.productUpdate?.userErrors;
  if (errs?.length) throw new Error(errs.map(e => e.message).join('; '));
  return r?.data?.productUpdate?.product;
}

async function attachImages(productId, imageUrls, altText) {
  const media = imageUrls.map(url => ({
    mediaContentType: 'IMAGE',
    originalSource: url,
    alt: altText || '',
  }));
  const r = await gql(`mutation($productId: ID!, $media: [CreateMediaInput!]!) {
    productCreateMedia(productId: $productId, media: $media) {
      mediaUserErrors { message }
    }
  }`, { productId, media });
  const errs = r?.data?.productCreateMedia?.mediaUserErrors || [];
  if (errs.length) console.warn(`  [images] ${errs.map(e => e.message).join('; ')}`);
}

(async () => {
  console.log('\nScanning for CTO products in Shopify...');
  const products = await getAllCtoProducts();
  console.log(`Found ${products.length} products with "CTO" in vendor.\n`);

  let updated = 0, skipped = 0, errors = 0;

  for (const p of products) {
    const variant = p.variants?.nodes?.[0];
    const sku = variant?.sku;
    const mpn = variant?.barcode; // barcode holds the manufacturer part number
    const cleanVendor = normalizeBrand(p.vendor);
    const hasImages = (p.media?.nodes?.length || 0) > 0;

    process.stdout.write(`  ${p.title.slice(0, 60).padEnd(60)} → `);

    let icecatTitle = null;
    let icecatImages = [];

    if (ICECAT_USER && mpn) {
      const ic = await fetchIcecat(cleanVendor, mpn);
      if (ic) {
        icecatTitle = ic.title;
        icecatImages = ic.images;
      }
    }

    const isApple = cleanVendor === 'Apple';
    const newTitle = icecatTitle || (isApple ? expandAppleTitle(p.title) : cleanTitle(p.title));
    const patch = { vendor: cleanVendor };
    if (newTitle !== p.title) patch.title = newTitle;

    try {
      await updateProduct(p.id, patch);
      if (!hasImages && icecatImages.length > 0) {
        await attachImages(p.id, icecatImages, newTitle);
        console.log(`✓  "${newTitle}" + ${icecatImages.length} images`);
      } else {
        console.log(`✓  "${newTitle}"`);
      }
      updated++;
    } catch (e) {
      console.log(`✗  ${e.message}`);
      errors++;
    }

    await new Promise(r => setTimeout(r, 300));
  }

  console.log(`\nDone — ${updated} updated, ${skipped} skipped, ${errors} errors.`);
})().catch(e => { console.error(e); process.exit(1); });
