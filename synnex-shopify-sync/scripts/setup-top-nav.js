'use strict';

/**
 * setup-top-nav.js
 * Creates the "top-nav" utility menu used by the header's top utility bar.
 * Usage: source .env && node scripts/setup-top-nav.js
 */

const STORE = process.env.SHOPIFY_STORE;
const TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;
const API   = process.env.SHOPIFY_API_VERSION || '2026-01';

if (!STORE || !TOKEN) {
  console.error('Set SHOPIFY_STORE and SHOPIFY_ACCESS_TOKEN before running.');
  process.exit(1);
}

const GQL_URL = `https://${STORE}.myshopify.com/admin/api/${API}/graphql.json`;

const TOP_NAV_ITEMS = [
  { title: 'Home',             url: '/' },
  { title: 'About Us',         url: '/pages/about-us' },
  { title: 'Brands',           url: '/collections' },
  { title: 'Contact Us',       url: '/pages/contact' },
  { title: 'Terms of Service', url: '/policies/terms-of-service' },
  { title: 'Refund Policy',    url: '/policies/refund-policy' },
];

async function gql(query, variables = {}) {
  const res = await fetch(GQL_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': TOKEN },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = await res.json();
  if (body.errors?.length) throw new Error(body.errors[0].message);
  return body.data;
}

const GET_MENUS = `query { menus(first: 30) { nodes { id handle title } } }`;

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

async function main() {
  console.log(`\nConnecting to ${STORE}.myshopify.com …\n`);

  const items = TOP_NAV_ITEMS.map(({ title, url }) => ({
    title, type: 'HTTP', url, items: [],
  }));

  const menusData = await gql(GET_MENUS);
  const existing = menusData.menus?.nodes?.find(m => m.handle === 'top-nav');

  if (existing) {
    console.log(`Found existing menu: "${existing.title}" — updating…`);
    const data = await gql(MENU_UPDATE, { id: existing.id, title: 'Top Nav', items });
    const errs = data.menuUpdate?.userErrors || [];
    if (errs.length) throw new Error(errs.map(e => e.message).join('; '));
    console.log(`  ✓ Updated "Top Nav" with ${items.length} links\n`);
  } else {
    console.log('Creating "top-nav" menu…');
    const data = await gql(MENU_CREATE, { title: 'Top Nav', handle: 'top-nav', items });
    const errs = data.menuCreate?.userErrors || [];
    if (errs.length) throw new Error(errs.map(e => e.message).join('; '));
    console.log(`  ✓ Created "Top Nav" with ${items.length} links\n`);
  }

  console.log('Links created:');
  TOP_NAV_ITEMS.forEach(({ title, url }) => console.log(`  ${title.padEnd(22)} → ${url}`));
  console.log('\nNow open Shopify Admin → Online Store → Themes → Customize header');
  console.log('and set "Top utility bar menu" to "Top Nav".\n');
}

main().catch(e => { console.error(`\n✗ ${e.message}\n`); process.exit(1); });
