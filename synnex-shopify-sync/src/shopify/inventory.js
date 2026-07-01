'use strict';

const { graphql } = require('./auth');

const SET_QUANTITIES = `
  mutation inventorySetQuantities($input: InventorySetQuantitiesInput!) {
    inventorySetQuantities(input: $input) {
      inventoryAdjustmentGroup {
        reason
        changes { name quantityAfterChange }
      }
      userErrors { code field message }
    }
  }
`;

const UPDATE_VARIANT_PRICE = `
  mutation productVariantsBulkUpdate($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
    productVariantsBulkUpdate(productId: $productId, variants: $variants) {
      productVariants { id price compareAtPrice inventoryPolicy }
      userErrors { field message }
    }
  }
`;

const SET_METAFIELDS = `
  mutation metafieldsSet($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) {
      metafields { key value }
      userErrors { message }
    }
  }
`;

/**
 * Batch-set absolute inventory quantities at a Shopify location.
 * Uses ignoreCompareQuantity so Shopify treats the values as source-of-truth.
 *
 * @param {Array<{ inventoryItemId: string, locationId: string, quantity: number }>} quantities
 */
async function setInventoryQuantities(quantities) {
  if (quantities.length === 0) return;

  const data = await graphql(SET_QUANTITIES, {
    input: {
      name: 'available',
      reason: 'correction',
      ignoreCompareQuantity: true,
      quantities,
    },
  });

  const { userErrors } = data.inventorySetQuantities;
  if (userErrors?.length) {
    throw new Error(userErrors.map(e => e.message).join('; '));
  }
}

/**
 * Update a variant's selling price, optional compare-at price, and inventory policy.
 *
 * @param {{ productId: string, variantId: string, price: number, compareAtPrice?: number, inventoryPolicy?: 'CONTINUE'|'DENY' }} options
 */
async function updateVariantPrice({ productId, variantId, price, compareAtPrice, inventoryPolicy }) {
  const variant = { id: variantId, price: String(price) };
  if (compareAtPrice != null) variant.compareAtPrice = String(compareAtPrice);
  if (inventoryPolicy) variant.inventoryPolicy = inventoryPolicy;

  const data = await graphql(UPDATE_VARIANT_PRICE, { productId, variants: [variant] });
  const { userErrors } = data.productVariantsBulkUpdate;
  if (userErrors?.length) {
    throw new Error(userErrors.map(e => e.message).join('; '));
  }
}

/**
 * Batch-set a custom.lead_time metafield on a list of product GIDs.
 * Sends up to 25 metafields per API call (Shopify limit).
 *
 * @param {string[]} productIds  - Array of Shopify product GIDs
 * @param {string}   leadTimeText - Text to display, e.g. "Usually ships in 5–7 business days"
 */
async function setProductLeadTimes(productIds, leadTimeText) {
  const metafields = productIds.map(ownerId => ({
    ownerId,
    namespace: 'custom',
    key: 'lead_time',
    value: leadTimeText,
    type: 'single_line_text_field',
  }));

  for (let i = 0; i < metafields.length; i += 25) {
    const chunk = metafields.slice(i, i + 25);
    const data = await graphql(SET_METAFIELDS, { metafields: chunk });
    const { userErrors } = data.metafieldsSet;
    if (userErrors?.length) {
      console.warn(`[lead_time metafields] ${userErrors.map(e => e.message).join('; ')}`);
    }
    if (i + 25 < metafields.length) await new Promise(r => setTimeout(r, 200));
  }
}

/**
 * Batch-set Google Shopping custom labels on products so the Shopify "Google &
 * YouTube" channel can segment the feed. Writes three mm-google-shopping
 * metafields per product (custom_label_0 = margin tier, custom_label_1 = pricing
 * basis, custom_label_2 = ad eligibility). Sends up to 25 metafields per call.
 *
 * @param {Array<{ ownerId: string, marginTier: string, pricingBasis: string, eligibility: string }>} items
 */
async function setGoogleShoppingLabels(items) {
  if (!items.length) return;
  const metafields = [];
  for (const it of items) {
    metafields.push(
      { ownerId: it.ownerId, namespace: 'mm-google-shopping', key: 'custom_label_0', value: it.marginTier,   type: 'single_line_text_field' },
      { ownerId: it.ownerId, namespace: 'mm-google-shopping', key: 'custom_label_1', value: it.pricingBasis,  type: 'single_line_text_field' },
      { ownerId: it.ownerId, namespace: 'mm-google-shopping', key: 'custom_label_2', value: it.eligibility,   type: 'single_line_text_field' },
    );
  }

  for (let i = 0; i < metafields.length; i += 25) {
    const chunk = metafields.slice(i, i + 25);
    const data = await graphql(SET_METAFIELDS, { metafields: chunk });
    const { userErrors } = data.metafieldsSet;
    if (userErrors?.length) {
      console.warn(`[google labels] ${userErrors.map(e => e.message).join('; ')}`);
    }
    if (i + 25 < metafields.length) await new Promise(r => setTimeout(r, 200));
  }
}

module.exports = { setInventoryQuantities, updateVariantPrice, setProductLeadTimes, setGoogleShoppingLabels };
