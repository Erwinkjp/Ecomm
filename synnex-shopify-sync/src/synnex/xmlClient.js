/**
 * TD Synnex Real-Time XML Price & Availability client.
 * Uses the "XML Real Time Price & Availability Query Tool" service.
 *
 * Get the exact request/response schema from the spec download on the TD Synnex
 * XML services page, or from XMLGROUP@TDSYNNEX.COM. Adjust the buildRequest /
 * parseResponse helpers to match.
 *
 * Env: SYNNEX_XML_URL, SYNNEX_XML_CUSTOMER_NO, SYNNEX_XML_USERNAME, SYNNEX_XML_PASSWORD
 */
const SYNNEX_XML_NS = 'http://synnex.com/xml/synnex';

function getConfig() {
  const url = process.env.SYNNEX_XML_URL;
  const customerNo = process.env.SYNNEX_XML_CUSTOMER_NO;
  const username = process.env.SYNNEX_XML_USERNAME;
  const password = process.env.SYNNEX_XML_PASSWORD;
  if (!url || !customerNo || !username || !password) return null;
  return { url, customerNo, username, password };
}

function isXmlConfigured() {
  return getConfig() !== null;
}

/**
 * Build Price & Availability request XML.
 * Structure may need to match TD Synnex spec exactly (customerNo, userName, password, skuList with synnexSKU/lineNumber).
 */
function buildPriceAvailabilityRequest(partNumbers) {
  const cfg = getConfig();
  if (!cfg) throw new Error('XML P&A not configured: set SYNNEX_XML_* env vars');
  const skuList = partNumbers
    .map((sku, i) => `<item><synnexSKU>${escapeXml(sku)}</synnexSKU><lineNumber>${i + 1}</lineNumber></item>`)
    .join('');
  return `<?xml version="1.0"?>
<priceAvailabilityRequest>
  <customerNo>${escapeXml(cfg.customerNo)}</customerNo>
  <userName>${escapeXml(cfg.username)}</userName>
  <password>${escapeXml(cfg.password)}</password>
  <skuList>${skuList}</skuList>
</priceAvailabilityRequest>`;
}

function escapeXml(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Parse Price & Availability response XML into array of { partNumber, quantityAvailable, price, currency }.
 * Tag names depend on the actual spec (e.g. qtyAvailable, unitPrice, etc.).
 */
function parsePriceAvailabilityResponse(xmlText) {
  const results = [];
  const reItem = /<item[^>]*>([\s\S]*?)<\/item>/gi;
  const getTag = (blob, name) => {
    const m = new RegExp(`<${name}[^>]*>([^<]*)</${name}>`, 'i').exec(blob);
    return m ? m[1].trim() : '';
  };
  let m;
  while ((m = reItem.exec(xmlText)) !== null) {
    const block = m[1];
    const partNumber = getTag(block, 'synnexSKU') || getTag(block, 'partNumber') || getTag(block, 'sku');
    const qty = getTag(block, 'qtyAvailable') || getTag(block, 'quantityAvailable') || getTag(block, 'qty') || '0';
    const price = getTag(block, 'unitPrice') || getTag(block, 'price') || getTag(block, 'sellPrice') || '';
    const currency = getTag(block, 'currency') || 'USD';
    results.push({
      partNumber,
      quantityAvailable: parseInt(qty, 10) || 0,
      price: price ? parseFloat(price) : undefined,
      currency,
    });
  }
  return results.filter((r) => r.partNumber);
}

/**
 * Query real-time price and availability for the given part numbers.
 * @param {string[]} partNumbers
 * @returns {Promise<Array<{ partNumber: string, quantityAvailable: number, price?: number, currency: string }>>}
 */
async function getPriceAvailabilityFromXml(partNumbers) {
  const cfg = getConfig();
  if (!cfg) throw new Error('XML P&A not configured');
  if (!partNumbers.length) return [];

  const xmlRequest = buildPriceAvailabilityRequest(partNumbers);
  const body = new URLSearchParams({ xmldata: xmlRequest }).toString();

  const res = await fetch(cfg.url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });

  const text = await res.text();
  if (!res.ok) throw new Error(`Synnex XML P&A error ${res.status}: ${text}`);

  const parsed = parsePriceAvailabilityResponse(text);
  if (parsed.length === 0 && text.length > 0) {
    if (/error|fault|invalid/i.test(text)) throw new Error(`Synnex XML response error: ${text.slice(0, 500)}`);
  }
  return parsed;
}

module.exports = {
  getPriceAvailabilityFromXml,
  isXmlConfigured,
  buildPriceAvailabilityRequest,
  parsePriceAvailabilityResponse,
};
