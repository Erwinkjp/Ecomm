#!/usr/bin/env node
'use strict';
/**
 * enrich-product.js — targeted Icecat enrichment for a SINGLE product.
 *
 * Pulls images + description + specs (+ a clean title) from Icecat for one SKU and
 * writes them to the matching Shopify product. Useful to spotlight a product (e.g.
 * a live bid line item) without running the full image-backfill sweep.
 *
 *   node scripts/enrich-product.js <handle> <brand> "<mpn>" [upc]
 *   node scripts/enrich-product.js bn5k5ut-aba HP "BN5K5UT#ABA" 199251337468
 *
 * Reads SHOPIFY_* and ICECAT_USERNAME from .env (this dir or ../). Reuses the
 * project's Icecat client for parsing. Only fills gaps unless --force is passed.
 */
const fs = require('fs');
const path = require('path');
const https = require('https');

// --- load .env into process.env BEFORE requiring config-dependent modules ---
(function loadEnv() {
  for (const p of [path.join(__dirname, '..', '.env'), path.join(__dirname, '.env')]) {
    if (fs.existsSync(p)) {
      for (let line of fs.readFileSync(p, 'utf8').split('\n')) {
        line = line.trim();
        if (!line || line.startsWith('#')) continue;
        if (line.startsWith('export ')) line = line.slice(7);
        const i = line.indexOf('=');
        if (i > 0) {
          const k = line.slice(0, i).trim();
          const v = line.slice(i + 1).trim().replace(/^["']|["']$/g, '');
          if (!(k in process.env)) process.env[k] = v;
        }
      }
      break;
    }
  }
})();

const { fetchIcecatProduct } = require(path.join(__dirname, '..', 'src', 'icecat', 'client'));

const [handle, brand, mpn, upc] = process.argv.slice(2);
const FORCE = process.argv.includes('--force');
if (!handle || !brand || !mpn) {
  console.error('Usage: node scripts/enrich-product.js <handle> <brand> "<mpn>" [upc] [--force]');
  process.exit(1);
}

const STORE = process.env.SHOPIFY_STORE;
const CID = process.env.SHOPIFY_CLIENT_ID;
const CS = process.env.SHOPIFY_CLIENT_SECRET;
const API = process.env.SHOPIFY_API_VERSION || '2026-01';

function req(pathname, method, headers, payload) {
  return new Promise((res, rej) => {
    const body = payload ? JSON.stringify(payload) : null;
    const h = Object.assign({ 'Content-Type': 'application/json', Accept: 'application/json' }, headers || {});
    if (body) h['Content-Length'] = Buffer.byteLength(body);
    const r = https.request({ hostname: `${STORE}.myshopify.com`, path: pathname, method, headers: h },
      resp => { let d = ''; resp.on('data', c => d += c); resp.on('end', () => res({ status: resp.statusCode, body: d })); });
    r.on('error', rej); if (body) r.write(body); r.end();
  });
}

async function token() {
  const r = await req('/admin/oauth/access_token', 'POST', {}, { client_id: CID, client_secret: CS, grant_type: 'client_credentials' });
  const t = JSON.parse(r.body).access_token;
  if (!t) throw new Error('token mint failed: ' + r.body.slice(0, 200));
  return t;
}
async function gql(tok, query, variables) {
  const r = await req(`/admin/api/${API}/graphql.json`, 'POST', { 'X-Shopify-Access-Token': tok }, { query, variables });
  const j = JSON.parse(r.body);
  if (j.errors) throw new Error('GraphQL: ' + JSON.stringify(j.errors));
  return j.data;
}

(async () => {
  console.log(`Icecat lookup: brand="${brand}" mpn="${mpn}"${upc ? ` upc=${upc}` : ''}`);
  const ice = await fetchIcecatProduct({ brand, partNumber: mpn, upc });
  if (!ice) {
    console.log('\nIcecat returned NO data for this SKU on the current tier.');
    console.log('-> On free Open Icecat, gated brands/SKUs need an app_key (Full Icecat). Set ICECAT_APP_KEY to unlock.');
    process.exit(2);
  }
  console.log(`Icecat hit: title=${ice.title ? 'yes' : 'no'}, images=${ice.images.length}, specs groups=${ice.specs.length}, desc=${ice.description ? 'yes' : 'no'}`);

  const tok = await token();
  const found = await gql(tok, `query($q:String!){ products(first:1, query:$q){ nodes{ id title descriptionHtml media(first:1){nodes{id}} } } }`,
    { q: `handle:${handle}` });
  const prod = found.products.nodes[0];
  if (!prod) { console.error(`No Shopify product with handle "${handle}"`); process.exit(3); }
  const hasImages = (prod.media?.nodes?.length ?? 0) > 0;
  const hasDesc = (prod.descriptionHtml || '').trim().length > 0;
  console.log(`Shopify product: ${prod.id} | hasImages=${hasImages} hasDesc=${hasDesc}`);

  // 1) Images
  if (ice.images.length && (!hasImages || FORCE)) {
    const media = ice.images.slice(0, 6).map(url => ({ mediaContentType: 'IMAGE', originalSource: url }));
    const r = await gql(tok, `mutation($p:ID!,$m:[CreateMediaInput!]!){ productCreateMedia(productId:$p, media:$m){ media{ ... on MediaImage{ id } } mediaUserErrors{ message } } }`,
      { p: prod.id, m: media });
    const errs = r.productCreateMedia.mediaUserErrors;
    console.log(errs.length ? `  images: ERROR ${errs.map(e => e.message).join('; ')}` : `  images: added ${media.length}`);
  } else console.log(`  images: skipped (${hasImages ? 'already has images' : 'none from Icecat'})`);

  // 2) Title + description
  const input = { id: prod.id };
  if (ice.title) input.title = ice.title;                       // fixes the truncated raw title
  if (ice.description && (!hasDesc || FORCE)) input.descriptionHtml = ice.description;
  if (input.title || input.descriptionHtml) {
    const r = await gql(tok, `mutation($i:ProductInput!){ productUpdate(input:$i){ product{ id title } userErrors{ message } } }`, { i: input });
    const errs = r.productUpdate.userErrors;
    console.log(errs.length ? `  title/desc: ERROR ${errs.map(e => e.message).join('; ')}` : `  title/desc: updated (title="${r.productUpdate.product.title.slice(0, 60)}...")`);
  } else console.log('  title/desc: skipped');

  // 3) Specs metafield (matches the sync's custom.spec_sheet convention)
  if (ice.specs?.length) {
    const r = await gql(tok, `mutation($m:[MetafieldsSetInput!]!){ metafieldsSet(metafields:$m){ userErrors{ message } } }`,
      { m: [{ ownerId: prod.id, namespace: 'custom', key: 'spec_sheet', type: 'json', value: JSON.stringify(ice.specs) }] });
    const errs = r.metafieldsSet.userErrors;
    console.log(errs.length ? `  specs: ERROR ${errs.map(e => e.message).join('; ')}` : `  specs: wrote ${ice.specs.length} groups`);
  }

  console.log('\nDone. Reload the product page to see images/description.');
})().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
