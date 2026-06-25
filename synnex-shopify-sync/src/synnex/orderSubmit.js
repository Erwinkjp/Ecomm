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
    .map((item, i) => {
      // TD SYNNEX's OrderRequest item identifies the product with <SKU> (the numeric
      // TD SYNNEX catalog ID — same value the P&A API and status response use). The
      // element is <SKU>, NOT <SynnexSKU>: sending the wrong name makes TD SYNNEX ignore
      // the SKU and file the line as a non-stock quote (SKU 99). Alphanumeric mfr part
      // numbers (should already be resolved to numeric IDs upstream) fall back to <MfgPN>.
      const isNumericId = /^\d+$/.test(item.synnexSku || '');
      const skuXml = isNumericId
        ? `<SKU>${escapeXml(item.synnexSku)}</SKU>`
        : `<MfgPN>${escapeXml(item.synnexSku)}</MfgPN>`;
      return `<Item>
        <LineNumber>${i + 1}</LineNumber>
        ${skuXml}
        <OrderQuantity>${Math.ceil(Number(item.quantity))}</OrderQuantity>
        <UnitPrice>${Number(item.unitPrice).toFixed(2)}</UnitPrice>
      </Item>`;
    })
    .join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<SynnexB2B>
  <Credential>
    <UserID>${escapeXml(username)}</UserID>
    <Password>${escapeXml(password)}</Password>
  </Credential>
  <OrderRequest>
    <CustomerNumber>${escapeXml(customerNo)}</CustomerNumber>
    <PONumber>${escapeXml(order.poNumber)}</PONumber>
    <DropShipFlag>Y</DropShipFlag>
    <Shipment>
      <ShipTo>
        <AddressName1>${escapeXml(ship.name)}</AddressName1>
        <AddressLine1>${escapeXml(ship.address1)}</AddressLine1>
        <AddressLine2>${escapeXml(ship.address2 || '')}</AddressLine2>
        <City>${escapeXml(ship.city)}</City>
        <State>${escapeXml(ship.province)}</State>
        <ZipCode>${escapeXml(ship.zip)}</ZipCode>
        <Country>${escapeXml(ship.country || 'US')}</Country>
        <PhoneNumber>${escapeXml((ship.phone || '').replace(/\D/g, ''))}</PhoneNumber>
        <Email>${escapeXml(ship.email || '')}</Email>
        <ShipMethod>
          <Code>${escapeXml(shipMethod)}</Code>
        </ShipMethod>
      </ShipTo>
    </Shipment>
    <Payment>
      <BillTo code="${escapeXml(customerNo)}"/>
    </Payment>
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

  // Order number may be at the top level or inside the first item element
  const firstItem = Array.isArray(orderResponse?.Items?.Item)
    ? orderResponse.Items.Item[0]
    : orderResponse?.Items?.Item;

  const synnexOrderId = String(
    orderResponse?.SynnexOrderNo?.['#text'] ||
    orderResponse?.OrderNo?.['#text'] ||
    orderResponse?.SynnexOrderNo ||
    orderResponse?.OrderNo ||
    firstItem?.OrderNumber?.['#text'] ||
    firstItem?.OrderNumber ||
    ''
  ).trim();

  const message = String(
    orderResponse?.Msg?.['#text'] ||
    orderResponse?.Message?.['#text'] ||
    orderResponse?.Reason?.['#text'] ||
    orderResponse?.ErrorMessage?.['#text'] ||
    orderResponse?.Msg ||
    orderResponse?.Message ||
    orderResponse?.Reason ||
    orderResponse?.ErrorMessage ||
    ''
  ).trim();

  const detail = String(
    orderResponse?.ErrorDetail?.['#text'] ||
    orderResponse?.ErrorDetail ||
    firstItem?.Reason?.['#text'] ||
    firstItem?.Reason ||
    ''
  ).trim();

  // TD Synnex returns code "accepted", "ACCEPTED", "0", or "SUCCESS" on success.
  // A duplicate PO rejection means the order was already received — treat as success.
  const codeNorm = code.toLowerCase();
  const isDuplicate = detail.toLowerCase().includes('already exists') ||
    message.toLowerCase().includes('dupplicated') ||
    message.toLowerCase().includes('duplicated');
  const accepted = ['accepted', '0', 'success'].includes(codeNorm) || isDuplicate;
  if (!accepted) {
    const reason = [message, detail].filter(Boolean).join(' — ') || `code: ${code}`;
    throw new Error(`TD Synnex rejected order ${poNumber}: ${reason}`);
  }

  // Guard: TD Synnex "accepts" unrecognized SKUs by filing them as a non-stock quote
  // order (SKU "99" / "NON-SYNNEX MFG" / "NON-STOCK", OrderType "QO") that never ships.
  // Treat that as a failure so it surfaces instead of silently never fulfilling.
  const itemSku  = String(firstItem?.SKU?.['#text']  ?? firstItem?.SKU  ?? '').trim();
  const itemMfg  = String(firstItem?.MfgPN?.['#text'] ?? firstItem?.MfgPN ?? '').trim().toUpperCase();
  const itemName = String(firstItem?.ProductName?.['#text'] ?? firstItem?.ProductName ?? '').trim().toUpperCase();
  const orderType = String(
    firstItem?.OrderType?.['#text'] ?? firstItem?.OrderType ??
    orderResponse?.OrderType?.['#text'] ?? orderResponse?.OrderType ?? ''
  ).trim().toUpperCase();
  const isNonStock = itemSku === '99' || itemMfg.includes('NON-SYNNEX') ||
    itemName.includes('NON-STOCK') || orderType === 'QO';
  if (isNonStock) {
    throw new Error(
      `TD Synnex did not recognize the product for order ${poNumber} ` +
      `(filed as non-stock SKU "${itemSku || '?'}"${itemName ? ` / ${itemName}` : ''}` +
      `${orderType ? `, type ${orderType}` : ''}). The submitted SKU is not a valid TD Synnex catalog ID.`
    );
  }

  return { synnexOrderId, status: 'submitted', message };
}

module.exports = { submitOrder };
