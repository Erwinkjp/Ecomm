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
    <CustomerNo>${escapeXml(customerNo)}</CustomerNo>
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

function parseStatusResponse(xml, poNumber) {
  const doc = parser.parse(xml);

  const statusResp =
    doc?.SynnexB2B?.OrderStatusResponse ||
    doc?.OrderStatusResponse ||
    {};

  const synnexOrderId = String(
    statusResp?.SynnexOrderNo?.['#text'] ||
    statusResp?.OrderNo?.['#text'] ||
    statusResp?.SynnexOrderNo ||
    statusResp?.OrderNo ||
    ''
  ).trim();

  const statusCode = String(
    statusResp?.OrderStatus?.['#text'] ||
    statusResp?.Status?.['#text'] ||
    statusResp?.OrderStatus ||
    statusResp?.Status ||
    ''
  ).trim().toUpperCase();

  // Normalize TD Synnex status codes to internal statuses
  let status;
  if (['SHIPPED', 'COMPLETE', 'CLOSED'].includes(statusCode)) {
    status = 'shipped';
  } else if (['CANCELLED', 'CANCELED', 'VOID'].includes(statusCode)) {
    status = 'cancelled';
  } else if (['ACCEPTED', 'PROCESSING', 'OPEN', 'HOLD'].includes(statusCode)) {
    status = 'processing';
  } else {
    status = 'processing'; // default to processing if unknown
  }

  // Extract tracking numbers from packages
  const packages = statusResp?.Packages?.Package || [];
  const trackingNumbers = (Array.isArray(packages) ? packages : [packages])
    .map(p => String(p?.TrackingNo?.['#text'] || p?.TrackingNo || '').trim())
    .filter(Boolean);

  const carrier = String(
    statusResp?.Packages?.Package?.[0]?.CarrierCode?.['#text'] ||
    statusResp?.Packages?.Package?.[0]?.CarrierCode ||
    statusResp?.ShipMethod?.['#text'] ||
    statusResp?.ShipMethod ||
    ''
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
  const map = {
    FEDX: 'FedEx', FEDX_GRD: 'FedEx', FEDX_2DAY: 'FedEx', FEDX_OVNT: 'FedEx',
    UPS: 'UPS', UPS_GRD: 'UPS', UPS_2DAY: 'UPS', UPS_OVNT: 'UPS',
    USPS: 'USPS', USPS_PM: 'USPS',
    DHL: 'DHL',
  };
  return map[code?.toUpperCase()] || code || 'Other';
}

module.exports = { checkOrderStatus };
