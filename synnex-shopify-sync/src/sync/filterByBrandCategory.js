/**
 * Filter synced items by brand/manufacturer and/or category.
 * Env: SYNNEX_SYNC_FILTER_BRANDS (comma-separated), SYNNEX_SYNC_FILTER_CATEGORIES (comma-separated).
 * Matching is case-insensitive. If both are set, item must match both (AND).
 */
function parseList(envValue) {
  if (!envValue || !String(envValue).trim()) return null;
  return new Set(
    String(envValue)
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean)
  );
}

function matches(item, brandsSet, categoriesSet) {
  const brand = (item.manufacturer || item.brand || '').trim().toLowerCase();
  const cat = (item.category || '').trim().toLowerCase();
  if (brandsSet && brandsSet.size > 0 && !brandsSet.has(brand)) return false;
  if (categoriesSet && categoriesSet.size > 0 && !categoriesSet.has(cat)) return false;
  return true;
}

function filterByBrandAndCategory(items) {
  const brands = parseList(process.env.SYNNEX_SYNC_FILTER_BRANDS);
  const categories = parseList(process.env.SYNNEX_SYNC_FILTER_CATEGORIES);
  if (!brands && !categories) return items;
  return items.filter((item) => matches(item, brands, categories));
}

module.exports = { filterByBrandAndCategory };