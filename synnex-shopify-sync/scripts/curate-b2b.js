'use strict';

/**
 * curate-b2b — make the storefront a clean B2B-forward IT store WITHOUT losing
 * consumer products. Three actions, driven by the catalog's UNSPSC codes:
 *
 *   CUT (→ DRAFT):    active products that are software licenses (UNSPSC 4323) or
 *                     services/warranties (8111). Non-shippable non-products. Drafted
 *                     (reversible, kept in system — warranties get reused later as
 *                     checkout add-ons).
 *   RESTORE (→ACTIVE):archived B2B hardware (UNSPSC 4320/4321/4322/3912/4617, in stock,
 *                     cost>=MIN_COST, no accessory noise) — currently hidden, bring back.
 *   KEEP (no change): everything else physical & active — laptops, accessories,
 *                     electronics, peripherals — stays buyable by anyone.
 *
 * Uses Shopify Bulk Operations (one bulk query to export all products; bulk mutations
 * to draft cuts and re-activate restores). Drafting/activating are reversible.
 *
 *   source .env && node scripts/curate-b2b.js            # dry run — counts only
 *   source .env && node scripts/curate-b2b.js --apply    # draft cuts + restore B2B
 *
 * CATALOG_FILE defaults to /tmp/catalog_sample (the .ap pulled from the S3 cache).
 */

const fs = require('fs');
const readline = require('readline');

const STORE = process.env.SHOPIFY_STORE;
const TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;
const VER = process.env.SHOPIFY_API_VERSION || '2026-01';
const CATALOG_FILE = process.env.CATALOG_FILE || '/tmp/catalog_sample';
const MIN_COST = Number(process.env.CURATE_MIN_COST || 20);
const APPLY = process.argv.includes('--apply');

const CUT_FAMILIES = new Set(['4323', '8111']);                       // software, services/warranties
const KEEP_FAMILIES = new Set(['4320', '4321', '4322', '3912', '4617']); // B2B hardware
const NOISE = /mouse ?pad|cable tie|coupler|cleaning cartridge|\bscrew\b|\blabel\b|wrist rest|cable manage|velcro|filler panel|blank panel|\bdust\b|grommet|cable clip/i;
const GQL = `https://${STORE}.myshopify.com/admin/api/${VER}/graphql.json`;

async function gql(query, variables) {
  const r = await fetch(GQL, { method: 'POST', headers: { 'X-Shopify-Access-Token': TOKEN, 'Content-Type': 'application/json' }, body: JSON.stringify({ query, variables }) });
  const j = await r.json();
  if (j.errors) throw new Error('GraphQL: ' + JSON.stringify(j.errors).slice(0, 400));
  return j.data;
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Build two SKU sets from the catalog: things to CUT, and B2B hardware to KEEP/RESTORE.
async function buildCatalogSets() {
  if (!fs.existsSync(CATALOG_FILE)) throw new Error(`Catalog not found at ${CATALOG_FILE} — pull the latest .ap from S3 first.`);
  const cut = new Set(), keep = new Set();
  let dtl = 0;
  const rl = readline.createInterface({ input: fs.createReadStream(CATALOG_FILE, { encoding: 'latin1' }), crlfDelay: Infinity });
  for await (const line of rl) {
    const f = line.split('~');
    if (f.length < 36 || f[1] !== 'DTL') continue;
    dtl++;
    const mpn = (f[2] || '').trim(); if (!mpn) continue;
    const fam = (f[34] || '').trim().slice(0, 4);
    if (CUT_FAMILIES.has(fam)) { cut.add(mpn); continue; }
    // B2B keep rule
    if (!KEEP_FAMILIES.has(fam)) continue;
    if ((parseFloat(f[9]) || 0) <= 0) continue;
    if ((parseFloat(f[12]) || 0) < MIN_COST) continue;
    if (NOISE.test(f[6] || '')) continue;
    keep.add(mpn);
  }
  console.log(`Catalog DTL rows: ${dtl} | cut-SKUs (software/services): ${cut.size} | B2B keep-SKUs: ${keep.size}`);
  return { cut, keep };
}

async function exportProducts() {
  const data = await gql(`mutation { bulkOperationRunQuery(query: """
      { products { edges { node { id status variants(first:1){ edges { node { sku } } } } } } }
    """) { bulkOperation { id status } userErrors { message } } }`);
  if (data.bulkOperationRunQuery.userErrors.length) throw new Error('bulk query: ' + JSON.stringify(data.bulkOperationRunQuery.userErrors));
  let op;
  for (;;) {
    await sleep(5000);
    op = (await gql(`{ currentBulkOperation(type: QUERY){ status objectCount url errorCode } }`)).currentBulkOperation;
    process.stdout.write(`\r  export: ${op.status} objects=${op.objectCount || 0}   `);
    if (['COMPLETED', 'FAILED', 'CANCELED'].includes(op.status)) break;
  }
  console.log('');
  if (op.status !== 'COMPLETED') throw new Error(`export ${op.status} (${op.errorCode || ''})`);
  const products = new Map(), skuByProduct = new Map();
  if (!op.url) return { products, skuByProduct };
  const text = await (await fetch(op.url)).text();
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    const o = JSON.parse(line);
    if (o.__parentId) { if (o.sku != null) skuByProduct.set(o.__parentId, String(o.sku).trim()); }
    else if (o.status) products.set(o.id, o.status);
  }
  return { products, skuByProduct };
}

async function runBulkMutation(label, mutation, lines) {
  if (lines.length === 0) { console.log(`  ${label}: nothing to do`); return; }
  const staged = await gql(`mutation($input:[StagedUploadInput!]!){ stagedUploadsCreate(input:$input){ stagedTargets{ url parameters{ name value } } userErrors{ message } } }`,
    { input: [{ resource: 'BULK_MUTATION_VARIABLES', filename: 'bulk.jsonl', mimeType: 'text/jsonl', httpMethod: 'POST' }] });
  const target = staged.stagedUploadsCreate.stagedTargets[0];
  const form = new FormData();
  for (const p of target.parameters) form.append(p.name, p.value);
  form.append('file', new Blob([lines.join('\n')], { type: 'text/jsonl' }), 'bulk.jsonl');
  const up = await fetch(target.url, { method: 'POST', body: form });
  if (!up.ok) throw new Error(`${label} upload HTTP ${up.status}`);
  const key = target.parameters.find(p => p.name === 'key').value;
  const run = await gql(`mutation($path:String!){ bulkOperationRunMutation(mutation:${JSON.stringify(mutation)}, stagedUploadPath:$path){ bulkOperation{ id } userErrors{ message } } }`, { path: key });
  if (run.bulkOperationRunMutation.userErrors.length) throw new Error(`${label}: ` + JSON.stringify(run.bulkOperationRunMutation.userErrors));
  let op;
  for (;;) {
    await sleep(5000);
    op = (await gql(`{ currentBulkOperation(type: MUTATION){ status objectCount errorCode } }`)).currentBulkOperation;
    process.stdout.write(`\r  ${label}: ${op.status} done=${op.objectCount || 0}   `);
    if (['COMPLETED', 'FAILED', 'CANCELED'].includes(op.status)) break;
  }
  console.log('');
  if (op.status !== 'COMPLETED') throw new Error(`${label} ${op.status} (${op.errorCode || ''})`);
}

(async () => {
  if (!STORE || !TOKEN) throw new Error('SHOPIFY_STORE / SHOPIFY_ACCESS_TOKEN not set — source .env');
  console.log(`Mode: ${APPLY ? 'APPLY' : 'DRY RUN'} | min cost $${MIN_COST}\n`);
  const { cut, keep } = await buildCatalogSets();
  console.log('Exporting all Shopify products...');
  const { products, skuByProduct } = await exportProducts();
  console.log(`Shopify products: ${products.size}`);

  const draftLines = [], restoreLines = [];
  let active = 0, archived = 0, draftAlready = 0, cutCount = 0, restoreCount = 0, keptCount = 0;
  for (const [id, status] of products) {
    const sku = skuByProduct.get(id) || '';
    if (status === 'ACTIVE') {
      active++;
      if (sku && cut.has(sku)) { cutCount++; draftLines.push(JSON.stringify({ input: { id, status: 'DRAFT' } })); }
      else keptCount++;
    } else if (status === 'ARCHIVED' || status === 'DRAFT') {
      status === 'ARCHIVED' ? archived++ : draftAlready++;
      if (sku && keep.has(sku)) { restoreCount++; restoreLines.push(JSON.stringify({ input: { id, status: 'ACTIVE' } })); }
    }
  }

  console.log(`\n=== RESULT ===`);
  console.log(`  active: ${active}  (archived: ${archived}, draft: ${draftAlready})`);
  console.log(`  CUT — active software/services → draft: ${cutCount}`);
  console.log(`  RESTORE — hidden B2B hardware → activate: ${restoreCount}`);
  console.log(`  KEEP — active physical products untouched: ${keptCount}`);
  if (!APPLY) { console.log('\nDRY RUN — no changes. Re-run with --apply to execute.'); return; }

  console.log('\nApplying...');
  await runBulkMutation('restore B2B', 'mutation($input:ProductInput!){ productUpdate(input:$input){ product{ id } userErrors{ message } } }', restoreLines);
  await runBulkMutation('draft cuts',  'mutation($input:ProductInput!){ productUpdate(input:$input){ product{ id } userErrors{ message } } }', draftLines);
  console.log('\nDone. Software/services drafted; B2B hardware restored. All reversible.');
})().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
