'use strict';

const { config } = require('./config');

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
 * Convert a parsed Synnex catalog product to a Shopify productSet input.
 *
 * @param {object} product - Output from parseCatalogXml()
 * @param {string} [enrichedDescription] - Full HTML description from Icecat (optional)
 * @returns {object} ProductSetInput for the Shopify GraphQL mutation
 */
function toShopifyProduct(product, enrichedDescription) {
  const { synnexSku, mfrPartNumber, description, manufacturer, category, price, msrp } = product;
  const sku = synnexSku || mfrPartNumber;
  const sellingPrice = applyMarkup(price);

  // Show MSRP as compare-at only when it's higher than the selling price
  const compareAtPrice = msrp && msrp > sellingPrice ? msrp : undefined;

  return {
    title: description || sku,
    // Use MPN for the URL handle (more SEO-friendly than the numeric Synnex internal ID)
    handle: toHandle(mfrPartNumber || sku),
    descriptionHtml: enrichedDescription || undefined,
    vendor: manufacturer || undefined,
    productType: category || undefined,
    status: 'ACTIVE',
    // Shopify requires at least one option even for single-variant products
    productOptions: [{ name: 'Title', values: [{ name: 'Default Title' }] }],
    variants: [
      {
        // sku = Synnex internal catalog ID — used by price-sync to query the XML P&A API
        sku,
        // barcode stores the manufacturer part number so merchants can identify the product
        barcode: mfrPartNumber || undefined,
        price: String(sellingPrice),
        compareAtPrice: compareAtPrice != null ? String(compareAtPrice) : undefined,
        inventoryPolicy: 'DENY',
        inventoryItem: { tracked: true },
        optionValues: [{ optionName: 'Title', name: 'Default Title' }],
      },
    ],
  };
}

module.exports = { toShopifyProduct, applyMarkup };
