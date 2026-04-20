'use strict';

const { config } = require('./config');

/**
 * Filter a product list by configured brands, categories, and SKU allowlist.
 *
 * Rules:
 * - If SYNNEX_SYNC_FILTER_BRANDS is set, only products whose manufacturer matches are kept.
 * - If SYNNEX_SYNC_FILTER_CATEGORIES is set, only products whose category matches are kept.
 * - If SYNNEX_SYNC_ALLOWLIST is set, only those exact SKUs are kept.
 * - All active filters are AND-ed together.
 * - Matching is case-insensitive for brands and categories.
 *
 * @param {object[]} products - Output from parseCatalogXml()
 * @returns {object[]} Filtered product list
 */
function applyFilters(products) {
  const { brands, categories, allowlist } = config.sync;

  const brandSet = brands.length
    ? new Set(brands.map(b => b.toLowerCase()))
    : null;

  const categorySet = categories.length
    ? new Set(categories.map(c => c.toLowerCase()))
    : null;

  const skuSet = allowlist.length ? new Set(allowlist) : null;

  return products.filter(p => {
    const sku = p.synnexSku || p.mfrPartNumber || p.partNumber;

    if (skuSet && !skuSet.has(sku)) return false;

    if (brandSet) {
      const mfr = (p.manufacturer || p.vendor || '').toLowerCase();
      if (!brandSet.has(mfr)) return false;
    }

    if (categorySet) {
      const cat = (p.category || p.productType || '').toLowerCase();
      if (!categorySet.has(cat)) return false;
    }

    return true;
  });
}

module.exports = { applyFilters };
