/**
 * Shopify Admin GraphQL client (productSet + inventorySetQuantities).
 *
 * Auth: SHOPIFY_CLIENT_ID + SHOPIFY_CLIENT_SECRET (Dev Dashboard; client_credentials grant).
 * Session is cached and refreshed before expiry (~24h).
 *
 * Also: SHOPIFY_STORE, SHOPIFY_LOCATION_ID (for inventory).
 */
const { URLSearchParams } = require('url');

const DEFAULT_API_VERSION = '2025-01';
const SESSION_REFRESH_BUFFER_MS = 60_000;

/** @type {{ bearer: string | null; expiresAtMs: number }} */
let shopifySession = { bearer: null, expiresAtMs: 0 };

function getStore() {
  const store = process.env.SHOPIFY_STORE;
  if (!store) throw new Error('SHOPIFY_STORE is required (e.g. your-store.myshopify.com)');
  return store.replace(/\.myshopify\.com$/, '');
}

async function exchangeClientCredentials(store) {
  const clientId = process.env.SHOPIFY_CLIENT_ID?.trim();
  const clientSecret = process.env.SHOPIFY_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) {
    throw new Error('SHOPIFY_CLIENT_ID and SHOPIFY_CLIENT_SECRET are required (Dev Dashboard → Settings → Credentials)');
  }

  const res = await fetch(`https://${store}.myshopify.com/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: clientId,
      client_secret: clientSecret,
    }),
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Shopify OAuth credential exchange failed ${res.status}: ${text}`);
  }

  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`Shopify OAuth invalid JSON: ${text}`);
  }
  const bearer = json.access_token;
  if (!bearer) {
    throw new Error(`Shopify OAuth response missing credential: ${text}`);
  }

  const expiresInSec = Number(json.expires_in) || 86399;
  return { bearer, expiresInSec };
}

/**
 * @param {{ bearer?: string }} config
 */
async function getShopifyBearer(config) {
  if (config.bearer) return config.bearer;

  const store = getStore();
  const now = Date.now();
  if (
    shopifySession.bearer &&
    now < shopifySession.expiresAtMs - SESSION_REFRESH_BUFFER_MS
  ) {
    return shopifySession.bearer;
  }

  const { bearer, expiresInSec } = await exchangeClientCredentials(store);
  shopifySession = {
    bearer,
    expiresAtMs: now + expiresInSec * 1000,
  };
  return bearer;
}

function getLocationId() {
  const id = process.env.SHOPIFY_LOCATION_ID;
  if (!id) throw new Error('SHOPIFY_LOCATION_ID is required for inventory (e.g. gid://shopify/Location/123)');
  return id;
}

async function graphql(query, variables, config = {}) {
  const store = config.store ?? getStore();
  const bearer = await getShopifyBearer(config);
  const apiVersion = config.apiVersion ?? process.env.SHOPIFY_API_VERSION ?? DEFAULT_API_VERSION;
  const url = `https://${store}.myshopify.com/admin/api/${apiVersion}/graphql.json`;

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      // Shopify Admin API requires this header name for the OAuth-issued value
      'X-Shopify-Access-Token': bearer,
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

/**
 * List SKUs with variant and inventory item IDs (XML P&A: match Synnex SKUs to Shopify variants).
 */
async function getVariantSkusAndInventoryItemIds(config = {}) {
  const out = [];
  let cursor = null;
  do {
    const query = `
      query variants($cursor: String) {
        productVariants(first: 250, after: $cursor) {
          pageInfo { hasNextPage endCursor }
          nodes {
            id
            sku
            inventoryItem { id }
          }
        }
      }
    `;
    const data = await graphql(query, { cursor }, config);
    const variants = data.productVariants;
    variants.nodes.forEach((n) => {
      if (n.id && n.sku && n.inventoryItem?.id) {
        out.push({ sku: n.sku, variantId: n.id, inventoryItemId: n.inventoryItem.id });
      }
    });
    cursor = variants.pageInfo.hasNextPage ? variants.pageInfo.endCursor : null;
  } while (cursor);
  return out;
}

async function updateVariantPricing({ variantId, price, compareAtPrice }, config = {}) {
  if (!variantId) throw new Error('variantId is required');
  if (!Number.isFinite(Number(price))) throw new Error('price must be a finite number');

  const input = {
    id: variantId,
    price: Number(price).toFixed(2),
  };
  if (compareAtPrice != null && Number.isFinite(Number(compareAtPrice)) && Number(compareAtPrice) > 0) {
    input.compareAtPrice = Number(compareAtPrice).toFixed(2);
  }

  const mutation = `
    mutation productVariantUpdate($input: ProductVariantInput!) {
      productVariantUpdate(input: $input) {
        productVariant {
          id
          price
          compareAtPrice
        }
        userErrors {
          field
          message
        }
      }
    }
  `;

  const data = await graphql(mutation, { input }, config);
  const result = data.productVariantUpdate;
  if (result.userErrors?.length) {
    throw new Error(`productVariantUpdate: ${result.userErrors.map((e) => e.message).join('; ')}`);
  }
  return result.productVariant;
}

module.exports = {
  productSet,
  inventorySetQuantities,
  getProductBySku,
  getVariantSkusAndInventoryItemIds,
  updateVariantPricing,
};
