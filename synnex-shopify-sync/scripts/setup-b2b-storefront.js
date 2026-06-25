'use strict';

/**
 * setup-b2b-storefront — build the B2B-forward storefront IA:
 *   1. Category collections (automated by the clean `group` tag from categorize.js)
 *   2. Solutions-by-Industry collections (automated, disjunctive over relevant groups)
 *   3. Main nav menu: Shop by Category ▸ (categories) | Solutions ▸ (industries) | Request a Quote
 *
 * Consumer products stay browsable (they live in the same category collections); B2B is
 * the hero via Solutions + nav ordering. Idempotent — safe to re-run.
 *
 *   source .env && node scripts/setup-b2b-storefront.js          # create collections + show planned nav
 *   source .env && node scripts/setup-b2b-storefront.js --nav    # also update the live main-menu
 */

const STORE = process.env.SHOPIFY_STORE, TOKEN = process.env.SHOPIFY_ACCESS_TOKEN, VER = process.env.SHOPIFY_API_VERSION || '2026-01';
const UPDATE_NAV = process.argv.includes('--nav');
const GQL = `https://${STORE}.myshopify.com/admin/api/${VER}/graphql.json`;

// Shop-by-Category: group tag → display title (B2B order; consumer cats included but lower)
const CATEGORIES = [
  ['computers-portables', 'Laptops, Desktops & Servers'],
  ['monitors-projectors', 'Monitors & Displays'],
  ['networking',          'Networking'],
  ['storage',             'Storage & NAS'],
  ['power',               'Power & UPS'],
  ['security',            'Security & Surveillance'],
  ['printers',            'Printers & Supplies'],
  ['memory',              'Memory'],
  ['components',          'Components'],
  ['input-devices',       'Keyboards & Mice'],
  ['computer-accessories','Accessories & Cables'],
  ['consumer-electronics','Audio & Electronics'],
];

// Solutions-by-Industry: industry → groups it surfaces (disjunctive / OR)
const INDUSTRIES = [
  ['Education',  ['computers-portables', 'monitors-projectors', 'networking', 'power']],
  ['Government', ['computers-portables', 'networking', 'security', 'power']],
  ['Healthcare', ['computers-portables', 'monitors-projectors', 'input-devices', 'security']],
  ['Finance',    ['computers-portables', 'networking', 'security', 'power']],
  ['Business',   ['computers-portables', 'networking', 'storage', 'monitors-projectors', 'power']],
];

async function gql(query, variables = {}) {
  const r = await fetch(GQL, { method: 'POST', headers: { 'X-Shopify-Access-Token': TOKEN, 'Content-Type': 'application/json' }, body: JSON.stringify({ query, variables }) });
  const j = await r.json();
  if (j.errors?.length) throw new Error(j.errors[0].message);
  return j.data;
}
const handleOf = t => t.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
const delay = ms => new Promise(r => setTimeout(r, ms));

const CREATE = `mutation($input:CollectionInput!){ collectionCreate(input:$input){ collection{ id title handle } userErrors{ message } } }`;
const BY_HANDLE = `query($h:String!){ collectionByHandle(handle:$h){ id title } }`;

// Collections created via the Admin API are NOT auto-published to the Online Store
// sales channel — they exist + populate but 404 on the storefront. Publishing the
// new sales-channel way needs write_publications (a scope our token lacks). The
// legacy REST `published:true` flag works with write_products and maps to the
// Online Store channel; storefront propagation takes ~10-15s. Idempotent.
async function publishToOnlineStore(handle) {
  const REST = `https://${STORE}.myshopify.com/admin/api/${VER}`;
  const headers = { 'X-Shopify-Access-Token': TOKEN, 'Content-Type': 'application/json' };
  const found = await (await fetch(`${REST}/smart_collections.json?handle=${handle}`, { headers })).json();
  const c = found.smart_collections?.[0];
  if (!c) { console.log(`    ! could not find ${handle} to publish`); return; }
  if (c.published_at) return; // already live on the storefront
  await fetch(`${REST}/smart_collections/${c.id}.json`, { method: 'PUT', headers, body: JSON.stringify({ smart_collection: { id: c.id, published: true } }) });
  console.log(`    → published to Online Store: ${handle}`);
}

// Create (or fetch) a smart collection; returns its GID. Ensures it's storefront-published.
async function ensureCollection(title, rules, disjunctive) {
  const handle = handleOf(title);
  const existing = (await gql(BY_HANDLE, { h: handle })).collectionByHandle;
  if (existing) { console.log(`  • exists: ${title}`); await publishToOnlineStore(handle); return existing.id; }
  const data = await gql(CREATE, { input: { title, ruleSet: { appliedDisjunctively: !!disjunctive, rules } } });
  const errs = data.collectionCreate.userErrors || [];
  if (errs.length) { console.log(`  ✗ ${title}: ${errs.map(e => e.message).join('; ')}`); return null; }
  console.log(`  ✓ created: ${title} (/${data.collectionCreate.collection.handle})`);
  await publishToOnlineStore(data.collectionCreate.collection.handle);
  return data.collectionCreate.collection.id;
}

async function main() {
  if (!STORE || !TOKEN) throw new Error('source .env first');
  console.log(`\n=== Category collections ===`);
  const catItems = [];
  for (const [tag, title] of CATEGORIES) {
    const id = await ensureCollection(title, [{ column: 'TAG', relation: 'EQUALS', condition: tag }], false);
    if (id) catItems.push({ title, type: 'COLLECTION', resourceId: id, items: [] });
    await delay(250);
  }

  console.log(`\n=== Solutions-by-Industry collections ===`);
  const indItems = [];
  for (const [industry, groups] of INDUSTRIES) {
    const title = `${industry} Solutions`;
    const rules = groups.map(g => ({ column: 'TAG', relation: 'EQUALS', condition: g }));
    const id = await ensureCollection(title, rules, true); // disjunctive (OR)
    if (id) indItems.push({ title: industry, type: 'COLLECTION', resourceId: id, items: [] });
    await delay(250);
  }

  // Build the B2B main nav
  const navItems = [
    { title: 'Shop by Category', type: 'HTTP', url: '/collections', items: catItems },
    { title: 'Solutions',        type: 'HTTP', url: '/collections', items: indItems },
    { title: 'Request a Quote',  type: 'HTTP', url: '/pages/contact', items: [] },
  ];

  console.log(`\n=== Planned main nav ===`);
  navItems.forEach(i => console.log(`  ${i.title}${i.items.length ? ' ▸ ' + i.items.map(s => s.title).join(', ') : ''}`));

  if (!UPDATE_NAV) { console.log('\nCollections ensured. Re-run with --nav to update the live main-menu.\n'); return; }

  const menus = (await gql(`{ menus(first:30){ nodes{ id handle title } } }`)).menus.nodes;
  const main = menus.find(m => m.handle === 'main-menu');
  const strip = its => its.map(i => ({ title: i.title, type: i.type, url: i.url, resourceId: i.resourceId, items: strip(i.items || []) }));
  if (main) {
    const d = await gql(`mutation($id:ID!,$items:[MenuItemUpdateInput!]!){ menuUpdate(id:$id, title:"Main menu", handle:"main-menu", items:$items){ userErrors{ message } } }`, { id: main.id, items: strip(navItems) });
    const e = d.menuUpdate.userErrors || []; if (e.length) throw new Error(e.map(x => x.message).join('; '));
    console.log('\n  ✓ Updated main-menu with the B2B nav\n');
  } else {
    const d = await gql(`mutation($items:[MenuItemCreateInput!]!){ menuCreate(title:"Main menu", handle:"main-menu", items:$items){ userErrors{ message } } }`, { items: strip(navItems) });
    const e = d.menuCreate.userErrors || []; if (e.length) throw new Error(e.map(x => x.message).join('; '));
    console.log('\n  ✓ Created main-menu with the B2B nav\n');
  }
}

main().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
