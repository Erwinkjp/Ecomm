'use strict';

function getEnv(key, defaultValue) {
  const val = process.env[key]?.trim();
  if (val) return val;
  return defaultValue;
}

function parseIntEnv(key, defaultValue) {
  const val = process.env[key]?.trim();
  if (!val) return defaultValue;
  const n = parseInt(val, 10);
  return Number.isFinite(n) ? n : defaultValue;
}

function parseFloatEnv(key, defaultValue) {
  const val = process.env[key]?.trim();
  if (!val) return defaultValue;
  const n = parseFloat(val);
  return Number.isFinite(n) ? n : defaultValue;
}

function parseBoolEnv(key, defaultValue) {
  const val = process.env[key]?.trim().toLowerCase();
  if (!val) return defaultValue;
  return val === 'true';
}

function parseListEnv(key) {
  const val = process.env[key]?.trim();
  if (!val) return [];
  return val.split(',').map(s => s.trim()).filter(Boolean);
}

const config = {
  shopify: {
    store: getEnv('SHOPIFY_STORE'),
    clientId: getEnv('SHOPIFY_CLIENT_ID'),
    clientSecret: getEnv('SHOPIFY_CLIENT_SECRET'),
    accessToken: getEnv('SHOPIFY_ACCESS_TOKEN'), // static token — takes priority over OAuth
    locationId: getEnv('SHOPIFY_LOCATION_ID'),
    apiVersion: getEnv('SHOPIFY_API_VERSION', '2026-01'),
  },
  synnex: {
    sftp: {
      host: getEnv('SYNNEX_SFTP_HOST', 'sftp.us.tdsynnex.com'),
      port: parseIntEnv('SYNNEX_SFTP_PORT', 22),
      username: getEnv('SYNNEX_SFTP_USERNAME'),
      password: getEnv('SYNNEX_SFTP_PASSWORD'),
      secretArn: getEnv('SYNNEX_SFTP_SECRET_ARN'),
      remotePath: getEnv('SYNNEX_SFTP_REMOTE_PATH'),
      zipEntry: getEnv('SYNNEX_SFTP_ZIP_ENTRY'),
      cacheBucket: getEnv('SYNNEX_SFTP_CACHE_BUCKET'),
    },
    xml: {
      url: getEnv('SYNNEX_XML_URL', 'https://ec.us.tdsynnex.com/SynnexXML/PriceAvailability'),
      customerNo: getEnv('SYNNEX_XML_CUSTOMER_NO'),
      username: getEnv('SYNNEX_XML_USERNAME'),
      password: getEnv('SYNNEX_XML_PASSWORD'),
      requestVersion: getEnv('SYNNEX_XML_REQUEST_VERSION', '2.8'),
      skuChunkSize: parseIntEnv('SYNNEX_XML_SKU_CHUNK_SIZE', 100),
      syncPrices: parseBoolEnv('SYNNEX_XML_SYNC_PRICES', true),
      msrpAsCompareAt: parseBoolEnv('SYNNEX_XML_MSRP_AS_COMPARE_AT', true),
    },
    order: {
      url: getEnv('SYNNEX_ORDER_URL', 'https://ec.us.tdsynnex.com/SynnexXML/order'),
      statusUrl: getEnv('SYNNEX_ORDER_STATUS_URL', 'https://ec.us.tdsynnex.com/SynnexXML/orderstatus'),
      defaultShipMethod: getEnv('SYNNEX_DEFAULT_SHIP_METHOD', 'FEDX_GRD'),
      // RMA endpoints — empty until the TD SYNNEX RMA spec is confirmed; the RMA
      // client stays inert (isRmaConfigured()===false) while these are blank.
      rmaUrl: getEnv('SYNNEX_RMA_URL', ''),
      rmaStatusUrl: getEnv('SYNNEX_RMA_STATUS_URL', ''),
    },
  },
  sync: {
    brands: parseListEnv('SYNNEX_SYNC_FILTER_BRANDS'),
    categories: parseListEnv('SYNNEX_SYNC_FILTER_CATEGORIES'),
    allowlist: parseListEnv('SYNNEX_SYNC_ALLOWLIST'),
    limit: parseIntEnv('SYNNEX_SYNC_LIMIT', undefined),
    concurrency: parseIntEnv('SYNNEX_SYNC_CONCURRENCY', 10),
    timeoutSeconds: parseIntEnv('SYNNEX_SYNC_TIMEOUT_SECONDS', 510), // stop streaming 90s before Lambda's hard cutoff
    markupPercent: parseFloatEnv('PRICE_MARKUP_PERCENT', 0),
    // Price-sync hides (drafts) any product whose synced sell price falls below this.
    minActivePrice: parseFloatEnv('PRICE_MIN_ACTIVE', 1),
    // Price-sync hides (drafts) cheap accessory/cable clutter priced below this that
    // isn't genuine hardware (see catalog/junkFilter.js). Set to 0 to disable.
    junkMaxPrice: parseFloatEnv('JUNK_MAX_PRICE', 5),
  },
  // Google Shopping feed curation. During price-sync, tag each live product with
  // mm-google-shopping custom labels (margin tier + ad eligibility) so consumer
  // Performance Max / Shopping campaigns can bid only on profitable, in-stock SKUs.
  // Off by default — flip GOOGLE_LABELS_ENABLED=true to start writing the labels.
  google: {
    labelsEnabled: parseBoolEnv('GOOGLE_LABELS_ENABLED', false),
    // Gross-margin cutoffs, as a fraction of the sell price ((sell - cost) / sell).
    marginHigh: parseFloatEnv('GOOGLE_MARGIN_HIGH', 0.25), // >= this  -> custom_label_0 "high"
    marginMid:  parseFloatEnv('GOOGLE_MARGIN_MID', 0.12),  // >= this  -> "mid", else "low"
    marginFloor: parseFloatEnv('GOOGLE_MARGIN_FLOOR', 0.10), // below this (or out of stock) -> "excluded"
  },
  icecat: {
    username: getEnv('ICECAT_USERNAME'),
    // Full Icecat content requires an app_key (paid/Full tier). Blank = Open Icecat (free).
    appKey: getEnv('ICECAT_APP_KEY', ''),
  },
};

function isSftpConfigured() {
  const { host, username, remotePath, password, secretArn } = config.synnex.sftp;
  return Boolean(host && username && remotePath && (password || secretArn));
}

function isXmlConfigured() {
  const { url, customerNo, username, password } = config.synnex.xml;
  return Boolean(url && customerNo && username && password);
}

function validateShopify() {
  const { store, clientId, clientSecret, locationId } = config.shopify;
  if (!store) throw new Error('Missing required env var: SHOPIFY_STORE');
  if (!clientId) throw new Error('Missing required env var: SHOPIFY_CLIENT_ID');
  if (!clientSecret) throw new Error('Missing required env var: SHOPIFY_CLIENT_SECRET');
  if (!locationId) throw new Error('Missing required env var: SHOPIFY_LOCATION_ID');
}

module.exports = { config, isSftpConfigured, isXmlConfigured, validateShopify };
