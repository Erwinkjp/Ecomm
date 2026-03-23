/**
 * Shopify Admin API client (server-only).
 * Used for order lookup and return creation — actions that require
 * the Admin access token and must never run in the browser.
 */

const domain = process.env.NEXT_PUBLIC_SHOPIFY_STORE_DOMAIN;
const adminToken = process.env.SHOPIFY_ADMIN_ACCESS_TOKEN;

async function adminFetch({ query, variables = {} }) {
  if (!domain || !adminToken) {
    throw new Error('Shopify Admin API is not configured. Set SHOPIFY_ADMIN_ACCESS_TOKEN and NEXT_PUBLIC_SHOPIFY_STORE_DOMAIN.');
  }

  const res = await fetch(`https://${domain}/admin/api/2025-01/graphql.json`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': adminToken,
    },
    body: JSON.stringify({ query, variables }),
    cache: 'no-store',
  });

  if (!res.ok) {
    throw new Error(`Shopify Admin API error: ${res.status} ${res.statusText}`);
  }

  const json = await res.json();
  if (json.errors?.length) {
    throw new Error(json.errors[0].message);
  }
  return json.data;
}

/**
 * Look up a single order by order name (e.g. "#1042") and customer email.
 * Returns null if not found or email doesn't match (security check).
 */
export async function lookupOrder(orderName, email) {
  // Normalize: strip leading # if provided, then re-add for query
  const normalized = orderName.replace(/^#/, '');
  const queryStr = `name:#${normalized}`;

  const data = await adminFetch({
    query: `
      query LookupOrder($query: String!) {
        orders(first: 1, query: $query) {
          nodes {
            id
            name
            email
            createdAt
            displayFulfillmentStatus
            cancelledAt
            totalPriceSet {
              shopMoney { amount currencyCode }
            }
            shippingAddress {
              name
              address1
              city
              provinceCode
              zip
              countryCode
            }
            fulfillments(first: 5) {
              status
              trackingInfo(first: 3) {
                number
                url
                company
              }
              updatedAt
            }
            lineItems(first: 20) {
              nodes {
                id
                title
                sku
                quantity
                currentQuantity
                refundableQuantity
                originalUnitPriceSet {
                  shopMoney { amount currencyCode }
                }
                image {
                  url
                  altText
                }
              }
            }
          }
        }
      }
    `,
    variables: { query: queryStr },
  });

  const order = data?.orders?.nodes?.[0];
  if (!order) return null;

  // Security: ensure the email matches so customers can't enumerate orders
  if (order.email?.toLowerCase() !== email.trim().toLowerCase()) return null;

  return order;
}

/**
 * Create a return for an order line item using the Shopify returnCreate mutation.
 * Returns { returnId, rmaNumber } on success or throws on error.
 */
export async function createReturn({ orderId, lineItemId, quantity, reason, customerNote }) {
  // Map human reason strings to Shopify's ReturnReasonCode enum
  const REASON_MAP = {
    'Item damaged / DOA':     'DEFECTIVE',
    'Wrong item received':    'WRONG_ITEM',
    'Changed my mind':        'UNWANTED',
    'Compatibility issue':    'DOES_NOT_FIT',
    'Other':                  'OTHER',
  };
  const reasonCode = REASON_MAP[reason] || 'OTHER';

  const data = await adminFetch({
    query: `
      mutation ReturnCreate($input: ReturnInput!) {
        returnCreate(returnInput: $input) {
          return {
            id
            name
            status
          }
          userErrors {
            field
            message
          }
        }
      }
    `,
    variables: {
      input: {
        orderId,
        returnLineItems: [
          {
            fulfillmentLineItemId: lineItemId,
            quantity,
            reason: reasonCode,
            customerNote: customerNote || '',
          },
        ],
        notifyCustomer: true,
      },
    },
  });

  const result = data?.returnCreate;
  if (result?.userErrors?.length) {
    throw new Error(result.userErrors[0].message);
  }

  const ret = result?.return;
  // Shopify return IDs look like gid://shopify/Return/123456 — extract the numeric part as RMA
  const rmaNumber = ret?.id?.split('/').pop();
  return { returnId: ret?.id, rmaNumber, status: ret?.status };
}
