/**
 * TD Synnex Partner API client (products + price/availability).
 *
 * Auth (use one):
 * - OAuth2 client credentials (recommended): POST to TD Synnex SSO token URL, then Bearer on API calls.
 * - Legacy: SYNNEX_API_KEY sent as Bearer + x-api-key (if your tenant still uses static keys).
 *
 * Env: SYNNEX_BASE_URL, optional SYNNEX_PRODUCTS_PATH, SYNNEX_PRICE_AVAILABILITY_PATH
 */
const { URLSearchParams } = require('url');

const DEFAULT_BASE_URL = 'https://api.synnex.com';
const DEFAULT_TOKEN_URL = 'https://sso.us.tdsynnex.com/oauth2/v1/token';
const TOKEN_REFRESH_BUFFER_MS = 60_000;

/** @type {{ bearer: string | null; expiresAtMs: number }} */
let oauthCache = { bearer: null, expiresAtMs: 0 };

function getBaseUrl() {
  return process.env.SYNNEX_BASE_URL ?? DEFAULT_BASE_URL;
}

function getTokenUrl() {
  return (process.env.SYNNEX_TOKEN_URL || DEFAULT_TOKEN_URL).trim();
}

function usesOAuth() {
  const id = process.env.SYNNEX_OAUTH_CLIENT_ID?.trim();
  const secret = process.env.SYNNEX_OAUTH_CLIENT_SECRET?.trim();
  return Boolean(id && secret);
}

async function fetchOAuthAccessToken() {
  const clientId = process.env.SYNNEX_OAUTH_CLIENT_ID?.trim();
  const clientSecret = process.env.SYNNEX_OAUTH_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) {
    throw new Error(
      'Set SYNNEX_OAUTH_CLIENT_ID and SYNNEX_OAUTH_CLIENT_SECRET (TD Synnex Partner API OAuth client credentials)'
    );
  }

  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: clientId,
    client_secret: clientSecret,
  });
  const scope = process.env.SYNNEX_OAUTH_SCOPE?.trim();
  if (scope) body.set('scope', scope);

  const tokenUrl = getTokenUrl();
  const res = await fetch(tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Synnex OAuth token request failed ${res.status}: ${text}`);
  }

  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`Synnex OAuth invalid JSON: ${text}`);
  }

  const accessToken = json.access_token;
  if (!accessToken) {
    throw new Error(`Synnex OAuth response missing access_token: ${text}`);
  }

  const expiresInSec = Number(json.expires_in) || 3600;
  return { accessToken, expiresInSec };
}

async function getOAuthBearer() {
  const now = Date.now();
  if (oauthCache.bearer && now < oauthCache.expiresAtMs - TOKEN_REFRESH_BUFFER_MS) {
    return oauthCache.bearer;
  }

  const { accessToken, expiresInSec } = await fetchOAuthAccessToken();
  oauthCache = {
    bearer: accessToken,
    expiresAtMs: now + expiresInSec * 1000,
  };
  return accessToken;
}

/**
 * @returns {Promise<Record<string, string>>}
 */
async function getRequestHeaders() {
  if (usesOAuth()) {
    const token = await getOAuthBearer();
    return {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    };
  }

  const apiKey = process.env.SYNNEX_API_KEY?.trim();
  if (!apiKey) {
    throw new Error(
      'Set SYNNEX_OAUTH_CLIENT_ID + SYNNEX_OAUTH_CLIENT_SECRET, or legacy SYNNEX_API_KEY'
    );
  }

  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${apiKey}`,
    'x-api-key': apiKey,
  };
}

function resolveApiPath(envKey, fallback) {
  const raw = process.env[envKey];
  if (raw == null || !String(raw).trim()) return fallback;
  const p = String(raw).trim();
  return p.startsWith('/') ? p : `/${p}`;
}

/**
 * Fetch product catalog (product info) from TD Synnex.
 * Set SYNNEX_PRODUCTS_PATH to the exact GET path from your OpenAPI (e.g. /api/v1/...).
 * Paths like /v1/products are not valid on api.us.tdsynnex.com — see Partner API catalog section.
 */
async function getProducts(config = {}) {
  const baseUrl = config.baseUrl ?? getBaseUrl();
  const path = resolveApiPath('SYNNEX_PRODUCTS_PATH', '/v1/products');
  const url = `${baseUrl.replace(/\/$/, '')}${path}`;
  const headers = config.headers ?? (await getRequestHeaders());

  const res = await fetch(url, {
    method: 'GET',
    headers,
  });

  if (!res.ok) {
    const text = await res.text();
    let hint = '';
    if (res.status === 404 || /NOT_FOUND|No static resource/i.test(text)) {
      hint =
        ' Set SYNNEX_PRODUCTS_PATH to the catalog/products GET path from your TD Synnex OpenAPI (Partner portal). Order/invoice endpoints under /api/v1/orders are not product feeds.';
    }
    throw new Error(`Synnex products API error ${res.status}: ${text}${hint}`);
  }

  const data = await res.json();
  return data.products ?? data.data ?? (Array.isArray(data) ? data : []);
}

/**
 * Fetch price & availability for one or more part numbers.
 */
async function getPriceAvailability(partNumbers, config = {}) {
  const baseUrl = config.baseUrl ?? getBaseUrl();
  const path = resolveApiPath('SYNNEX_PRICE_AVAILABILITY_PATH', '/v1/price-availability');
  const url = `${baseUrl.replace(/\/$/, '')}${path}`;
  const headers = config.headers ?? (await getRequestHeaders());

  const body = JSON.stringify({ partNumbers });
  const res = await fetch(url, {
    method: 'POST',
    headers,
    body,
  });

  if (!res.ok) {
    const text = await res.text();
    let hint = '';
    if (res.status === 404 || /NOT_FOUND|No static resource/i.test(text)) {
      hint = ' Set SYNNEX_PRICE_AVAILABILITY_PATH to the path from your OpenAPI (POST body for part numbers).';
    }
    throw new Error(`Synnex price/availability API error ${res.status}: ${text}${hint}`);
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
