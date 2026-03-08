/**
 * TD Synnex API client.
 * Base URL and paths can be overridden via env (SYNNEX_BASE_URL, etc.).
 * Auth: API key in header or OAuth2 as per your TD Synnex developer setup.
 */
const DEFAULT_BASE_URL = 'https://api.synnex.com';

function getBaseUrl() {
  return process.env.SYNNEX_BASE_URL ?? DEFAULT_BASE_URL;
}

function getApiKey() {
  const key = process.env.SYNNEX_API_KEY;
  if (!key) throw new Error('SYNNEX_API_KEY is required');
  return key;
}

/**
 * Fetch product catalog (product info) from TD Synnex.
 * Endpoint may vary; common pattern: /v1/products or /product-information
 */
async function getProducts(config = {}) {
  const baseUrl = config.baseUrl ?? getBaseUrl();
  const apiKey = config.apiKey ?? getApiKey();
  const path = process.env.SYNNEX_PRODUCTS_PATH ?? '/v1/products';
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
 * Common pattern: POST /price-availability or GET with query params.
 */
async function getPriceAvailability(partNumbers, config = {}) {
  const baseUrl = config.baseUrl ?? getBaseUrl();
  const apiKey = config.apiKey ?? getApiKey();
  const path = process.env.SYNNEX_PRICE_AVAILABILITY_PATH ?? '/v1/price-availability';
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
