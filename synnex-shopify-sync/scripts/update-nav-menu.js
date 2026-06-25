'use strict';

/**
 * update-nav-menu.js
 *
 * Creates or updates the Shopify "main-menu" navigation with a full
 * two-level hierarchy matching the TD Synnex category taxonomy.
 *
 * Usage: source .env && node scripts/update-nav-menu.js
 */

const STORE = process.env.SHOPIFY_STORE;
const TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;
const API   = process.env.SHOPIFY_API_VERSION || '2026-01';

if (!STORE || !TOKEN) {
  console.error('Set SHOPIFY_STORE and SHOPIFY_ACCESS_TOKEN before running.');
  process.exit(1);
}

const GQL_URL = `https://${STORE}.myshopify.com/admin/api/${API}/graphql.json`;

// ── Menu structure ────────────────────────────────────────────────────────────
// Each top-level item has a handle (for the collection URL) and sub-items.
// Items without a handle use a plain URL instead.

const MENU_STRUCTURE = [
  {
    title: 'All Products',
    url: '/collections/all',
  },
  {
    title: 'Computers & Portables',
    handle: 'computers-portables',
    children: [
      { title: 'Notebooks',       handle: 'notebooks' },
      { title: 'Desktops',        handle: 'desktops' },
      { title: 'Workstations',    handle: 'workstations' },
      { title: 'All-in-One PCs',  handle: 'all-in-one-pcs' },
      { title: 'Chromebooks',     handle: 'chromebooks' },
      { title: 'Tablets',         handle: 'tablets' },
      { title: 'AI Desktops',     handle: 'ai-desktops' },
      { title: 'AI Laptops',      handle: 'ai-laptops' },
      { title: 'Servers',         handle: 'servers' },
    ],
  },
  {
    title: 'Monitors & Projectors',
    handle: 'monitors-projectors',
    children: [
      { title: 'Monitors',        handle: 'monitors' },
      { title: 'Projectors',      handle: 'projectors' },
      { title: 'Televisions',     handle: 'televisions' },
      { title: 'Display Cables',  handle: 'display-cables' },
    ],
  },
  {
    title: 'Networking',
    handle: 'networking-communication',
    children: [
      { title: 'Routers',               handle: 'routers' },
      { title: 'Switches & Hubs',       handle: 'switches-hubs' },
      { title: 'Network Adapters',      handle: 'network-adapters' },
      { title: 'Network Cables',        handle: 'network-cables' },
      { title: 'Modems',                handle: 'modems' },
      { title: 'Video Conferencing',    handle: 'video-conferencing' },
      { title: 'Telephones',            handle: 'telephones' },
      { title: 'Network Accessories',   handle: 'network-accessories' },
    ],
  },
  {
    title: 'Input Devices',
    handle: 'input-devices',
    children: [
      { title: 'Keyboards',         handle: 'keyboards' },
      { title: 'Mice',              handle: 'mice' },
      { title: 'Webcams & Cameras', handle: 'webcams-cameras' },
      { title: 'Barcode Readers',   handle: 'barcode-readers' },
      { title: 'Game Controllers',  handle: 'game-controllers' },
      { title: 'Scanners',          handle: 'scanners' },
    ],
  },
  {
    title: 'Memory & Storage',
    url: '/collections/all',
    children: [
      { title: 'RAM',                 handle: 'ram' },
      { title: 'Flash Drives & USB',  handle: 'flash-drives-usb' },
      { title: 'Memory & Card Readers', handle: 'memory-card-readers' },
      { title: 'SSDs',                handle: 'ssds' },
      { title: 'External Storage',    handle: 'external-storage' },
      { title: 'Internal Storage',    handle: 'internal-storage' },
      { title: 'NAS',                 handle: 'nas' },
    ],
  },
  {
    title: 'Consumer Electronics',
    handle: 'consumer-electronics',
    children: [
      { title: 'Speakers',                handle: 'speakers' },
      { title: 'Headphones & Microphones', handle: 'headphones-microphones' },
      { title: 'Home Audio',              handle: 'home-audio' },
      { title: 'Digital Cameras',         handle: 'digital-cameras' },
      { title: 'Fitness & Wearables',     handle: 'fitness-wearables' },
      { title: 'AV Accessories',          handle: 'av-accessories' },
    ],
  },
  {
    title: 'Gaming',
    handle: 'gaming',
    children: [
      { title: 'Gaming Systems',      handle: 'gaming-systems' },
      { title: 'Gaming Accessories',  handle: 'gaming-accessories' },
      { title: 'Console Software',    handle: 'console-software' },
    ],
  },
  {
    title: 'Cell Phones',
    handle: 'cell-phones',
    children: [
      { title: 'iPhones',                   handle: 'iphones' },
      { title: 'Android Phones',            handle: 'android-phones' },
      { title: 'Cell Phone Accessories',    handle: 'cell-phone-accessories' },
      { title: 'Phone Chargers',            handle: 'phone-chargers' },
    ],
  },
  {
    title: 'Computer Accessories',
    handle: 'computer-accessories',
    children: [
      { title: 'Docking Stations',  handle: 'docking-stations' },
      { title: 'KVM & AV Splitters', handle: 'kvm-av-splitters' },
      { title: 'Cable Accessories', handle: 'cable-accessories' },
      { title: 'PC Carrying Cases', handle: 'pc-carrying-cases' },
    ],
  },
  {
    title: 'Printers',
    handle: 'printers',
    children: [
      { title: 'Laser Printers',        handle: 'laser-printers' },
      { title: 'Inkjet Printers',       handle: 'inkjet-printers' },
      { title: 'Multifunction Printers', handle: 'multifunction-printers' },
      { title: 'Printer Supplies',      handle: 'printer-supplies' },
    ],
  },
];

// ── GraphQL helpers ───────────────────────────────────────────────────────────

async function gql(query, variables = {}) {
  const res = await fetch(GQL_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': TOKEN },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
  const body = await res.json();
  if (body.errors?.length) throw new Error(body.errors[0].message);
  return body.data;
}

const GET_COLLECTION_ID = `
  query($handle: String!) {
    collectionByHandle(handle: $handle) { id }
  }
`;

const GET_MENUS = `
  query {
    menus(first: 20) {
      nodes { id handle title }
    }
  }
`;

const MENU_CREATE = `
  mutation menuCreate($title: String!, $handle: String!, $items: [MenuItemCreateInput!]!) {
    menuCreate(title: $title, handle: $handle, items: $items) {
      menu { id handle title }
      userErrors { field message }
    }
  }
`;

const MENU_UPDATE = `
  mutation menuUpdate($id: ID!, $title: String!, $items: [MenuItemUpdateInput!]!) {
    menuUpdate(id: $id, title: $title, items: $items) {
      menu { id handle title }
      userErrors { field message }
    }
  }
`;

// ── Build menu items ──────────────────────────────────────────────────────────

const collectionIds = {};

async function resolveCollectionId(handle) {
  if (collectionIds[handle]) return collectionIds[handle];
  const data = await gql(GET_COLLECTION_ID, { handle });
  const id = data.collectionByHandle?.id || null;
  collectionIds[handle] = id;
  return id;
}

async function buildItem(item) {
  const children = item.children
    ? await Promise.all(item.children.map(buildItem))
    : [];

  if (item.handle) {
    const resourceId = await resolveCollectionId(item.handle);
    if (resourceId) {
      return { title: item.title, type: 'COLLECTION', resourceId, items: children };
    }
    // Collection not found — fall back to URL
    console.warn(`  ⚠  Collection not found: ${item.handle} — using URL`);
    return { title: item.title, type: 'HTTP', url: `/collections/${item.handle}`, items: children };
  }

  return { title: item.title, type: 'HTTP', url: item.url || '/collections/all', items: children };
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\nConnecting to ${STORE}.myshopify.com …\n`);

  // Build all menu items (resolves collection IDs)
  console.log('Resolving collection IDs…');
  const items = await Promise.all(MENU_STRUCTURE.map(buildItem));
  console.log(`Built ${items.length} top-level menu items\n`);

  // Check if main-menu already exists
  let existingMenuId = null;
  try {
    const menusData = await gql(GET_MENUS);
    const existing = menusData.menus?.nodes?.find(
      m => m.handle === 'main-menu' || m.title.toLowerCase() === 'main menu'
    );
    if (existing) {
      existingMenuId = existing.id;
      console.log(`Found existing menu: "${existing.title}" (${existing.handle})`);
    }
  } catch (e) {
    console.warn(`Could not query menus: ${e.message}`);
  }

  if (existingMenuId) {
    console.log('Updating main-menu…');
    const data = await gql(MENU_UPDATE, { id: existingMenuId, title: 'Main Menu', items });
    const errs = data.menuUpdate?.userErrors || [];
    if (errs.length) throw new Error(errs.map(e => e.message).join('; '));
    const menu = data.menuUpdate.menu;
    console.log(`\n  ✓ Updated "${menu.title}" — ${items.length} top-level items\n`);
    return;
  }
  {
    console.log('Creating main-menu…');
    const data = await gql(MENU_CREATE, { title: 'Main Menu', handle: 'main-menu', items });
    const errs = data.menuCreate?.userErrors || [];
    if (errs.length) throw new Error(errs.map(e => e.message).join('; '));
    const menu = data.menuCreate.menu;
    console.log(`\n  ✓ Created "${menu.title}" — ${items.length} top-level items\n`);
  }
}

main().catch(e => {
  console.error(`\n✗ Error: ${e.message}\n`);
  if (e.message.includes('menuCreate') || e.message.includes('menuUpdate')) {
    console.log('Note: Menu API may require the write_online_store_navigation scope.');
    console.log('If this fails, go to Shopify Admin → Online Store → Navigation → Main Menu');
    console.log('and update manually using the structure printed below:\n');
    console.log(JSON.stringify(MENU_STRUCTURE, null, 2));
  }
  process.exit(1);
});
