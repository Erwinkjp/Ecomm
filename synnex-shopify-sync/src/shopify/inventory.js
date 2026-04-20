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
  mutation productVariantUpdate($input: ProductVariantInput!) {
    productVariantUpdate(input: $input) {
      productVariant { id price compareAtPrice }
      userErrors { field message }
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
 * Update a variant's selling price and optional compare-at (MSRP) price.
 *
 * @param {{ variantId: string, price: number, compareAtPrice?: number }} options
 */
async function updateVariantPrice({ variantId, price, compareAtPrice }) {
  const input = { id: variantId, price: String(price) };
  if (compareAtPrice != null) {
    input.compareAtPrice = String(compareAtPrice);
  }

  const data = await graphql(UPDATE_VARIANT_PRICE, { input });
  const { userErrors } = data.productVariantUpdate;
  if (userErrors?.length) {
    throw new Error(userErrors.map(e => e.message).join('; '));
  }
}

module.exports = { setInventoryQuantities, updateVariantPrice };
