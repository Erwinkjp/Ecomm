'use strict';

/**
 * Shopify webhook verification and parsing.
 *
 * Shopify signs every webhook request with HMAC-SHA256 using the
 * client secret. We must verify this before trusting the payload.
 */

const crypto = require('crypto');
const { config } = require('../config');
const { resolveShipMethod } = require('./shippingRates');

/**
 * Verify that a Shopify webhook request is authentic.
 * Returns true if the HMAC signature matches, false otherwise.
 *
 * @param {string} rawBody  - The raw (unparsed) request body string
 * @param {string} hmacHeader - Value of the X-Shopify-Hmac-Sha256 header
 */
function verifyWebhook(rawBody, hmacHeader) {
  if (!hmacHeader) return false;
  const secret = config.shopify.clientSecret;
  const computed = crypto
    .createHmac('sha256', secret)
    .update(rawBody, 'utf8')
    .digest('base64');
  return crypto.timingSafeEqual(
    Buffer.from(computed),
    Buffer.from(hmacHeader)
  );
}

/**
 * Parse a Shopify orders/paid webhook payload into a normalized order object.
 *
 * @param {object} payload - Parsed JSON webhook body
 * @returns {object} Normalized order ready for TD Synnex submission
 */
function parseOrderWebhook(payload) {
  const shipping = payload.shipping_address || payload.billing_address || {};
  const email = payload.email || payload.contact_email || '';

  const lineItems = (payload.line_items || [])
    .filter(item => item.sku && item.fulfillable_quantity > 0)
    .map(item => ({
      synnexSku: item.sku,         // We store Synnex SKU as the Shopify SKU
      quantity: item.fulfillable_quantity,
      unitPrice: parseFloat(item.price) || 0,
      title: item.title,
    }));

  return {
    shopifyOrderId: `gid://shopify/Order/${payload.id}`,
    shopifyOrderName: payload.name,       // e.g. "#1001"
    poNumber: `SHP-${payload.order_number}`,
    email,
    shipTo: {
      name: shipping.name || `${shipping.first_name || ''} ${shipping.last_name || ''}`.trim(),
      address1: shipping.address1 || '',
      address2: shipping.address2 || '',
      city: shipping.city || '',
      province: shipping.province_code || shipping.province || '',
      zip: shipping.zip || '',
      country: shipping.country_code || 'US',
      phone: shipping.phone || payload.phone || '',
      email,
    },
    lineItems,
    shipMethod: resolveShipMethod(payload.shipping_lines),
    totalPrice: parseFloat(payload.total_price) || 0,
  };
}

/**
 * Parse a Shopify returns/* webhook payload (returns/request, returns/approve, etc.)
 * into a normalized return object. The numeric TD SYNNEX synnexSku for each line item
 * is resolved later (in the submit-rmas job) from the stored order record.
 *
 * @param {object} payload - Parsed JSON webhook body (a Return resource)
 */
function parseReturnWebhook(payload) {
  const ret = payload.return || payload; // some topics nest under `return`
  const gid = (type, id) => (String(id || '').startsWith('gid://') ? String(id) : `gid://shopify/${type}/${id}`);

  const lineItems = (ret.return_line_items || ret.returnLineItems || []).map(li => ({
    quantity: li.quantity || 1,
    reason: li.return_reason || li.returnReason || li.reason || 'OTHER',
    // SKU/fulfillment refs vary by payload; resolved against the order record downstream.
    sku: li.sku || '',
    fulfillmentLineItemId: li.fulfillment_line_item_id || li.fulfillmentLineItemId || '',
    lineItemId: li.line_item_id || li.lineItemId || '',
  }));

  return {
    shopifyReturnId:  ret.admin_graphql_api_id || gid('Return', ret.id),
    shopifyOrderId:   ret.order_id ? gid('Order', ret.order_id) : (ret.order?.admin_graphql_api_id || ''),
    shopifyReturnName: ret.name || '',
    status:           ret.status || '',
    reason:           lineItems[0]?.reason || 'OTHER',
    lineItems,
  };
}

module.exports = { verifyWebhook, parseOrderWebhook, parseReturnWebhook };
