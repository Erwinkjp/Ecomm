#!/usr/bin/env node
'use strict';
/**
 * Set a company's "Company Standards" list (the customer-account extension page).
 *
 *   source .env && node scripts/set-company-standards.js <companyId> <sku> [sku2] [sku3] ...
 *
 *   companyId : numeric (e.g. 27472953568) or full gid://shopify/Company/...
 *   sku...    : Shopify variant SKUs of the products to make this company's standards
 *
 * What it does:
 *   1. Resolves each SKU to its product/variant (must be active).
 *   2. Publishes those products into the company's B2B catalog(s) so they're
 *      orderable at the company's pricing.
 *   3. Writes the curated list to the company's $app:standards.products metafield,
 *      which the Company Standards page reads.
 *
 * Auth: uses client_credentials from SHOPIFY_CLIENT_ID/SECRET (no static token needed).
 */
const store = process.env.SHOPIFY_STORE, id = process.env.SHOPIFY_CLIENT_ID,
      secret = process.env.SHOPIFY_CLIENT_SECRET, ver = process.env.SHOPIFY_API_VERSION || '2026-01';

let TOKEN;
async function gql(query, variables) {
  const r = await fetch(`https://${store}.myshopify.com/admin/api/${ver}/graphql.json`, {
    method: 'POST',
    headers: { 'X-Shopify-Access-Token': TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  return r.json();
}

(async () => {
  const [rawCompany, ...skus] = process.argv.slice(2);
  if (!rawCompany || skus.length === 0) {
    console.error('Usage: node scripts/set-company-standards.js <companyId> <sku> [sku2] ...');
    process.exit(1);
  }
  const companyGid = rawCompany.startsWith('gid://') ? rawCompany : `gid://shopify/Company/${rawCompany}`;

  TOKEN = (await (await fetch(`https://${store}.myshopify.com/admin/oauth/access_token`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: id, client_secret: secret, grant_type: 'client_credentials' }),
  })).json()).access_token;

  // 1. Resolve SKUs → { variantId, productId, title }
  const items = [];
  for (const sku of skus) {
    const d = await gql(`query($q:String!){products(first:1,query:$q){nodes{id title variants(first:25){nodes{id sku}}}}}`,
      { q: `sku:${sku} status:active` });
    const p = d.data?.products?.nodes?.[0];
    const v = p?.variants?.nodes?.find(x => x.sku === sku) || p?.variants?.nodes?.[0];
    if (!p || !v) { console.warn(`  ⚠ SKU not found / not active: ${sku}`); continue; }
    items.push({ variantId: v.id, productId: p.id, title: p.title.slice(0, 72), qty: 1 });
  }
  if (!items.length) { console.error('No products resolved — nothing to set.'); process.exit(1); }
  console.log(`Resolved ${items.length} product(s):`);
  items.forEach(i => console.log(`  • ${i.title}`));

  // NOTE: Company Standards is now purely a curated metafield (read by the account-page app).
  // We no longer publish products into the company's catalog here — companies are assigned to a
  // shared tier catalog ("B2B — All Products (N%)") that already contains the full in-stock set,
  // so all standards products are inherently available/orderable. (See create-b2b-account.js.)
  const cd = await gql(`query($id:ID!){company(id:$id){name}}`, { id: companyGid });

  // Write the standards metafield (drop productId before storing)
  const list = items.map(({ variantId, title, qty }) => ({ variantId, title, qty }));
  const w = await gql(`mutation($m:[MetafieldsSetInput!]!){metafieldsSet(metafields:$m){userErrors{field message}}}`,
    { m: [{ ownerId: companyGid, namespace: '$app:standards', key: 'products', type: 'json', value: JSON.stringify(list) }] });
  const e = w.data?.metafieldsSet?.userErrors;
  console.log(e && e.length ? `✗ metafield: ${JSON.stringify(e)}` : `✓ Set ${list.length} products as ${cd.data?.company?.name || 'the company'}'s Company Standards.`);
})().catch(e => { console.error(e); process.exit(1); });
