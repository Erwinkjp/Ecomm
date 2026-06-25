'use strict';

/**
 * bulk-publish.js
 * Publishes all Shopify products to the Online Store channel.
 * Run once to fix products created with publishedAt: null.
 *
 * Usage: node scripts/bulk-publish.js
 */

const https = require('https');

const STORE   = process.env.SHOPIFY_STORE;
const TOKEN   = process.env.SHOPIFY_ACCESS_TOKEN;
const CONCURRENCY = 4;   // parallel publish requests
const PAGE_SIZE   = 250; // products per GET page

if (!STORE || !TOKEN) {
  console.error('Set SHOPIFY_STORE and SHOPIFY_ACCESS_TOKEN env vars');
  process.exit(1);
}

function request(method, path, body) {
  return new Promise((res, rej) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = https.request({
      hostname: `${STORE}.myshopify.com`,
      path,
      method,
      headers: {
        'X-Shopify-Access-Token': TOKEN,
        'Content-Type': 'application/json',
        ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
      },
    }, r => {
      let d = '';
      r.on('data', c => d += c);
      r.on('end', () => res({ status: r.statusCode, headers: r.headers, body: JSON.parse(d) }));
    });
    req.on('error', rej);
    if (payload) req.write(payload);
    req.end();
  });
}

async function publishProduct(id, retries = 3) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    const r = await request('PUT', `/admin/api/2024-10/products/${id}.json`, {
      product: { id, published: true },
    });
    if (r.status === 200) return true;
    if (r.status === 429) {
      const wait = parseInt(r.headers['retry-after'] || '2', 10) * 1000;
      await new Promise(res => setTimeout(res, wait));
      continue;
    }
    console.warn(`  ⚠ Product ${id} returned ${r.status}`);
    return false;
  }
  return false;
}

async function getAllProductIds() {
  const ids = [];
  let url = `/admin/api/2024-10/products.json?limit=${PAGE_SIZE}&fields=id,published_at&published_status=unpublished`;

  while (url) {
    const r = await request('GET', url);
    const products = r.body.products || [];
    ids.push(...products.map(p => p.id));
    process.stdout.write(`\r  Fetching IDs... ${ids.length} unpublished found`);

    // Follow Link header pagination
    const link = r.headers.link || '';
    const next = link.match(/<([^>]+)>;\s*rel="next"/);
    if (next) {
      // Extract just the path+query from the full URL
      url = new URL(next[1]).pathname + new URL(next[1]).search;
    } else {
      url = null;
    }

    // Small pause between pages to be kind to the API
    if (url) await new Promise(res => setTimeout(res, 300));
  }
  console.log(); // newline after progress
  return ids;
}

async function runPool(ids) {
  let done = 0;
  let ok = 0;

  async function worker(chunk) {
    for (const id of chunk) {
      const success = await publishProduct(id);
      done++;
      if (success) ok++;
      process.stdout.write(`\r  Publishing... ${done}/${ids.length} (${ok} published, ${done-ok} errors)`);
    }
  }

  const chunkSize = Math.ceil(ids.length / CONCURRENCY);
  const chunks = Array.from({ length: CONCURRENCY }, (_, i) =>
    ids.slice(i * chunkSize, (i + 1) * chunkSize)
  );

  await Promise.all(chunks.map(worker));
  console.log(); // newline
  return ok;
}

(async () => {
  console.log(`\nBulk-publishing products on ${STORE}.myshopify.com\n`);

  console.log('Step 1: Fetching all unpublished product IDs...');
  const ids = await getAllProductIds();
  console.log(`  Found ${ids.length} unpublished products.\n`);

  if (ids.length === 0) {
    console.log('Nothing to publish. All products are already live.');
    return;
  }

  console.log(`Step 2: Publishing ${ids.length} products (${CONCURRENCY} concurrent)...`);
  const started = Date.now();
  const published = await runPool(ids);
  const elapsed = ((Date.now() - started) / 1000).toFixed(0);

  console.log(`\nDone in ${elapsed}s — ${published}/${ids.length} products published to Online Store.`);
})();
