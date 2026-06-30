'use strict';

/**
 * Lambda handler for TD Synnex ↔ Shopify integration.
 *
 * Jobs:
 *   catalog-sync       – Daily: SFTP → parse catalog → create/update Shopify products
 *   targeted-discover  – One-off: sync only specific types/tags (keyboards, mice, monitors…)
 *   scan-catalog       – Diagnostic: count catalog rows by type/tag — no Shopify writes
 *   price-sync         – Hourly: TD Synnex XML P&A → update prices + inventory
 *   submit-orders      – Every 5 min: pick up pending Shopify orders → submit to TD Synnex
 *   check-tracking     – Every 30 min: check TD Synnex order status → update Shopify fulfillments
 *
 * Webhook:
 *   POST /webhook/orders  – Shopify orders/paid webhook → queue order for fulfillment
 *
 * Event routing:
 *   EventBridge:   { "job": "catalog-sync" } | { "job": "price-sync" } | etc.
 *   HTTP POST:     POST /catalog-sync | /price-sync | /webhook/orders
 *   Direct invoke: { "job": "submit-orders" }
 */

const { config, isSftpConfigured, isXmlConfigured, validateShopify } = require('./config');
const { streamCatalogLines, listZipEntries } = require('./synnex/sftp');
const { createLineParser } = require('./synnex/catalog');
const { fetchPriceAvailability } = require('./synnex/pricing');
const { upsertProduct, getAllVariants, getActiveProductsPage, setProductDraft, setProductActive, getUnpublishedProductIds, publishProduct, updateProductContent } = require('./shopify/products');
const { setInventoryQuantities, updateVariantPrice, setProductLeadTimes } = require('./shopify/inventory');
const { toShopifyProduct, applyMarkup, mapCategory, buildTags, normalizeBrand, expandAppleTitle } = require('./transform');
const { categorize } = require('./categorize');
const { saveProduct, getAllProducts, getProductByMfrPart, getProductCount, scanProductsPage, getJobState, putJobState } = require('./catalog/products');
const { isCheapJunk } = require('./catalog/junkFilter');
const { fetchIcecatProduct } = require('./icecat/client');
const { verifyWebhook, parseOrderWebhook, parseReturnWebhook } = require('./shopify/webhooks');
const { createRma, checkRmaStatus, isRmaConfigured } = require('./synnex/rma');
const returnsState = require('./returns/state');
const { exchangeCodeForToken } = require('./shopify/auth');
const { calculateRates } = require('./shopify/shippingRates');
const { getUnfulfilledOrders, createFulfillment, addOrderNote } = require('./shopify/orders');
const { submitOrder } = require('./synnex/orderSubmit');
const { checkOrderStatus } = require('./synnex/orderStatus');
const { saveOrder, markSubmitted, markShipped, markFulfilled, markError, getOrdersByStatus, getOrder } = require('./orders/state');

// ─── Helpers ──────────────────────────────────────────────────────────────────

function truncateTitle(title) {
  if (!title || title.length <= 255) return title;
  return title.slice(0, 255).replace(/\s\S*$/, '').trim() || title.slice(0, 255).trim();
}

// ─── Catalog Sync ─────────────────────────────────────────────────────────────

// Category groups (from transform.js CATEGORY_MAP) that are excluded from the store.
// These map to the `group` field returned by mapCategory().
const EXCLUDED_GROUPS = new Set([
  'home-appliances', // vacuums, fans, water coolers, massage chairs — not B2B/B2C tech
  'software',        // software licenses — not prepared to support
]);

// Categories that are never sellable hardware — skip these regardless of brand.
// Covers: warranties, service contracts, software licenses, gaming peripherals.
const EXCLUDED_CATEGORIES = new Set([
  // Warranties & service plans (Lenovo, Dell, generic)
  'war', 'sp', 'sp3', 'sp-sm', 'svc', 'sve', 'svo', 'sv', 'svo',
  'service', 'warrantybund', 'warrantypart', 'warrantybun', 'warr ext',
  'retsrvc', 'spare parts',
  // Software & licensing
  'soft', 'sw', 'to1', 'to3rd', 'msoft', 'software', 'inst',
  'lgcy', 'ideaoption',
  // Volume / cloud licensing noise (biggest rows in the whole catalog)
  'mme new', 'mme ren', 'smb new', 'smb ren',
  'support', 'ts', '7750', 'csp_azureri',
  'ent network', 'data center', 'security', 'vipre cloud',
]);

/**
 * Download XML catalog from SFTP, parse it, filter by brand/category,
 * then create or update each product in Shopify.
 */
async function syncOneProduct(product, result) {
  const sku = product.synnexSku || product.mfrPartNumber;
  try {
    let enrichedTitle;
    let enrichedDescription;
    let images = [];
    let icecat = null;
    if (config.icecat.username) {
      try {
        icecat = await fetchIcecatProduct({
          brand: normalizeBrand(product.manufacturer),
          partNumber: product.mfrPartNumber,
          upc: product.upc,
        });
        if (icecat) {
          enrichedTitle = icecat.title;         // proper name e.g. "MacBook Pro 14\" M3 Pro"
          enrichedDescription = icecat.description;
          images = icecat.images;
        }
      } catch (_) {
        // Icecat failure never blocks the sync
      }
    }
    const shopifyInput = toShopifyProduct(product, enrichedDescription);
    // Use Icecat title when available; fall back to Apple-specific expansion for CTO products
    if (enrichedTitle) {
      shopifyInput.title = truncateTitle(enrichedTitle);
    } else if (normalizeBrand(product.manufacturer) === 'Apple') {
      shopifyInput.title = truncateTitle(expandAppleTitle(product.description));
    }
    const { productId, variantId, inventoryItemId } = await upsertProduct(shopifyInput, images);

    // Write specs metafield if Icecat returned structured spec data
    if (productId && icecat?.specs?.length > 0) {
      await updateProductContent(productId, { specs: icecat.specs }).catch(e =>
        console.warn(`[specs] ${sku}: ${e.message}`)
      );
    }

    result.synced += 1;

    // Persist to the approved-products catalog in DynamoDB.
    // This becomes the permanent record of what we sell — future syncs can
    // read from here instead of re-scanning the 1M-row catalog file.
    const { type: productType } = categorize({ unspsc: product.unspsc, description: product.description, category: product.category, manufacturer: product.manufacturer });
    const tags = buildTags(product.manufacturer, product);
    await saveProduct({
      synnexSku:              sku,
      mfrPartNumber:          product.mfrPartNumber,
      description:            product.description,
      manufacturer:           product.manufacturer,
      category:               product.category,
      unspsc:                 product.unspsc,
      productType,
      tags,
      map:                    product.map,
      msrp:                   product.msrp,
      shopifyProductId:       productId       || '',
      shopifyVariantId:       variantId       || '',
      shopifyInventoryItemId: inventoryItemId || '',
    });
  } catch (e) {
    console.warn(`[sync] error ${sku}: ${e.message}`);
    result.errors.push(`${sku}: ${e.message}`);
  }
}

/**
 * Fast-sync: read approved SKUs directly from DynamoDB and upsert them all
 * to Shopify — no catalog file scan needed.
 * Runs when the DynamoDB table is populated and `discover` is not requested.
 */
async function runFastCatalogSync(result) {
  const products = await getAllProducts();
  if (products.length === 0) return false; // nothing in DB yet — fall back to discovery

  result.mode = 'fast';
  const concurrency = config.sync.concurrency;
  const LAMBDA_TIMEOUT_MS = (config.sync.timeoutSeconds || 510) * 1000;
  const startedAt = Date.now();

  // Shuffle so each run covers a different random subset — otherwise the same
  // first N products are always synced and the rest never get touched.
  for (let i = products.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [products[i], products[j]] = [products[j], products[i]];
  }

  // Sync from DynamoDB in batches, respecting the time budget
  for (let i = 0; i < products.length; i += concurrency) {
    if (Date.now() - startedAt > LAMBDA_TIMEOUT_MS) {
      result.timedOut = true;
      break;
    }
    const batch = products.slice(i, i + concurrency);
    await Promise.all(batch.map(p => syncOneProduct(p, result)));
  }
  return true;
}

async function runCatalogSync(event = {}) {
  validateShopify();

  const result = { fetched: 0, skipped: 0, synced: 0, errors: [], mode: 'discover' };

  // If the DynamoDB approved-product table is populated and the caller hasn't
  // explicitly requested a fresh catalog discovery, run the fast path.
  if (!event.discover) {
    const count = await getProductCount();
    if (count > 0) {
      await runFastCatalogSync(result);
      return result;
    }
  }

  // ── Discovery mode: scan the TD Synnex catalog file ─────────────────────────
  if (!isSftpConfigured()) {
    throw new Error('SFTP not configured. Set SYNNEX_SFTP_HOST, SYNNEX_SFTP_USERNAME, SYNNEX_SFTP_REMOTE_PATH, and SYNNEX_SFTP_PASSWORD (or SYNNEX_SFTP_SECRET_ARN).');
  }
  const limit = config.sync.limit;
  const concurrency = config.sync.concurrency;

  // Build filter sets once so we don't recompute on every row
  const { brands, categories, allowlist } = config.sync;
  const brandSet = brands.length ? new Set(brands.map(b => b.toLowerCase())) : null;
  const categorySet = categories.length ? new Set(categories.map(c => c.toLowerCase())) : null;
  const skuSet = allowlist.length ? new Set(allowlist) : null;

  // Build the already-synced SKU set. DynamoDB scan is O(seconds) vs O(minutes) for
  // paginating 60k+ Shopify variants, so prefer DynamoDB when available.
  let syncedSkuSet;
  const dbProducts = await getAllProducts();
  if (dbProducts.length > 0) {
    syncedSkuSet = new Set(dbProducts.map(p => p.synnexSku).filter(Boolean));
    console.log(`[catalog-sync] using DynamoDB skip-set: ${syncedSkuSet.size} known SKUs`);
  } else {
    const existingVariants = await getAllVariants();
    syncedSkuSet = new Set(existingVariants.map(v => v.sku).filter(Boolean));
    console.log(`[catalog-sync] using Shopify skip-set: ${syncedSkuSet.size} known SKUs`);
  }

  // Stop streaming 90s before Lambda's hard timeout so we can flush and return cleanly
  const LAMBDA_TIMEOUT_MS = (config.sync.timeoutSeconds || 510) * 1000;
  const startedAt = Date.now();

  // Partition support: each Lambda processes only rows where rowIndex % partitionCount === partition.
  // Prevents concurrent runs from duplicating work on the same .ap file rows.
  const partition      = event.partition      ?? 0;
  const partitionCount = event.partitionCount ?? 1;
  let rowIndex = 0;

  let batch = [];
  let stopped = false;

  async function flushBatch() {
    if (batch.length === 0) return;
    const current = batch.splice(0);
    await Promise.all(current.map(p => syncOneProduct(p, result)));
  }

  let parseLine;

  await streamCatalogLines({
    onHeader(headerLine) {
      parseLine = createLineParser(headerLine);
    },
    async onRow(line) {
      if (stopped || Date.now() - startedAt > LAMBDA_TIMEOUT_MS) {
        stopped = true;
        return false;
      }

      const product = parseLine(line);
      if (!product) return true;

      // Partition filter — skip rows not owned by this Lambda instance
      if (partitionCount > 1 && (rowIndex++ % partitionCount) !== partition) return true;

      if (skuSet && !skuSet.has(product.synnexSku || product.mfrPartNumber)) return true;
      if (brandSet && !brandSet.has((product.manufacturer || '').toLowerCase())) return true;
      if (categorySet && !categorySet.has((product.category || '').toLowerCase())) return true;

      // Exclude warranties, service plans, software, and non-office categories across all brands.
      // These are never sellable hardware items and would pollute the store.
      if (EXCLUDED_CATEGORIES.has((product.category || '').toLowerCase())) return true;

      // Exclude non-tech category groups (home appliances etc.)
      const { group: productGroup } = mapCategory(product.category);
      if (EXCLUDED_GROUPS.has(productGroup)) return true;

      // Skip products already in Shopify — price-sync handles their price/inventory updates.
      // This lets each catalog-sync run advance past already-synced SKUs and pick up new ones.
      // Note: draft products (manually hidden) stay draft — catalog-sync never re-publishes them.
      const sku = product.synnexSku || product.mfrPartNumber;
      if (syncedSkuSet.has(sku)) { result.skipped += 1; return true; }

      result.fetched += 1;

      batch.push(product);

      // Flush when batch is full, or we've hit the hard limit
      if (limit && result.fetched >= limit) {
        await flushBatch();
        return false;
      }
      if (batch.length >= concurrency) {
        await flushBatch();
      }

      return true;
    },
  });

  // Flush any remaining products collected before the time limit
  await flushBatch();

  return result;
}

// ─── Targeted Discovery ────────────────────────────────────────────────────────

/**
 * Stream the full Synnex catalog but only sync products that belong to the
 * requested Shopify product types and/or tag groups.
 *
 * Unlike catalog-sync's discover mode — which processes every new SKU until
 * the Lambda timeout — this job rejects non-matching rows with a pure sync
 * regex check (no async I/O).  A single invocation can therefore walk the
 * entire catalog file and collect all keyboards, mice, monitors, etc. even
 * if those products appear near the end of a 500,000-row file.
 *
 * Direct invoke examples:
 *   { "job": "targeted-discover", "tags": ["keyboard", "mouse"] }
 *   { "job": "targeted-discover", "types": ["Monitors"] }
 *   { "job": "targeted-discover", "types": ["Accessories"], "tags": ["keyboard","mouse"], "limit": 500 }
 *
 * Recognised types (from transform.js CATEGORY_MAP):
 *   Laptops, Chromebooks, Desktops, Workstations, Monitors, Tablets, Gaming,
 *   Accessories, Storage, Memory, Networking, Power, Software, Printers
 *
 * Common tags:
 *   laptop, notebook, monitor, display, keyboard, mouse, docking-station,
 *   cable, headset, bag, storage, memory, networking, power
 */
async function runTargetedDiscover(event = {}) {
  validateShopify();
  if (!isSftpConfigured()) {
    throw new Error(
      'SFTP not configured. Set SYNNEX_SFTP_HOST, SYNNEX_SFTP_USERNAME, ' +
      'SYNNEX_SFTP_REMOTE_PATH, and SYNNEX_SFTP_PASSWORD (or SYNNEX_SFTP_SECRET_ARN).'
    );
  }

  const targetTypes = new Set((event.types || []).map(t => t.toLowerCase()));
  const targetTags  = new Set((event.tags  || []).map(t => t.toLowerCase()));

  // b2bOnly: list the full B2B hardware keep-set (UNSPSC families + in-stock + cost
  // floor + no accessory noise) — same rule as scripts/curate-b2b.js. Used to list the
  // ~24K current B2B hardware SKUs not yet in Shopify.
  const b2bOnly = event.b2bOnly === true;
  const B2B_FAMILIES = new Set(['4320', '4321', '4322', '3912', '4617']);
  const B2B_MIN_COST = Number(event.minCost ?? 20);
  const B2B_NOISE = /mouse ?pad|cable tie|coupler|cleaning cartridge|\bscrew\b|\blabel\b|wrist rest|cable manage|velcro|filler panel|blank panel|\bdust\b|grommet|cable clip/i;

  if (!b2bOnly && targetTypes.size === 0 && targetTags.size === 0) {
    throw new Error(
      'targeted-discover requires "b2bOnly":true, or at least one "types"/"tags" array.\n' +
      'Example: { "job": "targeted-discover", "b2bOnly": true }'
    );
  }

  const limit       = event.limit ?? config.sync.limit;
  const concurrency = config.sync.concurrency;
  const LAMBDA_TIMEOUT_MS = (config.sync.timeoutSeconds || 510) * 1000;
  const startedAt   = Date.now();

  // Load already-synced SKUs from the DynamoDB catalog (one paginated scan) rather
  // than paginating ~700K Shopify variants (too slow — it blew the Lambda budget).
  const dbProducts = await getAllProducts();
  const syncedSkuSet = new Set();
  for (const p of dbProducts) {
    if (p.synnexSku) syncedSkuSet.add(p.synnexSku);
    if (p.mfrPartNumber) syncedSkuSet.add(p.mfrPartNumber);
  }

  const result = {
    fetched: 0,
    skipped: 0,
    synced:  0,
    errors:  [],
    timedOut: false,
    mode:    'targeted-discover',
    targets: { types: [...targetTypes], tags: [...targetTags] },
  };

  let batch   = [];
  let stopped = false;

  async function flushBatch() {
    if (!batch.length) return;
    const current = batch.splice(0);
    await Promise.all(current.map(p => syncOneProduct(p, result)));
  }

  let parseLine;

  await streamCatalogLines({
    onHeader(h) { parseLine = createLineParser(h); },
    async onRow(line) {
      if (stopped || Date.now() - startedAt > LAMBDA_TIMEOUT_MS) {
        stopped = true;
        result.timedOut = true;
        return false;
      }

      const product = parseLine(line);
      if (!product) return true;

      if (b2bOnly) {
        // B2B hardware keep-rule (mirrors curate-b2b): UNSPSC family + in-stock + cost floor + no noise.
        if (!B2B_FAMILIES.has(String(product.unspsc || '').slice(0, 4))) return true;
        if ((product.quantityAvailable || 0) <= 0) return true;
        if ((product.price || 0) < B2B_MIN_COST) return true;
        if (B2B_NOISE.test(product.description || '')) return true;
      } else {
        // Type/tag targeting — categorize() (UNSPSC-driven) instead of the old mapCategory.
        const { type: mappedType, tags: mappedTags, group: mappedGroup } =
          categorize({ unspsc: product.unspsc, description: product.description, category: product.category, manufacturer: product.manufacturer });
        if (EXCLUDED_GROUPS.has(mappedGroup)) return true;
        const typeMatch = targetTypes.size > 0 && targetTypes.has((mappedType || '').toLowerCase());
        const tagMatch  = targetTags.size  > 0 && mappedTags.some(t => targetTags.has(t.toLowerCase()));
        if (!typeMatch && !tagMatch) return true;
      }

      // Skip products already in Shopify
      const sku = product.synnexSku || product.mfrPartNumber;
      if (syncedSkuSet.has(sku)) { result.skipped += 1; return true; }

      result.fetched += 1;
      batch.push(product);

      if (limit && result.fetched >= limit) {
        await flushBatch();
        stopped = true;
        return false;
      }
      if (batch.length >= concurrency) {
        await flushBatch();
      }

      return true;
    },
  });

  await flushBatch();
  return result;
}

/**
 * Walk the full Synnex catalog and return a count breakdown by Shopify product
 * type and tag — no Shopify writes.  Run this first to understand how many
 * keyboards, mice, monitors, etc. are available before invoking targeted-discover.
 *
 * Direct invoke: { "job": "scan-catalog" }
 *
 * Returns:
 *   { totalRows, excludedRows, eligibleRows, byType: { Laptops: N, … }, byTag: { keyboard: N, … } }
 *
 * Also reports how many of each type/tag are already synced to Shopify vs new,
 * so you can see exactly how much of each category remains to be discovered.
 */
async function runScanCatalog() {
  if (!isSftpConfigured()) {
    throw new Error('SFTP not configured.');
  }

  // Load already-synced SKUs for the "already in Shopify" breakdown
  const existingVariants = await getAllVariants();
  const syncedSkuSet = new Set(existingVariants.map(v => v.sku).filter(Boolean));

  const typeCounts  = {};   // total available in catalog
  const tagCounts   = {};
  const typeSynced  = {};   // subset already in Shopify
  const tagSynced   = {};

  let totalRows    = 0;
  let excludedRows = 0;

  let parseLine;
  await streamCatalogLines({
    onHeader(h) { parseLine = createLineParser(h); },
    onRow(line) {
      const product = parseLine(line);
      if (!product) return true;
      totalRows += 1;

      if (EXCLUDED_CATEGORIES.has((product.category || '').toLowerCase())) {
        excludedRows += 1;
        return true;
      }

      const { type, tags } = mapCategory(product.category, product.description);
      const sku = product.synnexSku || product.mfrPartNumber;
      const alreadySynced = syncedSkuSet.has(sku);

      const t = type || 'Unknown';
      typeCounts[t] = (typeCounts[t] || 0) + 1;
      if (alreadySynced) typeSynced[t] = (typeSynced[t] || 0) + 1;

      for (const tag of tags) {
        tagCounts[tag]  = (tagCounts[tag]  || 0) + 1;
        if (alreadySynced) tagSynced[tag] = (tagSynced[tag] || 0) + 1;
      }

      return true;
    },
  });

  // Sort by count descending and annotate with synced/remaining breakdown
  const annotate = (counts, synced) =>
    Object.fromEntries(
      Object.entries(counts)
        .sort(([, a], [, b]) => b - a)
        .map(([k, total]) => {
          const done      = synced[k] || 0;
          const remaining = total - done;
          return [k, { total, synced: done, remaining }];
        })
    );

  return {
    totalRows,
    excludedRows,
    eligibleRows: totalRows - excludedRows,
    byType: annotate(typeCounts, typeSynced),
    byTag:  annotate(tagCounts,  tagSynced),
  };
}

// ─── Fix Publications ──────────────────────────────────────────────────────────

/**
 * Publish every product in Shopify to the Online Store sales channel.
 *
 * The previous publishProduct implementation used the Shopify REST Products API
 * (hardcoded at version 2024-10), which was sunset in April 2025. Every product
 * synced after that date was created in Shopify but never published to the
 * storefront. Run this job once to fix the backlog.
 *
 * Subsequent syncs now use the GraphQL publishablePublish mutation so this
 * one-off repair won't be needed again.
 *
 * Direct invoke: { "job": "fix-publications" }
 */
async function runFixPublications() {
  validateShopify();

  const startedAt = Date.now();
  // Leave 60 s buffer before Lambda hard timeout to return a clean result
  const LAMBDA_TIMEOUT_MS = (config.sync.timeoutSeconds || 510) * 1000;

  const productIds = await getUnpublishedProductIds();

  const result = { total: productIds.length, published: 0, alreadyPublished: 0, errorCount: 0, timedOut: false };
  const sampleErrors = [];
  const CONCURRENCY = 10;

  for (let i = 0; i < productIds.length; i += CONCURRENCY) {
    if (Date.now() - startedAt > LAMBDA_TIMEOUT_MS) {
      result.timedOut = true;
      console.log(`[fix-publications] timeout after ${result.published + result.alreadyPublished} products — re-run to continue`);
      break;
    }

    const batch = productIds.slice(i, i + CONCURRENCY);
    await Promise.all(batch.map(async (gid) => {
      try {
        await publishProduct(gid);
        result.published += 1;
      } catch (e) {
        // Shopify returns various "already published" messages depending on API version
        if (/already (published|exists)|not changed/i.test(e.message)) {
          result.alreadyPublished += 1;
        } else {
          result.errorCount += 1;
          // Keep first 5 error samples for diagnosis
          if (sampleErrors.length < 5) sampleErrors.push(`${gid}: ${e.message}`);
        }
      }
    }));

    const done = result.published + result.alreadyPublished + result.errorCount;
    if (done > 0 && done % 200 === 0) {
      console.log(`[fix-publications] progress: ${done}/${productIds.length} (ok=${result.published + result.alreadyPublished} err=${result.errorCount})`);
    }
  }

  if (sampleErrors.length) {
    console.log('[fix-publications] sample errors:', JSON.stringify(sampleErrors));
  }

  return result;
}

// ─── Fix Product Types ────────────────────────────────────────────────────────

/**
 * Bulk-correct productType for keyboards and mice that were synced with the
 * wrong type ('Accessories') before the transform.js fix.
 *
 * Direct invoke: { "job": "fix-product-types" }
 */
async function runFixProductTypes() {
  validateShopify();
  const { graphql: gql } = require('./shopify/auth');

  const QUERY = `
    query getByTagAndType($q: String!, $cursor: String) {
      products(first: 250, after: $cursor, query: $q) {
        pageInfo { hasNextPage endCursor }
        nodes { id }
      }
    }
  `;
  const UPDATE = `
    mutation productUpdate($input: ProductInput!) {
      productUpdate(input: $input) {
        product { id productType }
        userErrors { field message }
      }
    }
  `;

  const FIXES = [
    { query: 'tag:keyboard product_type:Accessories', productType: 'Keyboard' },
    { query: 'tag:mouse product_type:Accessories',    productType: 'Mouse'    },
  ];

  const result = { fixed: 0, errors: 0 };

  for (const { query, productType } of FIXES) {
    let cursor = null;
    do {
      const data = await gql(QUERY, { q: query, ...(cursor ? { cursor } : {}) });
      const page = data.products;
      const ids = page.nodes.map(p => p.id);

      await Promise.all(ids.map(async (id) => {
        try {
          await gql(UPDATE, { input: { id, productType } });
          result.fixed += 1;
        } catch (e) {
          result.errors += 1;
          console.warn(`[fix-product-types] ${id}: ${e.message}`);
        }
      }));

      cursor = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
    } while (cursor);
  }

  return result;
}

// ─── Fix Mice Cleanup ─────────────────────────────────────────────────────────

/**
 * Fix products incorrectly typed as Mouse due to description-matching bug.
 *
 * Strategy:
 *  - Actual mice (title contains mouse/trackball/trackpad) → keep as Mouse
 *  - Desktops / mini PCs → retype to Desktops, remove mouse tag
 *  - AV / conferencing gear → retype to Accessories, remove mouse tag
 *  - Headsets / earbuds → retype to Accessories, remove mouse tag
 *  - Rack / enclosure / panel / infrastructure → delete (not in catalog scope)
 *  - ID cards / specialty media → delete (not in catalog scope)
 *  - Everything else unrecognised → retype to Accessories, remove mouse tag
 *
 * Direct invoke: { "job": "fix-mice-cleanup" }
 */
async function runFixMiceCleanup() {
  validateShopify();
  const { graphql: gql } = require('./shopify/auth');

  const LIST = `
    query listMouse($cursor: String) {
      products(first: 250, after: $cursor, query: "product_type:Mouse") {
        pageInfo { hasNextPage endCursor }
        nodes { id title tags }
      }
    }
  `;
  const UPDATE = `
    mutation productUpdate($input: ProductInput!) {
      productUpdate(input: $input) {
        product { id }
        userErrors { field message }
      }
    }
  `;
  const DELETE = `
    mutation productDelete($input: ProductDeleteInput!) {
      productDelete(input: $input) {
        deletedProductId
        userErrors { field message }
      }
    }
  `;

  // Title patterns that confirm this is an actual pointing device
  const IS_MOUSE = /\b(mouse|mice|trackball|trackpad|track\s*point|pointer)\b/i;

  // Classification for non-mice
  function classify(title) {
    const t = title.toLowerCase();
    if (/\b(mini pc|micro pc|nuc|optiplex|qcm|qbm|desktop|small form|sff|tower)\b/.test(t))
      return { action: 'retype', productType: 'Desktops', removeTag: 'mouse', addTag: 'desktop' };
    if (/\b(rally bar|mic pod|tap cat|tapcat|conference|video bar|webcam|sight)\b/.test(t))
      return { action: 'retype', productType: 'Accessories', removeTag: 'mouse', addTag: 'av' };
    if (/\b(headphone|headset|earbud|earphone)\b/.test(t))
      return { action: 'retype', productType: 'Accessories', removeTag: 'mouse', addTag: 'headset' };
    if (/\b(rack|enclosure|blank panel|patch panel|cable mgmt|netshel)\b/.test(t))
      return { action: 'delete' };
    if (/\b(pvc card|id card|mil\b|micrometer|cr80)\b/.test(t))
      return { action: 'delete' };
    // Default: move to Accessories, strip mouse tag
    return { action: 'retype', productType: 'Accessories', removeTag: 'mouse', addTag: 'accessory' };
  }

  const result = { kept: 0, retyped: 0, deleted: 0, errors: 0 };
  let cursor = null;

  do {
    const data = await gql(LIST, cursor ? { cursor } : {});
    const page = data.products;

    await Promise.all(page.nodes.map(async (p) => {
      try {
        if (IS_MOUSE.test(p.title)) {
          result.kept += 1;
          return;
        }

        const decision = classify(p.title);

        if (decision.action === 'delete') {
          await gql(DELETE, { input: { id: p.id } });
          result.deleted += 1;
          return;
        }

        // retype: update productType and swap tags
        const newTags = p.tags
          .filter(t => t !== decision.removeTag)
          .concat(decision.addTag || []);
        await gql(UPDATE, { input: { id: p.id, productType: decision.productType, tags: newTags } });
        result.retyped += 1;
      } catch (e) {
        result.errors += 1;
        console.warn(`[fix-mice-cleanup] ${p.id} "${p.title.slice(0, 40)}": ${e.message}`);
      }
    }));

    cursor = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
  } while (cursor);

  return result;
}

// ─── Price & Inventory Sync ───────────────────────────────────────────────────

/**
 * Fetch price & availability from TD Synnex XML P&A API for all Shopify SKUs,
 * then update variant prices and inventory quantities.
 */
// Product types that TD Synnex sources on-demand from the manufacturer.
// When stock = 0, keep selling (dropship model) and show a lead time notice.
const SPECIAL_ORDER_TYPES = new Set(['Laptops', 'Desktops', 'Workstations', 'Chromebooks', 'Tablets']);

async function runPriceSync() {
  validateShopify();
  if (!isXmlConfigured()) {
    throw new Error('XML P&A not configured. Set SYNNEX_XML_CUSTOMER_NO, SYNNEX_XML_USERNAME, and SYNNEX_XML_PASSWORD.');
  }

  const result = { skusChecked: 0, pricesUpdated: 0, inventoryUpdated: 0, drafted: 0, reactivated: 0, errors: [], timedOut: false };
  // Products whose synced price falls below this are hidden (drafted) — they're SKUs
  // TD Synnex returns no/zero cost for. Tunable via PRICE_MIN_ACTIVE (default $1).
  const MIN_ACTIVE_PRICE = config.sync.minActivePrice;

  // Stop 90 s before Lambda hard timeout so we can flush inventory and return cleanly
  const LAMBDA_TIMEOUT_MS = (config.sync.timeoutSeconds || 510) * 1000;
  const startedAt = Date.now();

  // Use the DynamoDB catalog as the source of truth for price sync.
  // It stores synnexSku (the numeric TD Synnex catalog ID that the P&A API accepts)
  // and all three Shopify GIDs so we can update without a separate Shopify lookup.
  // getAllVariants() from Shopify stores manufacturer part numbers as SKUs (the P&A
  // API rejects these — it only accepts the internal Synnex catalog ID).
  const products = await getAllProducts();
  const validProducts = products.filter(p => p.synnexSku && p.shopifyVariantId);
  if (validProducts.length === 0) return result;
  result.skusChecked = validProducts.length;

  // Shuffle so each run covers a random subset when the full catalog is too large
  // to process completely within one Lambda execution window.
  for (let i = validProducts.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [validProducts[i], validProducts[j]] = [validProducts[j], validProducts[i]];
  }

  const { locationId } = config.shopify;
  const { syncPrices, msrpAsCompareAt, skuChunkSize } = config.synnex.xml;
  // Eligible MAP items (MAP ≤ MSRP) are priced at MSRP × this factor, floored at MAP.
  const MAP_MSRP_FACTOR = 0.90;

  // Process in rolling batches: fetch P&A for each batch, update prices immediately,
  // then advance to the next batch. This keeps memory flat and makes progress even
  // when the catalog is too large to fit in one Lambda execution.
  const BATCH_SIZE = skuChunkSize * 5; // 40 * 5 = 200 products → 5 P&A API calls per loop
  const inventoryUpdates = [];
  const specialOrderProductIds = new Set();

  for (let i = 0; i < validProducts.length; i += BATCH_SIZE) {
    if (Date.now() - startedAt > LAMBDA_TIMEOUT_MS) {
      result.timedOut = true;
      break;
    }

    const batch = validProducts.slice(i, i + BATCH_SIZE);
    const skus = [...new Set(batch.map(p => p.synnexSku).filter(Boolean))];
    if (skus.length === 0) continue;

    let pAndA;
    try {
      pAndA = await fetchPriceAvailability(skus);
    } catch (e) {
      result.errors.push(`P&A batch ${i}: ${e.message}`);
      continue;
    }
    const byPartNumber = new Map(pAndA.map(p => [p.partNumber, p]));

    const PRICE_CONCURRENCY = 10;
    for (let j = 0; j < batch.length; j += PRICE_CONCURRENCY) {
      const chunk = batch.slice(j, j + PRICE_CONCURRENCY);
      await Promise.all(chunk.map(async (product) => {
        if (!product.synnexSku) return;
        const data = byPartNumber.get(product.synnexSku);
        if (!data) return;

        const isSpecialOrder = SPECIAL_ORDER_TYPES.has(product.productType);
        const qty = data.quantityAvailable ?? 0;
        const gid = product.shopifyProductId
          ? (product.shopifyProductId.startsWith('gid://') ? product.shopifyProductId : `gid://shopify/Product/${product.shopifyProductId}`)
          : null;

        if (syncPrices && product.shopifyVariantId) {
          try {
            const packQty   = data.innerPackQty || 1;
            // Unit price × pack size = what the customer pays for one shipment
            const unitCost  = (data.price != null ? data.price : 0) * packQty;
            // MAP-protected pricing. Sanity: only trust MAP within 5× unit cost (the feed has
            // garbage MAP values, e.g. $4788 on a $9 item). For an "eligible" MAP item
            // (MAP ≤ MSRP) we price NEAR MSRP — competitive, but never below the MAP floor and
            // never above MSRP. Non-MAP items (and MAP items without a usable MSRP) keep cost+markup.
            const mapSane  = product.map && data.price > 0 && product.map <= data.price * 5;
            const mapPack  = mapSane ? product.map * packQty : 0;
            const msrpPack = (product.msrp || 0) * packQty;
            let sellPrice;
            if (mapPack > 0 && msrpPack > 0 && mapPack <= msrpPack) {
              const target = Math.round(msrpPack * MAP_MSRP_FACTOR * 100) / 100;
              sellPrice = Math.min(msrpPack, Math.max(mapPack, target));
            } else {
              sellPrice = Math.max(applyMarkup(unitCost), mapPack);
            }
            const compareAt = msrpAsCompareAt && data.msrp ? data.msrp * packQty : undefined;

            // GUARD: TD Synnex returned no/zero cost → not sellable. Hide it (draft) so a
            // $0 listing never goes live. Flag it (autoHiddenZeroPrice) so this — and only
            // this — gets auto-restored below if a real price returns; never un-hides
            // products drafted for other reasons (services/software, orphans, etc.).
            if (data.price == null || unitCost <= 0 || sellPrice < MIN_ACTIVE_PRICE) {
              if (gid && !product.autoHiddenZeroPrice) {
                await setProductDraft(gid);
                await saveProduct({ ...product, autoHiddenZeroPrice: true });
                result.drafted += 1;
              }
              return;
            }

            // JUNK GUARD: cheap accessory/cable clutter (sub-$JUNK_MAX_PRICE, not real
            // hardware) is kept off the storefront permanently. Flagged autoHiddenJunk so
            // it's never auto-restored, and skipped on later runs once flagged.
            if (isCheapJunk(product.description, sellPrice)) {
              if (gid && !product.autoHiddenJunk) {
                await setProductDraft(gid);
                await saveProduct({ ...product, autoHiddenJunk: true });
                result.drafted += 1;
              }
              return;
            }

            // Sanity guard: never push a price that is less than 10% of the compare-at
            // price (when available) — this catches pack-pricing errors and bad catalog data.
            if (compareAt && sellPrice < compareAt * 0.10) {
              result.errors.push(`${product.synnexSku} price skipped: $${sellPrice} is <10% of MSRP $${compareAt} (packQty=${packQty})`);
              return;
            }

            const inventoryPolicy = isSpecialOrder && qty === 0 ? 'CONTINUE' : 'DENY';
            await updateVariantPrice({
              productId: product.shopifyProductId,
              variantId: product.shopifyVariantId,
              price: sellPrice,
              compareAtPrice: compareAt,
              inventoryPolicy,
            });
            result.pricesUpdated += 1;

            // Self-heal: if we previously auto-hid this for a zero price, a real price is
            // back — restore it to the storefront and clear the flag.
            if (gid && product.autoHiddenZeroPrice) {
              await setProductActive(gid);
              await saveProduct({ ...product, autoHiddenZeroPrice: false });
              result.reactivated += 1;
            }

            if (isSpecialOrder && qty === 0) specialOrderProductIds.add(product.shopifyProductId);
            if (product.shopifyInventoryItemId && locationId) {
              inventoryUpdates.push({ inventoryItemId: product.shopifyInventoryItemId, locationId, quantity: qty });
            }
          } catch (e) {
            result.errors.push(`${product.synnexSku} price: ${e.message}`);
          }
        }
      }));
    }
  }

  // Stamp a lead-time notice on every special-order product so the theme can display it
  if (specialOrderProductIds.size > 0) {
    try {
      await setProductLeadTimes(
        [...specialOrderProductIds],
        'Special order — usually ships within 5–7 business days. If we are unable to fulfill your order you will be contacted within 24 hours.'
      );
    } catch (e) {
      result.errors.push(`lead_time metafields: ${e.message}`);
    }
  }

  // Send inventory updates in chunks of 100 (Shopify limit per call)
  const INV_CHUNK = 100;
  for (let i = 0; i < inventoryUpdates.length; i += INV_CHUNK) {
    const chunk = inventoryUpdates.slice(i, i + INV_CHUNK);
    try {
      await setInventoryQuantities(chunk);
      result.inventoryUpdated += chunk.length;
    } catch (e) {
      result.errors.push(`inventory chunk ${i}–${i + chunk.length}: ${e.message}`);
    }
  }

  return result;
}

// ─── Featured Collection Refresh ─────────────────────────────────────────────

/**
 * refresh-featured: Rebuild the "featured-products" Shopify collection so it
 * contains only products that are both in-stock (totalInventory > 0) AND have
 * at least one image.  Runs nightly via EventBridge after the catalog sync.
 */
async function runRefreshFeatured() {
  const result = { scanned: 0, inStockWithImage: 0, added: 0, errors: [] };

  const store = process.env.SHOPIFY_STORE;
  const token = process.env.SHOPIFY_ACCESS_TOKEN;
  if (!store || !token) throw new Error('SHOPIFY_STORE / SHOPIFY_ACCESS_TOKEN not set');

  const https = require('https');
  function gql(query, variables = {}) {
    return new Promise((res, rej) => {
      const body = JSON.stringify({ query, variables });
      const req = https.request({
        hostname: `${store}.myshopify.com`,
        path: '/admin/api/2024-10/graphql.json',
        method: 'POST',
        headers: {
          'X-Shopify-Access-Token': token,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
      }, r => { let d = ''; r.on('data', c => d += c); r.on('end', () => res(JSON.parse(d))); });
      req.on('error', rej);
      req.write(body); req.end();
    });
  }

  // 1. Ensure the collection exists
  const colData = await gql('{ collectionByHandle(handle: "featured-products") { id } }');
  let collectionId = colData?.data?.collectionByHandle?.id;
  if (!collectionId) {
    const created = await gql(`mutation {
      collectionCreate(input: { title: "Featured Products", handle: "featured-products", sortOrder: BEST_SELLING }) {
        collection { id }
        userErrors { message }
      }
    }`);
    collectionId = created?.data?.collectionCreate?.collection?.id;
  }
  if (!collectionId) throw new Error('Could not get or create featured-products collection');

  // 2. Collect in-stock products with images
  const productIds = [];
  let cursor = null;
  do {
    const d = await gql(`query($cursor: String) {
      products(first: 250, after: $cursor, query: "inventory_total:>0") {
        pageInfo { hasNextPage endCursor }
        nodes { id featuredImage { url } }
      }
    }`, { cursor });
    const page = d?.data?.products;
    if (!page) break;
    for (const p of page.nodes) {
      result.scanned++;
      if (p.featuredImage) { productIds.push(p.id); result.inStockWithImage++; }
    }
    cursor = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
    if (cursor) await new Promise(r => setTimeout(r, 200));
  } while (cursor);

  // 3. Replace collection members in batches of 250
  for (let i = 0; i < productIds.length; i += 250) {
    const chunk = productIds.slice(i, i + 250);
    const r = await gql(`mutation($id: ID!, $productIds: [ID!]!) {
      collectionAddProductsV2(id: $id, productIds: $productIds) {
        userErrors { message }
      }
    }`, { id: collectionId, productIds: chunk });
    const errs = r?.data?.collectionAddProductsV2?.userErrors || [];
    if (errs.length) result.errors.push(...errs.map(e => e.message));
    else result.added += chunk.length;
    if (i + 250 < productIds.length) await new Promise(r => setTimeout(r, 300));
  }

  return result;
}

// ─── Order Fulfillment Jobs ───────────────────────────────────────────────────

/**
 * reconcile-listings: Retire orphaned storefront listings.
 *
 * The store contains many active products that are no longer backed by the live TD Synnex
 * catalog — created by an earlier import, or since discontinued. They show frozen "phantom"
 * inventory (price-sync only updates products in the catalog table) and can't be fulfilled.
 *
 * This walks every active Shopify product and sets any whose SKU isn't in the live catalog
 * to DRAFT (reversible — removes from storefront without deleting). Dry-run by default;
 * pass { apply: true } to actually draft. Runs nightly once enabled.
 *
 * @param {{ apply?: boolean }} opts
 */
async function runReconcileListings(opts = {}) {
  const apply = opts.apply === true;
  const result = { apply, catalogSkus: 0, scanned: 0, orphaned: 0, drafted: 0, kept: 0, samples: [], errors: [], timedOut: false, nextCursor: null };

  // Build the set of valid SKUs = every manufacturer part number (and numeric catalog ID)
  // present in the live catalog table. A listing whose SKU isn't here is orphaned.
  const products = await getAllProducts();
  const validSkus = new Set();
  for (const p of products) {
    const mpn = String(p.mfrPartNumber || '').trim(); if (mpn) validSkus.add(mpn);
    const sid = String(p.synnexSku || '').trim();      if (sid) validSkus.add(sid);
  }
  result.catalogSkus = validSkus.size;

  const startedAt = Date.now();
  const BUDGET_MS = (config.sync.timeoutSeconds || 510) * 1000;

  // Scan active products and draft orphans INLINE per page, so progress (and drafting)
  // persists even if the store is too large to finish in one invocation. Resumable:
  // on timeout we return nextCursor; the caller re-invokes with { startCursor } to continue.
  // nextCursor is captured before drafting, and Shopify cursors are id-based, so drafting
  // already-scanned items doesn't disturb forward pagination.
  let cursor = opts.startCursor || null;
  do {
    if (Date.now() - startedAt > BUDGET_MS) { result.timedOut = true; result.nextCursor = cursor; break; }
    const { products: page, nextCursor } = await getActiveProductsPage(cursor);

    const orphansThisPage = [];
    for (const prod of page) {
      result.scanned++;
      const sku = String(prod.sku || '').trim();
      if (sku && validSkus.has(sku)) { result.kept++; continue; }
      result.orphaned++;
      orphansThisPage.push(prod);
      if (result.samples.length < 10) result.samples.push(`${sku || '(no sku)'} — ${(prod.title || '').slice(0, 44)}`);
    }

    if (apply && orphansThisPage.length) {
      const CONC = 5;
      for (let i = 0; i < orphansThisPage.length; i += CONC) {
        const chunk = orphansThisPage.slice(i, i + CONC);
        await Promise.all(chunk.map(p =>
          setProductDraft(p.id).then(() => { result.drafted++; }).catch(e => result.errors.push(`${p.id}: ${e.message}`))
        ));
      }
    }

    cursor = nextCursor;
  } while (cursor);

  return result;
}

/**
 * Translate each order line item's stored SKU (the Shopify variant SKU, which holds the
 * manufacturer part number) into the numeric TD Synnex catalog ID required by the order API.
 * Numeric values are already catalog IDs and pass through untouched. Throws if any line
 * item can't be resolved — better to fail the order loudly than submit an unshippable
 * non-stock quote.
 *
 * @param {Array<{synnexSku:string, quantity:number, unitPrice:number, title:string}>} lineItems
 * @returns {Promise<Array>} line items with synnexSku set to the numeric catalog ID
 */
async function resolveLineItemSkus(lineItems) {
  return Promise.all((lineItems || []).map(async (li) => {
    const stored = String(li.synnexSku || '').trim();
    if (/^\d+$/.test(stored)) return li; // already a numeric catalog ID
    const product = await getProductByMfrPart(stored);
    const resolved = String(product?.synnexSku || '').trim();
    if (!/^\d+$/.test(resolved)) {
      throw new Error(
        `Could not resolve TD Synnex catalog ID for SKU "${stored}" (${li.title || 'item'}). ` +
        `Order not submitted to avoid a non-stock quote.`
      );
    }
    return { ...li, synnexSku: resolved };
  }));
}

/**
 * submit-orders: Pick up pending orders from DynamoDB and submit them to TD Synnex.
 * Runs every 5 minutes via EventBridge.
 */
async function runSubmitOrders() {
  const result = { processed: 0, submitted: 0, errors: [] };

  const pending = await getOrdersByStatus('pending');
  // Also retry recent errors
  const errored = await getOrdersByStatus('error');
  const toProcess = [...pending, ...errored];

  result.processed = toProcess.length;

  for (const stateOrder of toProcess) {
    try {
      // The webhook stores the Shopify variant SKU (= manufacturer part number) on each
      // line item. TD Synnex's order API only accepts the numeric internal catalog ID
      // (synnexSku) — submitting an MfgPN gets filed as a non-stock quote that never ships.
      // Resolve each line item to its numeric synnexSku here before submitting.
      const lineItems = await resolveLineItemSkus(stateOrder.lineItems);

      const submitResult = await submitOrder({
        poNumber: stateOrder.poNumber,
        shipTo: stateOrder.shipTo,
        lineItems,
      });
      await markSubmitted(stateOrder.shopifyOrderId, { synnexOrderId: submitResult.synnexOrderId });
      result.submitted += 1;
    } catch (e) {
      await markError(stateOrder.shopifyOrderId, e.message).catch(() => {});
      // Leave a visible note in Shopify Admin so staff know to follow up
      await addOrderNote(
        stateOrder.shopifyOrderId,
        `TD Synnex fulfillment failed: ${e.message}. Please contact the customer and arrange alternative fulfillment or issue a refund.`
      ).catch(() => {});
      result.errors.push(`${stateOrder.shopifyOrderName}: ${e.message}`);
    }
  }

  return result;
}

/**
 * check-tracking: Check TD Synnex for order status updates and fulfill orders in Shopify.
 * Runs every 30 minutes via EventBridge.
 */
async function runCheckTracking() {
  const result = { checked: 0, fulfilled: 0, errors: [] };

  const submitted = await getOrdersByStatus('submitted');
  result.checked = submitted.length;

  for (const stateOrder of submitted) {
    try {
      const status = await checkOrderStatus(stateOrder.poNumber);

      if (status.status === 'shipped' && status.trackingNumbers.length > 0) {
        // Update Shopify fulfillment with tracking
        await createFulfillment({
          orderId: stateOrder.shopifyOrderId,
          trackingNumbers: status.trackingNumbers,
          carrier: status.carrier,
          notifyCustomer: true,
        });
        await markShipped(stateOrder.shopifyOrderId, {
          trackingNumbers: status.trackingNumbers,
          carrier: status.carrier,
        });
        await markFulfilled(stateOrder.shopifyOrderId);
        result.fulfilled += 1;
      }
    } catch (e) {
      result.errors.push(`${stateOrder.shopifyOrderName}: ${e.message}`);
    }
  }

  return result;
}

// ─── Returns / RMA Jobs ───────────────────────────────────────────────────────
// Sibling of submit-orders / check-tracking, for the return side. Both jobs no-op
// gracefully until the TD SYNNEX RMA endpoint+spec is configured (isRmaConfigured()).

/**
 * Resolve a return's line items to the numeric TD SYNNEX catalog IDs the RMA API needs,
 * by mapping against the original order record (same numeric-SKU resolution as orders).
 * SPEC TODO: support partial-line returns; currently applies the return reason to all
 * resolved order items (covers the common full-item return).
 */
async function resolveReturnLineItems(ret, order) {
  const orderItems = order?.lineItems?.length ? await resolveLineItemSkus(order.lineItems) : [];
  if (orderItems.length === 0) {
    throw new Error('Original order not found or has no line items to map for the RMA');
  }
  const reason = ret.reason || 'OTHER';
  return orderItems.map(li => ({ synnexSku: li.synnexSku, quantity: li.quantity, reason }));
}

/**
 * submit-rmas: Open TD SYNNEX RMAs for newly requested returns. (EventBridge schedule.)
 */
async function runSubmitRmas() {
  const result = { processed: 0, submitted: 0, errors: [] };
  if (!isRmaConfigured()) {
    result.note = 'RMA endpoint not configured — awaiting TD SYNNEX RMA spec (SYNNEX_RMA_URL)';
    return result;
  }
  const toProcess = [
    ...(await returnsState.getReturnsByStatus('requested')),
    ...(await returnsState.getReturnsByStatus('error')),
  ];
  result.processed = toProcess.length;
  for (const ret of toProcess) {
    try {
      const order = ret.shopifyOrderId ? await getOrder(ret.shopifyOrderId) : null;
      const lineItems = await resolveReturnLineItems(ret, order);
      const r = await createRma({ poNumber: ret.poNumber, synnexOrderId: ret.synnexOrderId, lineItems });
      await returnsState.markRmaRequested(ret.shopifyReturnId, { rmaNumber: r.rmaNumber, synnexRmaStatus: r.status });
      // TODO (post-spec): relay r.returnLabelUrl / RMA number back to the customer.
      result.submitted += 1;
    } catch (e) {
      await returnsState.markError(ret.shopifyReturnId, e.message).catch(() => {});
      result.errors.push(`${ret.shopifyReturnId}: ${e.message}`);
    }
  }
  return result;
}

/**
 * check-rma: Poll TD SYNNEX RMA status; when received/credited, close out the return.
 * (EventBridge schedule — sibling of check-tracking.)
 */
async function runCheckRma() {
  const result = { checked: 0, received: 0, errors: [] };
  if (!isRmaConfigured()) {
    result.note = 'RMA endpoint not configured — awaiting TD SYNNEX RMA spec (SYNNEX_RMA_STATUS_URL)';
    return result;
  }
  const open = await returnsState.getReturnsByStatus('rma_requested');
  result.checked = open.length;
  for (const ret of open) {
    try {
      const s = await checkRmaStatus({ rmaNumber: ret.rmaNumber, poNumber: ret.poNumber });
      // SPEC TODO: confirm which status string means received/credited.
      if (/receiv|credit|complet|closed/i.test(s.status)) {
        await returnsState.markReceived(ret.shopifyReturnId, { synnexRmaStatus: s.status, returnTracking: s.returnTracking });
        // TODO (post-spec): close the Shopify return + issue the refund via the Returns API (write_returns).
        result.received += 1;
      }
    } catch (e) {
      result.errors.push(`${ret.shopifyReturnId}: ${e.message}`);
    }
  }
  return result;
}

// ─── Clean Home Appliances ────────────────────────────────────────────────────

/**
 * clean-home-appliances: Delete all Shopify products tagged "home-appliances"
 * and remove them from DynamoDB. Safe to re-run.
 *
 * Direct invoke: { "job": "clean-home-appliances" }
 */
async function runCleanHomeAppliances() {
  const { graphql } = require('./shopify/auth');
  const { DynamoDBClient, DeleteItemCommand, ScanCommand } = require('@aws-sdk/client-dynamodb');
  const { marshall, unmarshall } = require('@aws-sdk/util-dynamodb');

  const result = { scannedShopify: 0, deletedShopify: 0, deletedDynamo: 0, errors: [] };

  const LIST = `
    query listByTag($cursor: String) {
      products(first: 250, after: $cursor, query: "tag:home-appliances") {
        pageInfo { hasNextPage endCursor }
        nodes { id variants(first: 1) { nodes { sku } } }
      }
    }
  `;
  const DELETE = `
    mutation productDelete($input: ProductDeleteInput!) {
      productDelete(input: $input) {
        deletedProductId
        userErrors { message }
      }
    }
  `;

  const dynamodb = new DynamoDBClient({});
  const PRODUCTS_TABLE = process.env.PRODUCTS_TABLE;

  let cursor = null;
  do {
    const data = await graphql(LIST, cursor ? { cursor } : {});
    const page = data?.products;
    if (!page) break;

    result.scannedShopify += page.nodes.length;

    await Promise.all(page.nodes.map(async (p) => {
      try {
        const del = await graphql(DELETE, { input: { id: p.id } });
        const errs = del?.productDelete?.userErrors || [];
        if (errs.length) {
          result.errors.push(`${p.id}: ${errs.map(e => e.message).join('; ')}`);
        } else {
          result.deletedShopify += 1;
          // Remove from DynamoDB by SKU
          const sku = p.variants?.nodes?.[0]?.sku;
          if (sku && PRODUCTS_TABLE) {
            try {
              await dynamodb.send(new DeleteItemCommand({
                TableName: PRODUCTS_TABLE,
                Key: marshall({ synnexSku: sku }),
              }));
              result.deletedDynamo += 1;
            } catch (_) {}
          }
        }
      } catch (e) {
        result.errors.push(`${p.id}: ${e.message}`);
      }
    }));

    cursor = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
    if (cursor) await new Promise(r => setTimeout(r, 300));
  } while (cursor);

  return result;
}

// ─── Clean Collections ────────────────────────────────────────────────────────

/**
 * clean-collections: Delete all Shopify collections that have zero products.
 * Empty collections appear as dead nav items — removing them keeps the
 * storefront navigation clean without requiring manual edits.
 */
async function runCleanCollections() {
  const { graphql } = require('./shopify/auth');
  const result = { scanned: 0, deleted: 0, errors: [] };

  const LIST = `
    query listCollections($cursor: String) {
      collections(first: 250, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id
          title
          productsCount { count }
        }
      }
    }
  `;

  const DELETE = `
    mutation deleteCollection($id: ID!) {
      collectionDelete(input: { id: $id }) {
        deletedCollectionId
        userErrors { message }
      }
    }
  `;

  let cursor = null;
  const toDelete = [];

  do {
    const data = await graphql(LIST, cursor ? { cursor } : {});
    const page = data?.collections;
    if (!page) break;
    for (const col of page.nodes) {
      result.scanned++;
      if (col.title !== 'All Products' && col.productsCount?.count === 0) {
        toDelete.push({ id: col.id, title: col.title });
      }
    }
    cursor = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
  } while (cursor);

  for (const col of toDelete) {
    try {
      const del = await graphql(DELETE, { id: col.id });
      const errs = del?.collectionDelete?.userErrors || [];
      if (errs.length) {
        result.errors.push(`${col.title}: ${errs.map(e => e.message).join('; ')}`);
      } else {
        result.deleted++;
        console.log(`[clean-collections] deleted "${col.title}"`);
      }
    } catch (e) {
      result.errors.push(`${col.title}: ${e.message}`);
    }
  }

  return result;
}

/**
 * clean-software: Delete all Shopify products tagged "software". Safe to re-run.
 */
async function runCleanSoftware() {
  const { graphql } = require('./shopify/auth');
  const result = { scanned: 0, deleted: 0, errors: 0 };

  const LIST = `
    query($cursor: String) {
      products(first: 250, after: $cursor, query: "tag:software") {
        pageInfo { hasNextPage endCursor }
        nodes { id }
      }
    }
  `;
  const DELETE = `
    mutation productDelete($input: ProductDeleteInput!) {
      productDelete(input: $input) { deletedProductId userErrors { message } }
    }
  `;

  let cursor = null;
  do {
    const data = await graphql(LIST, cursor ? { cursor } : {});
    const page = data?.products;
    if (!page) break;
    result.scanned += page.nodes.length;

    await Promise.all(page.nodes.map(async (p) => {
      try {
        const del = await graphql(DELETE, { input: { id: p.id } });
        const errs = del?.productDelete?.userErrors || [];
        if (errs.length) result.errors++;
        else result.deleted++;
      } catch (e) { result.errors++; }
    }));

    cursor = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
  } while (cursor);

  console.log(`[clean-software] complete: ${JSON.stringify(result)}`);
  return result;
}

/**
 * fix-monitor-accessories: Products miscategorized as type "Monitors" that are actually accessories
 * (cables, adapters, carts, mounts, stands, filters, docks, hubs, splitters).
 * Moves them to type "Computer Accessories" + computer-accessories tag.
 */
async function runFixMonitorAccessories() {
  const { graphql } = require('./shopify/auth');
  const ACCESSORY_PATTERN = /cable|adapter|converter|dock|hub|cart|mount|bracket|stand|arm|kvm|splitter|switch|extender|filter|scaler|selector/i;
  const result = { scanned: 0, updated: 0, skipped: 0, errors: 0 };

  const LIST = `
    query($cursor: String) {
      products(first: 250, after: $cursor, query: "product_type:Monitors") {
        pageInfo { hasNextPage endCursor }
        nodes { id title tags }
      }
    }
  `;
  const UPDATE = `
    mutation productUpdate($input: ProductInput!) {
      productUpdate(input: $input) {
        product { id }
        userErrors { message }
      }
    }
  `;

  let cursor = null;
  do {
    const data = await graphql(LIST, cursor ? { cursor } : {});
    const page = data?.products;
    if (!page) break;

    await Promise.all(page.nodes.map(async (p) => {
      result.scanned++;
      if (!ACCESSORY_PATTERN.test(p.title)) { result.skipped++; return; }

      const newTags = p.tags
        .filter(t => t !== 'monitors-projectors' && t !== 'monitor')
        .concat(['computer-accessories']);

      try {
        const res = await graphql(UPDATE, {
          input: { id: p.id, productType: 'Computer Accessories', tags: newTags },
        });
        const errs = res?.productUpdate?.userErrors || [];
        if (errs.length) { result.errors++; }
        else { result.updated++; }
      } catch (e) { result.errors++; }
    }));

    cursor = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
  } while (cursor);

  console.log(`[fix-monitor-accessories] complete: ${JSON.stringify(result)}`);
  return result;
}

/**
 * fix-display-cables: Re-tag all "Display Cables" products from monitors-projectors → computer-accessories.
 * Safe to re-run.
 */
async function runFixDisplayCables() {
  const { graphql } = require('./shopify/auth');
  const result = { scanned: 0, updated: 0, skipped: 0, errors: 0 };

  const LIST = `
    query listDisplayCables($cursor: String) {
      products(first: 250, after: $cursor, query: "product_type:'Display Cables'") {
        pageInfo { hasNextPage endCursor }
        nodes { id tags }
      }
    }
  `;
  const UPDATE_TAGS = `
    mutation productUpdate($input: ProductInput!) {
      productUpdate(input: $input) {
        product { id tags }
        userErrors { message }
      }
    }
  `;

  let cursor = null;
  do {
    const data = await graphql(LIST, cursor ? { cursor } : {});
    const page = data?.products;
    if (!page) break;

    await Promise.all(page.nodes.map(async (p) => {
      result.scanned++;
      const hasWrong = p.tags.includes('monitors-projectors');
      const hasRight = p.tags.includes('computer-accessories');
      if (!hasWrong && hasRight) { result.skipped++; return; }

      const newTags = p.tags
        .filter(t => t !== 'monitors-projectors')
        .concat(hasRight ? [] : ['computer-accessories']);

      try {
        const res = await graphql(UPDATE_TAGS, { input: { id: p.id, tags: newTags } });
        const errs = res?.productUpdate?.userErrors || [];
        if (errs.length) { result.errors++; }
        else { result.updated++; }
      } catch (e) {
        result.errors++;
      }
    }));

    cursor = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
  } while (cursor);

  console.log(`[fix-display-cables] complete: ${JSON.stringify(result)}`);
  return result;
}

/**
 * draft-pack-errors: Scan all Shopify products for suspiciously low prices and
 * set them to DRAFT (hidden from storefront). Skips products already draft.
 * Safe to invoke multiple times — idempotent.
 * Runs in batches to stay within Lambda timeout; invoke repeatedly until done.
 *
 * Direct invoke: { "job": "draft-pack-errors" }
 */
async function runDraftPackErrors() {
  const { graphql } = require('./shopify/auth');
  const result = { scanned: 0, drafted: 0, skipped: 0, errors: 0 };

  const CHEAP_PATTERNS = [
    /\bcat\s*[56]\b/i, /patch\s*cab/i, /\bRJ.?(11|45)\b/i,
    /modular.*coupl/i, /inline\s+coupl/i, /wall\s*plate/i,
    /faceplate/i, /keystone/i, /cable\s*tie/i, /velcro/i,
    /telephone.*cab/i, /phone\s*cab/i,
  ];

  const LIST = `
    query($cursor: String) {
      products(first: 250, after: $cursor, query: "status:active") {
        pageInfo { hasNextPage endCursor }
        nodes {
          id title status
          variants(first: 1) { nodes { price compareAtPrice } }
        }
      }
    }
  `;
  const DRAFT = `
    mutation($id: ID!) {
      productUpdate(input: { id: $id, status: DRAFT }) {
        product { id }
        userErrors { message }
      }
    }
  `;

  const startedAt = Date.now();
  const TIMEOUT_MS = 540000; // stop 60s before Lambda hard limit

  let cursor = null;
  do {
    if (Date.now() - startedAt > TIMEOUT_MS) {
      console.log('[draft-pack-errors] approaching timeout, stopping — invoke again to continue');
      break;
    }

    const data = await graphql(LIST, cursor ? { cursor } : {});
    const page = data?.products;
    if (!page) break;

    for (const p of page.nodes) {
      result.scanned++;
      const v = p.variants?.nodes?.[0];
      if (!v) continue;

      const price     = parseFloat(v.price || '0');
      const compareAt = parseFloat(v.compareAtPrice || '0');
      if (price <= 0) continue;
      if (CHEAP_PATTERNS.some(re => re.test(p.title))) continue;

      const flagged = (compareAt > 0 && price < compareAt * 0.15) || price < 2.00;
      if (!flagged) continue;

      try {
        const res = await graphql(DRAFT, { id: p.id });
        const errs = res?.productUpdate?.userErrors || [];
        if (errs.length) result.errors++;
        else result.drafted++;
      } catch (e) {
        result.errors++;
      }
    }

    cursor = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
  } while (cursor);

  console.log(`[draft-pack-errors] complete: ${JSON.stringify(result)}`);
  return result;
}

/**
 * find-pack-errors: Scan Shopify for products with suspiciously low prices —
 * typically caused by pack items where the catalog price wasn't multiplied by
 * the inner pack quantity. Reports up to 250 affected products.
 *
 * A product is flagged when:
 *   - compareAtPrice exists AND price < compareAtPrice × 0.15  (>85% off MSRP)
 *   - OR price < $2.00 for any product (absolute floor)
 *
 * Direct invoke: { "job": "find-pack-errors" }
 */
async function runFindPackErrors() {
  const { graphql } = require('./shopify/auth');
  const result = { scanned: 0, flagged: [], errors: 0 };

  const LIST = `
    query($cursor: String) {
      products(first: 250, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id title productType
          variants(first: 1) {
            nodes { price compareAtPrice sku }
          }
        }
      }
    }
  `;

  let cursor = null;
  do {
    const data = await graphql(LIST, cursor ? { cursor } : {});
    const page = data?.products;
    if (!page) break;

    for (const p of page.nodes) {
      result.scanned++;
      const v = p.variants?.nodes?.[0];
      if (!v) continue;
      const price = parseFloat(v.price || '0');
      const compareAt = parseFloat(v.compareAtPrice || '0');

      const tooFarBelowMsrp = compareAt > 0 && price < compareAt * 0.15;
      const absolutelyTooLow = price > 0 && price < 2.00;

      if (tooFarBelowMsrp || absolutelyTooLow) {
        result.flagged.push({
          id: p.id,
          title: p.title.slice(0, 60),
          productType: p.productType,
          sku: v.sku,
          price,
          compareAtPrice: compareAt || null,
          reason: absolutelyTooLow ? 'price<$2' : `price is ${Math.round(price/compareAt*100)}% of MSRP`,
        });
      }
    }

    cursor = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
    if (cursor) await new Promise(r => setTimeout(r, 200));
  } while (cursor && result.scanned < 50000); // cap at 50k to avoid Lambda timeout

  console.log(`[find-pack-errors] scanned=${result.scanned} flagged=${result.flagged.length}`);
  return result;
}

/**
 * image-backfill: For each Shopify product with no images, query Icecat and attach any found images.
 * Reads all products from DynamoDB, batches Icecat lookups, updates Shopify.
 * Safe to re-run (skips products that already have images).
 *
 * Direct invoke: { "job": "image-backfill" }
 * Optional:      { "job": "image-backfill", "limit": 500 }
 */
async function runImageBackfill(event) {
  const { graphql } = require('./shopify/auth');
  const { getAllProducts } = require('./catalog/products');

  const limit = event?.limit || 2000;
  const CONCURRENCY = 5;
  const result = { scanned: 0, attempted: 0, updated: 0, skipped: 0, errors: 0 };

  const GET_PRODUCT_IMAGES = `
    query getImages($id: ID!) {
      product(id: $id) {
        id
        descriptionHtml
        media(first: 1) { nodes { id } }
        metafield(namespace: "custom", key: "spec_sheet") { value }
        variants(first: 1) { nodes { sku } }
      }
    }
  `;

  const CREATE_MEDIA = `
    mutation productCreateMedia($productId: ID!, $media: [CreateMediaInput!]!) {
      productCreateMedia(productId: $productId, media: $media) {
        media { ... on MediaImage { id image { url } } }
        mediaUserErrors { code field message }
      }
    }
  `;

  const products = await getAllProducts();
  const eligible = products
    .filter(p => p.shopifyProductId && p.mfrPartNumber && p.manufacturer)
    .slice(0, limit);

  result.scanned = eligible.length;

  for (let i = 0; i < eligible.length; i += CONCURRENCY) {
    const batch = eligible.slice(i, i + CONCURRENCY);
    await Promise.all(batch.map(async (p) => {
      try {
        const productGid = p.shopifyProductId.startsWith('gid://')
          ? p.shopifyProductId
          : `gid://shopify/Product/${p.shopifyProductId}`;
        const existing = await graphql(GET_PRODUCT_IMAGES, { id: productGid });
        const prod = existing?.product;
        if (!prod) { result.skipped++; return; }

        const hasImages   = (prod.media?.nodes?.length ?? 0) > 0;
        const hasDesc     = (prod.descriptionHtml || '').trim().length > 0;
        const hasSpecs    = !!prod.metafield?.value;

        // Skip products that already have everything
        if (hasImages && hasDesc && hasSpecs) { result.skipped++; return; }

        result.attempted++;
        const icecat = await fetchIcecatProduct({
          brand: normalizeBrand(p.manufacturer),
          partNumber: p.mfrPartNumber,
          upc: p.upc,
        });
        if (!icecat) { result.skipped++; return; }

        // Attach images if missing
        if (!hasImages && icecat.images.length > 0) {
          const media = icecat.images.slice(0, 5).map(url => ({
            mediaContentType: 'IMAGE',
            originalSource: url,
          }));
          const res = await graphql(CREATE_MEDIA, { productId: productGid, media });
          const errs = res?.productCreateMedia?.mediaUserErrors || [];
          if (errs.length) result.errors++;
        }

        // Write description and/or specs if missing
        const contentUpdate = {};
        if (!hasDesc && icecat.description) contentUpdate.description = icecat.description;
        if (!hasSpecs && icecat.specs?.length > 0) contentUpdate.specs = icecat.specs;

        if (Object.keys(contentUpdate).length > 0) {
          await updateProductContent(productGid, contentUpdate).catch(() => result.errors++);
        }

        result.updated++;
      } catch (e) {
        result.errors++;
      }
    }));
  }

  console.log(`[image-backfill] complete: ${JSON.stringify(result)}`);
  return result;
}

/**
 * Consumer brands with strong Icecat coverage. The catalog is ~80% enterprise/
 * infrastructure/software (HPE, Cisco, Extreme, Veeam, Panduit, Chatsworth…) that
 * Icecat barely covers; targeting these brands keeps the enrichment hit-rate high
 * (~40-50% on the free tier) instead of burning calls on absent SKUs.
 * Matched case-insensitively as a prefix/substring of the catalog manufacturer.
 */
const ENRICH_BRAND_ALLOWLIST = [
  'HP INC', 'HEWLETT PACKARD', 'LENOVO', 'DELL', 'LOGITECH', 'SAMSUNG', 'ASUS', 'ACER',
  'APPLE', 'NVIDIA', 'GETAC', 'EPSON', 'BROTHER', 'CANON', 'TARGUS', 'KENSINGTON', 'BELKIN',
  'TP-LINK', 'NETGEAR', 'D-LINK', 'RAZER', 'CORSAIR', 'STEELSERIES', 'VIEWSONIC', 'BENQ',
  'AOC', 'MSI', 'JABRA', 'POLY', 'SEAGATE', 'WESTERN DIGITAL', 'KINGSTON', 'CRUCIAL',
  'SANDISK', 'INTEL', 'AMD', 'TOSHIBA', 'DYNABOOK', 'SONY', 'LG ELECTRON', 'VERBATIM',
  'WACOM', 'ELGATO', 'ANKER', 'INTELLINET', 'DA-LITE',
];
function isEnrichBrand(manufacturer) {
  const m = (manufacturer || '').toUpperCase();
  return ENRICH_BRAND_ALLOWLIST.some(b => m.includes(b));
}

/**
 * Free Open Icecat returns images + title + specs but gates the prose description
 * (Full-Icecat only). When there's no description but we do have specs, synthesize
 * a clean HTML description from the key specs so product pages still read well.
 */
function specsToDescriptionHtml(title, specs) {
  const flat = [];
  for (const group of specs || []) {
    for (const sp of group.specs || []) {
      if (sp.name && sp.value) flat.push([sp.name, sp.value]);
    }
  }
  if (flat.length === 0) return null;
  const rows = flat.slice(0, 18)
    .map(([n, v]) => `<tr><td style="padding:4px 12px 4px 0;color:#666">${n}</td><td style="padding:4px 0">${v}</td></tr>`)
    .join('');
  const lead = title ? `<p>${title}</p>` : '';
  return `${lead}<table style="border-collapse:collapse;font-size:14px">${rows}</table>`;
}

/**
 * targeted-enrich: resumable, scheduled Icecat enrichment for the marketable,
 * high-coverage consumer-brand hardware. For each ACTIVE Shopify product in the
 * brand allowlist that's missing content, it fetches Icecat and fills in a clean
 * title, images, description, and spec sheet — then tags products that end up with
 * BOTH an image and a description `featured` so they can be floated to the top of
 * each collection (the "nice browsing experience" pass).
 *
 * Resumable: persists its DynamoDB scan cursor + running stats in a jobstate row,
 * so an EventBridge schedule can drive it to completion across many 15-min invokes.
 * Each invoke stops ~90s before the Lambda timeout and saves progress.
 *
 *   { "job": "targeted-enrich" }            # resume (or start) the run
 *   { "job": "targeted-enrich", "reset": true }   # restart from the beginning
 *   { "job": "targeted-enrich", "status": true }  # just report saved progress
 */
async function runTargetedEnrich(event = {}) {
  const { graphql } = require('./shopify/auth');
  const STATE_KEY = 'targeted-enrich';
  const CONCURRENCY = 8;
  const DEADLINE_MS = (config.sync.timeoutSeconds || 510) * 1000;
  const startedAt = Date.now();

  let state = (await getJobState(STATE_KEY)) || null;
  if (event.status) return { state: state || 'not-started' };
  if (event.reset || !state) {
    state = { cursor: null, done: false, stats: { scanned: 0, candidates: 0, active: 0, enriched: 0, featured: 0, noData: 0, skipped: 0, errors: 0 }, startedAt: new Date().toISOString() };
  }
  if (state.done) return { alreadyComplete: true, state };
  const s = state.stats;

  const GET = `query($id: ID!) {
    product(id: $id) {
      id status title descriptionHtml
      media(first: 1) { nodes { id } }
      metafield(namespace: "custom", key: "spec_sheet") { value }
    }
  }`;
  const CREATE_MEDIA = `mutation($productId: ID!, $media: [CreateMediaInput!]!) {
    productCreateMedia(productId: $productId, media: $media) { mediaUserErrors { message } }
  }`;
  const UPDATE = `mutation($input: ProductInput!) {
    productUpdate(input: $input) { product { id } userErrors { message } }
  }`;
  const TAGS_ADD = `mutation($id: ID!, $tags: [String!]!) {
    tagsAdd(id: $id, tags: $tags) { userErrors { message } }
  }`;

  async function processOne(p) {
    try {
      const gid = p.shopifyProductId.startsWith('gid://') ? p.shopifyProductId : `gid://shopify/Product/${p.shopifyProductId}`;
      const prod = (await graphql(GET, { id: gid }))?.product;
      if (!prod) { s.skipped++; return; }
      if (prod.status !== 'ACTIVE') { s.skipped++; return; }      // only enrich live products
      s.active++;

      const hasImages = (prod.media?.nodes?.length ?? 0) > 0;
      const hasDesc   = (prod.descriptionHtml || '').trim().length > 0;
      const hasSpecs  = !!prod.metafield?.value;

      if (hasImages && hasDesc && hasSpecs) {            // already complete — just ensure featured tag
        if (hasImages && hasDesc) { await graphql(TAGS_ADD, { id: gid, tags: ['featured'] }); s.featured++; }
        s.skipped++; return;
      }

      const icecat = await fetchIcecatProduct({ brand: normalizeBrand(p.manufacturer), partNumber: p.mfrPartNumber, upc: p.upc });
      if (!icecat) { s.noData++; return; }

      // Title + description + specs via productUpdate
      const input = { id: gid };
      if (icecat.title && icecat.title.length > 5) input.title = truncateTitle(icecat.title);
      // Prefer Icecat's prose description (Full tier); else synthesize one from specs (free tier).
      if (!hasDesc) {
        const desc = icecat.description || specsToDescriptionHtml(icecat.title, icecat.specs);
        if (desc) input.descriptionHtml = desc;
      }
      if (!hasSpecs && icecat.specs?.length > 0) {
        input.metafields = [{ namespace: 'custom', key: 'spec_sheet', type: 'json', value: JSON.stringify(icecat.specs) }];
      }
      if (Object.keys(input).length > 1) {
        const u = await graphql(UPDATE, { input });
        if (u?.productUpdate?.userErrors?.length) s.errors++;
      }

      // Images via productCreateMedia
      let gotImages = false;
      if (!hasImages && icecat.images?.length > 0) {
        const media = icecat.images.slice(0, 5).map(url => ({ mediaContentType: 'IMAGE', originalSource: url }));
        const m = await graphql(CREATE_MEDIA, { productId: gid, media });
        if (m?.productCreateMedia?.mediaUserErrors?.length) s.errors++; else gotImages = true;
      }

      s.enriched++;
      // Feature products that now have an image (which on the free tier also means a
      // clean title + spec-derived description + spec sheet) — these are the ones worth
      // floating to the top of each collection for a clean browsing experience.
      const nowHasImage = hasImages || gotImages;
      const nowHasDesc  = hasDesc || !!(input.descriptionHtml);
      if (nowHasImage && nowHasDesc) { await graphql(TAGS_ADD, { id: gid, tags: ['featured'] }); s.featured++; }
    } catch (e) {
      s.errors++;
    }
  }

  // Optional safety cap on how many candidates to process this invoke (for test runs).
  const maxCandidates = Number.isFinite(event.maxCandidates) ? event.maxCandidates : Infinity;
  let processedThisRun = 0;

  // Drive the resumable scan until the time budget is spent or the table is exhausted.
  let cursor = state.cursor || undefined;
  while (true) {
    if (Date.now() - startedAt > DEADLINE_MS || processedThisRun >= maxCandidates) { state.cursor = cursor || null; break; }
    const { items, lastKey } = await scanProductsPage({ exclusiveStartKey: cursor, limit: 400 });
    s.scanned += items.length;
    let candidates = items.filter(p => {
      if (!(p.shopifyProductId && p.mfrPartNumber && p.manufacturer && isEnrichBrand(p.manufacturer))) return false;
      // Never enrich/feature non-physical items (warranties, support, services, software) —
      // those should be hidden, not surfaced. categorize flags them as services/software.
      const g = categorize({ unspsc: p.unspsc, description: p.description, category: p.category, manufacturer: p.manufacturer }).group;
      if (g === 'services' || g === 'software') { s.skippedNonPhysical = (s.skippedNonPhysical || 0) + 1; return false; }
      return true;
    });
    if (processedThisRun + candidates.length > maxCandidates) candidates = candidates.slice(0, maxCandidates - processedThisRun);
    s.candidates += candidates.length;
    for (let i = 0; i < candidates.length; i += CONCURRENCY) {
      await Promise.all(candidates.slice(i, i + CONCURRENCY).map(processOne));
    }
    processedThisRun += candidates.length;
    cursor = lastKey;
    if (!lastKey) { state.done = true; state.cursor = null; break; }
    state.cursor = cursor;
    await putJobState(STATE_KEY, state);   // checkpoint each page
  }

  await putJobState(STATE_KEY, state);
  console.log(`[targeted-enrich] ${state.done ? 'COMPLETE' : 'checkpoint'}: ${JSON.stringify(s)}`);
  return { done: state.done, stats: s, elapsedMs: Date.now() - startedAt };
}

// ─── Lambda Entry Point ───────────────────────────────────────────────────────

function isHttpEvent(event) {
  return Boolean(event?.requestContext?.http);
}

function getPath(event) {
  return event?.rawPath || event?.requestContext?.http?.path || '';
}

function resolveJob(event) {
  // EventBridge input or direct invocation
  if (event?.job) return event.job;

  // HTTP path-based routing
  const path = getPath(event);
  if (path.endsWith('/catalog-sync')) return 'catalog-sync';
  if (path.endsWith('/price-sync')) return 'price-sync';
  if (path.endsWith('/submit-orders')) return 'submit-orders';
  if (path.endsWith('/check-tracking')) return 'check-tracking';

  // Body-based override
  if (event?.body) {
    try {
      const body = typeof event.body === 'string' ? JSON.parse(event.body) : event.body;
      if (body?.job) return body.job;
    } catch (_) {}
  }

  return 'price-sync';
}

function jsonResponse(isHttp, statusCode, body) {
  if (!isHttp) return body;
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}

exports.handler = async (event) => {
  const isHttp = isHttpEvent(event);
  const method = event?.requestContext?.http?.method;
  const path = getPath(event);

  // Health check
  if (method === 'GET' && path.endsWith('/health')) {
    return jsonResponse(isHttp, 200, { status: 'ok', service: 'synnex-shopify-sync' });
  }

  // One-time OAuth callback — exchanges authorization code for a permanent access token.
  // Visit this URL after authorizing the app: GET /oauth/callback?code=...
  if (method === 'GET' && path.endsWith('/oauth/callback')) {
    const code = event.queryStringParameters?.code;
    if (!code) return jsonResponse(isHttp, 400, { error: 'Missing code parameter' });
    try {
      const data = await exchangeCodeForToken(code);
      return jsonResponse(isHttp, 200, {
        message: 'Success! Copy the access_token below and set it as SHOPIFY_ACCESS_TOKEN in your .env, then redeploy.',
        access_token: data.access_token,
        scope: data.scope,
      });
    } catch (e) {
      return jsonResponse(isHttp, 500, { error: e.message });
    }
  }

  // B2B Company Standards — returns a company's curated product list for the
  // customer-account UI extension (which has the companyId but can't read the
  // company metafield client-side). CORS-enabled for the extension's fetch.
  if (path.endsWith('/b2b/standards')) {
    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };
    if (method === 'OPTIONS') return { statusCode: 204, headers: cors, body: '' };
    if (method === 'GET') {
      try {
        const raw = event.queryStringParameters?.companyId || '';
        const gid = raw.startsWith('gid://') ? raw : `gid://shopify/Company/${raw}`;
        const rawLoc = event.queryStringParameters?.locationId || '';
        const { graphql: gql } = require('./shopify/auth');
        const data = await gql(
          `query($id: ID!) { company(id: $id) { name metafield(namespace: "$app:standards", key: "products") { value } locations(first: 1) { edges { node { id } } } } }`,
          { id: gid }
        );
        let products = [];
        try { products = JSON.parse(data?.company?.metafield?.value || '[]'); } catch (_) {}

        // Resolve the company location to price against (buyer's selected location, else the company's first).
        const locId = (rawLoc && rawLoc.startsWith('gid://')) ? rawLoc
          : (rawLoc ? `gid://shopify/CompanyLocation/${rawLoc}` : data?.company?.locations?.edges?.[0]?.node?.id);

        // Fetch consumer (retail) + B2B contextual price for each standards variant.
        const ids = products.map((p) => p.variantId).filter(Boolean);
        if (ids.length && locId) {
          try {
            const priced = await gql(
              `query($ids: [ID!]!, $ctx: ContextualPricingContext!) {
                 nodes(ids: $ids) { ... on ProductVariant {
                   id price contextualPricing(context: $ctx) { price { amount currencyCode } }
                 } }
               }`,
              { ids, ctx: { companyLocationId: locId } }
            );
            const byId = {};
            for (const n of (priced?.nodes || [])) {
              if (!n?.id) continue;
              byId[n.id] = {
                retailPrice: n.price != null ? Number(n.price) : null,
                b2bPrice: n.contextualPricing?.price?.amount != null ? Number(n.contextualPricing.price.amount) : null,
                currency: n.contextualPricing?.price?.currencyCode || 'USD',
              };
            }
            products = products.map((p) => ({ ...p, ...(byId[p.variantId] || {}) }));
          } catch (_) { /* pricing is best-effort — fall back to title-only list */ }
        }

        return { statusCode: 200, headers: { ...cors, 'Content-Type': 'application/json' },
          body: JSON.stringify({ company: data?.company?.name || '', products }) };
      } catch (e) {
        return { statusCode: 500, headers: { ...cors, 'Content-Type': 'application/json' }, body: JSON.stringify({ error: e.message }) };
      }
    }
  }

  // Checkout Terms & Agreement text — read by the checkout UI extension to render the
  // scrollable terms. Source: shop metafield custom.checkout_terms (editable in admin);
  // falls back to the terms-of-service page body. Returns { paragraphs: [...] }.
  if (path.endsWith('/checkout/terms')) {
    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };
    if (method === 'OPTIONS') return { statusCode: 204, headers: cors, body: '' };
    if (method === 'GET') {
      try {
        const { graphql: gql } = require('./shopify/auth');
        const data = await gql(`{ shop { metafield(namespace: "custom", key: "checkout_terms") { value } } }`);
        let raw = data?.shop?.metafield?.value || '';
        if (!raw) {
          const pg = await gql(`{ pages(first: 1, query: "handle:terms-of-service") { nodes { body } } }`);
          raw = pg?.pages?.nodes?.[0]?.body || '';
        }
        // Convert any HTML (page fallback) to clean text; metafield is already plain.
        const text = raw
          .replace(/<\/(p|div|li|h[1-6])>/gi, '\n\n').replace(/<li[^>]*>/gi, '• ')
          .replace(/<br\s*\/?>(?!\n)/gi, '\n').replace(/<[^>]+>/g, '')
          .replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ');
        const paragraphs = text.split(/\n\s*\n/).map((s) => s.trim().replace(/[ \t]+/g, ' ')).filter(Boolean);
        return { statusCode: 200, headers: { ...cors, 'Content-Type': 'application/json' },
          body: JSON.stringify({ paragraphs }) };
      } catch (e) {
        return { statusCode: 500, headers: { ...cors, 'Content-Type': 'application/json' }, body: JSON.stringify({ error: e.message, paragraphs: [] }) };
      }
    }
  }

  // Shopify orders/paid webhook — must respond quickly, queues order for processing
  if (method === 'POST' && path.endsWith('/webhook/orders')) {
    const rawBody = event.body || '';
    const hmac = event.headers?.['x-shopify-hmac-sha256'];

    if (!verifyWebhook(rawBody, hmac)) {
      return { statusCode: 401, body: 'Unauthorized' };
    }

    try {
      const payload = JSON.parse(rawBody);
      const order = parseOrderWebhook(payload);

      if (order.lineItems.length === 0) {
        return { statusCode: 200, body: 'No fulfillable items' };
      }

      // Store full order data needed for TD Synnex submission
      await saveOrder({
        ...order,
        shipTo: order.shipTo,
        lineItems: order.lineItems,
      });

      console.log(`[webhook] Queued order ${order.shopifyOrderName} (${order.lineItems.length} items)`);
      return { statusCode: 200, body: 'OK' };
    } catch (e) {
      // If it's a duplicate (order already queued), that's fine
      if (e.name === 'ConditionalCheckFailedException') {
        return { statusCode: 200, body: 'Already queued' };
      }
      console.error('[webhook] Error:', e.message);
      return { statusCode: 500, body: e.message };
    }
  }

  // Shopify orders/cancelled webhook — cancel pending orders before they reach TD Synnex
  if (method === 'POST' && path.endsWith('/webhook/orders-cancelled')) {
    const rawBody = event.body || '';
    const hmac = event.headers?.['x-shopify-hmac-sha256'];

    if (!verifyWebhook(rawBody, hmac)) {
      return { statusCode: 401, body: 'Unauthorized' };
    }

    try {
      const payload = JSON.parse(rawBody);
      const shopifyOrderId = `gid://shopify/Order/${payload.id}`;
      const orderName = payload.name;
      const existing = await getOrder(shopifyOrderId);

      if (!existing) {
        console.log(`[webhook/cancelled] ${orderName} not in queue — nothing to do`);
        return { statusCode: 200, body: 'Not queued' };
      }

      if (existing.status === 'pending' || existing.status === 'error') {
        // Safe to remove — hasn't been submitted to TD Synnex yet
        const { DynamoDBClient, DeleteItemCommand } = require('@aws-sdk/client-dynamodb');
        const { marshall } = require('@aws-sdk/util-dynamodb');
        const client = new DynamoDBClient({});
        await client.send(new DeleteItemCommand({
          TableName: process.env.ORDERS_TABLE,
          Key: marshall({ shopifyOrderId }),
        }));
        console.log(`[webhook/cancelled] ${orderName} removed from queue (was ${existing.status})`);
      } else {
        // Already submitted to TD Synnex — flag for manual cancellation
        await markError(shopifyOrderId, `CANCELLED IN SHOPIFY — manually cancel TD Synnex order ${existing.synnexOrderId || 'unknown'}`);
        console.warn(`[webhook/cancelled] ${orderName} already submitted to TD Synnex (${existing.synnexOrderId}) — manual cancellation required`);
      }

      return { statusCode: 200, body: 'OK' };
    } catch (e) {
      console.error('[webhook/cancelled] Error:', e.message);
      return { statusCode: 500, body: e.message };
    }
  }

  // Shopify refunds/create webhook — log refund, flag fulfilled orders for manual review
  if (method === 'POST' && path.endsWith('/webhook/refunds')) {
    const rawBody = event.body || '';
    const hmac = event.headers?.['x-shopify-hmac-sha256'];

    if (!verifyWebhook(rawBody, hmac)) {
      return { statusCode: 401, body: 'Unauthorized' };
    }

    try {
      const payload = JSON.parse(rawBody);
      const shopifyOrderId = `gid://shopify/Order/${payload.order_id}`;
      const refundAmount = payload.transactions?.reduce((sum, t) => sum + parseFloat(t.amount || 0), 0) || 0;
      const existing = await getOrder(shopifyOrderId);

      console.log(`[webhook/refunds] Refund $${refundAmount} on order ${shopifyOrderId} (status: ${existing?.status || 'not queued'})`);

      if (existing && existing.status === 'submitted') {
        await markError(shopifyOrderId, `REFUND ISSUED $${refundAmount} — check if TD Synnex order ${existing.synnexOrderId} needs to be cancelled`);
      }

      return { statusCode: 200, body: 'OK' };
    } catch (e) {
      console.error('[webhook/refunds] Error:', e.message);
      return { statusCode: 500, body: e.message };
    }
  }

  // Shopify returns/* webhook — capture a return request and queue it for an RMA.
  // Register topics returns/request and/or returns/approve to this address.
  if (method === 'POST' && path.endsWith('/webhook/returns')) {
    const rawBody = event.body || '';
    const hmac = event.headers?.['x-shopify-hmac-sha256'];
    if (!verifyWebhook(rawBody, hmac)) {
      return { statusCode: 401, body: 'Unauthorized' };
    }
    try {
      const ret = parseReturnWebhook(JSON.parse(rawBody));
      // Enrich with the original order's PO + TD SYNNEX order number for the RMA call.
      const order = ret.shopifyOrderId ? await getOrder(ret.shopifyOrderId) : null;
      await returnsState.saveReturn({
        ...ret,
        shopifyOrderName: order?.shopifyOrderName || '',
        poNumber: order?.poNumber || '',
        synnexOrderId: order?.synnexOrderId || '',
      });
      console.log(`[webhook/returns] Queued return ${ret.shopifyReturnId} for order ${ret.shopifyOrderId} (${ret.lineItems.length} items)`);
      return { statusCode: 200, body: 'OK' };
    } catch (e) {
      if (e.name === 'ConditionalCheckFailedException') return { statusCode: 200, body: 'Already queued' };
      console.error('[webhook/returns] Error:', e.message);
      return { statusCode: 500, body: e.message };
    }
  }

  // scan-catalog is handled by the main job dispatcher below (runScanCatalog)

  // Peek first 5 lines of catalog file (debug)
  if (event?.job === 'peek-catalog') {
    if (!isSftpConfigured()) return jsonResponse(isHttp, 400, { error: 'SFTP not configured' });
    try {
      const lines = [];
      await streamCatalogLines({
        onHeader(h) { lines.push({ type: 'header', line: h }); },
        onRow(line) {
          lines.push({ type: 'row', line });
          return lines.length < 6; // stop after 5 data rows
        },
      });
      return jsonResponse(isHttp, 200, { lines });
    } catch (e) {
      return jsonResponse(isHttp, 500, { error: e.message });
    }
  }

  // Count active rows in catalog (debug) — {"job":"count-catalog"}
  if (event?.job === 'count-catalog') {
    if (!isSftpConfigured()) return jsonResponse(isHttp, 400, { error: 'SFTP not configured' });
    try {
      let totalRows = 0;
      let activeRows = 0;
      let parseLine;
      await streamCatalogLines({
        onHeader(h) { parseLine = createLineParser(h); },
        onRow(line) {
          totalRows += 1;
          const p = parseLine(line);
          if (p) activeRows += 1;
          return true; // always continue
        },
      });
      return jsonResponse(isHttp, 200, { totalRows, activeRows });
    } catch (e) {
      return jsonResponse(isHttp, 500, { error: e.message });
    }
  }

  // Sample products matching optional brand/category filters (debug, no Shopify writes)
  // Direct invoke: { "job": "sample-catalog", "brand": "APPLE CTO", "limit": 20 }
  if (event?.job === 'sample-catalog') {
    if (!isSftpConfigured()) return jsonResponse(isHttp, 400, { error: 'SFTP not configured' });
    try {
      const filterBrand = (event.brand || '').toLowerCase();
      const filterCategory = (event.category || '').toLowerCase();
      const sampleLimit = event.limit || 20;
      const products = [];
      let parseLine;
      await streamCatalogLines({
        onHeader(h) { parseLine = createLineParser(h); },
        onRow(line) {
          const p = parseLine(line);
          if (!p) return true;
          if (filterBrand && (p.manufacturer || '').toLowerCase() !== filterBrand) return true;
          if (filterCategory && (p.category || '').toLowerCase() !== filterCategory) return true;
          products.push({
            synnexSku: p.synnexSku,
            mfrPartNumber: p.mfrPartNumber,
            description: p.description,
            manufacturer: p.manufacturer,
            category: p.category,
            price: p.price,
            msrp: p.msrp,
            quantityAvailable: p.quantityAvailable,
            upc: p.upc,
          });
          return products.length < sampleLimit;
        },
      });
      return jsonResponse(isHttp, 200, { count: products.length, products });
    } catch (e) {
      return jsonResponse(isHttp, 500, { error: e.message });
    }
  }

  // Shopify carrier service endpoint — called at checkout to compute shipping options.
  // Shopify expects { rates: [...] } within 10 seconds; no HMAC on this request.
  if (method === 'POST' && path.endsWith('/shipping-rates')) {
    try {
      const body = event.body ? JSON.parse(event.body) : {};
      const rates = await calculateRates(body);
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rates }),
      };
    } catch (e) {
      console.error('[shipping-rates] Error:', e.message);
      return { statusCode: 500, body: e.message };
    }
  }

  // ZIP inspection utility (debug) — HTTP GET or direct invoke {"job":"list-zip"}
  const isListZip = (method === 'GET' && path.endsWith('/list-zip')) || event?.job === 'list-zip';
  if (isListZip) {
    if (!isSftpConfigured()) {
      return jsonResponse(isHttp, 400, { error: 'SFTP not configured' });
    }
    try {
      const entries = await listZipEntries();
      return jsonResponse(isHttp, 200, { entries });
    } catch (e) {
      return jsonResponse(isHttp, 500, { error: e.message });
    }
  }

  const job = resolveJob(event);

  try {
    let result;
    if (job === 'catalog-sync')           result = await runCatalogSync(event);
    else if (job === 'targeted-discover') result = await runTargetedDiscover(event);
    else if (job === 'scan-catalog')      result = await runScanCatalog();
    else if (job === 'fix-publications')  result = await runFixPublications();
    else if (job === 'fix-product-types') result = await runFixProductTypes();
    else if (job === 'fix-mice-cleanup')  result = await runFixMiceCleanup();
    else if (job === 'price-sync')        result = await runPriceSync();
    else if (job === 'refresh-featured')  result = await runRefreshFeatured();
    else if (job === 'clean-collections')     result = await runCleanCollections();
    else if (job === 'clean-home-appliances') result = await runCleanHomeAppliances();
    else if (job === 'clean-software')        result = await runCleanSoftware();
    else if (job === 'image-backfill')        result = await runImageBackfill(event);
    else if (job === 'targeted-enrich')       result = await runTargetedEnrich(event);
    else if (job === 'find-pack-errors')         result = await runFindPackErrors();
    else if (job === 'draft-pack-errors')        result = await runDraftPackErrors();
    else if (job === 'fix-display-cables')       result = await runFixDisplayCables();
    else if (job === 'fix-monitor-accessories')  result = await runFixMonitorAccessories();
    else if (job === 'submit-orders')     result = await runSubmitOrders();
    else if (job === 'check-tracking')    result = await runCheckTracking();
    else if (job === 'submit-rmas')       result = await runSubmitRmas();
    else if (job === 'check-rma')         result = await runCheckRma();
    else if (job === 'reconcile-listings') result = await runReconcileListings({ apply: event?.apply === true, startCursor: event?.startCursor });
    else result = { error: `Unknown job: ${job}` };

    const hasErrors = result.errors?.length > 0 || result.error;
    console.log(`[${job}] complete:`, JSON.stringify({ ...result, errors: result.errors?.length }));
    return jsonResponse(isHttp, hasErrors ? 207 : 200, { job, ...result });
  } catch (e) {
    console.error(`[${job}] fatal:`, e.message);
    return jsonResponse(isHttp, 500, { job, error: e.message });
  }
};
