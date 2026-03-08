/**
 * TD Synnex product/price-availability types.
 * Align with TD Synnex REST API responses (Price & Availability / Product info).
 */

/**
 * @typedef {Object} SynnexProduct
 * @property {string} partNumber
 * @property {string} [manufacturerPartNumber]
 * @property {string} [description]
 * @property {string} [manufacturer]
 * @property {string} [category]
 * @property {string} [upc]
 */

/**
 * @typedef {Object} SynnexPriceAvailability
 * @property {string} partNumber
 * @property {number} quantityAvailable
 * @property {number} [price]
 * @property {string} [currency]
 * @property {string} [warehouse]
 */

/**
 * @typedef {SynnexProduct & SynnexPriceAvailability} SynnexProductWithAvailability
 */

const DEFAULT_BASE_URL = 'https://api.synnex.com';

function getBaseUrl() {
  return process.env.SYNNEX_BASE_URL || DEFAULT_BASE_URL;
}

function getApiKey() {
  const key = process.env.SYNNEX_API_KEY;
  if (!key) throw new Error('SYNNEX_API_KEY is required');
  return key;
}

/**
 * Fetch product catalog (product info) from TD Synnex.
 * @returns {Promise<SynnexProduct[]>}
 */
async function getProducts(config = {}) {
  const baseUrl = config.baseUrl || getBaseUrl();
  const apiKey = config.apiKey || getApiKey();
  const path = process.env.SYNNEX_PRODUCTS_PATH || '/v1/products';
  const url = `${baseUrl.replace(/\/$/, '')}${path}`;

  const res = await fetch(url, {
    method: 'GET',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
      'x-api-key': apiKey,
    },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Synnex products API error ${res.status}: ${text}`);
  }

  const data = await res.json();
  return data.products ?? data.data ?? (Array.isArray(data) ? data : []);
}

/**
 * Fetch price & availability for one or more part numbers.
 * @param {string[]} partNumbers
 * @returns {Promise<SynnexPriceAvailability[]>}
 */
async function getPriceAvailability(partNumbers, config = {}) {
  const baseUrl = config.baseUrl || getBaseUrl();
  const apiKey = config.apiKey || getApiKey();
  const path = process.env.SYNNEX_PRICE_AVAILABILITY_PATH || '/v1/price-availability';
  const url = `${baseUrl.replace(/\/$/, '')}${path}`;

  const body = JSON.stringify({ partNumbers });
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
      'x-api-key': apiKey,
    },
    body,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Synnex price/availability API error ${res.status}: ${text}`);
  }

  const data = await res.json();
  return data.results ?? data.data ?? (Array.isArray(data) ? data : []);
}

/**
 * Get products with merged price and availability.
 * @returns {Promise<SynnexProductWithAvailability[]>}
 */
async function getProductsWithAvailability(config = {}) {
  const products = await getProducts(config);
  const partNumbers = products.map((p) => p.partNumber);
  if (partNumbers.length === 0) return [];

  const availability = await getPriceAvailability(partNumbers, config);
  const byPart = new Map(availability.map((a) => [a.partNumber, a]));

  return products.map((p) => {
    const av = byPart.get(p.partNumber);
    return {
      ...p,
      quantityAvailable: av?.quantityAvailable ?? 0,
      price: av?.price,
      currency: av?.currency,
    };
  });
}

module.exports = {
  getProducts,
  getPriceAvailability,
  getProductsWithAvailability,
};
