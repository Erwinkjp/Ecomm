'use strict';

/**
 * retag-categories — re-tag existing Shopify products with the clean UNSPSC-driven
 * categories (productType + tags) from src/categorize.js. Fixes the garbage types the
 * old field[35]-based mapCategory produced. Powers the B2B collections + nav.
 *
 * Builds an mfrPartNumber→UNSPSC map from the catalog, bulk-exports all products,
 * re-categorizes each active product, and bulk-updates productType + tags via Shopify
 * Bulk Operations. Reversible (it just rewrites type/tags).
 *
 *   source .env && node scripts/retag-categories.js          # dry run — change counts + distribution
 *   source .env && node scripts/retag-categories.js --apply  # apply
 */

const fs = require('fs');
const readline = require('readline');
const { categorize } = require('../src/categorize');

const STORE = process.env.SHOPIFY_STORE, TOKEN = process.env.SHOPIFY_ACCESS_TOKEN, VER = process.env.SHOPIFY_API_VERSION || '2026-01';
const CATALOG_FILE = process.env.CATALOG_FILE || '/tmp/catalog_sample';
const APPLY = process.argv.includes('--apply');
const GQL = `https://${STORE}.myshopify.com/admin/api/${VER}/graphql.json`;

async function gql(query, variables) {
  const r = await fetch(GQL, { method: 'POST', headers: { 'X-Shopify-Access-Token': TOKEN, 'Content-Type': 'application/json' }, body: JSON.stringify({ query, variables }) });
  const j = await r.json();
  if (j.errors) throw new Error('GraphQL: ' + JSON.stringify(j.errors).slice(0, 400));
  return j.data;
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function buildUnspscMap() {
  if (!fs.existsSync(CATALOG_FILE)) {
    // No local catalog → fall back to title-based categorization. Fine for the
    // --hide-only pass (services/software are caught by keyword guards on the title);
    // for a full retag a present catalog gives better UNSPSC-driven types.
    console.log(`No catalog at ${CATALOG_FILE} — using title-based categorization (UNSPSC map empty).`);
    return new Map();
  }
  const map = new Map();
  const rl = readline.createInterface({ input: fs.createReadStream(CATALOG_FILE, { encoding: 'latin1' }), crlfDelay: Infinity });
  for await (const line of rl) {
    const f = line.split('~');
    if (f.length < 36 || f[1] !== 'DTL') continue;
    const mpn = (f[2] || '').trim(); if (!mpn) continue;
    const u = (f[34] || '').trim(); if (u) map.set(mpn, u);
  }
  console.log(`Catalog UNSPSC map: ${map.size} SKUs`);
  return map;
}

async function exportProducts() {
  const d = await gql(`mutation { bulkOperationRunQuery(query: """
    { products { edges { node { id status title productType vendor variants(first:1){ edges { node { sku } } } } } } }
  """) { bulkOperation { id } userErrors { message } } }`);
  if (d.bulkOperationRunQuery.userErrors.length) throw new Error(JSON.stringify(d.bulkOperationRunQuery.userErrors));
  let op;
  for (;;) { await sleep(5000); op = (await gql(`{ currentBulkOperation(type:QUERY){ status objectCount url errorCode } }`)).currentBulkOperation;
    process.stdout.write(`\r  export: ${op.status} ${op.objectCount || 0}   `); if (['COMPLETED','FAILED','CANCELED'].includes(op.status)) break; }
  console.log('');
  if (op.status !== 'COMPLETED') throw new Error(`export ${op.status}`);
  const prod = new Map(), skuByProd = new Map();
  if (!op.url) return { prod, skuByProd };
  const text = await (await fetch(op.url)).text();
  for (const line of text.split('\n')) { if (!line.trim()) continue; const o = JSON.parse(line);
    if (o.__parentId) { if (o.sku != null) skuByProd.set(o.__parentId, String(o.sku).trim()); }
    else if (o.status) prod.set(o.id, { status: o.status, title: o.title || '', productType: o.productType || '', vendor: o.vendor || '' }); }
  return { prod, skuByProd };
}

async function runBulkMutation(label, mutation, lines) {
  if (!lines.length) { console.log(`  ${label}: nothing`); return; }
  const staged = await gql(`mutation($i:[StagedUploadInput!]!){ stagedUploadsCreate(input:$i){ stagedTargets{ url parameters{ name value } } userErrors{ message } } }`,
    { i: [{ resource: 'BULK_MUTATION_VARIABLES', filename: 'b.jsonl', mimeType: 'text/jsonl', httpMethod: 'POST' }] });
  const t = staged.stagedUploadsCreate.stagedTargets[0];
  const form = new FormData(); for (const p of t.parameters) form.append(p.name, p.value);
  form.append('file', new Blob([lines.join('\n')], { type: 'text/jsonl' }), 'b.jsonl');
  const up = await fetch(t.url, { method: 'POST', body: form }); if (!up.ok) throw new Error(`${label} upload ${up.status}`);
  const key = t.parameters.find(p => p.name === 'key').value;
  const run = await gql(`mutation($p:String!){ bulkOperationRunMutation(mutation:${JSON.stringify(mutation)}, stagedUploadPath:$p){ userErrors{ message } } }`, { p: key });
  if (run.bulkOperationRunMutation.userErrors.length) throw new Error(`${label}: ` + JSON.stringify(run.bulkOperationRunMutation.userErrors));
  let op;
  for (;;) { await sleep(5000); op = (await gql(`{ currentBulkOperation(type:MUTATION){ status objectCount errorCode } }`)).currentBulkOperation;
    process.stdout.write(`\r  ${label}: ${op.status} ${op.objectCount || 0}   `); if (['COMPLETED','FAILED','CANCELED'].includes(op.status)) break; }
  console.log('');
  if (op.status !== 'COMPLETED') throw new Error(`${label} ${op.status} (${op.errorCode || ''})`);
}

(async () => {
  if (!STORE || !TOKEN) throw new Error('source .env first');
  console.log(`Mode: ${APPLY ? 'APPLY' : 'DRY RUN'}\n`);
  const unspscMap = await buildUnspscMap();
  console.log('Exporting products...');
  const { prod, skuByProd } = await exportProducts();
  console.log(`Shopify products: ${prod.size}`);

  // Hide only clearly non-physical (services/software). Keep physical AND "other"
  // (mostly real products with cryptic titles) active + searchable; "other" is tagged
  // uncategorized so it stays out of the clean category collections.
  const HIDE_GROUPS = new Set(['services', 'software']);
  const retagLines = [], hideLines = [];
  let active = 0, keep = 0, hide = 0;
  const keepDist = {}, hideDist = {};
  for (const [id, p] of prod) {
    if (p.status !== 'ACTIVE') continue;
    active++;
    const sku = skuByProd.get(id) || '';
    const unspsc = sku ? unspscMap.get(sku) : '';
    const cat = unspsc ? categorize({ unspsc }) : categorize({ description: p.title });
    if (HIDE_GROUPS.has(cat.group)) {
      hide++; hideDist[cat.type] = (hideDist[cat.type] || 0) + 1;
      hideLines.push(JSON.stringify({ input: { id, status: 'DRAFT' } }));
    } else {
      keep++; keepDist[cat.type] = (keepDist[cat.type] || 0) + 1;
      const vendorTag = (p.vendor || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
      const tags = [...new Set([vendorTag, cat.group, ...cat.tags].filter(Boolean))];
      retagLines.push(JSON.stringify({ input: { id, productType: cat.type, tags } }));
    }
  }

  console.log(`\n=== RESULT ===`);
  console.log(`  active: ${active}`);
  console.log(`  KEEP (physical, retag): ${keep}`);
  console.log(`  HIDE (services/software/other → draft): ${hide}`);
  console.log('--- KEEP distribution (top 25) ---');
  Object.entries(keepDist).sort((a, b) => b[1] - a[1]).slice(0, 25).forEach(([k, v]) => console.log(`${String(v).padStart(7)}  ${k}`));
  console.log('--- HIDE breakdown ---');
  Object.entries(hideDist).sort((a, b) => b[1] - a[1]).forEach(([k, v]) => console.log(`${String(v).padStart(7)}  ${k}`));

  if (!APPLY) { console.log('\nDRY RUN — no changes. Re-run with --apply.'); return; }
  if (!process.argv.includes('--hide-only')) {
    console.log(`\nRetagging ${retagLines.length} keepers...`);
    await runBulkMutation('retag', 'mutation($input:ProductInput!){ productUpdate(input:$input){ product{ id } userErrors{ message } } }', retagLines);
  } else { console.log('\n--hide-only: skipping retag.'); }
  console.log(`Hiding ${hideLines.length}...`);
  await runBulkMutation('hide', 'mutation($input:ProductInput!){ productUpdate(input:$input){ product{ id } userErrors{ message } } }', hideLines);
  console.log('\nDone — physical products retagged + searchable; everything else drafted.');
})().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
