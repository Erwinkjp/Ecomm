'use strict';

/**
 * Icecat Open Catalog API client.
 *
 * Fetches product descriptions and images by manufacturer name + part number,
 * or by UPC/GTIN barcode as a fallback.
 *
 * API docs: https://icecat.us/developer
 * Free tier: Open Icecat (no auth beyond username in query string)
 */

const { config } = require('../config');

// Correct endpoint for Icecat Open Catalog API
// URL format: https://live.icecat.biz/api?UserName=...&lang=en&Brand=...&ProductCode=...
const ICECAT_BASE = 'https://live.icecat.biz/api';

/**
 * Fetch enrichment data for a single product from Icecat.
 *
 * @param {{ brand: string, partNumber: string, upc?: string }} product
 * @returns {Promise<{ description: string, images: string[] } | null>}
 *   Returns null if Icecat has no data for this product.
 */
async function fetchIcecatProduct({ brand, partNumber, upc }) {
  const username = config.icecat.username;
  if (!username) return null;

  // Try by brand + part number first (most reliable)
  let result = await queryIcecat({ Brand: brand, ProductCode: partNumber });

  // Fall back to UPC/GTIN if available and brand+MPN returned nothing
  if (!result && upc && upc.length >= 12) {
    result = await queryIcecat({ GTIN: upc.padStart(13, '0') });
  }

  return result;
}

async function queryIcecat(params) {
  const username = config.icecat.username;
  const qs = new URLSearchParams({
    UserName: username,
    lang: 'en',
    ...params,
  });

  let resp;
  try {
    resp = await fetch(`${ICECAT_BASE}?${qs}`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(15_000),
    });
  } catch (e) {
    // Network timeout or error — skip enrichment for this product
    return null;
  }

  if (resp.status === 404 || resp.status === 400) return null;
  if (!resp.ok) return null;

  let body;
  try {
    body = await resp.json();
  } catch (_) {
    return null;
  }

  // live.icecat.biz returns StatusCode 1 for success, 8 (or Code 404) for not found
  if (body?.StatusCode && body.StatusCode !== 1) return null;

  // Icecat wraps data under body.data
  const data = body?.data;
  if (!data) return null;

  // Extract description (prefer long, fall back to short)
  const longDesc = data.Description?.LongDesc?.trim();
  const shortDesc = data.Description?.ShortDesc?.trim();
  const description = longDesc || shortDesc || null;

  // Extract image URLs — prefer highest resolution (PicMax > Pic500x500 > Pic)
  const gallery = Array.isArray(data.Gallery) ? data.Gallery : [];
  const images = gallery
    .map(g => g.PicMax || g.Pic500x500 || g.Pic)
    .filter(Boolean)
    .slice(0, 10); // Shopify supports up to 250, but 10 is plenty

  if (!description && images.length === 0) return null;

  return { description, images };
}

module.exports = { fetchIcecatProduct };
