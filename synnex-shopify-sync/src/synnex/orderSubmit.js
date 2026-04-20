'use strict';

/**
 * TD Synnex XML order submission.
 *
 * Submits a dropship order to TD Synnex via their XML Order API.
 * TD Synnex ships directly to the customer (dropship model).
 *
 * Endpoint: https://ec.us.tdsynnex.com/SynnexXML/order
 * Protocol: HTTP POST, Content-Type: application/x-www-form-urlencoded
 * Body:      xmldata=<URL-encoded XML>
 *
 * Contact your TD Synnex rep to confirm your exact order submission URL
 * and available ship method codes for your account.
 */

const { XMLParser } = require('fast-xml-parser');
const { config } = require('../config');

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  textNodeName: '#text',
  parseAttributeValue: true,
  trimValues: true,
});

function escapeXml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Build the XML order submission payload.
 *
 * @param {object} order
 * @param {string} order.poNumber      - Your PO number (use Shopify order name, e.g. #1001)
 * @param {object} order.shipTo        - Shipping destination
 * @param {string} order.shipTo.name   - Full name
 * @param {string} order.shipTo.address1
 * @param {string} order.shipTo.address2
 * @param {string} order.shipTo.city
 * @param {string} order.shipTo.province - State/province code (e.g. CA)
 * @param {string} order.shipTo.zip
 * @param {string} order.shipTo.country - Country code (e.g. US)
 * @param {string} order.shipTo.phone
 * @param {string} order.shipTo.email
 * @param {Array}  order.lineItems      - Array of { synnexSku, quantity, unitPrice }
 * @param {string} [order.shipMethod]   - Ship method code (default: FEDX_GRD)
 */
function buildOrderXml(order) {
  const { customerNo, username, password } = config.synnex.xml;
  const ship = order.shipTo;
  const shipMethod = order.shipMethod || config.synnex.order.defaultShipMethod;

  const itemLines = order.lineItems
    .map((item, i) =>
      `<Item>
        <LineNumber>${i + 1}</LineNumber>
        <SynnexSKU>${escapeXml(item.synnexSku)}</SynnexSKU>
        <Quantity>${Math.ceil(Number(item.quantity))}</Quantity>
        <UnitPrice>${Number(item.unitPrice).toFixed(2)}</UnitPrice>
      </Item>`
    )
    .join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<SynnexB2B>
  <Credential>
    <UserID>${escapeXml(username)}</UserID>
    <Password>${escapeXml(password)}</Password>
  </Credential>
  <OrderRequest>
    <CustomerNo>${escapeXml(customerNo)}</CustomerNo>
    <PONumber>${escapeXml(order.poNumber)}</PONumber>
    <Shipment>
      <ShipToName>${escapeXml(ship.name)}</ShipToName>
      <AddressLine1>${escapeXml(ship.address1)}</AddressLine1>
      <AddressLine2>${escapeXml(ship.address2 || '')}</AddressLine2>
      <City>${escapeXml(ship.city)}</City>
      <State>${escapeXml(ship.province)}</State>
      <ZipCode>${escapeXml(ship.zip)}</ZipCode>
      <Country>${escapeXml(ship.country || 'US')}</Country>
      <PhoneNumber>${escapeXml((ship.phone || '').replace(/\D/g, ''))}</PhoneNumber>
      <Email>${escapeXml(ship.email || '')}</Email>
      <ShipMethodCode>${escapeXml(shipMethod)}</ShipMethodCode>
    </Shipment>
    <Items>
      ${itemLines}
    </Items>
  </OrderRequest>
</SynnexB2B>`;
}

/**
 * Submit a dropship order to TD Synnex.
 *
 * @param {object} order - See buildOrderXml() for shape
 * @returns {{ synnexOrderId: string, status: string, message: string }}
 */
async function submitOrder(order) {
  const url = config.synnex.order.url;
  const xmlBody = buildOrderXml(order);

  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `xmldata=${encodeURIComponent(xmlBody)}`,
    signal: AbortSignal.timeout(30_000),
  });

  if (!resp.ok) {
    throw new Error(`TD Synnex order submission HTTP ${resp.status}: ${resp.statusText}`);
  }

  const text = await resp.text();
  return parseOrderResponse(text, order.poNumber);
}

function parseOrderResponse(xml, poNumber) {
  const doc = parser.parse(xml);

  // Navigate common response structures
  const orderResponse =
    doc?.SynnexB2B?.OrderResponse ||
    doc?.OrderResponse ||
    doc?.orderResponse ||
    {};

  const code = String(
    orderResponse?.Code?.['#text'] ||
    orderResponse?.ResponseCode?.['#text'] ||
    orderResponse?.code ||
    orderResponse?.Code ||
    ''
  ).trim();

  const synnexOrderId = String(
    orderResponse?.SynnexOrderNo?.['#text'] ||
    orderResponse?.OrderNo?.['#text'] ||
    orderResponse?.SynnexOrderNo ||
    orderResponse?.OrderNo ||
    ''
  ).trim();

  const message = String(
    orderResponse?.Msg?.['#text'] ||
    orderResponse?.Message?.['#text'] ||
    orderResponse?.Msg ||
    orderResponse?.Message ||
    ''
  ).trim();

  // TD Synnex returns code "ACCEPTED" or "0" on success
  const accepted = code === 'ACCEPTED' || code === '0' || code === 'SUCCESS';
  if (!accepted) {
    throw new Error(`TD Synnex rejected order ${poNumber}: [${code}] ${message}`);
  }

  return { synnexOrderId, status: 'submitted', message };
}

module.exports = { submitOrder };
