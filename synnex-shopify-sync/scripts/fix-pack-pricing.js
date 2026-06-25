#!/usr/bin/env node
'use strict';

/**
 * fix-pack-pricing.js
 *
 * Scans ALL Shopify products for suspiciously low prices caused by pack-quantity
 * pricing errors (TD Synnex sends per-unit price for bulk-pack items).
 *
 * Detection rules:
 *   - price < $2.00 (absolute floor — nothing we sell should be this cheap)
 *   - price < compareAtPrice × 0.15 (more than 85% off MSRP)
 *
 * Exclusions (legitimate cheap products):
 *   - Short cables / patch cords / couplers (Cat5/Cat6, RJ45, modular)
 *   - Wall plates / faceplates / keystones
 *   - Cable ties / velcro / labels
 *
 * Actions (pass --action=<action>):
 *   report   (default) — scan and save report to pack-pricing-report.json, no changes
 *   draft    — set affected products to draft (hidden from storefront)
 *   tag      — add tag "bulk-only" + "registered-business" so a B2B collection rule
 *              can surface them only to approved customers
 *
 * Usage:
 *   node scripts/fix-pack-pricing.js                   # report only
 *   node scripts/fix-pack-pricing.js --action=draft    # hide from storefront
 *   node scripts/fix-pack-pricing.js --action=tag      # tag for B2B collection
 */

const https = require('https');
const fs    = require('fs');
const path  = require('path');

const STORE = process.env.SHOPIFY_STORE;
const TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;

if (!STORE || !TOKEN) {
  console.error('Missing SHOPIFY_STORE or SHOPIFY_ACCESS_TOKEN. Run: source .env && node scripts/fix-pack-pricing.js');
  process.exit(1);
}

const ACTION = (process.argv.find(a => a.startsWith('--action=')) || '--action=report').split('=')[1];
const VALID_ACTIONS = ['report', 'draft', 'tag'];
if (!VALID_ACTIONS.includes(ACTION)) {
  console.error(`Unknown action "${ACTION}". Use: report | draft | tag`);
  process.exit(1);
}

// Products whose titles match these patterns are legitimately cheap — skip them
const CHEAP_PRODUCT_PATTERNS = [
  /\bcat\s*[56]\b/i,           // Cat5/Cat6 cables
  /patch\s*cab/i,              // patch cables
  /\bRJ.?(11|45)\b/i,          // RJ45/RJ11 connectors
  /modular.*coupl/i,           // modular couplers
  /\binline\s+coupl/i,
  /wall\s*plate/i,             // wall plates
  /faceplate/i,                // faceplates
  /keystone/i,                 // keystone jacks
  /cable\s*tie/i,              // cable ties
  /velcro/i,
  /\blabel\b/i,
  /telephone.*cab/i,
  /phone\s*cab/i,
];

function isLegitimatelyCheap(title) {
  return CHEAP_PRODUCT_PATTERNS.some(re => re.test(title));
}

// ── Shopify GraphQL ────────────────────────────────────────────────────────────

async function gql(query, variables = {}, retries = 5) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await gqlOnce(query, variables);
    } catch (e) {
      const retryable = e.code === 'ENOTFOUND' || e.code === 'ETIMEDOUT' || e.code === 'ECONNRESET' || e.code === 'ECONNREFUSED';
      if (!retryable || attempt === retries) throw e;
      const wait = Math.min(1000 * Math.pow(2, attempt), 30000);
      process.stderr.write(`\n  [retry ${attempt}/${retries}] ${e.code} — waiting ${wait/1000}s...\n`);
      await new Promise(r => setTimeout(r, wait));
    }
  }
}

function gqlOnce(query, variables = {}) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ query, variables });
    const req = https.request({
      hostname: `${STORE}.myshopify.com`,
      path: '/admin/api/2026-01/graphql.json',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': TOKEN,
        'Content-Length': Buffer.byteLength(body),
      },
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve(JSON.parse(d)); }
        catch (e) { reject(new Error(`JSON parse error: ${d.slice(0, 200)}`)); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Scan ──────────────────────────────────────────────────────────────────────

async function scanAll() {
  const LIST = `
    query($cursor: String) {
      products(first: 250, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id title productType status tags
          variants(first: 1) {
            nodes { id price compareAtPrice sku }
          }
        }
      }
    }
  `;

  const flagged = [];
  let cursor = null;
  let scanned = 0;
  let page = 0;

  process.stdout.write('Scanning');

  do {
    const data = await gql(LIST, cursor ? { cursor } : {});
    const products = data?.data?.products;
    if (!products) {
      console.error('\nUnexpected response:', JSON.stringify(data).slice(0, 300));
      break;
    }

    for (const p of products.nodes) {
      scanned++;
      const v = p.variants?.nodes?.[0];
      if (!v) continue;

      const price      = parseFloat(v.price || '0');
      const compareAt  = parseFloat(v.compareAtPrice || '0');

      if (price <= 0) continue;
      if (isLegitimatelyCheap(p.title)) continue;

      if (p.status === 'DRAFT') continue; // already hidden, skip

      const tooFarBelowMsrp = compareAt > 0 && price < compareAt * 0.15;
      const absolutelyTooLow = price < 2.00;

      if (tooFarBelowMsrp || absolutelyTooLow) {
        flagged.push({
          id:           p.id,
          variantId:    v.id,
          title:        p.title,
          productType:  p.productType,
          status:       p.status,
          tags:         p.tags,
          sku:          v.sku,
          price,
          compareAtPrice: compareAt || null,
          reason: absolutelyTooLow
            ? `price $${price.toFixed(2)} < $2.00 floor`
            : `price $${price.toFixed(2)} is ${Math.round(price/compareAt*100)}% of MSRP $${compareAt.toFixed(2)}`,
        });
      }
    }

    cursor = products.pageInfo.hasNextPage ? products.pageInfo.endCursor : null;
    page++;
    if (page % 20 === 0) process.stdout.write(` ${scanned.toLocaleString()}`);

    // Respect Shopify rate limits
    await sleep(150);
  } while (cursor);

  console.log(`\nDone. Scanned ${scanned.toLocaleString()} products, found ${flagged.length} affected.`);
  return { scanned, flagged };
}

// ── Fix: Draft ─────────────────────────────────────────────────────────────────

async function draftProducts(flagged) {
  const DRAFT = `
    mutation($input: ProductInput!) {
      productUpdate(input: $input) {
        product { id status }
        userErrors { message }
      }
    }
  `;

  let fixed = 0, errors = 0;
  const alreadyDraft = flagged.filter(p => p.status === 'DRAFT').length;
  const toFix = flagged.filter(p => p.status !== 'DRAFT');

  console.log(`\nDrafting ${toFix.length} products (${alreadyDraft} already draft)...`);

  for (let i = 0; i < toFix.length; i++) {
    const p = toFix[i];
    try {
      const res = await gql(DRAFT, { input: { id: p.id, status: 'DRAFT' } });
      const errs = res?.data?.productUpdate?.userErrors || [];
      if (errs.length) { errors++; console.error(`  ERR ${p.title}: ${errs.map(e => e.message).join('; ')}`); }
      else fixed++;
    } catch (e) { errors++; console.error(`  ERR ${p.title}: ${e.message}`); }

    if ((i + 1) % 50 === 0) {
      process.stdout.write(`  ${i+1}/${toFix.length} processed\n`);
      await sleep(500);
    } else {
      await sleep(120);
    }
  }
  console.log(`Drafted: ${fixed}  Errors: ${errors}`);
}

// ── Fix: Tag for B2B ──────────────────────────────────────────────────────────

async function tagProducts(flagged) {
  const UPDATE = `
    mutation($input: ProductInput!) {
      productUpdate(input: $input) {
        product { id tags }
        userErrors { message }
      }
    }
  `;

  const B2B_TAGS = ['bulk-only', 'registered-business'];
  let fixed = 0, errors = 0;

  console.log(`\nTagging ${flagged.length} products with: ${B2B_TAGS.join(', ')}...`);

  for (let i = 0; i < flagged.length; i++) {
    const p = flagged[i];
    const newTags = [...new Set([...p.tags, ...B2B_TAGS])];
    try {
      const res = await gql(UPDATE, { input: { id: p.id, tags: newTags } });
      const errs = res?.data?.productUpdate?.userErrors || [];
      if (errs.length) { errors++; console.error(`  ERR ${p.title}: ${errs.map(e => e.message).join('; ')}`); }
      else fixed++;
    } catch (e) { errors++; console.error(`  ERR ${p.title}: ${e.message}`); }

    if ((i + 1) % 50 === 0) {
      process.stdout.write(`  ${i+1}/${flagged.length} processed\n`);
      await sleep(500);
    } else {
      await sleep(120);
    }
  }
  console.log(`Tagged: ${fixed}  Errors: ${errors}`);
}

// ── Report ────────────────────────────────────────────────────────────────────

function saveReport(scanned, flagged) {
  // Group by root cause
  const byType = {};
  for (const p of flagged) {
    const t = p.productType || 'Unknown';
    if (!byType[t]) byType[t] = [];
    byType[t].push(p);
  }

  const summary = Object.entries(byType)
    .sort((a, b) => b[1].length - a[1].length)
    .map(([type, items]) => ({ productType: type, count: items.length }));

  const report = {
    generatedAt: new Date().toISOString(),
    scanned,
    totalFlagged: flagged.length,
    byProductType: summary,
    products: flagged.sort((a, b) => a.price - b.price),
  };

  const outPath = path.join(__dirname, 'pack-pricing-report.json');
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
  console.log(`\nReport saved to: ${outPath}`);

  // Console summary
  console.log('\n── By Product Type ──────────────────────────────');
  summary.slice(0, 20).forEach(r => console.log(`  ${String(r.count).padStart(4)}  ${r.productType}`));

  console.log('\n── Sample Affected Products ─────────────────────');
  flagged.slice(0, 20).forEach(p =>
    console.log(`  $${p.price.toFixed(2).padStart(6)}  ${p.title.slice(0, 65)}`)
  );
  if (flagged.length > 20) console.log(`  ... and ${flagged.length - 20} more (see pack-pricing-report.json)`);
}

// ── Main ──────────────────────────────────────────────────────────────────────

(async () => {
  console.log(`Action: ${ACTION.toUpperCase()}  |  Store: ${STORE}\n`);

  const reportPath = path.join(__dirname, 'pack-pricing-report.json');
  let scanned, flagged;

  if (ACTION !== 'report' && fs.existsSync(reportPath)) {
    // Re-use the saved report — no need to re-scan 710k products
    const saved = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
    scanned = saved.scanned;
    flagged = saved.products;
    console.log(`Loaded existing report: ${flagged.length} affected products (scanned ${scanned.toLocaleString()})`);
    console.log(`Report generated: ${saved.generatedAt}\n`);
  } else {
    ({ scanned, flagged } = await scanAll());
    saveReport(scanned, flagged);
  }

  if (flagged.length === 0) {
    console.log('\nNo affected products found.');
    return;
  }

  if (ACTION === 'draft') {
    await draftProducts(flagged);
  } else if (ACTION === 'tag') {
    await tagProducts(flagged);
  } else {
    console.log('\nRun with --action=draft to hide all from storefront,');
    console.log('or --action=tag to mark as bulk-only for B2B access.');
  }
})().catch(e => { console.error(e); process.exit(1); });
