'use strict';

const { graphql } = require('./auth');

const PRODUCT_UPDATE_PUBLISHED = `
  mutation productUpdate($input: ProductInput!) {
    productUpdate(input: $input) {
      product { id publishedAt }
      userErrors { field message }
    }
  }
`;

/**
 * Publish a product to the Online Store by setting publishedAt.
 * Uses productUpdate (requires write_products only — no publications scope needed).
 */
async function publishProduct(productGid) {
  const data = await graphql(PRODUCT_UPDATE_PUBLISHED, {
    input: { id: productGid, publishedAt: new Date().toISOString() },
  });
  const errors = data.productUpdate?.userErrors || [];
  if (errors.length) {
    throw new Error(errors.map(e => e.message).join('; '));
  }
}

const PRODUCT_SET = `
  mutation productSet($input: ProductSetInput!) {
    productSet(synchronous: true, input: $input) {
      product {
        id
        variants(first: 10) {
          nodes {
            id
            sku
            inventoryItem { id }
          }
        }
      }
      userErrors { code field message }
    }
  }
`;

// Images are attached separately via productCreateMedia (2026-01+)
const CREATE_MEDIA = `
  mutation productCreateMedia($productId: ID!, $media: [CreateMediaInput!]!) {
    productCreateMedia(productId: $productId, media: $media) {
      media {
        ... on MediaImage {
          id
          image { url }
        }
      }
      mediaUserErrors { code field message }
    }
  }
`;

const GET_PRODUCT_BY_SKU = `
  query getProductBySku($query: String!) {
    productVariants(first: 1, query: $query) {
      nodes {
        product { id }
      }
    }
  }
`;

const GET_PRODUCT_BY_HANDLE = `
  query getProductByHandle($handle: String!) {
    productByHandle(handle: $handle) {
      id
    }
  }
`;

const GET_VARIANTS_PAGE = `
  query getVariants($cursor: String) {
    productVariants(first: 250, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id
        sku
        product { id productType }
        inventoryItem { id }
      }
    }
  }
`;

/**
 * Create or update a Shopify product via productSet (upsert by handle).
 * If imageUrls are provided, attaches them via productCreateMedia after upsert.
 *
 * @param {object} input - ProductSetInput
 * @param {string[]} [imageUrls] - Optional image URLs from Icecat
 * @returns {{ productId, variantId, inventoryItemId }}
 */
async function upsertProduct(input, imageUrls = []) {
  // Look up existing product by SKU first, then fall back to handle
  // (Handle fallback handles the case where the SKU format has changed between syncs)
  const sku = input.variants?.[0]?.sku;
  if (sku) {
    const lookup = await graphql(GET_PRODUCT_BY_SKU, { query: `sku:${sku}` });
    const existingId = lookup.productVariants?.nodes?.[0]?.product?.id;
    if (existingId) input = { ...input, id: existingId };
  }

  // If SKU lookup missed but we have a handle, check if a product with that handle exists
  if (!input.id && input.handle) {
    const handleLookup = await graphql(GET_PRODUCT_BY_HANDLE, { handle: input.handle });
    const existingId = handleLookup.productByHandle?.id;
    if (existingId) input = { ...input, id: existingId };
  }

  let data = await graphql(PRODUCT_SET, { input });
  let { product, userErrors } = data.productSet;

  // Handle collision: another product already owns this handle. Append the SKU to make it unique.
  if (userErrors?.some(e => e.code === 'HANDLE_NOT_UNIQUE') && input.handle && sku) {
    const deduped = { ...input, handle: `${input.handle}-${sku}`.toLowerCase().replace(/[^a-z0-9-]/g, '-') };
    data = await graphql(PRODUCT_SET, { input: deduped });
    product = data.productSet.product;
    userErrors = data.productSet.userErrors;
  }

  if (userErrors?.length) {
    throw new Error(userErrors.map(e => `[${e.code}] ${e.message}`).join('; '));
  }

  const productId = product?.id;

  // Attach images if provided
  if (productId && imageUrls.length > 0) {
    const media = imageUrls.map(url => ({
      mediaContentType: 'IMAGE',
      originalSource: url,
      alt: input.title || '',
    }));

    try {
      const mediaData = await graphql(CREATE_MEDIA, { productId, media });
      const mediaErrors = mediaData.productCreateMedia?.mediaUserErrors || [];
      if (mediaErrors.length) {
        // Log but don't fail the sync over image errors
        console.warn(`[images] ${input.title}: ${mediaErrors.map(e => e.message).join('; ')}`);
      }
    } catch (e) {
      console.warn(`[images] ${input.title}: ${e.message}`);
    }
  }

  // Only publish NEW products. If the product already existed (has an id in input),
  // leave its status untouched — draft products manually hidden should stay hidden.
  const isNewProduct = !input.id;
  if (productId && isNewProduct) {
    await publishProduct(productId).catch(e => console.warn(`[publish] ${productId}: ${e.message}`));
  }

  const variant = product?.variants?.nodes?.[0];
  return {
    productId,
    variantId: variant?.id,
    inventoryItemId: variant?.inventoryItem?.id,
  };
}

/**
 * Fetch all Shopify product variants (SKU + inventoryItemId), paginated.
 */
async function getAllVariants() {
  const variants = [];
  let cursor = null;

  do {
    const data = await graphql(GET_VARIANTS_PAGE, cursor ? { cursor } : {});
    const page = data.productVariants;

    for (const v of page.nodes) {
      if (v.sku) {
        variants.push({
          variantId: v.id,
          sku: v.sku,
          productId: v.product?.id,
          productType: v.product?.productType,
          inventoryItemId: v.inventoryItem?.id,
        });
      }
    }

    cursor = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
  } while (cursor);

  return variants;
}

const GET_UNPUBLISHED_PRODUCTS = `
  query getUnpublished($cursor: String) {
    products(first: 250, after: $cursor, query: "published_status:unpublished status:active") {
      pageInfo { hasNextPage endCursor }
      nodes { id }
    }
  }
`;

/**
 * Fetch IDs of all active products not yet published to the Online Store.
 */
async function getUnpublishedProductIds() {
  const ids = [];
  let cursor = null;

  do {
    const data = await graphql(GET_UNPUBLISHED_PRODUCTS, cursor ? { cursor } : {});
    const page = data.products;
    for (const p of page.nodes) ids.push(p.id);
    cursor = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
  } while (cursor);

  return ids;
}

const GET_ACTIVE_PRODUCTS = `
  query getActiveProducts($cursor: String) {
    products(first: 100, after: $cursor, query: "status:active") {
      pageInfo { hasNextPage endCursor }
      nodes {
        id
        title
        variants(first: 1) { nodes { sku } }
      }
    }
  }
`;

/**
 * Fetch one page of active products (id, title, first-variant SKU) for reconciliation.
 * Returns { products: [{id, title, sku}], nextCursor }.
 */
async function getActiveProductsPage(cursor) {
  const data = await graphql(GET_ACTIVE_PRODUCTS, cursor ? { cursor } : {});
  const page = data.products;
  const products = page.nodes.map(n => ({
    id: n.id,
    title: n.title,
    sku: n.variants?.nodes?.[0]?.sku || '',
  }));
  return { products, nextCursor: page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null };
}

const PRODUCT_SET_STATUS = `
  mutation productUpdate($id: ID!, $status: ProductStatus!) {
    productUpdate(input: { id: $id, status: $status }) {
      product { id status }
      userErrors { field message }
    }
  }
`;

/**
 * Set a product's status to DRAFT — removes it from the storefront and all sales
 * channels without deleting it (fully reversible). Used to retire orphaned listings.
 */
async function setProductDraft(productGid) {
  const data = await graphql(PRODUCT_SET_STATUS, { id: productGid, status: 'DRAFT' });
  const errors = data.productUpdate?.userErrors || [];
  if (errors.length) throw new Error(errors.map(e => e.message).join('; '));
}

const UPDATE_PRODUCT_CONTENT = `
  mutation productUpdate($input: ProductInput!) {
    productUpdate(input: $input) {
      product { id }
      userErrors { field message }
    }
  }
`;

/**
 * Write Icecat description and/or spec sheet to a product's metafields.
 * Safe to call on existing products — only updates the fields provided.
 *
 * @param {string} productGid
 * @param {{ description?: string, specs?: Array<{group: string, specs: Array<{name,value}>}> }} content
 */
async function updateProductContent(productGid, { description, specs } = {}) {
  const metafields = [];

  if (specs && specs.length > 0) {
    metafields.push({
      namespace: 'custom',
      key: 'spec_sheet',
      type: 'json',
      value: JSON.stringify(specs),
    });
  }

  const input = { id: productGid };
  if (description) input.descriptionHtml = description;
  if (metafields.length > 0) input.metafields = metafields;

  if (!description && metafields.length === 0) return;

  const data = await graphql(UPDATE_PRODUCT_CONTENT, { input });
  const errors = data.productUpdate?.userErrors || [];
  if (errors.length) {
    throw new Error(errors.map(e => e.message).join('; '));
  }
}

module.exports = { upsertProduct, getAllVariants, getActiveProductsPage, setProductDraft, getUnpublishedProductIds, publishProduct, updateProductContent };
