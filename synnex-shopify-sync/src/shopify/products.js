'use strict';

const { graphql } = require('./auth');

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
        product { id }
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

  const data = await graphql(PRODUCT_SET, { input });
  const { product, userErrors } = data.productSet;

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
          inventoryItemId: v.inventoryItem?.id,
        });
      }
    }

    cursor = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
  } while (cursor);

  return variants;
}

module.exports = { upsertProduct, getAllVariants };
