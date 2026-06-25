'use strict';

/**
 * retag-by-title.js
 *
 * Fixes products that are missing productType / group tags.
 * Two passes:
 *   1. Re-run mapCategory() against the existing productType string
 *      (catches products whose type is a raw TD Synnex category string that
 *       didn't match when first synced but now has a rule).
 *   2. Title-keyword inference for products that still have no type.
 *
 * Usage:
 *   source .env && node scripts/retag-by-title.js            # dry run
 *   source .env && node scripts/retag-by-title.js --apply    # write changes
 */

const STORE = process.env.SHOPIFY_STORE;
const TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;
const API   = process.env.SHOPIFY_API_VERSION || '2026-01';
const APPLY = process.argv.includes('--apply');

if (!STORE || !TOKEN) { console.error('Set SHOPIFY_STORE and SHOPIFY_ACCESS_TOKEN'); process.exit(1); }

const GQL = `https://${STORE}.myshopify.com/admin/api/${API}/graphql.json`;

const { mapCategory, buildTags, normalizeBrand } = require('../src/transform');

// ── Title-based inference rules ───────────────────────────────────────────────
// Applied only when mapCategory(existingType) returns no match.
// ORDERING IS CRITICAL — complete device rules before component/cable rules.

const TITLE_RULES = [
  // ── Complete computer/device products first ───────────────────────────────
  // These must come before storage/memory rules because laptop/desktop titles
  // often include specs like "512GB SSD" or "16GB RAM".

  // KVM must beat Desktop rule ("Desktop KVM" → KVM, not Desktop)
  { re: /\bKVM\b/i,                                     type: 'KVM & AV Splitters',      group: 'computer-accessories', tags: ['kvm'] },

  // Workstations before plain Desktop
  { re: /\bWorkstation\b/i,                             type: 'Workstations',            group: 'computers-portables',  tags: ['workstation','desktop'] },

  // Chromebook before generic Notebook
  { re: /Chromebook/i,                                  type: 'Chromebooks',             group: 'computers-portables',  tags: ['laptop','chromebook'] },

  // All-in-One before Desktop
  { re: /All.in.One PC|AIO PC/i,                        type: 'All-in-One PCs',          group: 'computers-portables',  tags: ['desktop','aio'] },

  // Notebook/Laptop — but NOT accessories: power cord, stand, bag, case, lock, cooler
  { re: /\b(Notebook|Laptop)\b(?!.{0,30}(Cord|Cable|Stand|Bag|Sleeve|Case|Lock|Screen|Filter|Arm|Tray|Mount|Cooler|Fan|Pad|Riser|Strap|Holder))/i,
                                                         type: 'Notebooks',               group: 'computers-portables',  tags: ['laptop','notebook'] },

  // Desktop Computer specifically (not "for Desktop Computer" accessories)
  { re: /Desktop (Computer|PC)\b|Desktop.*\b(i[3579]|Ryzen|Core)\b/i,
                                                         type: 'Desktops',                group: 'computers-portables',  tags: ['desktop'] },

  // Server
  { re: /\bServer\b(?!.{0,20}(Cable|Rack Mount\s*only|Rail Kit))/i,
                                                         type: 'Servers',                 group: 'computers-portables',  tags: ['server'] },

  // Tablets/iPads
  { re: /\bTablet\b|\biPad\b/i,                         type: 'Tablets',                 group: 'computers-portables',  tags: ['tablet'] },

  // ── Monitors & Displays ───────────────────────────────────────────────────
  // Monitor accessories must be caught before the Monitor rule fires.
  // "Monitor Arm/Mount/Stand/Cable/Bracket/Riser/Filter/Extender" are accessories.
  // Also catches "Wall/Desk/Ceiling Mount for Monitor" via trailing "for Monitor".
  { re: /Monitor\s+(Arm|Mount|Stand|Bracket|Riser|Filter|Shield|Extender|Extension|Holder|Clip|Tray)|for\s+(a\s+)?Monitor\b|Monitor.{0,30}(Cable|Cord)|Monitor.{0,20}(Arm|Mount)\b/i,
                                                         type: 'Computer Accessories',    group: 'computer-accessories', tags: ['computer-accessories'] },
  // True monitor: \bMonitor\b but NOT followed within 40 chars by accessory keywords
  { re: /\bMonitor\b(?!.{0,40}(Cable|Cord|Arm\b|Mount\b|Bracket|Riser|Filter|Shield|Extender|Extension|Splitter|Hub|Clip|Tray|Holder|Port\b))/i,
                                                         type: 'Monitors',                group: 'monitors-projectors',  tags: ['monitor'] },
  { re: /\bProjector\b/i,                               type: 'Projectors',              group: 'monitors-projectors',  tags: ['projector'] },
  { re: /\bTelevision\b|\bTV\b.*\d{2}"/i,               type: 'Televisions',             group: 'monitors-projectors',  tags: ['tv','display'] },

  // ── Storage (standalone storage products) ────────────────────────────────
  { re: /\bSSD\b|Solid.State Drive/i,                   type: 'SSDs',                    group: 'storage',              tags: ['storage','ssd'] },
  { re: /\bNVMe\b|\bM\.2\b.*(SSD|Drive)/i,              type: 'SSDs',                    group: 'storage',              tags: ['storage','ssd'] },
  { re: /\bNAS\b|Network.Attached Storage/i,            type: 'NAS',                     group: 'storage',              tags: ['storage','nas'] },
  { re: /External.*(Drive|HDD|SSD|Storage)/i,           type: 'External Storage',        group: 'storage',              tags: ['storage'] },
  { re: /Internal.*(Drive|HDD|SSD|Storage)/i,           type: 'Internal Storage',        group: 'storage',              tags: ['storage'] },
  { re: /Hard.?Disk Drive|HDD\b|Hard Drive/i,           type: 'Internal Storage',        group: 'storage',              tags: ['storage'] },
  { re: /Flash Drive|USB.*Drive|Thumb Drive/i,          type: 'Flash Drives & USB',      group: 'memory',               tags: ['storage','usb'] },
  { re: /Memory Card|SD Card|MicroSD|CF Card|Card Reader/i, type: 'Memory & Card Readers', group: 'memory',            tags: ['memory'] },
  { re: /\bRAM\b|\bDDR[345]\b|\bDIMM\b|\bSODIMM\b/i,   type: 'RAM',                     group: 'memory',               tags: ['memory','ram'] },

  // ── Networking ───────────────────────────────────────────────────────────
  { re: /Network Switch|Ethernet Switch|Managed Switch|Unmanaged Switch|\bSwitch\b.*\d+.?[Pp]ort/i,
                                                         type: 'Switches & Hubs',         group: 'networking',           tags: ['networking','switch'] },
  { re: /\bRouter\b|Wireless.*Gateway/i,                type: 'Routers',                 group: 'networking',           tags: ['networking','router'] },
  { re: /Wireless Access Point|\bWAP\b/i,               type: 'Routers',                 group: 'networking',           tags: ['networking','router'] },
  { re: /Network Adapter|NIC\b|Ethernet Adapter|PCIe.*Network.*Card|Network.*PCIe.*Card/i,
                                                         type: 'Network Adapters',        group: 'networking',           tags: ['networking','adapter'] },
  { re: /Network Cable|Patch Cable|Cat5e?|Cat6a?|Cat7|Ethernet Cable|Fiber.*Cable|Fibre.*Cable/i,
                                                         type: 'Network Cables',          group: 'networking',           tags: ['networking','cable'] },
  { re: /\bModem\b/i,                                   type: 'Modems',                  group: 'networking',           tags: ['networking','modem'] },
  { re: /\bTransceiver\b|SFP\+?|QSFP|Fiber Module/i,   type: 'Repeaters & Transceivers',group: 'networking',           tags: ['networking'] },
  { re: /Video Conferencing|Conference Camera|Conference Room System/i,
                                                         type: 'Video Conferencing',      group: 'networking',           tags: ['av','conferencing'] },
  { re: /\bVoIP\b|IP Phone|Desk Phone.*\bPhone\b/i,    type: 'Telephones',              group: 'networking',           tags: ['phone'] },

  // ── Input Devices ────────────────────────────────────────────────────────
  // Barcode/scanner before generic Scanner
  { re: /Barcode (Scanner|Reader)|Barcode.*Gun/i,       type: 'Barcode Readers',         group: 'input-devices',        tags: ['scanner','barcode'] },
  { re: /\bScanner\b/i,                                 type: 'Scanners',                group: 'input-devices',        tags: ['scanner'] },
  // Keyboard — but NOT "Keyboard Wedge Cable" (a cable with keyboard connector)
  { re: /\bKeyboard\b(?!.{0,20}(Wedge.*Cable|Cable.*Wedge))/i,
                                                         type: 'Keyboards',               group: 'input-devices',        tags: ['keyboard'] },
  { re: /\bMouse\b|\bMice\b/i,                          type: 'Mice',                    group: 'input-devices',        tags: ['mouse'] },
  { re: /Webcam|Web Cam/i,                              type: 'Webcams & Cameras',       group: 'input-devices',        tags: ['camera','webcam'] },
  { re: /Game Controller|Gamepad|Joystick/i,            type: 'Game Controllers',        group: 'input-devices',        tags: ['gaming','controller'] },

  // ── Printers ─────────────────────────────────────────────────────────────
  { re: /Laser Printer/i,                               type: 'Laser Printers',          group: 'printers',             tags: ['printer','laser'] },
  { re: /Inkjet Printer/i,                              type: 'Inkjet Printers',         group: 'printers',             tags: ['printer','inkjet'] },
  { re: /Multifunction.*Printer|MFP\b/i,               type: 'Multifunction Printers',  group: 'printers',             tags: ['printer','mfp'] },
  { re: /Toner Cartridge|Ink Cartridge|Printer Supplies/i, type: 'Printer Supplies',    group: 'printers',             tags: ['printer','supplies'] },
  { re: /\bPrinter\b/i,                                 type: 'Printers',                group: 'printers',             tags: ['printer'] },

  // ── Power ────────────────────────────────────────────────────────────────
  { re: /\bUPS\b|Uninterruptible Power Supply/i,        type: 'UPS',                     group: 'power',                tags: ['power','ups'] },
  { re: /Surge Protector/i,                             type: 'Surge Protectors',        group: 'power',                tags: ['power'] },
  { re: /Power Strip/i,                                 type: 'Power Strips',            group: 'power',                tags: ['power'] },
  { re: /\bBattery\b|\bBatteries\b/i,                   type: 'Batteries',               group: 'power',                tags: ['power','battery'] },
  { re: /Power Supply\b|PSU\b/i,                        type: 'Power Supplies',          group: 'power',                tags: ['power'] },
  // Power cord/cable comes after Battery so "Battery Cable" doesn't hit this
  { re: /Power Cord|AC Adapter\b|AC.*Cord/i,            type: 'Cable Accessories',       group: 'computer-accessories', tags: ['cable'] },

  // ── Computer Accessories ─────────────────────────────────────────────────
  { re: /Docking Station|Port Replicator/i,             type: 'Docking Stations',        group: 'computer-accessories', tags: ['dock'] },
  { re: /Laptop.*(Bag|Sleeve|Case|Backpack)|Notebook.*(Bag|Sleeve|Case)|Carrying Case/i,
                                                         type: 'PC Carrying Cases',       group: 'computer-accessories', tags: ['case','bag'] },

  // ── Consumer Electronics / Audio ─────────────────────────────────────────
  { re: /\bHeadset\b|\bHeadphone\b/i,                   type: 'Headphones & Microphones',group: 'consumer-electronics', tags: ['headphone'] },
  { re: /\bMicrophone\b/i,                              type: 'Headphones & Microphones',group: 'consumer-electronics', tags: ['microphone'] },
  { re: /\bSpeaker\b/i,                                 type: 'Speakers',                group: 'consumer-electronics', tags: ['speaker','audio'] },
  { re: /Fitness Tracker|Smartwatch|Smart Watch/i,      type: 'Fitness & Wearables',     group: 'consumer-electronics', tags: ['wearable','fitness'] },

  // ── Security ─────────────────────────────────────────────────────────────
  { re: /Security Camera|IP Camera|CCTV|Surveillance Camera/i,
                                                         type: 'Security Cameras',        group: 'security',             tags: ['security','camera'] },

  // ── Software ─────────────────────────────────────────────────────────────
  { re: /\bSoftware\b/i,                                type: 'Software',                group: 'software',             tags: ['software'] },

  // ── Networking catch-ups ─────────────────────────────────────────────────
  // "28-Port Smart Managed Gigabit Switch" — port count before "Switch"
  { re: /\d+.?[Pp]ort.*\bSwitch\b|\bPoE.*Switch\b|\bSwitch\b.*PoE/i,
                                                         type: 'Switches & Hubs',         group: 'networking',           tags: ['networking','switch'] },
  { re: /\bRJ45\b|\bRJ-45\b/i,                          type: 'Network Cables',          group: 'networking',           tags: ['networking','cable'] },
  { re: /USB.*Shar.*Switch|Shar.*Switch.*USB/i,         type: 'Switches & Hubs',         group: 'networking',           tags: ['networking','switch'] },

  // ── Power — PDU, SurgeArrest ─────────────────────────────────────────────
  { re: /\bPDU\b|Rack.*Outlets?|Metered Rack/i,         type: 'Power Strips',            group: 'power',                tags: ['power'] },
  { re: /SurgeArrest/i,                                  type: 'Surge Protectors',        group: 'power',                tags: ['power'] },

  // ── Printer supplies — label media, ribbons, printheads ──────────────────
  { re: /Label.*Paper|Label.*Roll|Thermal.*Label|Direct Thermal.*Label/i,
                                                         type: 'Printer Supplies',        group: 'printers',             tags: ['printer','supplies'] },
  { re: /Ribbon Cartridge|Printhead|Print Head/i,       type: 'Printer Supplies',        group: 'printers',             tags: ['printer','supplies'] },
  { re: /CD.*Case|DVD.*Case|Jewel Case/i,               type: 'Cable Accessories',       group: 'computer-accessories', tags: ['storage'] },

  // ── Cables — specific types first, then broad fallback ───────────────────
  { re: /DisplayPort.*Cable|HDMI.*Cable|VGA.*Cable|DVI.*Cable|Thunderbolt.*Cable/i,
                                                         type: 'Display Cables',          group: 'monitors-projectors',  tags: ['cable','display'] },
  { re: /SATA.*Cable|Cable.*SATA/i,                     type: 'Cable Accessories',       group: 'computer-accessories', tags: ['cable'] },
  { re: /USB.*Cable|Cable.*USB/i,                       type: 'Cable Accessories',       group: 'computer-accessories', tags: ['cable'] },
  { re: /\bCable\b/i,                                   type: 'Cable Accessories',       group: 'computer-accessories', tags: ['cable'] },

  // ── Adapters — very last; only if title is clearly about an adapter ───────
  // Exclude "Adaptive" and "for Desktop/Laptop" phrasing
  { re: /\bAdapter\b(?!ive)/i,                          type: 'Input Adapters',          group: 'input-devices',        tags: ['adapter'] },
];

function inferFromTitle(title) {
  for (const rule of TITLE_RULES) {
    if (rule.re.test(title)) {
      return { type: rule.type, group: rule.group, tags: rule.tags };
    }
  }
  return null;
}

// ── GraphQL helpers ───────────────────────────────────────────────────────────

async function gql(query, variables = {}) {
  const res = await fetch(GQL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': TOKEN },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = await res.json();
  if (body.errors?.length) throw new Error(body.errors[0].message);
  return body.data;
}

const UPDATE_PRODUCT = `
  mutation productUpdate($input: ProductInput!) {
    productUpdate(input: $input) {
      product { id productType tags }
      userErrors { field message }
    }
  }
`;

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

async function withRetry(fn, { attempts = 5, baseMs = 1000 } = {}) {
  for (let i = 0; i < attempts; i++) {
    try { return await fn(); }
    catch (e) {
      if (i === attempts - 1) throw e;
      const wait = baseMs * 2 ** i;
      console.error(`  ↻ retry ${i + 1}/${attempts - 1} after ${wait}ms — ${e.message}`);
      await delay(wait);
    }
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n${APPLY ? '🔧 APPLY MODE' : '🔍 DRY RUN'} — ${STORE}.myshopify.com\n`);

  const stats = { scanned: 0, alreadyOk: 0, fixedByRemap: 0, fixedByTitle: 0, noMatch: 0, errors: 0 };
  const noMatchSamples = [];

  let cursor = null;
  let hasNext = true;
  let page = 0;

  while (hasNext) {
    page++;
    const q = `{
      products(first: 250${cursor ? `, after: "${cursor}"` : ''}) {
        edges {
          cursor
          node {
            id title productType vendor
            tags
          }
        }
        pageInfo { hasNextPage }
      }
    }`;

    const data = await withRetry(() => gql(q));
    const edges = data.products.edges;
    hasNext = data.products.pageInfo.hasNextPage;
    if (edges.length) cursor = edges.at(-1).cursor;

    for (const { node } of edges) {
      stats.scanned++;
      const { id, title, productType, vendor, tags } = node;

      // Determine current group tag if any
      const hasGroupTag = tags.some(t =>
        ['computers-portables','monitors-projectors','networking','input-devices',
         'memory','consumer-electronics','gaming','cell-phones','computer-accessories',
         'home-appliances','drones','office','power','printers','security','software','storage']
          .includes(t)
      );

      // Pass 1: re-run mapCategory on existing productType
      let mapped = null;
      if (productType) {
        const result = mapCategory(productType);
        if (result.group) mapped = result; // only use if it resolved to a known group
      }

      // Pass 2: title inference if still no match
      if (!mapped) {
        mapped = inferFromTitle(title);
      }

      if (!mapped) {
        stats.noMatch++;
        if (noMatchSamples.length < 20) noMatchSamples.push({ title, productType });
        continue;
      }

      // Check if an update is needed
      const targetType = mapped.type;
      const targetGroup = mapped.group;
      const targetTagSet = new Set([
        vendor ? vendor.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') : null,
        targetGroup,
        ...mapped.tags,
      ].filter(Boolean));

      const typeOk  = productType === targetType;
      const groupOk = tags.includes(targetGroup);

      if (typeOk && groupOk) {
        stats.alreadyOk++;
        continue;
      }

      // Merge new tags with existing non-group tags (preserve manual tags)
      const keepTags = tags.filter(t => !['computers-portables','monitors-projectors','networking',
        'input-devices','memory','consumer-electronics','gaming','cell-phones','computer-accessories',
        'home-appliances','drones','office','power','printers','security','software','storage',
        'laptop','notebook','desktop','tablet','monitor','keyboard','mouse','server','workstation',
        'printer','cable','adapter','storage','ssd','memory','ram','battery','power','ups',
        'networking','router','switch','adapter','dock','camera','webcam','headphone','microphone',
        'speaker','audio','gaming','controller','barcode','scanner'].includes(t));
      const newTags = [...new Set([...keepTags, ...targetTagSet])];

      const source = !productType || !mapCategory(productType).group ? 'title' : 'remap';
      if (source === 'remap') stats.fixedByRemap++; else stats.fixedByTitle++;

      if (page <= 2 || stats.fixedByTitle + stats.fixedByRemap <= 20) {
        console.log(`  [${source}] "${title.slice(0, 55)}"`);
        console.log(`          type: "${productType || '(none)'}" → "${targetType}"  group: +${targetGroup}`);
      }

      if (APPLY) {
        try {
          const numId = id.replace('gid://shopify/Product/', '');
          const res = await withRetry(() => gql(UPDATE_PRODUCT, { input: { id, productType: targetType, tags: newTags } }));
          const errs = res.productUpdate?.userErrors || [];
          if (errs.length) throw new Error(errs.map(e => e.message).join('; '));
          await delay(150); // ~6 req/s, well under 10 req/s burst
        } catch (e) {
          console.error(`  ✗ ${title.slice(0, 50)}: ${e.message}`);
          stats.errors++;
        }
      }
    }

    if (page % 10 === 0) {
      process.stdout.write(`  … page ${page}, scanned ${stats.scanned.toLocaleString()}\n`);
    }
  }

  console.log(`\n${'─'.repeat(60)}`);
  console.log(`  Scanned:          ${stats.scanned.toLocaleString()}`);
  console.log(`  Already correct:  ${stats.alreadyOk.toLocaleString()}`);
  console.log(`  Fixed by remap:   ${stats.fixedByRemap.toLocaleString()}`);
  console.log(`  Fixed by title:   ${stats.fixedByTitle.toLocaleString()}`);
  console.log(`  No match:         ${stats.noMatch.toLocaleString()}`);
  console.log(`  Errors:           ${stats.errors}`);
  console.log(`${'─'.repeat(60)}`);

  if (noMatchSamples.length) {
    console.log(`\n  Sample unmatched products (first ${noMatchSamples.length}):`);
    noMatchSamples.forEach(({ title, productType }) =>
      console.log(`    "${title.slice(0, 60)}"  [type: "${productType || ''}"]`)
    );
  }

  if (!APPLY) {
    const total = stats.fixedByRemap + stats.fixedByTitle;
    console.log(`\n  Dry run complete. ${total.toLocaleString()} products would be updated.`);
    console.log('  Re-run with --apply to write changes.\n');
  }
}

main().catch(e => { console.error(`\n✗ ${e.message}`); process.exit(1); });
