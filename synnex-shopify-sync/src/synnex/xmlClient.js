/**
 * TD Synnex Real-Time XML Price & Availability (P&A) client.
 * Aligned with TD SYNNEX "XML Real Time Price & Availability" spec (v3.40 style):
 * - Request root: <priceRequest> with repeated <skuList> blocks
 * - Response rows: <PriceAvailabilityList>
 *
 * Transport: POST application/x-www-form-urlencoded with xmldata=<XML>.
 */

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

function buildPriceAvailabilityRequest(partNumbers) {
  const cfg = getConfig();
  if (!cfg) throw new Error('XML P&A not configured: set SYNNEX_XML_* env vars');
  const version = (process.env.SYNNEX_XML_REQUEST_VERSION || '').trim();
  const rootAttrs = version ? ` version="${escapeXml(version)}"` : '';
  const skuList = partNumbers
    .map((sku, i) => `<skuList><synnexSKU>${escapeXml(sku)}</synnexSKU><lineNumber>${i + 1}</lineNumber></skuList>`)
    .join('');
  return `<?xml version="1.0" encoding="UTF-8"?>
<priceRequest${rootAttrs}>
  <customerNo>${escapeXml(cfg.customerNo)}</customerNo>
  <userName>${escapeXml(cfg.username)}</userName>
  <password>${escapeXml(cfg.password)}</password>
  ${skuList}
</priceRequest>`;
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

function getTag(blob, name) {
  const m = new RegExp(`<${name}[^>]*>([^<]*)</${name}>`, 'i').exec(blob);
  return m ? m[1].trim() : '';
}

function sumWarehouseQty(block) {
  let sum = 0;
  const reWh = /<AvailabilityByWarehouse>([\s\S]*?)<\/AvailabilityByWarehouse>/gi;
  let m;
  while ((m = reWh.exec(block)) !== null) {
    sum += parseInt(getTag(m[1], 'qty') || '0', 10) || 0;
  }
  return sum;
}

function parseAvailabilityByWarehouse(block) {
  const out = [];
  const reWh = /<AvailabilityByWarehouse>([\s\S]*?)<\/AvailabilityByWarehouse>/gi;
  let m;
  while ((m = reWh.exec(block)) !== null) {
    const wh = m[1];
    const infoMatch = /<warehouseInfo>([\s\S]*?)<\/warehouseInfo>/i.exec(wh);
    const info = infoMatch ? infoMatch[1] : wh;
    out.push({
      warehouseNumber: getTag(info, 'number'),
      zipcode: getTag(info, 'zipcode'),
      city: getTag(info, 'city'),
      addr: getTag(info, 'addr'),
      qty: parseInt(getTag(wh, 'qty') || '0', 10) || 0,
      onOrderQuantity: getTag(wh, 'onOrderQuantity') ? parseInt(getTag(wh, 'onOrderQuantity'), 10) : undefined,
      estimatedArrivalDate: getTag(wh, 'estimatedArrivalDate') || undefined,
    });
  }
  return out;
}

function parsePriceAvailabilityResponse(xmlText) {
  const results = [];
  const reItem = /<PriceAvailabilityList>([\s\S]*?)<\/PriceAvailabilityList>/gi;
  let m;
  while ((m = reItem.exec(xmlText)) !== null) {
    const block = m[1];
    const partNumber = getTag(block, 'synnexSKU') || getTag(block, 'SynnexSKU');
    if (!partNumber) continue;

    const status = getTag(block, 'status') || getTag(block, 'Status') || '';
    const globalStatus = getTag(block, 'GlobalProductStatusCode') || '';
    const totalQty = getTag(block, 'totalQuantity');
    let quantityAvailable = totalQty !== '' ? parseInt(totalQty, 10) || 0 : sumWarehouseQty(block);
    const statusKey = status.toLowerCase().replace(/\s/g, '');
    if (
      statusKey.includes('notfound') ||
      statusKey.includes('notauthorized') ||
      statusKey === 'discontinued' ||
      globalStatus.toLowerCase().includes('discontinued')
    ) {
      quantityAvailable = 0;
    }

    const price = getTag(block, 'price');
    const parsedPrice = price !== '' && !Number.isNaN(parseFloat(price)) ? parseFloat(price) : undefined;
    const warehouses = parseAvailabilityByWarehouse(block);

    results.push({
      partNumber,
      quantityAvailable,
      price: parsedPrice,
      currency: 'USD',
      status: status || undefined,
      globalProductStatusCode: globalStatus || undefined,
      description: getTag(block, 'description') || undefined,
      mfgPN: getTag(block, 'mfgPN') || undefined,
      mfgCode: getTag(block, 'mfgCode') || undefined,
      euRequired: getTag(block, 'EURequired') || undefined,
      msrp: getTag(block, 'msrp') ? parseFloat(getTag(block, 'msrp')) : undefined,
      weight: getTag(block, 'weight') ? parseFloat(getTag(block, 'weight')) : undefined,
      availabilityByWarehouse: warehouses.length ? warehouses : undefined,
    });
  }
  return results.filter((r) => r.partNumber);
}

function chunkArray(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function getChunkSize() {
  const n = parseInt(process.env.SYNNEX_XML_SKU_CHUNK_SIZE || '40', 10);
  return Number.isFinite(n) && n > 0 ? Math.min(n, 200) : 40;
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
  const chunks = chunkArray(partNumbers, getChunkSize());
  const merged = [];
  for (const partChunk of chunks) {
    const xmlRequest = buildPriceAvailabilityRequest(partChunk);
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
    merged.push(...parsed);
  }
  return merged;
}

module.exports = {
  getPriceAvailabilityFromXml,
  isXmlConfigured,
  buildPriceAvailabilityRequest,
  parsePriceAvailabilityResponse,
};
