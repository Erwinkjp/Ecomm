/**
 * Lambda handler. Can be invoked by:
 * - EventBridge (scheduled): no body; runs full sync with default options.
 * - API Gateway / direct invoke: optional body { syncProducts?: boolean, limit?: number }.
 */
const { runSync } = require('./sync/sync');
const { listZipEntriesFromSftp, isSftpConfigured } = require('./synnex/sftpSource');

function isSyncEvent(body) {
  return body !== null && typeof body === 'object';
}

function isHttpApiEvent(event) {
  return Boolean(event?.requestContext?.http);
}

function httpApiHealthResponse() {
  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'ok', service: 'synnex-shopify-sync' }),
  };
}

async function handler(event, _context) {
  if (isHttpApiEvent(event)) {
    const method = event.requestContext.http.method;
    const path = event.rawPath || event.requestContext.http.path || '';
    if (method === 'GET' && (path === '/health' || path.endsWith('/health'))) {
      return httpApiHealthResponse();
    }
  }

  // Special action: only list files inside the SFTP zip (no sync). Use test event {"action": "listZip"}.
  const body = event && typeof event === 'object' && event.body;
  const parsed = typeof body === 'string' ? (() => { try { return JSON.parse(body); } catch (_) { return event; } })() : event;
  if (parsed && parsed.action === 'listZip') {
    if (!isSftpConfigured()) return { error: 'SFTP not configured', hint: 'Set SYNNEX_SFTP_* env vars' };
    try {
      const list = await listZipEntriesFromSftp();
      return list;
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) };
    }
  }

  let options = { syncProducts: true, limit: undefined };

  if (event && typeof event === 'object' && event.body) {
    try {
      const parsed = typeof event.body === 'string' ? JSON.parse(event.body) : event.body;
      if (isSyncEvent(parsed)) {
        options = { syncProducts: parsed.syncProducts ?? true, limit: parsed.limit };
      }
    } catch (_) {
      // ignore invalid body
    }
  } else if (isSyncEvent(event)) {
    options = { syncProducts: event.syncProducts ?? true, limit: event.limit };
  }

  const result = await runSync(options);

  const isApiGateway = event && typeof event === 'object' && 'requestContext' in event;
  if (isApiGateway) {
    return {
      statusCode: result.errors.length ? 207 : 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        productsFetched: result.productsFetched,
        productsSynced: result.productsSynced,
        pricesUpdated: result.pricesUpdated,
        inventoryUpdated: result.inventoryUpdated,
        errors: result.errors,
      }),
    };
  }

  return {
    productsFetched: result.productsFetched,
    synced: result.productsSynced,
    pricesUpdated: result.pricesUpdated,
    inventoryUpdated: result.inventoryUpdated,
    errors: result.errors,
  };
}

module.exports = { handler };
