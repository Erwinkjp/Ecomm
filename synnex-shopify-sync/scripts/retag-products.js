'use strict';

/**
 * retag-products.js
 *
 * Re-tags all existing Shopify products with the new group tags and corrected
 * productTypes from the updated TD Synnex category taxonomy.
 *
 * Runs entirely against the Shopify API — no DynamoDB or SFTP needed.
 * Safe to re-run: skips products that already have a group tag.
 *
 * Usage: source .env && node scripts/retag-products.js
 */

const STORE   = process.env.SHOPIFY_STORE;
const TOKEN   = process.env.SHOPIFY_ACCESS_TOKEN;
const API     = process.env.SHOPIFY_API_VERSION || '2026-01';
const CONCURRENCY = 8;

if (!STORE || !TOKEN) {
  console.error('Set SHOPIFY_STORE and SHOPIFY_ACCESS_TOKEN before running.');
  process.exit(1);
}

const GQL_URL = `https://${STORE}.myshopify.com/admin/api/${API}/graphql.json`;

// ── Group tags (all possible values from the new CATEGORY_MAP) ───────────────

const ALL_GROUPS = new Set([
  'cell-phones', 'computer-accessories', 'computers-portables',
  'consumer-electronics', 'drones', 'gaming', 'home-appliances',
  'input-devices', 'memory', 'monitors-projectors', 'networking',
  'office', 'power', 'printers', 'security', 'software', 'storage',
]);

// ── Maps old productType → { newType, group } ────────────────────────────────
// Covers every type the old CATEGORY_MAP could have produced.

const TYPE_MAP = {
  // Computers
  'Laptops':           { type: 'Notebooks',              group: 'computers-portables' },
  'Laptop':            { type: 'Notebooks',              group: 'computers-portables' },
  'Chromebooks':       { type: 'Chromebooks',            group: 'computers-portables' },
  'Chromebook':        { type: 'Chromebooks',            group: 'computers-portables' },
  'Desktops':          { type: 'Desktops',               group: 'computers-portables' },
  'Desktop':           { type: 'Desktops',               group: 'computers-portables' },
  'Workstations':      { type: 'Workstations',           group: 'computers-portables' },
  'Workstation':       { type: 'Workstations',           group: 'computers-portables' },
  'Tablets':           { type: 'Tablets',                group: 'computers-portables' },
  'Tablet':            { type: 'Tablets',                group: 'computers-portables' },
  // Monitors
  'Monitors':          { type: 'Monitors',               group: 'monitors-projectors' },
  'Monitor':           { type: 'Monitors',               group: 'monitors-projectors' },
  // Input Devices
  'Keyboard':          { type: 'Keyboards',              group: 'input-devices' },
  'Keyboards':         { type: 'Keyboards',              group: 'input-devices' },
  'Mouse':             { type: 'Mice',                   group: 'input-devices' },
  'Mice':              { type: 'Mice',                   group: 'input-devices' },
  // Memory
  'Memory':            { type: 'Memory',                 group: 'memory' },
  // Storage
  'Storage':           { type: 'Storage',                group: 'storage' },
  // Networking
  'Networking':        { type: 'Network Devices',        group: 'networking' },
  // Gaming
  'Gaming':            { type: 'Gaming Systems',         group: 'gaming' },
  // Power
  'Power':             { type: 'UPS',                    group: 'power' },
  // Software
  'Software':          { type: 'Software',               group: 'software' },
  // Printers
  'Printers':          { type: 'Printers',               group: 'printers' },
  'Printer':           { type: 'Printers',               group: 'printers' },
  // Already correct new types — just need group tag added
  'Notebooks':         { type: 'Notebooks',              group: 'computers-portables' },
  'All-in-One PCs':    { type: 'All-in-One PCs',         group: 'computers-portables' },
  'AI Desktops':       { type: 'AI Desktops',            group: 'computers-portables' },
  'AI Laptops':        { type: 'AI Laptops',             group: 'computers-portables' },
  'AI PCs':            { type: 'AI PCs',                 group: 'computers-portables' },
  'Servers':           { type: 'Servers',                group: 'computers-portables' },
  'Monitors & Projectors': { type: 'Monitors',           group: 'monitors-projectors' },
  'Projectors':        { type: 'Projectors',             group: 'monitors-projectors' },
  'Televisions':       { type: 'Televisions',            group: 'monitors-projectors' },
  'RAM':               { type: 'RAM',                    group: 'memory' },
  'Routers':           { type: 'Routers',                group: 'networking' },
  'Switches & Hubs':   { type: 'Switches & Hubs',        group: 'networking' },
  'Gaming Systems':    { type: 'Gaming Systems',         group: 'gaming' },
  'Gaming Accessories':{ type: 'Gaming Accessories',     group: 'gaming' },
  'Speakers':          { type: 'Speakers',               group: 'consumer-electronics' },
  'Drones':            { type: 'Drones',                 group: 'drones' },
  'SSDs':              { type: 'SSDs',                   group: 'storage' },
  'UPS':               { type: 'UPS',                    group: 'power' },
  'Laser Printers':    { type: 'Laser Printers',         group: 'printers' },
  'Inkjet Printers':   { type: 'Inkjet Printers',        group: 'printers' },
  'Docking Stations':  { type: 'Docking Stations',       group: 'computer-accessories' },
};

// When productType is 'Accessories', use tags to determine a better mapping
function resolveAccessories(tags) {
  const t = new Set(tags.map(x => x.toLowerCase()));
  if (t.has('dock'))         return { type: 'Docking Stations',          group: 'computer-accessories' };
  if (t.has('keyboard'))     return { type: 'Keyboards',                 group: 'input-devices' };
  if (t.has('mouse'))        return { type: 'Mice',                      group: 'input-devices' };
  if (t.has('headset') || t.has('headphone')) return { type: 'Headphones & Microphones', group: 'consumer-electronics' };
  if (t.has('cable'))        return { type: 'Cable Accessories',         group: 'computer-accessories' };
  if (t.has('bag'))          return { type: 'PC Carrying Cases',         group: 'computer-accessories' };
  if (t.has('av'))           return { type: 'AV Accessories',            group: 'consumer-electronics' };
  if (t.has('scanner'))      return { type: 'Scanners',                  group: 'input-devices' };
  if (t.has('gaming'))       return { type: 'Gaming Accessories',        group: 'gaming' };
  if (t.has('networking'))   return { type: 'Network Accessories',       group: 'networking' };
  if (t.has('power') || t.has('ups')) return { type: 'UPS',             group: 'power' };
  return { type: 'Computer Accessories', group: 'computer-accessories' };
}

// ── GraphQL helpers ───────────────────────────────────────────────────────────

async function gql(query, variables = {}, retries = 3) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await fetch(GQL_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': TOKEN },
        body: JSON.stringify({ query, variables }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.json();
      if (body.errors?.length) {
        const msg = body.errors[0].message;
        if (msg.toLowerCase().includes('throttled') && attempt < retries) {
          await new Promise(r => setTimeout(r, 2000 * attempt));
          continue;
        }
        throw new Error(msg);
      }
      return body.data;
    } catch (e) {
      if (attempt < retries && (e.code === 'ETIMEDOUT' || e.code === 'ECONNRESET' || e.message.includes('fetch failed'))) {
        await new Promise(r => setTimeout(r, 3000 * attempt));
        continue;
      }
      throw e;
    }
  }
}

const GET_PRODUCTS = `
  query getProducts($cursor: String) {
    products(first: 250, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id
        productType
        tags
      }
    }
  }
`;

const UPDATE_PRODUCT = `
  mutation productUpdate($input: ProductInput!) {
    productUpdate(input: $input) {
      product { id productType tags }
      userErrors { field message }
    }
  }
`;

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\nFetching all products from ${STORE}.myshopify.com …\n`);

  // 1. Load all products
  const products = [];
  let cursor = null;
  do {
    const data = await gql(GET_PRODUCTS, cursor ? { cursor } : {});
    const page = data.products;
    products.push(...page.nodes);
    cursor = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
    process.stdout.write(`\r  Loaded ${products.length} products…`);
  } while (cursor);
  console.log(`\n  Total: ${products.length} products\n`);

  // 2. Identify which need updating
  const toUpdate = [];
  for (const p of products) {
    const hasGroup = p.tags.some(t => ALL_GROUPS.has(t));
    if (hasGroup) continue; // already has group tag — skip

    const pt = p.productType || '';
    let mapping = TYPE_MAP[pt];
    if (!mapping && pt.toLowerCase().includes('accessor')) {
      mapping = resolveAccessories(p.tags);
    }
    if (!mapping) {
      // Unknown type — infer from tags if possible
      const tagSet = new Set(p.tags.map(t => t.toLowerCase()));
      if (tagSet.has('laptop') || tagSet.has('notebook'))       mapping = { type: pt, group: 'computers-portables' };
      else if (tagSet.has('desktop'))                           mapping = { type: pt, group: 'computers-portables' };
      else if (tagSet.has('monitor') || tagSet.has('display'))  mapping = { type: pt, group: 'monitors-projectors' };
      else if (tagSet.has('keyboard'))                          mapping = { type: pt, group: 'input-devices' };
      else if (tagSet.has('mouse'))                             mapping = { type: pt, group: 'input-devices' };
      else if (tagSet.has('memory') || tagSet.has('ram'))       mapping = { type: pt, group: 'memory' };
      else if (tagSet.has('storage') || tagSet.has('ssd'))      mapping = { type: pt, group: 'storage' };
      else if (tagSet.has('networking') || tagSet.has('router'))mapping = { type: pt, group: 'networking' };
      else if (tagSet.has('gaming'))                            mapping = { type: pt, group: 'gaming' };
      else if (tagSet.has('printer'))                           mapping = { type: pt, group: 'printers' };
      else continue; // can't infer — skip
    }

    const newTags = [...new Set([...p.tags, mapping.group])];
    toUpdate.push({
      id: p.id,
      productType: mapping.type,
      tags: newTags,
    });
  }

  console.log(`  ${toUpdate.length} products need re-tagging (${products.length - toUpdate.length} already up to date)\n`);

  if (toUpdate.length === 0) {
    console.log('Nothing to do.\n');
    return;
  }

  // 3. Update in batches
  let done = 0;
  let errors = 0;

  async function updateOne({ id, productType, tags }) {
    try {
      const data = await gql(UPDATE_PRODUCT, { input: { id, productType, tags } });
      const errs = data.productUpdate?.userErrors || [];
      if (errs.length) throw new Error(errs.map(e => e.message).join('; '));
      done++;
    } catch (e) {
      errors++;
      if (errors <= 5) console.error(`\n  ✗ ${id}: ${e.message}`);
    }
    if ((done + errors) % 100 === 0 || done + errors === toUpdate.length) {
      process.stdout.write(`\r  Updated ${done}/${toUpdate.length}  errors: ${errors}`);
    }
  }

  for (let i = 0; i < toUpdate.length; i += CONCURRENCY) {
    await Promise.all(toUpdate.slice(i, i + CONCURRENCY).map(updateOne));
  }

  console.log(`\n\n  Done — updated: ${done}  errors: ${errors}\n`);
}

main().catch(e => { console.error(e); process.exit(1); });
