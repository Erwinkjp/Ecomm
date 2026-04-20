'use strict';

/**
 * Shopify order and fulfillment operations.
 */

const { graphql } = require('./auth');

const GET_UNFULFILLED_ORDERS = `
  query getUnfulfilledOrders($cursor: String) {
    orders(first: 50, after: $cursor, query: "fulfillment_status:unfulfilled financial_status:paid") {
      pageInfo { hasNextPage endCursor }
      nodes {
        id
        name
        email
        shippingAddress {
          name
          address1
          address2
          city
          provinceCode
          zip
          countryCodeV2
          phone
        }
        lineItems(first: 50) {
          nodes {
            id
            quantity
            variant {
              id
              sku
              price
              inventoryItem { id }
            }
            product { id title }
          }
        }
        fulfillments(first: 5) {
          id
          status
        }
      }
    }
  }
`;

const GET_FULFILLMENT_ORDER = `
  query getFulfillmentOrder($orderId: ID!) {
    order(id: $orderId) {
      fulfillmentOrders(first: 5) {
        nodes {
          id
          status
          lineItems(first: 50) {
            nodes {
              id
              remainingQuantity
              lineItem {
                variant { sku }
              }
            }
          }
        }
      }
    }
  }
`;

const CREATE_FULFILLMENT = `
  mutation fulfillmentCreateV2($fulfillment: FulfillmentV2Input!) {
    fulfillmentCreateV2(fulfillment: $fulfillment) {
      fulfillment {
        id
        status
        trackingInfo { number company url }
      }
      userErrors { field message }
    }
  }
`;

/**
 * Fetch all paid, unfulfilled orders from Shopify.
 * @returns {Promise<object[]>} Array of order objects
 */
async function getUnfulfilledOrders() {
  const orders = [];
  let cursor = null;

  do {
    const data = await graphql(GET_UNFULFILLED_ORDERS, cursor ? { cursor } : {});
    const page = data.orders;

    for (const order of page.nodes) {
      // Skip orders that already have a successful fulfillment
      const alreadyFulfilled = order.fulfillments?.some(
        f => ['SUCCESS', 'OPEN'].includes(f.status)
      );
      if (!alreadyFulfilled) {
        orders.push(order);
      }
    }

    cursor = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
  } while (cursor);

  return orders;
}

/**
 * Get the fulfillment order ID needed to create a fulfillment.
 * Shopify requires a fulfillment order ID (separate from order ID) since 2022.
 *
 * @param {string} orderId - Shopify order GID
 * @returns {string|null} Fulfillment order ID
 */
async function getFulfillmentOrderId(orderId) {
  const data = await graphql(GET_FULFILLMENT_ORDER, { orderId });
  const fulfillmentOrders = data.order?.fulfillmentOrders?.nodes || [];

  // Return the first open fulfillment order
  const open = fulfillmentOrders.find(fo => fo.status === 'OPEN');
  return open?.id || fulfillmentOrders[0]?.id || null;
}

/**
 * Create a fulfillment on a Shopify order with tracking information.
 *
 * @param {object} options
 * @param {string} options.orderId           - Shopify order GID
 * @param {string[]} options.trackingNumbers  - Carrier tracking numbers
 * @param {string} options.carrier            - Carrier name (FedEx, UPS, USPS, etc.)
 * @param {string} [options.notifyCustomer]   - Send email to customer (default true)
 */
async function createFulfillment({ orderId, trackingNumbers, carrier, notifyCustomer = true }) {
  const fulfillmentOrderId = await getFulfillmentOrderId(orderId);
  if (!fulfillmentOrderId) {
    throw new Error(`No open fulfillment order found for Shopify order ${orderId}`);
  }

  const trackingInfo = trackingNumbers.map(number => ({
    number,
    company: carrier,
  }));

  const data = await graphql(CREATE_FULFILLMENT, {
    fulfillment: {
      lineItemsByFulfillmentOrder: [{ fulfillmentOrderId }],
      trackingInfo: trackingInfo[0], // Shopify takes one tracking per fulfillment
      notifyCustomer,
    },
  });

  const { fulfillment, userErrors } = data.fulfillmentCreateV2;
  if (userErrors?.length) {
    throw new Error(userErrors.map(e => e.message).join('; '));
  }

  return fulfillment;
}

module.exports = { getUnfulfilledOrders, createFulfillment };
