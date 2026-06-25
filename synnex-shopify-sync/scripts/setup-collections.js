'use strict';

/**
 * setup-collections.js
 *
 * Creates all Shopify automated collections matching the TD Synnex category taxonomy.
 *
 * Top-level collections  → automated by tag (e.g. tag = "computers-portables")
 * Subcategory collections → automated by product_type (e.g. product_type = "Notebooks")
 *
 * Usage:
 *   source .env && node scripts/setup-collections.js
 *
 * Safe to re-run — skips collections that already exist.
 */

const STORE = process.env.SHOPIFY_STORE;
const TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;
const API   = process.env.SHOPIFY_API_VERSION || '2026-01';

if (!STORE || !TOKEN) {
  console.error('❌  Set SHOPIFY_STORE and SHOPIFY_ACCESS_TOKEN before running.');
  process.exit(1);
}

// ── Collection definitions ────────────────────────────────────────────────────

const TOP_LEVEL = [
  { title: 'Computers & Portables',        tag: 'computers-portables' },
  { title: 'Monitors & Projectors',         tag: 'monitors-projectors' },
  { title: 'Networking & Communication',    tag: 'networking' },
  { title: 'Input Devices',                 tag: 'input-devices' },
  { title: 'Memory',                        tag: 'memory' },
  { title: 'Consumer Electronics',          tag: 'consumer-electronics' },
  { title: 'Gaming',                        tag: 'gaming' },
  { title: 'Cell Phones',                   tag: 'cell-phones' },
  { title: 'Computer Accessories',          tag: 'computer-accessories' },
  { title: 'Home Appliances',               tag: 'home-appliances' },
  { title: 'Drones',                        tag: 'drones' },
  { title: 'Office',                        tag: 'office' },
  { title: 'Power',                         tag: 'power' },
  { title: 'Printers',                      tag: 'printers' },
  { title: 'Security',                      tag: 'security' },
  { title: 'Software',                      tag: 'software' },
  { title: 'Storage',                       tag: 'storage' },
];

const SUBCATEGORIES = [
  // Computers & Portables
  { title: 'Notebooks',                     type: 'Notebooks' },
  { title: 'Desktops',                      type: 'Desktops' },
  { title: 'Workstations',                  type: 'Workstations' },
  { title: 'All-in-One PCs',                type: 'All-in-One PCs' },
  { title: 'Chromebooks',                   type: 'Chromebooks' },
  { title: 'Tablets',                       type: 'Tablets' },
  { title: 'Servers',                       type: 'Servers' },
  { title: 'Server Barebones',              type: 'Server Barebones' },
  { title: 'Terminals',                     type: 'Terminals' },
  { title: 'Handhelds & PDAs',              type: 'Handhelds & PDAs' },
  { title: 'AI Desktops',                   type: 'AI Desktops' },
  { title: 'AI Laptops',                    type: 'AI Laptops' },
  { title: 'AI PCs',                        type: 'AI PCs' },
  // Monitors & Projectors
  { title: 'Monitors',                      type: 'Monitors' },
  { title: 'Projectors',                    type: 'Projectors' },
  { title: 'Televisions',                   type: 'Televisions' },
  { title: 'Display Cables',                type: 'Display Cables' },
  // Input Devices
  { title: 'Keyboards',                     type: 'Keyboards' },
  { title: 'Mice',                          type: 'Mice' },
  { title: 'Webcams & Cameras',             type: 'Webcams & Cameras' },
  { title: 'Barcode Readers',               type: 'Barcode Readers' },
  { title: 'Scanners',                      type: 'Scanners' },
  { title: 'Game Controllers',              type: 'Game Controllers' },
  { title: 'Remote Controls',               type: 'Remote Controls' },
  { title: 'Input Adapters',                type: 'Input Adapters' },
  { title: 'Input Cables',                  type: 'Input Cables' },
  { title: 'Input Device Accessories',      type: 'Input Device Accessories' },
  // Memory
  { title: 'RAM',                           type: 'RAM' },
  { title: 'Flash Drives & USB',            type: 'Flash Drives & USB' },
  { title: 'Memory & Card Readers',         type: 'Memory & Card Readers' },
  { title: 'Cache Memory',                  type: 'Cache Memory' },
  // Networking
  { title: 'Routers',                       type: 'Routers' },
  { title: 'Switches & Hubs',               type: 'Switches & Hubs' },
  { title: 'Network Adapters',              type: 'Network Adapters' },
  { title: 'Network Cables',                type: 'Network Cables' },
  { title: 'Network Accessories',           type: 'Network Accessories' },
  { title: 'Modems',                        type: 'Modems' },
  { title: 'Antennas',                      type: 'Antennas' },
  { title: 'Video Conferencing',            type: 'Video Conferencing' },
  { title: 'Telephones',                    type: 'Telephones' },
  { title: 'Network Devices',               type: 'Network Devices' },
  { title: 'Print Servers',                 type: 'Print Servers' },
  { title: 'Repeaters & Transceivers',      type: 'Repeaters & Transceivers' },
  // Consumer Electronics
  { title: 'Speakers',                      type: 'Speakers' },
  { title: 'Headphones & Microphones',      type: 'Headphones & Microphones' },
  { title: 'Bluetooth Headphones',          type: 'Bluetooth Headphones' },
  { title: 'Home Audio',                    type: 'Home Audio' },
  { title: 'Portable Audio',                type: 'Portable Audio' },
  { title: 'Digital Cameras',               type: 'Digital Cameras' },
  { title: 'Camcorders',                    type: 'Camcorders' },
  { title: 'AV Accessories',                type: 'AV Accessories' },
  { title: 'AV Cables',                     type: 'AV Cables' },
  { title: 'AV Players & Recorders',        type: 'AV Players & Recorders' },
  { title: 'Fitness & Wearables',           type: 'Fitness & Wearables' },
  { title: 'GPS',                           type: 'GPS' },
  // Cell Phones
  { title: 'iPhones',                       type: 'iPhones' },
  { title: 'Android Phones',               type: 'Android Phones' },
  { title: 'iPhone Cases',                  type: 'iPhone Cases' },
  { title: 'Android Cases',                 type: 'Android Cases' },
  { title: 'Phone Chargers',                type: 'Phone Chargers' },
  { title: 'Cell Phone Accessories',        type: 'Cell Phone Accessories' },
  // Computer Accessories
  { title: 'Docking Stations',              type: 'Docking Stations' },
  { title: 'KVM & AV Splitters',            type: 'KVM & AV Splitters' },
  { title: 'Cable Accessories',             type: 'Cable Accessories' },
  { title: 'PC Carrying Cases',             type: 'PC Carrying Cases' },
  // Gaming
  { title: 'Gaming Systems',                type: 'Gaming Systems' },
  { title: 'Gaming Accessories',            type: 'Gaming Accessories' },
  { title: 'Console Software',              type: 'Console Software' },
  // Home Appliances
  { title: 'Vacuums',                       type: 'Vacuums' },
  { title: 'Fans',                          type: 'Fans' },
  { title: 'Water Coolers',                 type: 'Water Coolers' },
  // Printers
  { title: 'Laser Printers',               type: 'Laser Printers' },
  { title: 'Inkjet Printers',               type: 'Inkjet Printers' },
  { title: 'Multifunction Printers',        type: 'Multifunction Printers' },
  { title: 'Printer Supplies',              type: 'Printer Supplies' },
  // Storage
  { title: 'SSDs',                          type: 'SSDs' },
  { title: 'External Storage',              type: 'External Storage' },
  { title: 'Internal Storage',              type: 'Internal Storage' },
  { title: 'NAS',                           type: 'NAS' },
  // Power
  { title: 'UPS',                           type: 'UPS' },
  { title: 'Surge Protectors',              type: 'Surge Protectors' },
  { title: 'Batteries',                     type: 'Batteries' },
  // Security
  { title: 'Security Cameras',              type: 'Security Cameras' },
];

// ── GraphQL helpers ───────────────────────────────────────────────────────────

const GQL_URL = `https://${STORE}.myshopify.com/admin/api/${API}/graphql.json`;

async function gql(query, variables = {}) {
  const res = await fetch(GQL_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': TOKEN,
    },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
  const body = await res.json();
  if (body.errors?.length) throw new Error(body.errors[0].message);
  return body.data;
}

const CREATE_COLLECTION = `
  mutation collectionCreate($input: CollectionInput!) {
    collectionCreate(input: $input) {
      collection { id title handle }
      userErrors { field message }
    }
  }
`;

const GET_COLLECTION_BY_HANDLE = `
  query ($handle: String!) {
    collectionByHandle(handle: $handle) { id title }
  }
`;

function toHandle(title) {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

async function collectionExists(handle) {
  const data = await gql(GET_COLLECTION_BY_HANDLE, { handle });
  return !!data.collectionByHandle;
}

async function createCollection(input) {
  const data = await gql(CREATE_COLLECTION, { input });
  const { collection, userErrors } = data.collectionCreate;
  if (userErrors?.length) {
    const alreadyExists = userErrors.some(e => e.message.toLowerCase().includes('already'));
    if (alreadyExists) return { skipped: true, title: input.title };
    throw new Error(userErrors.map(e => e.message).join('; '));
  }
  return { created: true, title: collection.title, handle: collection.handle };
}

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  let created = 0;
  let skipped = 0;
  let errors  = 0;

  console.log(`\nConnecting to ${STORE}.myshopify.com …\n`);

  // Top-level collections (automated by tag)
  console.log(`── Top-level collections (${TOP_LEVEL.length}) ──────────────────`);
  for (const { title, tag } of TOP_LEVEL) {
    const handle = toHandle(title);
    try {
      if (await collectionExists(handle)) {
        console.log(`  SKIP  ${title}`);
        skipped++;
      } else {
        const res = await createCollection({
          title,
          ruleSet: {
            appliedDisjunctively: false,
            rules: [{ column: 'TAG', relation: 'EQUALS', condition: tag }],
          },
        });
        if (res.skipped) { console.log(`  SKIP  ${title}`); skipped++; }
        else             { console.log(`  ✓     ${title}  (/${res.handle})`); created++; }
      }
    } catch (e) {
      console.error(`  ✗     ${title}: ${e.message}`);
      errors++;
    }
    await delay(250); // stay well within rate limits
  }

  // Subcategory collections (automated by product_type)
  console.log(`\n── Subcategory collections (${SUBCATEGORIES.length}) ──────────────────`);
  for (const { title, type } of SUBCATEGORIES) {
    const handle = toHandle(title);
    try {
      if (await collectionExists(handle)) {
        console.log(`  SKIP  ${title}`);
        skipped++;
      } else {
        const res = await createCollection({
          title,
          ruleSet: {
            appliedDisjunctively: false,
            rules: [{ column: 'TYPE', relation: 'EQUALS', condition: type }],
          },
        });
        if (res.skipped) { console.log(`  SKIP  ${title}`); skipped++; }
        else             { console.log(`  ✓     ${title}  (/${res.handle})`); created++; }
      }
    } catch (e) {
      console.error(`  ✗     ${title}: ${e.message}`);
      errors++;
    }
    await delay(250);
  }

  console.log(`\n──────────────────────────────────────────────`);
  console.log(`  Created: ${created}  |  Skipped: ${skipped}  |  Errors: ${errors}`);
  console.log(`──────────────────────────────────────────────\n`);
}

main().catch(e => { console.error(e); process.exit(1); });
