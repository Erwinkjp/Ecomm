'use strict';

/**
 * TD Synnex real-time XML Price & Availability API client.
 *
 * Posts chunked SKU batches to the XML P&A endpoint and returns
 * normalized { partNumber, quantityAvailable, price?, msrp? } objects.
 *
 * Endpoint: https://ec.us.tdsynnex.com/SynnexXML/PriceAvailability
 * Protocol: HTTP POST, Content-Type: application/x-www-form-urlencoded
 * Body:      xmldata=<URL-encoded XML request>
 */

const { XMLParser } = require('fast-xml-parser');
const { config } = require('../config');

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  textNodeName: '#text',
  parseAttributeValue: true,
  trimValues: true,
  isArray: name => ['PriceAvailabilityList', 'AvailabilityByWarehouse'].includes(name),
});

function escapeXml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function buildRequest(partNumbers) {
  const { customerNo, username, password } = config.synnex.xml;
  const skuLines = partNumbers
    .map((sku, i) =>
      `<skuList><synnexSKU>${escapeXml(sku)}</synnexSKU><lineNumber>${i + 1}</lineNumber></skuList>`
    )
    .join('\n');

  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<priceRequest>\n` +
    `<customerNo>${escapeXml(customerNo)}</customerNo>\n` +
    `<userName>${escapeXml(username)}</userName>\n` +
    `<password>${escapeXml(password)}</password>\n` +
    skuLines + '\n' +
    `<jsonVersion>false</jsonVersion>\n` +
    `</priceRequest>`
  );
}

function text(node) {
  if (node == null) return undefined;
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (typeof node === 'object' && '#text' in node) return String(node['#text']);
  return undefined;
}

function parseResponse(xml) {
  const doc = parser.parse(xml);

  // Try known response root locations
  const lists =
    doc?.SynnexB2B?.PriceAvailabilityList ||
    doc?.priceResponse?.PriceAvailabilityList ||
    doc?.PriceAvailabilityWS?.PriceAvailabilityList ||
    [];

  if (!Array.isArray(lists)) return [];

  return lists
    .map(item => {
      const partNumber =
        text(item.synnexSKU) || text(item.SynnexSKU) ||
        text(item.mfgPN) || text(item.MfgPN) ||
        text(item.partNumber) || text(item.PartNumber);

      if (!partNumber) return null;

      // Quantity: prefer totalQuantity, fall back to summing warehouse quantities
      let qty = parseInt(text(item.totalQuantity) || text(item.TotalQuantity) || '0', 10);
      if (!qty && Array.isArray(item.AvailabilityByWarehouse)) {
        qty = item.AvailabilityByWarehouse.reduce(
          (sum, wh) => sum + parseInt(text(wh.qty) || text(wh.Qty) || '0', 10), 0
        );
      }

      const price = parseFloat(
        text(item.price) || text(item.unitPrice) || text(item.sellPrice) ||
        text(item.Price) || text(item.UnitPrice) || '0'
      );
      const msrpVal = parseFloat(
        text(item.msrp) || text(item.MSRP) || text(item.listPrice) || text(item.ListPrice) || '0'
      );

      return {
        partNumber,
        quantityAvailable: Math.max(0, Number.isFinite(qty) ? qty : 0),
        price: Number.isFinite(price) && price > 0 ? price : undefined,
        msrp: Number.isFinite(msrpVal) && msrpVal > 0 ? msrpVal : undefined,
      };
    })
    .filter(Boolean);
}

/**
 * Fetch real-time price and availability for an array of part numbers.
 * Requests are chunked per SYNNEX_XML_SKU_CHUNK_SIZE (default 40, max 200).
 *
 * @param {string[]} partNumbers
 * @returns {Promise<Array<{partNumber, quantityAvailable, price?, msrp?}>>}
 */
async function fetchPriceAvailability(partNumbers) {
  const { url, skuChunkSize } = config.synnex.xml;
  const chunkSize = Math.min(Math.max(1, skuChunkSize), 200);
  const results = [];

  for (let i = 0; i < partNumbers.length; i += chunkSize) {
    const chunk = partNumbers.slice(i, i + chunkSize);
    const xmlBody = buildRequest(chunk);

    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `xmldata=${encodeURIComponent(xmlBody)}`,
    });

    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      throw new Error(`XML P&A request failed: HTTP ${resp.status} ${resp.statusText}${body ? ` — ${body.slice(0, 500)}` : ''}`);
    }

    const responseText = await resp.text();
    results.push(...parseResponse(responseText));
  }

  return results;
}

module.exports = { fetchPriceAvailability };
