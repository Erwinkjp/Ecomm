/**
 * Lambda handler. Can be invoked by:
 * - EventBridge (scheduled): no body; runs full sync with default options.
 * - API Gateway / direct invoke: optional body { syncProducts?: boolean, limit?: number }.
 */
const { runSync } = require('./sync/sync');

function isSyncEvent(body) {
  return body !== null && typeof body === 'object';
}

async function handler(event, _context) {
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
        inventoryUpdated: result.inventoryUpdated,
        errors: result.errors,
      }),
    };
  }

  return {
    synced: result.productsSynced,
    inventoryUpdated: result.inventoryUpdated,
    errors: result.errors,
  };
}

module.exports = { handler };
