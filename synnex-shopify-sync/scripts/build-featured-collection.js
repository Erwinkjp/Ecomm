'use strict';
/**
 * build-featured-collection.js
 * Creates a "Featured Products" collection and fills it with every product
 * that has at least one image. Run once (or re-run to refresh).
 *
 * Usage: node scripts/build-featured-collection.js
 */
const https = require('https');

const STORE = process.env.SHOPIFY_STORE;
const TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;

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

async function getOrCreateCollection() {
  // Check if it already exists
  const existing = await gql(`{ collectionByHandle(handle: "featured-products") { id handle } }`);
  if (existing?.data?.collectionByHandle?.id) {
    console.log('  Collection already exists:', existing.data.collectionByHandle.id);
    return existing.data.collectionByHandle.id;
  }

  const r = await gql(`mutation {
    collectionCreate(input: { title: "Featured Products", handle: "featured-products", sortOrder: BEST_SELLING }) {
      collection { id handle }
      userErrors { field message }
    }
  }`);
  const errs = r?.data?.collectionCreate?.userErrors;
  if (errs?.length) throw new Error(errs.map(e => e.message).join('; '));
  const id = r?.data?.collectionCreate?.collection?.id;
  console.log('  Created collection:', id);
  return id;
}

async function getAllProductsWithImagesInStock() {
  const ids = [];
  let cursor = null;
  do {
    // Filter server-side to only products with inventory > 0
    const d = await gql(`query($cursor: String) {
      products(first: 250, after: $cursor, query: "inventory_total:>0") {
        pageInfo { hasNextPage endCursor }
        nodes { id featuredImage { url } totalInventory }
      }
    }`, { cursor });
    const page = d?.data?.products;
    if (!page) break;
    for (const p of page.nodes) {
      if (p.featuredImage) ids.push(p.id);
    }
    cursor = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
    process.stdout.write(`\r  Scanning... ${ids.length} in-stock products with images`);
    if (cursor) await new Promise(r => setTimeout(r, 200));
  } while (cursor);
  console.log();
  return ids;
}

async function addToCollection(collectionId, productIds) {
  for (let i = 0; i < productIds.length; i += 250) {
    const chunk = productIds.slice(i, i + 250);
    const r = await gql(`mutation($id: ID!, $productIds: [ID!]!) {
      collectionAddProductsV2(id: $id, productIds: $productIds) {
        job { id done }
        userErrors { field message }
      }
    }`, { id: collectionId, productIds: chunk });
    const errs = r?.data?.collectionAddProductsV2?.userErrors;
    if (errs?.length) console.warn('  Warn:', errs.map(e => e.message).join('; '));
    process.stdout.write(`\r  Added ${Math.min(i + 250, productIds.length)}/${productIds.length}`);
    await new Promise(r => setTimeout(r, 300));
  }
  console.log();
}

(async () => {
  console.log('\nBuilding Featured Products collection...\n');

  console.log('Step 1: Get or create collection...');
  const collectionId = await getOrCreateCollection();

  // First clear out old products in the collection
  console.log('\nStep 2: Clearing existing collection members...');
  const existing = await gql(`{ collection(handle: "featured-products") { products(first: 250) { nodes { id } } } }`);
  const oldIds = existing?.data?.collection?.products?.nodes?.map(p => p.id) || [];
  if (oldIds.length > 0) {
    await gql(`mutation($id: ID!, $productIds: [ID!]!) {
      collectionRemoveProducts(id: $id, productIds: $productIds) {
        userErrors { field message }
      }
    }`, { id: collectionId, productIds: oldIds }).catch(() => {});
    console.log(`  Cleared ${oldIds.length} old entries.`);
  }

  console.log('\nStep 3: Scan for in-stock products with images...');
  const ids = await getAllProductsWithImagesInStock();
  console.log(`  Found ${ids.length} in-stock products with images.`);

  if (ids.length === 0) {
    console.log('No products with images found. Exiting.');
    return;
  }

  console.log(`\nStep 4: Adding ${ids.length} products to collection...`);
  await addToCollection(collectionId, ids);

  // Publish the collection
  await gql(`mutation($id: ID!) {
    publishablePublish(id: $id, input: { publicationIds: [] }) {
      userErrors { field message }
    }
  }`, { id: collectionId }).catch(() => {});

  console.log(`\nDone — ${ids.length} products in "Featured Products" collection.`);
})().catch(e => { console.error(e); process.exit(1); });
