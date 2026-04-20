'use strict';

/**
 * Lambda handler for TD Synnex ↔ Shopify integration.
 *
 * Jobs:
 *   catalog-sync    – Daily: SFTP → parse catalog → create/update Shopify products
 *   price-sync      – Hourly: TD Synnex XML P&A → update prices + inventory
 *   submit-orders   – Every 5 min: pick up pending Shopify orders → submit to TD Synnex
 *   check-tracking  – Every 30 min: check TD Synnex order status → update Shopify fulfillments
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
const { setInventoryQuantities, updateVariantPrice } = require('./shopify/inventory');
const { toShopifyProduct, applyMarkup } = require('./transform');
const { fetchIcecatProduct } = require('./icecat/client');
const { verifyWebhook, parseOrderWebhook } = require('./shopify/webhooks');
const { exchangeCodeForToken } = require('./shopify/auth');
const { getUnfulfilledOrders, createFulfillment } = require('./shopify/orders');
const { submitOrder } = require('./synnex/orderSubmit');
const { checkOrderStatus } = require('./synnex/orderStatus');
const { saveOrder, markSubmitted, markShipped, markFulfilled, markError, getOrdersByStatus } = require('./orders/state');

// ─── Catalog Sync ─────────────────────────────────────────────────────────────

/**
 * Download XML catalog from SFTP, parse it, filter by brand/category,
 * then create or update each product in Shopify.
 */
async function runCatalogSync() {
  validateShopify();
  if (!isSftpConfigured()) {
    throw new Error('SFTP not configured. Set SYNNEX_SFTP_HOST, SYNNEX_SFTP_USERNAME, SYNNEX_SFTP_REMOTE_PATH, and SYNNEX_SFTP_PASSWORD (or SYNNEX_SFTP_SECRET_ARN).');
  }

  const result = { fetched: 0, synced: 0, errors: [] };
  const limit = config.sync.limit;

  // Build filter sets once so we don't recompute on every row
  const { brands, categories, allowlist } = config.sync;
  const brandSet = brands.length ? new Set(brands.map(b => b.toLowerCase())) : null;
  const categorySet = categories.length ? new Set(categories.map(c => c.toLowerCase())) : null;
  const skuSet = allowlist.length ? new Set(allowlist) : null;

  // Collect matching products (up to limit) without loading the full file into arrays
  const toProcess = [];
  let parseLine;

  await streamCatalogLines({
    onHeader(headerLine) {
      parseLine = createLineParser(headerLine);
    },
    onRow(line) {
      const product = parseLine(line);
      if (!product) return true;

      const sku = product.synnexSku || product.mfrPartNumber;
      if (skuSet && !skuSet.has(sku)) return true;
      if (brandSet && !brandSet.has((product.manufacturer || '').toLowerCase())) return true;
      if (categorySet && !categorySet.has((product.category || '').toLowerCase())) return true;

      toProcess.push(product);
      result.fetched += 1;

      // Stop scanning the file once we have enough
      if (limit && toProcess.length >= limit) return false;
      return true;
    },
  });

  for (const product of toProcess) {
    const sku = product.synnexSku || product.mfrPartNumber;
    try {
      // Enrich with Icecat description + images (non-fatal if unavailable)
      let enrichedDescription;
      let images = [];
      if (config.icecat.username) {
        try {
          const icecat = await fetchIcecatProduct({
            brand: product.manufacturer,
            partNumber: product.mfrPartNumber,
            upc: product.upc,
          });
          if (icecat) {
            enrichedDescription = icecat.description;
            images = icecat.images;
          }
        } catch (_) {
          // Icecat failure never blocks the sync
        }
      }

      await upsertProduct(toShopifyProduct(product, enrichedDescription), images);
      result.synced += 1;
    } catch (e) {
      result.errors.push(`${sku}: ${e.message}`);
    }
  }

  return result;
}

// ─── Price & Inventory Sync ───────────────────────────────────────────────────

/**
 * Fetch price & availability from TD Synnex XML P&A API for all Shopify SKUs,
 * then update variant prices and inventory quantities.
 */
async function runPriceSync() {
  validateShopify();
  if (!isXmlConfigured()) {
    throw new Error('XML P&A not configured. Set SYNNEX_XML_CUSTOMER_NO, SYNNEX_XML_USERNAME, and SYNNEX_XML_PASSWORD.');
  }

  const result = { skusChecked: 0, pricesUpdated: 0, inventoryUpdated: 0, errors: [] };

  // Get all variants currently in Shopify
  const variants = await getAllVariants();
  const skus = [...new Set(variants.map(v => v.sku).filter(Boolean))];
  if (skus.length === 0) return result;

  result.skusChecked = skus.length;

  // Query TD Synnex for real-time price & availability
  const pAndA = await fetchPriceAvailability(skus);
  const byPartNumber = new Map(pAndA.map(p => [p.partNumber, p]));

  const { locationId } = config.shopify;
  const { syncPrices, msrpAsCompareAt } = config.synnex.xml;
  const inventoryUpdates = [];

  for (const variant of variants) {
    if (!variant.sku) continue;
    const data = byPartNumber.get(variant.sku);
    if (!data) continue;

    // Update variant price
    if (syncPrices && data.price != null && variant.variantId) {
      try {
        await updateVariantPrice({
          variantId: variant.variantId,
          price: applyMarkup(data.price),
          compareAtPrice: msrpAsCompareAt && data.msrp ? data.msrp : undefined,
        });
        result.pricesUpdated += 1;
      } catch (e) {
        result.errors.push(`${variant.sku} price: ${e.message}`);
      }
    }

    // Collect inventory update
    if (variant.inventoryItemId && locationId) {
      inventoryUpdates.push({
        inventoryItemId: variant.inventoryItemId,
        locationId,
        quantity: data.quantityAvailable,
      });
    }
  }

  // Send inventory updates in one batch
  if (inventoryUpdates.length > 0) {
    try {
      await setInventoryQuantities(inventoryUpdates);
      result.inventoryUpdated = inventoryUpdates.length;
    } catch (e) {
      result.errors.push(`inventory batch: ${e.message}`);
    }
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
    if (job === 'catalog-sync')    result = await runCatalogSync();
    else if (job === 'price-sync') result = await runPriceSync();
    else if (job === 'submit-orders')  result = await runSubmitOrders();
    else if (job === 'check-tracking') result = await runCheckTracking();
    else result = { error: `Unknown job: ${job}` };

    const hasErrors = result.errors?.length > 0 || result.error;
    console.log(`[${job}] complete:`, JSON.stringify({ ...result, errors: result.errors?.length }));
    return jsonResponse(isHttp, hasErrors ? 207 : 200, { job, ...result });
  } catch (e) {
    console.error(`[${job}] fatal:`, e.message);
    return jsonResponse(isHttp, 500, { job, error: e.message });
  }
};
