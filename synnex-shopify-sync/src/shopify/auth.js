'use strict';

/**
 * Shopify OAuth token management for Dev Dashboard (custom app) credentials.
 * Tokens are cached in module scope and refreshed 60 seconds before expiry.
 */

const { config } = require('../config');

let session = null;

/**
 * Execute a Shopify Admin GraphQL query or mutation.
 * Handles authentication automatically.
 *
 * @param {string} query - GraphQL query or mutation string
 * @param {object} [variables] - GraphQL variables
 * @returns {Promise<object>} The `data` field from the GraphQL response
 */
async function graphql(query, variables) {
  const token = await getAccessToken();
  const { store, apiVersion } = config.shopify;

  const resp = await fetch(
    `https://${store}.myshopify.com/admin/api/${apiVersion}/graphql.json`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': token,
      },
      body: JSON.stringify({ query, variables }),
    }
  );

  if (!resp.ok) {
    throw new Error(`Shopify GraphQL HTTP ${resp.status}: ${resp.statusText}`);
  }

  const body = await resp.json();
  if (body.errors?.length) {
    throw new Error(`Shopify GraphQL error: ${body.errors[0].message}`);
  }

  return body.data;
}

async function getAccessToken() {
  // If a static access token is set (from one-time OAuth setup), use it directly
  if (config.shopify.accessToken) {
    return config.shopify.accessToken;
  }

  const now = Date.now();
  if (session && session.expiresAt - 60_000 > now) {
    return session.token;
  }

  const { store, clientId, clientSecret } = config.shopify;
  const resp = await fetch(
    `https://${store}.myshopify.com/admin/oauth/access_token`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: clientId,
        client_secret: clientSecret,
        grant_type: 'client_credentials',
      }),
    }
  );

  if (!resp.ok) {
    const detail = await resp.text().catch(() => '');
    throw new Error(`Shopify auth failed (${resp.status}): ${detail}`);
  }

  const data = await resp.json();
  session = {
    token: data.access_token,
    expiresAt: now + (data.expires_in ? data.expires_in * 1000 : 86_400_000),
  };

  return session.token;
}

/**
 * Exchange an OAuth authorization code for a permanent offline access token.
 * Called once during setup via the /oauth/callback endpoint.
 */
async function exchangeCodeForToken(code) {
  const { store, clientId, clientSecret } = config.shopify;
  const resp = await fetch(
    `https://${store}.myshopify.com/admin/oauth/access_token`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, code }),
    }
  );
  if (!resp.ok) {
    const detail = await resp.text().catch(() => '');
    throw new Error(`Token exchange failed (${resp.status}): ${detail}`);
  }
  return resp.json();
}

module.exports = { graphql, exchangeCodeForToken };
