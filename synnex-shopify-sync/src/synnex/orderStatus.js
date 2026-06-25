'use strict';

/**
 * TD Synnex XML order status check.
 *
 * Queries TD Synnex for the current status of a submitted order,
 * including tracking number and carrier when shipped.
 */

const { XMLParser } = require('fast-xml-parser');
const { config } = require('../config');

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  textNodeName: '#text',
  parseAttributeValue: true,
  trimValues: true,
  isArray: name => name === 'Package',
});

function escapeXml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function buildStatusXml(poNumber) {
  const { customerNo, username, password } = config.synnex.xml;
  return `<?xml version="1.0" encoding="UTF-8"?>
<SynnexB2B>
  <Credential>
    <UserID>${escapeXml(username)}</UserID>
    <Password>${escapeXml(password)}</Password>
  </Credential>
  <OrderStatusRequest>
    <CustomerNumber>${escapeXml(customerNo)}</CustomerNumber>
    <PONumber>${escapeXml(poNumber)}</PONumber>
  </OrderStatusRequest>
</SynnexB2B>`;
}

/**
 * @typedef {object} OrderStatus
 * @property {string} poNumber
 * @property {string} synnexOrderId
 * @property {string} status - 'pending' | 'processing' | 'shipped' | 'cancelled'
 * @property {string[]} trackingNumbers
 * @property {string} carrier
 */

/**
 * Check the status of a previously submitted TD Synnex order.
 *
 * @param {string} poNumber - The PO number used when submitting the order
 * @returns {Promise<OrderStatus>}
 */
async function checkOrderStatus(poNumber) {
  const url = config.synnex.order.statusUrl;
  const xmlBody = buildStatusXml(poNumber);

  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `xmldata=${encodeURIComponent(xmlBody)}`,
    signal: AbortSignal.timeout(30_000),
  });

  if (!resp.ok) {
    throw new Error(`TD Synnex order status HTTP ${resp.status}: ${resp.statusText}`);
  }

  const text = await resp.text();
  return parseStatusResponse(text, poNumber);
}

function text(node) {
  if (node == null) return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (typeof node === 'object' && '#text' in node) return String(node['#text']);
  return '';
}

function parseStatusResponse(xml, poNumber) {
  const doc = parser.parse(xml);

  const statusResp =
    doc?.SynnexB2B?.OrderStatusResponse ||
    doc?.OrderStatusResponse ||
    {};

  // Item-level details (tracking, ship date, order number live here)
  const rawItem = statusResp?.Items?.Item;
  const firstItem = Array.isArray(rawItem) ? rawItem[0] : (rawItem || {});

  const synnexOrderId = (
    text(statusResp?.SynnexOrderNo) ||
    text(statusResp?.OrderNo) ||
    text(firstItem?.OrderNumber)
  ).trim();

  // Status is in <Code> at the response level; item-level <Code> reflects line status
  const topCode = text(statusResp?.Code).trim().toLowerCase();
  const shipDate = text(firstItem?.ShipDatetime).trim();
  const shipQty  = parseInt(text(firstItem?.ShipQuantity) || '0', 10);

  // Determine status: if something has shipped, use item data; otherwise use top-level code
  let status;
  if (shipDate && shipQty > 0) {
    status = 'shipped';
  } else if (['cancelled', 'canceled', 'void'].includes(topCode)) {
    status = 'cancelled';
  } else {
    status = 'processing';
  }

  // Tracking lives at item level under <Packages><Package><TrackingNumber>.
  // (Package is forced to an array by the parser config.) Older shapes used
  // <TrackingNo> at item/response level — kept as fallbacks.
  const pkgs = firstItem?.Packages?.Package;
  const firstPkg = Array.isArray(pkgs) ? pkgs[0] : pkgs;
  const trackingRaw =
    text(firstPkg?.TrackingNumber) ||
    text(firstPkg?.TrackingNo) ||
    text(firstItem?.TrackingNo) ||
    text(statusResp?.Packages?.Package?.[0]?.TrackingNumber);
  const trackingNumbers = trackingRaw ? [String(trackingRaw).trim()] : [];

  // Prefer the human-readable ship method description (e.g. "FedEx Home Delivery - Ground")
  // for carrier detection; fall back to the code.
  const carrier = (
    text(firstItem?.ShipMethodDescription) ||
    text(firstItem?.ShipMethod) ||
    text(firstPkg?.CarrierCode) ||
    text(statusResp?.ShipMethod)
  ).trim();

  return {
    poNumber,
    synnexOrderId,
    status,
    trackingNumbers,
    carrier: normalizeCarrier(carrier),
  };
}

/**
 * Map TD Synnex carrier codes to Shopify-recognized carrier names.
 */
function normalizeCarrier(code) {
  const v = (code || '').toString();
  // Substring match first — handles descriptions like "FedEx Home Delivery - Ground"
  // and codes like FHD / FXG that aren't in the exact-match map.
  if (/fedex|\bfhd\b|\bfedx\b|\bfx[a-z]?\b/i.test(v)) return 'FedEx';
  if (/\bups\b/i.test(v)) return 'UPS';
  if (/usps|postal/i.test(v)) return 'USPS';
  if (/\bdhl\b/i.test(v)) return 'DHL';
  const map = {
    FEDX: 'FedEx', FEDX_GRD: 'FedEx', FEDX_2DAY: 'FedEx', FEDX_OVNT: 'FedEx',
    UPS: 'UPS', UPS_GRD: 'UPS', UPS_2DAY: 'UPS', UPS_OVNT: 'UPS',
    USPS: 'USPS', USPS_PM: 'USPS',
    DHL: 'DHL',
  };
  return map[v.toUpperCase()] || v || 'Other';
}

module.exports = { checkOrderStatus };
