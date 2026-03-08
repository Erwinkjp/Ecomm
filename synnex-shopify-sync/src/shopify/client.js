/**
 * Shopify Admin GraphQL client (productSet + inventorySetQuantities).
 * Requires SHOPIFY_STORE, SHOPIFY_ACCESS_TOKEN, and optionally SHOPIFY_LOCATION_ID.
 */
const DEFAULT_API_VERSION = '2025-01';

function getStore() {
  const store = process.env.SHOPIFY_STORE;
  if (!store) throw new Error('SHOPIFY_STORE is required (e.g. your-store.myshopify.com)');
  return store.replace(/\.myshopify\.com$/, '');
}

function getAccessToken() {
  const token = process.env.SHOPIFY_ACCESS_TOKEN;
  if (!token) throw new Error('SHOPIFY_ACCESS_TOKEN is required');
  return token;
}

function getLocationId() {
  const id = process.env.SHOPIFY_LOCATION_ID;
  if (!id) throw new Error('SHOPIFY_LOCATION_ID is required for inventory (e.g. gid://shopify/Location/123)');
  return id;
}

async function graphql(query, variables, config = {}) {
  const store = config.store ?? getStore();
  const accessToken = config.accessToken ?? getAccessToken();
  const apiVersion = config.apiVersion ?? process.env.SHOPIFY_API_VERSION ?? DEFAULT_API_VERSION;
  const url = `https://${store}.myshopify.com/admin/api/${apiVersion}/graphql.json`;

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': accessToken,
    },
    body: JSON.stringify({ query, variables }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Shopify GraphQL error ${res.status}: ${text}`);
  }

  const json = await res.json();
  if (json.errors?.length) {
    throw new Error(`Shopify GraphQL errors: ${json.errors.map((e) => e.message).join('; ')}`);
  }
  if (json.data == null) throw new Error('Shopify response missing data');
  return json.data;
}

/**
 * Create or update a product using productSet (upsert by handle or id).
 */
async function productSet(product, config = {}) {
  const productInput = {
    title: product.title,
    status: product.status ?? 'ACTIVE',
  };
  if (product.handle) productInput.handle = product.handle;
  if (product.description != null) productInput.descriptionHtml = product.description;
  if (product.vendor) productInput.vendor = product.vendor;
  if (product.productType) productInput.productType = product.productType;
  if (product.id) productInput.id = product.id;

  if (product.variants?.length) {
    productInput.variants = product.variants.map((v) => ({
      sku: v.sku,
      price: v.price,
      compareAtPrice: v.compareAtPrice,
      inventoryPolicy: v.inventoryPolicy ?? 'DENY',
      options: v.options,
    }));
  }

  const query = `
    mutation productSet($product: ProductSetInput!) {
      productSet(product: $product) {
        product {
          id
          variants(first: 100) {
            nodes {
              id
              sku
              inventoryItem {
                id
              }
            }
          }
        }
        userErrors {
          code
          field
          message
        }
      }
    }
  `;

  const data = await graphql(query, { product: productInput }, config);
  const result = data.productSet;
  if (result.userErrors?.length) {
    throw new Error(`productSet userErrors: ${result.userErrors.map((e) => e.message).join('; ')}`);
  }
  const prod = result.product;
  if (!prod) return {};

  const variantIds = prod.variants?.nodes?.map((n) => n.id) ?? [];
  const inventoryItemIds = (prod.variants?.nodes?.map((n) => n.inventoryItem?.id).filter(Boolean) ?? []);
  return {
    productId: prod.id,
    variantIds,
    inventoryItemIds,
  };
}

/**
 * Set inventory quantities at a location (inventorySetQuantities).
 */
async function inventorySetQuantities(quantities, options = {}, config = {}) {
  const locationId = config.locationId ?? getLocationId();
  const key = options.idempotencyKey ?? `synnex-sync-${Date.now()}`;

  const input = {
    name: 'available',
    reason: options.reason ?? 'correction',
    referenceDocumentUri: `synnex-sync://lambda/${key}`,
    ignoreCompareQuantity: options.ignoreCompareQuantity ?? true,
    quantities: quantities.map((q) => ({
      inventoryItemId: q.inventoryItemId,
      locationId,
      quantity: q.quantity,
      compareQuantity: q.compareQuantity ?? null,
    })),
  };

  const query = `
    mutation inventorySetQuantities($input: InventorySetQuantitiesInput!) {
      inventorySetQuantities(input: $input) {
        inventoryAdjustmentGroup {
          reason
          changes {
            name
            quantityAfterChange
          }
        }
        userErrors {
          code
          field
          message
        }
      }
    }
  `;

  const data = await graphql(query, { input }, config);
  const result = data.inventorySetQuantities;
  if (result.userErrors?.length) {
    throw new Error(`inventorySetQuantities userErrors: ${result.userErrors.map((e) => e.message).join('; ')}`);
  }
}

/**
 * Look up product by SKU to get inventory item and variant IDs (for inventory-only updates).
 */
async function getProductBySku(sku, config = {}) {
  const query = `
    query getProductBySku($query: String!) {
      productVariants(first: 1, query: $query) {
        nodes {
          id
          sku
          product { id }
          inventoryItem { id }
        }
      }
    }
  `;
  const data = await graphql(query, { query: `sku:${sku}` }, config);
  const node = data.productVariants?.nodes?.[0];
  if (!node?.inventoryItem?.id) return null;
  return {
    productId: node.product.id,
    variantId: node.id,
    inventoryItemId: node.inventoryItem.id,
  };
}

module.exports = {
  productSet,
  inventorySetQuantities,
  getProductBySku,
};
