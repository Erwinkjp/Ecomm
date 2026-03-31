/**
 * Sync orchestration: pull from TD Synnex, map to Shopify, push products and inventory.
 * Supports: REST API, flat file, or Real-Time XML (Price & Availability).
 */
const { getProductsWithAvailability } = require('../synnex/client');
const { getProductsWithAvailabilityFromFile, isFileSourceConfigured } = require('../synnex/fileSource');
const { loadAllowlist } = require('../synnex/allowlist');
const { getPriceAvailabilityFromXml, isXmlConfigured } = require('../synnex/xmlClient');
const {
  productSet,
  inventorySetQuantities,
  getProductBySku,
  getVariantSkusAndInventoryItemIds,
  updateVariantPricing,
} = require('../shopify/client');
const { synnexToShopifyProduct } = require('./transform');
const { filterByBrandAndCategory } = require('./filterByBrandCategory');

async function fetchFromSynnex() {
  const allowlist = await loadAllowlist();
  if (isFileSourceConfigured()) {
    return getProductsWithAvailabilityFromFile(allowlist);
  }
  if (isXmlConfigured()) {
    const variants = await getVariantSkusAndInventoryItemIds();
    const partNumbers = [...new Set(variants.map((v) => v.sku).filter(Boolean))];
    if (partNumbers.length === 0) return [];
    const pAndA = await getPriceAvailabilityFromXml(partNumbers);
    const bySku = new Map(variants.map((v) => [v.sku, v]));
    return pAndA.map((p) => {
      const row = bySku.get(p.partNumber);
      return {
        ...p,
        _inventoryItemId: row?.inventoryItemId,
        _variantId: row?.variantId,
      };
    });
  }
  return getProductsWithAvailability();
}

/**
 * Full sync: fetch from Synnex, optionally create/update products, then set inventory.
 * @param {Object} options
 * @param {boolean} [options.syncProducts=true] - If true, create/update products in Shopify; if false, only update inventory for known SKUs
 * @param {number} [options.limit] - Max products to sync in one run (default all)
 */
async function runSync(options = {}) {
  const { syncProducts = true, limit } = options;
  const result = {
    productsFetched: 0,
    productsSynced: 0,
    pricesUpdated: 0,
    inventoryUpdated: 0,
    errors: [],
  };
  const syncXmlPrices = isXmlConfigured() && process.env.SYNNEX_XML_SYNC_PRICES !== 'false';
  const msrpAsCompareAt = process.env.SYNNEX_XML_MSRP_AS_COMPARE_AT === 'true';

  let items;
  try {
    items = await fetchFromSynnex();
  } catch (e) {
    result.errors.push(`Synnex fetch failed: ${e instanceof Error ? e.message : String(e)}`);
    return result;
  }

  items = filterByBrandAndCategory(items);
  result.productsFetched = items.length;
  const toProcess = limit != null ? items.slice(0, limit) : items;

  const inventoryQuantities = [];

  for (const item of toProcess) {
    try {
      let inventoryItemId = item._inventoryItemId;
      let variantId = item._variantId;

      if (!inventoryItemId && syncProducts && !isXmlConfigured()) {
        const shopifyProduct = synnexToShopifyProduct(item);
        const setResult = await productSet(shopifyProduct);
        if (setResult.inventoryItemIds?.[0]) {
          inventoryItemId = setResult.inventoryItemIds[0];
          result.productsSynced += 1;
        }
      }

      if (!inventoryItemId) {
        const existing = await getProductBySku(item.partNumber);
        inventoryItemId = existing?.inventoryItemId;
        variantId = variantId || existing?.variantId;
      }

      if (
        syncXmlPrices &&
        variantId &&
        item.price != null &&
        Number.isFinite(Number(item.price)) &&
        Number(item.price) >= 0
      ) {
        try {
          await updateVariantPricing({
            variantId,
            price: Number(item.price),
            compareAtPrice:
              msrpAsCompareAt && item.msrp != null && Number.isFinite(Number(item.msrp))
                ? Number(item.msrp)
                : undefined,
          });
          result.pricesUpdated += 1;
        } catch (e) {
          result.errors.push(`${item.partNumber} price update: ${e instanceof Error ? e.message : String(e)}`);
        }
      }

      if (inventoryItemId) {
        const locationId = process.env.SHOPIFY_LOCATION_ID;
        inventoryQuantities.push({
          inventoryItemId,
          locationId,
          quantity: item.quantityAvailable,
        });
      }
    } catch (e) {
      result.errors.push(`${item.partNumber}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  if (inventoryQuantities.length > 0) {
    try {
      await inventorySetQuantities(
        inventoryQuantities,
        { reason: 'synnex-sync', ignoreCompareQuantity: true }
      );
      result.inventoryUpdated = inventoryQuantities.length;
    } catch (e) {
      result.errors.push(`inventorySetQuantities: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  return result;
}

module.exports = { runSync };
