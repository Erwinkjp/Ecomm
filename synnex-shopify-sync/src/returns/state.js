'use strict';

/**
 * Return state management via DynamoDB — the returns sibling of orders/state.js.
 *
 * Tracks every Shopify return through its lifecycle:
 *   requested → rma_requested (RMA opened at TD SYNNEX) → received → refunded
 *                              ↓
 *                            error (retryable)
 *
 * Table schema:
 *   PK: shopifyReturnId (string) — Shopify Return GID
 *   Attributes: shopifyOrderId, poNumber, synnexOrderId, lineItems, reason,
 *               rmaNumber, synnexRmaStatus, returnTracking, status,
 *               errorMessage, createdAt, updatedAt
 */

const { DynamoDBClient, PutItemCommand, UpdateItemCommand, ScanCommand, GetItemCommand } = require('@aws-sdk/client-dynamodb');
const { marshall, unmarshall } = require('@aws-sdk/util-dynamodb');

let client;

function getClient() {
  if (!client) client = new DynamoDBClient({});
  return client;
}

function tableName() {
  return process.env.RETURNS_TABLE;
}

/**
 * Save a new return in state (status: requested). Idempotent on shopifyReturnId.
 */
async function saveReturn(ret) {
  if (!tableName()) return;
  const now = new Date().toISOString();
  await getClient().send(new PutItemCommand({
    TableName: tableName(),
    Item: marshall({
      shopifyReturnId: ret.shopifyReturnId,
      shopifyOrderId:  ret.shopifyOrderId || '',
      shopifyOrderName: ret.shopifyOrderName || '',
      poNumber:        ret.poNumber || '',        // original TD SYNNEX PO (SHP-####)
      synnexOrderId:   ret.synnexOrderId || '',
      lineItems:       ret.lineItems || [],        // [{ synnexSku, mfrPartNumber, quantity, reason }]
      reason:          ret.reason || '',
      rmaNumber:       '',
      synnexRmaStatus: '',
      returnTracking:  [],
      status:          'requested',
      errorMessage:    '',
      createdAt:       now,
      updatedAt:       now,
    }, { removeUndefinedValues: true }),
    ConditionExpression: 'attribute_not_exists(shopifyReturnId)',
  }));
}

/**
 * Record the RMA number after it's opened at TD SYNNEX (status: rma_requested).
 */
async function markRmaRequested(shopifyReturnId, { rmaNumber, synnexRmaStatus }) {
  await update(shopifyReturnId, {
    ':status': 'rma_requested',
    ':rmaNumber': rmaNumber || '',
    ':synnexRmaStatus': synnexRmaStatus || '',
    ':updatedAt': new Date().toISOString(),
  }, 'SET #status = :status, rmaNumber = :rmaNumber, synnexRmaStatus = :synnexRmaStatus, updatedAt = :updatedAt');
}

/**
 * Update when TD SYNNEX reports the return received / credited.
 */
async function markReceived(shopifyReturnId, { synnexRmaStatus, returnTracking }) {
  await update(shopifyReturnId, {
    ':status': 'received',
    ':synnexRmaStatus': synnexRmaStatus || '',
    ':returnTracking': returnTracking || [],
    ':updatedAt': new Date().toISOString(),
  }, 'SET #status = :status, synnexRmaStatus = :synnexRmaStatus, returnTracking = :returnTracking, updatedAt = :updatedAt');
}

/**
 * Mark the return fully closed (refund processed in Shopify).
 */
async function markRefunded(shopifyReturnId) {
  await update(shopifyReturnId, {
    ':status': 'refunded',
    ':updatedAt': new Date().toISOString(),
  }, 'SET #status = :status, updatedAt = :updatedAt');
}

/**
 * Record an error (keeps the return retryable).
 */
async function markError(shopifyReturnId, errorMessage) {
  await update(shopifyReturnId, {
    ':status': 'error',
    ':errorMessage': String(errorMessage).slice(0, 1000),
    ':updatedAt': new Date().toISOString(),
  }, 'SET #status = :status, errorMessage = :errorMessage, updatedAt = :updatedAt');
}

async function update(shopifyReturnId, values, expression) {
  await getClient().send(new UpdateItemCommand({
    TableName: tableName(),
    Key: marshall({ shopifyReturnId }),
    UpdateExpression: expression,
    ExpressionAttributeNames: { '#status': 'status' },
    ExpressionAttributeValues: marshall(values),
  }));
}

/**
 * Get returns in a given status.
 * @param {'requested'|'rma_requested'|'received'|'refunded'|'error'} status
 */
async function getReturnsByStatus(status) {
  if (!tableName()) return [];
  const result = await getClient().send(new ScanCommand({
    TableName: tableName(),
    FilterExpression: '#status = :status',
    ExpressionAttributeNames: { '#status': 'status' },
    ExpressionAttributeValues: marshall({ ':status': status }),
  }));
  return (result.Items || []).map(item => unmarshall(item));
}

async function getReturn(shopifyReturnId) {
  if (!tableName()) return null;
  const result = await getClient().send(new GetItemCommand({
    TableName: tableName(),
    Key: marshall({ shopifyReturnId }),
  }));
  return result.Item ? unmarshall(result.Item) : null;
}

module.exports = { saveReturn, markRmaRequested, markReceived, markRefunded, markError, getReturnsByStatus, getReturn };
