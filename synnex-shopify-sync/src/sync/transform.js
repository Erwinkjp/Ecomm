/**
 * Transforms TD Synnex product + availability into Shopify product input.
 */
function synnexToShopifyProduct(p) {
  const handle = p.partNumber
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  const variant = {
    sku: p.partNumber,
    price: p.price != null ? String(p.price) : undefined,
    inventoryPolicy: 'DENY',
  };
  return {
    title: p.description || p.partNumber,
    handle,
    description: p.description ?? undefined,
    vendor: p.manufacturer ?? undefined,
    productType: p.category ?? undefined,
    status: 'ACTIVE',
    variants: [variant],
  };
}

module.exports = { synnexToShopifyProduct };
