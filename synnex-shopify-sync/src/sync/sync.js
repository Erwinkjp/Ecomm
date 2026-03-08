/**
 * Sync orchestration: pull from TD Synnex, map to Shopify, push products and inventory.
 */
const { getProductsWithAvailability } = require('../synnex/client');
const { productSet, inventorySetQuantities, getProductBySku } = require('../shopify/client');
const { synnexToShopifyProduct } = require('./transform');

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
    inventoryUpdated: 0,
    errors: [],
  };

  let items;
  try {
    items = await getProductsWithAvailability();
  } catch (e) {
    result.errors.push(`Synnex fetch failed: ${e instanceof Error ? e.message : String(e)}`);
    return result;
  }

  result.productsFetched = items.length;
  const toProcess = limit != null ? items.slice(0, limit) : items;

  const inventoryQuantities = [];

  for (const item of toProcess) {
    try {
      let inventoryItemId;

      if (syncProducts) {
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
