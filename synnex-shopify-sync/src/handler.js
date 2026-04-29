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
const { upsertProduct, getAllVariants } = require('./shopify/products');
const { setInventoryQuantities, updateVariantPrice, setProductLeadTimes } = require('./shopify/inventory');
const { toShopifyProduct, applyMarkup, mapCategory, buildTags, normalizeBrand, expandAppleTitle } = require('./transform');
const { saveProduct, getAllProducts, getProductCount } = require('./catalog/products');
const { fetchIcecatProduct } = require('./icecat/client');
const { verifyWebhook, parseOrderWebhook } = require('./shopify/webhooks');
const { exchangeCodeForToken } = require('./shopify/auth');
const { calculateRates } = require('./shopify/shippingRates');
const { getUnfulfilledOrders, createFulfillment, addOrderNote } = require('./shopify/orders');
const { submitOrder } = require('./synnex/orderSubmit');
const { checkOrderStatus } = require('./synnex/orderStatus');
const { saveOrder, markSubmitted, markShipped, markFulfilled, markError, getOrdersByStatus, getOrder } = require('./orders/state');

// ─── Catalog Sync ─────────────────────────────────────────────────────────────

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
    if (config.icecat.username) {
      try {
        const icecat = await fetchIcecatProduct({
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
      shopifyInput.title = enrichedTitle;
    } else if (normalizeBrand(product.manufacturer) === 'Apple') {
      shopifyInput.title = expandAppleTitle(product.description);
    }
    const { productId, variantId, inventoryItemId } = await upsertProduct(shopifyInput, images);
    result.synced += 1;

    // Persist to the approved-products catalog in DynamoDB.
    // This becomes the permanent record of what we sell — future syncs can
    // read from here instead of re-scanning the 1M-row catalog file.
    const { type: productType } = mapCategory(product.category, product.description);
    const tags = buildTags(product.manufacturer, product.category, product.description);
    await saveProduct({
      synnexSku:              sku,
      mfrPartNumber:          product.mfrPartNumber,
      description:            product.description,
      manufacturer:           product.manufacturer,
      category:               product.category,
      productType,
      tags,
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

  // Load all SKUs already in Shopify so we can skip them and advance through the catalog.
  // Each run processes the NEXT batch of new products rather than re-syncing the same ones.
  const existingVariants = await getAllVariants();
  const syncedSkuSet = new Set(existingVariants.map(v => v.sku).filter(Boolean));

  // Stop streaming 90s before Lambda's hard timeout so we can flush and return cleanly
  const LAMBDA_TIMEOUT_MS = (config.sync.timeoutSeconds || 510) * 1000;
  const startedAt = Date.now();

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

      if (skuSet && !skuSet.has(product.synnexSku || product.mfrPartNumber)) return true;
      if (brandSet && !brandSet.has((product.manufacturer || '').toLowerCase())) return true;
      if (categorySet && !categorySet.has((product.category || '').toLowerCase())) return true;

      // Exclude warranties, service plans, software, and non-office categories across all brands.
      // These are never sellable hardware items and would pollute the store.
      if (EXCLUDED_CATEGORIES.has((product.category || '').toLowerCase())) return true;

      // Skip products already in Shopify — price-sync handles their price/inventory updates.
      // This lets each catalog-sync run advance past already-synced SKUs and pick up new ones.
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

  if (targetTypes.size === 0 && targetTags.size === 0) {
    throw new Error(
      'targeted-discover requires at least one "types" or "tags" array.\n' +
      'Example: { "job": "targeted-discover", "tags": ["keyboard", "mouse"] }'
    );
  }

  const limit       = event.limit ?? config.sync.limit;
  const concurrency = config.sync.concurrency;
  const LAMBDA_TIMEOUT_MS = (config.sync.timeoutSeconds || 510) * 1000;
  const startedAt   = Date.now();

  // Load already-synced SKUs so we skip products already in Shopify.
  // price-sync handles their price/inventory updates — we only want new ones.
  const existingVariants = await getAllVariants();
  const syncedSkuSet = new Set(existingVariants.map(v => v.sku).filter(Boolean));

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

      // Reject excluded categories (warranties, software licences, etc.)
      if (EXCLUDED_CATEGORIES.has((product.category || '').toLowerCase())) return true;

      // mapCategory is a pure sync function — no I/O.  Rejecting here means
      // non-matching rows cost only one regex pass before being discarded,
      // allowing the scanner to cover the full file within the Lambda budget.
      const { type: mappedType, tags: mappedTags } = mapCategory(product.category, product.description);
      const typeMatch = targetTypes.size > 0 && targetTypes.has((mappedType || '').toLowerCase());
      const tagMatch  = targetTags.size  > 0 && mappedTags.some(t => targetTags.has(t.toLowerCase()));
      if (!typeMatch && !tagMatch) return true;

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

  const result = { skusChecked: 0, pricesUpdated: 0, inventoryUpdated: 0, errors: [], timedOut: false };

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

    for (const product of batch) {
      if (!product.synnexSku) continue;
      const data = byPartNumber.get(product.synnexSku);
      if (!data) continue;

      const isSpecialOrder = SPECIAL_ORDER_TYPES.has(product.productType);
      const qty = data.quantityAvailable ?? 0;

      // Update variant price + inventory policy.
      // Only queue the inventory update when the price update succeeds — a successful
      // price write confirms the Shopify GIDs are still valid, so the inventory item
      // ID is also trustworthy. Stale GIDs (deleted/recreated products) are skipped.
      if (syncPrices && data.price != null && product.shopifyVariantId) {
        try {
          const inventoryPolicy = isSpecialOrder && qty === 0 ? 'CONTINUE' : 'DENY';
          await updateVariantPrice({
            productId: product.shopifyProductId,
            variantId: product.shopifyVariantId,
            price: applyMarkup(data.price),
            compareAtPrice: msrpAsCompareAt && data.msrp ? data.msrp : undefined,
            inventoryPolicy,
          });
          result.pricesUpdated += 1;
          if (isSpecialOrder && qty === 0) specialOrderProductIds.add(product.shopifyProductId);
          if (product.shopifyInventoryItemId && locationId) {
            inventoryUpdates.push({ inventoryItemId: product.shopifyInventoryItemId, locationId, quantity: qty });
          }
        } catch (e) {
          result.errors.push(`${product.synnexSku} price: ${e.message}`);
        }
      }
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
      const submitResult = await submitOrder({
        poNumber: stateOrder.poNumber,
        shipTo: stateOrder.shipTo,
        lineItems: stateOrder.lineItems,
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

  // Scan catalog and return all unique brands + categories (debug/setup)
  if (event?.job === 'scan-catalog') {
    if (!isSftpConfigured()) return jsonResponse(isHttp, 400, { error: 'SFTP not configured' });
    try {
      const brands = new Map();   // brand → count
      const categories = new Map(); // category → count
      let parseLine;
      await streamCatalogLines({
        onHeader(h) { parseLine = createLineParser(h); },
        onRow(line) {
          const p = parseLine(line);
          if (!p) return true;
          if (p.manufacturer) brands.set(p.manufacturer, (brands.get(p.manufacturer) || 0) + 1);
          if (p.category)     categories.set(p.category, (categories.get(p.category) || 0) + 1);
          return true;
        },
      });
      const sort = (m) => [...m.entries()].sort((a, b) => b[1] - a[1]).map(([name, count]) => ({ name, count }));
      return jsonResponse(isHttp, 200, { brands: sort(brands), categories: sort(categories) });
    } catch (e) {
      return jsonResponse(isHttp, 500, { error: e.message });
    }
  }

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
      const rates = calculateRates(body);
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
    else if (job === 'price-sync')        result = await runPriceSync();
    else if (job === 'refresh-featured')  result = await runRefreshFeatured();
    else if (job === 'clean-collections') result = await runCleanCollections();
    else if (job === 'submit-orders')     result = await runSubmitOrders();
    else if (job === 'check-tracking')    result = await runCheckTracking();
    else result = { error: `Unknown job: ${job}` };

    const hasErrors = result.errors?.length > 0 || result.error;
    console.log(`[${job}] complete:`, JSON.stringify({ ...result, errors: result.errors?.length }));
    return jsonResponse(isHttp, hasErrors ? 207 : 200, { job, ...result });
  } catch (e) {
    console.error(`[${job}] fatal:`, e.message);
    return jsonResponse(isHttp, 500, { job, error: e.message });
  }
};
