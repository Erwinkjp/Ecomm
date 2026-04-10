/**
 * TD Synnex Real-Time XML Price & Availability (P&A).
 *
 * Production US endpoints (set SYNNEX_XML_URL):
 * - Price + availability: https://ec.us.tdsynnex.com/SynnexXML/PriceAvailability
 * - Availability only:    https://ec.us.tdsynnex.com/SynnexXML/Availability
 *
 * POST application/x-www-form-urlencoded with xmldata=<request XML>.
 * Align request/response tags with your TD Synnex XML spec; contact XMLGROUP@TDSYNNEX.COM if needed.
 *
 * Env: SYNNEX_XML_URL, SYNNEX_XML_CUSTOMER_NO, SYNNEX_XML_USERNAME, SYNNEX_XML_PASSWORD
 * Optional: SYNNEX_XML_REQUEST_VERSION, SYNNEX_XML_SKU_CHUNK_SIZE, SYNNEX_XML_LIST_BY
 *   (synnexSKU default; set mfgPN for manufacturer P/N requests per spec example 2).
 */
function getConfig() {
  const url = process.env.SYNNEX_XML_URL?.trim();
  const customerNo = process.env.SYNNEX_XML_CUSTOMER_NO?.trim();
  const username = process.env.SYNNEX_XML_USERNAME?.trim();
  const password = process.env.SYNNEX_XML_PASSWORD?.trim();
  if (!url || !customerNo || !username || !password) return null;
  return { url, customerNo, username, password };
}

function isXmlConfigured() {
  return getConfig() !== null;
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
 * TD Synnex spec: root <priceRequest> (optional version="2.3" etc.), one <skuList> per line
 * with <synnexSKU> + <lineNumber> (or <mfgPN> + <lineNumber> — see SYNNEX_XML_LIST_BY).
 */
function buildPriceAvailabilityRequest(partNumbers) {
  const cfg = getConfig();
  if (!cfg) throw new Error('XML P&A not configured: set SYNNEX_XML_* env vars');
  const version = (process.env.SYNNEX_XML_REQUEST_VERSION || '').trim();
  const rootOpen = version
    ? `<priceRequest version="${escapeXml(version)}">`
    : '<priceRequest>';
  const listBy = (process.env.SYNNEX_XML_LIST_BY || 'synnexSKU').trim().toLowerCase();
  const skuTag = listBy === 'mfgpn' || listBy === 'mfg_pn' ? 'mfgPN' : 'synnexSKU';

  const skuBlocks = partNumbers
    .map(
      (sku, i) =>
        `<skuList><${skuTag}>${escapeXml(sku)}</${skuTag}><lineNumber>${i + 1}</lineNumber></skuList>`
    )
    .join('');

  return `<?xml version="1.0" encoding="UTF-8"?>
${rootOpen}
<customerNo>${escapeXml(cfg.customerNo)}</customerNo>
<userName>${escapeXml(cfg.username)}</userName>
<password>${escapeXml(cfg.password)}</password>
${skuBlocks}
</priceRequest>`;
}

function parsePriceAvailabilityResponse(xmlText) {
  const results = [];
  /** Spec: <priceResponse> … <PriceAvailabilityList> … </PriceAvailabilityList> */
  const reList = /<PriceAvailabilityList[^>]*>([\s\S]*?)<\/PriceAvailabilityList>/gi;
  const getTag = (blob, name) => {
    const m = new RegExp(`<${name}[^>]*>([^<]*)</${name}>`, 'i').exec(blob);
    return m ? m[1].trim() : '';
  };

  function warehouseQtySum(block) {
    let sum = 0;
    const reWh = /<AvailabilityByWarehouse[^>]*>([\s\S]*?)<\/AvailabilityByWarehouse>/gi;
    let wm;
    while ((wm = reWh.exec(block)) !== null) {
      const q = getTag(wm[1], 'qty');
      sum += parseInt(q, 10) || 0;
    }
    return sum;
  }

  let m;
  while ((m = reList.exec(xmlText)) !== null) {
    const block = m[1];
    const partNumber =
      getTag(block, 'synnexSKU') || getTag(block, 'mfgPN') || getTag(block, 'partNumber');
    let qtyStr = getTag(block, 'totalQuantity');
    if (!qtyStr) {
      const summed = warehouseQtySum(block);
      qtyStr = summed > 0 ? String(summed) : getTag(block, 'qtyAvailable') || getTag(block, 'qty') || '0';
    }
    const price =
      getTag(block, 'price') || getTag(block, 'unitPrice') || getTag(block, 'sellPrice') || '';
    const currency = getTag(block, 'currency') || 'USD';
    const msrp = getTag(block, 'msrp') || getTag(block, 'MSRP') || getTag(block, 'listPrice') || '';
    results.push({
      partNumber,
      quantityAvailable: parseInt(qtyStr, 10) || 0,
      price: price ? parseFloat(price) : undefined,
      currency,
      msrp: msrp ? parseFloat(msrp) : undefined,
    });
  }
  return results.filter((r) => r.partNumber);
}

function getChunkSize() {
  const n = parseInt(process.env.SYNNEX_XML_SKU_CHUNK_SIZE || '40', 10);
  return Number.isFinite(n) && n > 0 ? Math.min(n, 200) : 40;
}

/**
 * @param {string[]} partNumbers
 * @returns {Promise<Array<{ partNumber: string, quantityAvailable: number, price?: number, currency: string, msrp?: number }>>}
 */
async function getPriceAvailabilityFromXml(partNumbers) {
  const cfg = getConfig();
  if (!cfg) throw new Error('XML P&A not configured');
  if (!partNumbers.length) return [];

  const chunkSize = getChunkSize();
  const merged = [];

  for (let i = 0; i < partNumbers.length; i += chunkSize) {
    const chunk = partNumbers.slice(i, i + chunkSize);
    const xmlRequest = buildPriceAvailabilityRequest(chunk);
    const body = new URLSearchParams({ xmldata: xmlRequest }).toString();

    const res = await fetch(cfg.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });

    const text = await res.text();
    if (!res.ok) throw new Error(`Synnex XML P&A error ${res.status}: ${text}`);

    const parsed = parsePriceAvailabilityResponse(text);
    if (parsed.length === 0 && text.length > 0 && /error|fault|invalid/i.test(text)) {
      throw new Error(`Synnex XML response error: ${text.slice(0, 500)}`);
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
