'use strict';

const { config } = require('./config');
const { categorize } = require('./categorize');

/**
 * Map raw TD Synnex manufacturer names to clean, customer-facing brand names.
 *
 * TD Synnex appends internal suffixes like "CTO" (Configure To Order) and
 * uses legal entity names like "DELL MARKETING L.P." — none of which should
 * appear on the storefront or be sent to Icecat for image lookups.
 */
const BRAND_MAP = {
  'apple cto':                 'Apple',
  'apple':                     'Apple',
  'dell marketing l.p.':       'Dell',
  'dell marketing lp':         'Dell',
  'dell':                      'Dell',
  'acer america corporation':  'Acer',
  'acer america corp':         'Acer',
  'acer':                      'Acer',
  'logitech inc':              'Logitech',
  'logitech':                  'Logitech',
  'asus':                      'ASUS',
  'lenovo':                    'Lenovo',
  'hp inc':                    'HP',
  'hp':                        'HP',
  'microsoft corporation':     'Microsoft',
  'microsoft':                 'Microsoft',
  'samsung electronics':       'Samsung',
  'samsung':                   'Samsung',
};

/**
 * Normalise a raw TD Synnex manufacturer name to a clean brand name.
 * Falls back to title-casing the raw value if no mapping is found.
 */
function normalizeBrand(raw) {
  if (!raw) return raw;
  const key = raw.trim().toLowerCase();
  if (BRAND_MAP[key]) return BRAND_MAP[key];

  // Strip trailing " CTO" (or "- CTO") that Synnex appends to some brands
  const stripped = key.replace(/[\s-]+cto$/i, '').trim();
  if (BRAND_MAP[stripped]) return BRAND_MAP[stripped];

  // Title-case as a best-effort fallback (e.g. "BELKIN" → "Belkin")
  return raw.trim().replace(/\w\S*/g, w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase());
}

/**
 * Strip distributor-internal noise from a product title before showing it
 * to customers or sending it to Icecat.
 *
 * Examples:
 *   "MacBook Pro 14 CTO"          → "MacBook Pro 14"
 *   "MacBook Pro 14 - CTO"        → "MacBook Pro 14"
 *   "ThinkPad X1 Carbon Gen 12"   → unchanged
 */
function cleanTitle(title) {
  if (!title) return title;
  return title
    .replace(/^CTO[\s-]+/i, '')      // leading "CTO " or "CTO-"
    .replace(/[\s-]+CTO\s*$/i, '')   // trailing "CTO" or "- CTO"
    .replace(/\s{2,}/g, ' ')         // collapse double spaces
    .trim();
}

/**
 * Expand Apple-specific TD Synnex CTO title abbreviations into a clean,
 * customer-facing product name.
 *
 * Apple CTO products are custom-configured and not in Icecat, so we expand
 * the warehouse shorthand ourselves.
 *
 * "CTO MBP 14 M5 MAX 18 CPU 32 GPU 36GB 2TB SLVR SPLA"
 *   → "MacBook Pro 14\" M5 Max 18-core CPU 32-core GPU 36GB 2TB Silver"
 */
function expandAppleTitle(raw) {
  let t = (raw || '')
    .replace(/^CTO[\s-]+/i, '')
    .replace(/[\s-]+SPLA\b/gi, '')
    .replace(/\bW\/\s+SPANISH.*$/i, '')
    .replace(/\bSPANISH.*$/i, '')
    .replace(/\(LATIN\s+AMERI[^)]*\)/gi, '')
    .trim();

  // Product names
  t = t
    .replace(/\bMBP\b/gi, 'MacBook Pro')
    .replace(/\bMBA\b/gi, 'MacBook Air')
    .replace(/\bIMAC\b/gi, 'iMac')
    .replace(/\bMAC\s+MINI\b/gi, 'Mac Mini')
    .replace(/\bMAC\s+PRO\b/gi, 'Mac Pro');

  // Colours
  t = t
    .replace(/\bSLVR\b/gi, 'Silver')
    .replace(/\bSPACE\s+BLACK\b/gi, 'Space Black')
    .replace(/\bMIDNIGHT\b/gi, 'Midnight')
    .replace(/\bSTARLIGHT\b/gi, 'Starlight')
    .replace(/\bSPACE\s+GR[AE]Y\b/gi, 'Space Gray')
    .replace(/\bGLD\b/gi, 'Gold')
    .replace(/\b(SILVER|BLACK|GOLD|BLUE|PINK|PURPLE|RED|WHITE|GRAY|GREY)\b/g,
      w => w.charAt(0) + w.slice(1).toLowerCase());

  // Chip tier casing
  t = t.replace(/\b(MAX|PRO)\b/g, w => w.charAt(0) + w.slice(1).toLowerCase());

  // Core counts: "18 CPU" or "18CPU" → "18-core CPU"
  t = t.replace(/(\d+)\s*CPU\b/gi, '$1-core CPU');
  t = t.replace(/(\d+)\s*GPU\b/gi, '$1-core GPU');
  t = t.replace(/(\d+)C\b(?!\s*PU)/gi, '$1-core');

  // Screen size: "MacBook Pro 14" → 'MacBook Pro 14"'
  t = t.replace(/(MacBook (?:Pro|Air))\s+(\d+(?:\.\d+)?)\b/gi, '$1 $2"');

  // Strip trailing wattage (charger spec, not a product feature)
  t = t.replace(/\s+\d+W\s*$/i, '');

  // Strip internal codes and locale suffixes
  t = t.replace(/\b(TID|NK|TP|SL)\b/gi, '');
  t = t.replace(/\b(GERMAN|HEBREW|FRENCH|JAPANESE|KOREAN|ARABIC|CHINESE|ITALIAN|NORDIC)\b/gi, '');

  return t.replace(/\s{2,}/g, ' ').trim();
}

/**
 * Apply the configured price markup to a TD Synnex cost price.
 * PRICE_MARKUP_PERCENT=15 means the customer pays cost × 1.15.
 */
function applyMarkup(costPrice) {
  const pct = config.sync.markupPercent;
  const base = Number(costPrice);
  if (!pct || !Number.isFinite(base)) return base;
  return Math.round(base * (1 + pct / 100) * 100) / 100;
}

/** Convert a part number to a Shopify-safe URL handle. */
function toHandle(str) {
  return String(str)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Full TD Synnex category taxonomy mapped to Shopify productType + tags.
 *
 * Each rule matches against field[35] of the .ap flat file — the full human-readable
 * TD Synnex category name (e.g. "Notebooks", "Mice / Pointing Devices").
 *
 * `type`  → Shopify productType  (subcategory — used for sub-collection automated rules)
 * `group` → top-level group tag  (e.g. "computers-portables" — used for top-level collections)
 * `tags`  → additional searchable tags on the product
 */
const CATEGORY_MAP = [
  // ── Cell Phones ──────────────────────────────────────────────────────────────
  { match: /Android Cables?/i,                    type: 'Android Cables',            group: 'cell-phones',          tags: ['android', 'cable'] },
  { match: /Android Cases?/i,                     type: 'Android Cases',             group: 'cell-phones',          tags: ['android', 'case'] },
  { match: /Android Phones?/i,                    type: 'Android Phones',            group: 'cell-phones',          tags: ['android', 'phone'] },
  { match: /Cell Phone Accessories/i,             type: 'Cell Phone Accessories',    group: 'cell-phones',          tags: ['phone-accessory'] },
  { match: /Phone Chargers?/i,                    type: 'Phone Chargers',            group: 'cell-phones',          tags: ['charger'] },
  { match: /iPhone Cables?/i,                     type: 'iPhone Cables',             group: 'cell-phones',          tags: ['iphone', 'cable'] },
  { match: /iPhone Cases?/i,                      type: 'iPhone Cases',              group: 'cell-phones',          tags: ['iphone', 'case'] },
  { match: /^iPhones?$/i,                         type: 'iPhones',                   group: 'cell-phones',          tags: ['iphone', 'phone'] },

  // ── Computer Accessories ─────────────────────────────────────────────────────
  { match: /Cable Accessories/i,                  type: 'Cable Accessories',         group: 'computer-accessories', tags: ['cable'] },
  { match: /KVM|AV Splitters?/i,                  type: 'KVM & AV Splitters',        group: 'computer-accessories', tags: ['kvm'] },
  { match: /PC Carrying Cases?/i,                 type: 'PC Carrying Cases',         group: 'computer-accessories', tags: ['case', 'bag'] },
  { match: /Port Replicators?|Docking/i,          type: 'Docking Stations',          group: 'computer-accessories', tags: ['dock'] },
  { match: /^Computer Accessories$/i,             type: 'Computer Accessories',      group: 'computer-accessories', tags: ['accessory'] },

  // ── Computers and Portables ──────────────────────────────────────────────────
  { match: /AI Desktops?/i,                       type: 'AI Desktops',               group: 'computers-portables',  tags: ['desktop', 'ai'] },
  { match: /AI Laptops?/i,                        type: 'AI Laptops',                group: 'computers-portables',  tags: ['laptop', 'ai'] },
  { match: /\bAI PC\b/i,                          type: 'AI PCs',                    group: 'computers-portables',  tags: ['desktop', 'ai'] },
  { match: /All.in.one|All in one|\bAIO\b/i,      type: 'All-in-One PCs',            group: 'computers-portables',  tags: ['desktop', 'aio'] },
  { match: /Chromebooks?/i,                       type: 'Chromebooks',               group: 'computers-portables',  tags: ['laptop', 'chromebook'] },
  { match: /^Desktops?$/i,                        type: 'Desktops',                  group: 'computers-portables',  tags: ['desktop'] },
  { match: /Handhelds?|PDAs?/i,                   type: 'Handhelds & PDAs',          group: 'computers-portables',  tags: ['handheld'] },
  { match: /Notebooks?|Laptops?/i,                type: 'Notebooks',                 group: 'computers-portables',  tags: ['laptop', 'notebook'] },
  { match: /Server Barebones?/i,                  type: 'Server Barebones',          group: 'computers-portables',  tags: ['server'] },
  { match: /^Servers?$/i,                         type: 'Servers',                   group: 'computers-portables',  tags: ['server'] },
  { match: /Tablet PCs?|Tablets?|\bIPAD\b/i,     type: 'Tablets',                   group: 'computers-portables',  tags: ['tablet'] },
  { match: /Terminals?|Network Computers?/i,      type: 'Terminals',                 group: 'computers-portables',  tags: ['terminal'] },
  { match: /Workstations?/i,                      type: 'Workstations',              group: 'computers-portables',  tags: ['workstation', 'desktop'] },

  // ── Consumer Electronics ─────────────────────────────────────────────────────
  { match: /AV Accessories/i,                     type: 'AV Accessories',            group: 'consumer-electronics', tags: ['av'] },
  { match: /AV Cables?/i,                         type: 'AV Cables',                 group: 'consumer-electronics', tags: ['av', 'cable'] },
  { match: /AV Furniture/i,                       type: 'AV Furniture',              group: 'consumer-electronics', tags: ['av'] },
  { match: /Bluetooth Headphones?/i,              type: 'Bluetooth Headphones',      group: 'consumer-electronics', tags: ['headphone', 'bluetooth'] },
  { match: /CE Carrying Cases?/i,                 type: 'CE Carrying Cases',         group: 'consumer-electronics', tags: ['case', 'bag'] },
  { match: /Camcorders?/i,                        type: 'Camcorders',                group: 'consumer-electronics', tags: ['camera'] },
  { match: /Combined AV/i,                        type: 'Combined AV Devices',       group: 'consumer-electronics', tags: ['av'] },
  { match: /Digital AV Players?|DVD Players?|AV Players?/i, type: 'AV Players & Recorders', group: 'consumer-electronics', tags: ['av'] },
  { match: /Digital Cameras?/i,                   type: 'Digital Cameras',           group: 'consumer-electronics', tags: ['camera'] },
  { match: /Eyewear/i,                            type: 'Eyewear',                   group: 'consumer-electronics', tags: ['wearable'] },
  { match: /Fitness|Smartwatches?/i,              type: 'Fitness & Wearables',       group: 'consumer-electronics', tags: ['wearable', 'fitness'] },
  { match: /GPS Receivers?/i,                     type: 'GPS',                       group: 'consumer-electronics', tags: ['gps'] },
  { match: /Headphones? & Microphones?/i,         type: 'Headphones & Microphones',  group: 'consumer-electronics', tags: ['headphone', 'microphone'] },
  { match: /\bHealth\b/i,                         type: 'Health Devices',            group: 'consumer-electronics', tags: ['health'] },
  { match: /Home Audios?/i,                       type: 'Home Audio',                group: 'consumer-electronics', tags: ['audio'] },
  { match: /Optical System/i,                     type: 'Optical Systems',           group: 'consumer-electronics', tags: ['optical'] },
  { match: /Portable Audios?/i,                   type: 'Portable Audio',            group: 'consumer-electronics', tags: ['audio'] },
  { match: /Speakers?/i,                          type: 'Speakers',                  group: 'consumer-electronics', tags: ['speaker', 'audio'] },

  // ── Drones ───────────────────────────────────────────────────────────────────
  { match: /Drones?/i,                            type: 'Drones',                    group: 'drones',               tags: ['drone'] },

  // ── Gaming ───────────────────────────────────────────────────────────────────
  { match: /Console Software/i,                   type: 'Console Software',          group: 'gaming',               tags: ['gaming', 'software'] },
  { match: /Gaming Accessories/i,                 type: 'Gaming Accessories',        group: 'gaming',               tags: ['gaming'] },
  { match: /Gaming Systems?/i,                    type: 'Gaming Systems',            group: 'gaming',               tags: ['gaming'] },
  { match: /\bPC Software\b/i,                    type: 'PC Software',               group: 'gaming',               tags: ['gaming', 'software'] },

  // ── Home Appliances ──────────────────────────────────────────────────────────
  { match: /\bFans?\b/i,                          type: 'Fans',                      group: 'home-appliances',      tags: ['appliance'] },
  { match: /Massage Chairs?/i,                    type: 'Massage Chairs',            group: 'home-appliances',      tags: ['appliance'] },
  { match: /Vacuums?/i,                           type: 'Vacuums',                   group: 'home-appliances',      tags: ['appliance'] },
  { match: /Water Coolers?/i,                     type: 'Water Coolers',             group: 'home-appliances',      tags: ['appliance'] },
  { match: /Other Appliances?|Home Appliances?/i, type: 'Appliances',               group: 'home-appliances',      tags: ['appliance'] },

  // ── Input Devices and Document Imaging ───────────────────────────────────────
  { match: /Barcode Readers?/i,                   type: 'Barcode Readers',           group: 'input-devices',        tags: ['scanner', 'barcode'] },
  { match: /Game Controllers?|Joy\s*Sticks?/i,    type: 'Game Controllers',          group: 'input-devices',        tags: ['gaming', 'controller'] },
  { match: /Input Adapters?/i,                    type: 'Input Adapters',            group: 'input-devices',        tags: ['adapter'] },
  { match: /Input Cables?/i,                      type: 'Input Cables',              group: 'input-devices',        tags: ['cable'] },
  { match: /Input Device Accessories/i,           type: 'Input Device Accessories',  group: 'input-devices',        tags: ['accessory'] },
  { match: /Keyboards?|Keypads?/i,                type: 'Keyboards',                 group: 'input-devices',        tags: ['keyboard'] },
  { match: /Mice|Pointing Devices?/i,             type: 'Mice',                      group: 'input-devices',        tags: ['mouse'] },
  { match: /PC & Network Cameras?|Webcams?/i,     type: 'Webcams & Cameras',         group: 'input-devices',        tags: ['camera', 'webcam'] },
  { match: /Remote Controls?/i,                   type: 'Remote Controls',           group: 'input-devices',        tags: ['remote'] },
  { match: /Scanners?/i,                          type: 'Scanners',                  group: 'input-devices',        tags: ['scanner'] },

  // ── Memory ───────────────────────────────────────────────────────────────────
  { match: /Cache Memories?/i,                    type: 'Cache Memory',              group: 'memory',               tags: ['memory'] },
  { match: /Flash USB|USB Drives?/i,              type: 'Flash Drives & USB',        group: 'memory',               tags: ['storage', 'usb'] },
  { match: /Memory Boards?|Card Readers?/i,       type: 'Memory & Card Readers',     group: 'memory',               tags: ['memory'] },
  { match: /RAM Modules?/i,                       type: 'RAM',                       group: 'memory',               tags: ['memory', 'ram'] },
  { match: /Read.Only Memories?/i,                type: 'ROM',                       group: 'memory',               tags: ['memory'] },
  { match: /\bMemory\b/i,                         type: 'Memory',                    group: 'memory',               tags: ['memory', 'ram'] },

  // ── Monitors & Projectors ────────────────────────────────────────────────────
  { match: /Display Cables?/i,                    type: 'Display Cables',            group: 'computer-accessories', tags: ['cable', 'display'] },
  { match: /^Monitors?$/i,                        type: 'Monitors',                  group: 'monitors-projectors',  tags: ['monitor'] },
  { match: /Projectors?/i,                        type: 'Projectors',                group: 'monitors-projectors',  tags: ['projector'] },
  { match: /Televisions?|\bTVs?\b/i,              type: 'Televisions',               group: 'monitors-projectors',  tags: ['tv', 'display'] },

  // ── Networking & Communication ────────────────────────────────────────────────
  { match: /Antennas?/i,                          type: 'Antennas',                  group: 'networking',           tags: ['networking'] },
  { match: /Bridges?.*Routers?|Routers?/i,        type: 'Routers',                   group: 'networking',           tags: ['networking', 'router'] },
  { match: /Concentrators?|Multiplexers?/i,       type: 'Network Multiplexers',      group: 'networking',           tags: ['networking'] },
  { match: /Hubs?.*Switches?|Switches?.*Hubs?|Network Switches?/i, type: 'Switches & Hubs', group: 'networking',   tags: ['networking', 'switch'] },
  { match: /Management Software/i,               type: 'Network Management',         group: 'networking',           tags: ['networking', 'software'] },
  { match: /Modems?/i,                            type: 'Modems',                    group: 'networking',           tags: ['networking', 'modem'] },
  { match: /Network Accessories/i,               type: 'Network Accessories',        group: 'networking',           tags: ['networking'] },
  { match: /Network Adapters?/i,                  type: 'Network Adapters',          group: 'networking',           tags: ['networking', 'adapter'] },
  { match: /Network Cables?/i,                    type: 'Network Cables',            group: 'networking',           tags: ['networking', 'cable'] },
  { match: /Network Devices?/i,                   type: 'Network Devices',           group: 'networking',           tags: ['networking'] },
  { match: /Other Communication/i,               type: 'Communication Devices',      group: 'networking',           tags: ['networking'] },
  { match: /Print Servers?|Printer Servers?/i,    type: 'Print Servers',             group: 'networking',           tags: ['networking', 'printer'] },
  { match: /Repeaters?|Transceivers?/i,           type: 'Repeaters & Transceivers',  group: 'networking',           tags: ['networking'] },
  { match: /Telephones?/i,                        type: 'Telephones',                group: 'networking',           tags: ['phone'] },
  { match: /Video Conferencing/i,                 type: 'Video Conferencing',        group: 'networking',           tags: ['av', 'conferencing'] },

  // ── Office Machines & Supplies ────────────────────────────────────────────────
  { match: /Calculators?/i,                       type: 'Calculators',               group: 'office',               tags: ['office'] },
  { match: /Label Makers?|Label Printers?/i,      type: 'Label Makers',              group: 'office',               tags: ['office', 'printer'] },
  { match: /Office Supplies/i,                    type: 'Office Supplies',           group: 'office',               tags: ['office'] },
  { match: /Shredders?/i,                         type: 'Shredders',                 group: 'office',               tags: ['office'] },
  { match: /Whiteboards?|Presentation/i,          type: 'Presentation Equipment',    group: 'office',               tags: ['office'] },

  // ── Power ────────────────────────────────────────────────────────────────────
  { match: /Surge Protectors?/i,                  type: 'Surge Protectors',          group: 'power',                tags: ['power'] },
  { match: /UPS|Uninterruptible/i,                type: 'UPS',                       group: 'power',                tags: ['power', 'ups'] },
  { match: /Power Strips?/i,                      type: 'Power Strips',              group: 'power',                tags: ['power'] },
  { match: /Batteries?/i,                         type: 'Batteries',                 group: 'power',                tags: ['power', 'battery'] },
  { match: /Power Supplies|PSU/i,                 type: 'Power Supplies',            group: 'power',                tags: ['power'] },

  // ── Printers & Scanners ───────────────────────────────────────────────────────
  { match: /Inkjet Printers?/i,                   type: 'Inkjet Printers',           group: 'printers',             tags: ['printer', 'inkjet'] },
  { match: /Laser Printers?/i,                    type: 'Laser Printers',            group: 'printers',             tags: ['printer', 'laser'] },
  { match: /Multifunction.*Printers?|MFP/i,       type: 'Multifunction Printers',    group: 'printers',             tags: ['printer', 'mfp'] },
  { match: /Printer (Ink|Toner|Supplies)/i,        type: 'Printer Supplies',          group: 'printers',             tags: ['printer', 'supplies'] },
  { match: /Printers?/i,                          type: 'Printers',                  group: 'printers',             tags: ['printer'] },

  // ── Security ─────────────────────────────────────────────────────────────────
  { match: /Security Cameras?|Surveillance/i,     type: 'Security Cameras',          group: 'security',             tags: ['security', 'camera'] },
  { match: /Access Control/i,                     type: 'Access Control',            group: 'security',             tags: ['security'] },
  { match: /Biometric/i,                          type: 'Biometric Devices',         group: 'security',             tags: ['security'] },

  // ── Software ─────────────────────────────────────────────────────────────────
  { match: /\bSoftware\b/i,                       type: 'Software',                  group: 'software',             tags: ['software'] },

  // ── Storage ──────────────────────────────────────────────────────────────────
  { match: /External (Drives?|Storage|HDDs?|SSDs?)/i, type: 'External Storage',     group: 'storage',              tags: ['storage'] },
  { match: /Internal (Drives?|Storage|HDDs?|SSDs?)/i, type: 'Internal Storage',     group: 'storage',              tags: ['storage'] },
  { match: /NAS|Network Attached/i,               type: 'NAS',                       group: 'storage',              tags: ['storage', 'nas'] },
  { match: /Optical Drives?/i,                    type: 'Optical Drives',            group: 'storage',              tags: ['storage'] },
  { match: /\bSSD\b/i,                            type: 'SSDs',                      group: 'storage',              tags: ['storage', 'ssd'] },
  { match: /\bStorage\b/i,                        type: 'Storage',                   group: 'storage',              tags: ['storage'] },
];

function mapCategory(rawCategory) {
  for (const rule of CATEGORY_MAP) {
    if (rule.match.test(rawCategory || '')) {
      return { type: rule.type, group: rule.group, tags: rule.tags };
    }
  }
  return { type: rawCategory || undefined, group: undefined, tags: [] };
}

/**
 * Build a tag list for a product: vendor tag + group tag + subcategory tags.
 * The group tag (e.g. "computers-portables") powers top-level Shopify collections.
 * Categorization is UNSPSC-driven (see categorize.js); pass the full product so it
 * has unspsc + description, not just the (unreliable) field[35] category.
 */
function buildTags(manufacturer, product) {
  const cat = typeof product === 'string'
    ? categorize({ category: product })            // back-compat: category string only
    : categorize({ unspsc: product?.unspsc, description: product?.description, category: product?.category, manufacturer });
  const vendorTag = (manufacturer || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return [...new Set([vendorTag, cat.group, ...cat.tags].filter(Boolean))];
}

/**
 * Convert a parsed Synnex catalog product to a Shopify productSet input.
 *
 * @param {object} product - Output from parseCatalogXml()
 * @param {string} [enrichedDescription] - Full HTML description from Icecat (optional)
 * @returns {object} ProductSetInput for the Shopify GraphQL mutation
 */
function toShopifyProduct(product, enrichedDescription) {
  const { synnexSku, mfrPartNumber, description, manufacturer, category, price, msrp, quantityAvailable } = product;
  const sku = synnexSku || mfrPartNumber;
  const sellingPrice = applyMarkup(price);

  // Only include price fields when we actually have a valid cost price.
  // In fast-sync mode (reading from DynamoDB) price is undefined — omitting it
  // leaves the existing Shopify price untouched. Price-sync handles pricing anyway.
  const hasValidPrice = Number.isFinite(sellingPrice);

  // Show MSRP as compare-at only when it's higher than the selling price
  const compareAtPrice = hasValidPrice && msrp && msrp > sellingPrice ? msrp : undefined;

  const { locationId } = config.shopify;

  // Activate inventory at the configured location so price-sync can later set quantities.
  // productSet accepts inventoryQuantities to create+activate inventory in one call.
  const inventoryQuantities =
    locationId && quantityAvailable != null
      ? [{ locationId, name: 'available', quantity: Math.max(0, quantityAvailable) }]
      : undefined;

  const { type: productType } = categorize({ unspsc: product.unspsc, description, category, manufacturer });
  const tags = buildTags(manufacturer, product);
  // group tag is already included in buildTags output via the group field

  const rawTitle = cleanTitle(description) || sku;
  const cleanedTitle = rawTitle.length > 255
    ? rawTitle.slice(0, 255).replace(/\s\S*$/, '').trim() || rawTitle.slice(0, 255).trim()
    : rawTitle;
  const vendor = normalizeBrand(manufacturer);

  return {
    title: cleanedTitle,
    // Use MPN for the URL handle (more SEO-friendly than the numeric Synnex internal ID)
    handle: toHandle(mfrPartNumber || sku),
    descriptionHtml: enrichedDescription || undefined,
    vendor: vendor || undefined,
    productType: productType || undefined,
    tags,
    status: 'ACTIVE',
    // Shopify requires at least one option even for single-variant products
    productOptions: [{ name: 'Title', values: [{ name: 'Default Title' }] }],
    variants: [
      {
        // sku = Synnex internal catalog ID — used by price-sync to query the XML P&A API
        sku,
        // barcode stores the manufacturer part number so merchants can identify the product
        barcode: mfrPartNumber || undefined,
        ...(hasValidPrice ? { price: String(sellingPrice) } : {}),
        ...(compareAtPrice != null ? { compareAtPrice: String(compareAtPrice) } : {}),
        inventoryPolicy: 'CONTINUE',
        inventoryItem: { tracked: true },
        ...(inventoryQuantities ? { inventoryQuantities } : {}),
        optionValues: [{ optionName: 'Title', name: 'Default Title' }],
      },
    ],
  };
}

module.exports = { toShopifyProduct, applyMarkup, mapCategory, buildTags, normalizeBrand, cleanTitle, expandAppleTitle };
