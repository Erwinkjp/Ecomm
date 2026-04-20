'use strict';

/**
 * Order state management via DynamoDB.
 *
 * Tracks every Shopify order through its fulfillment lifecycle:
 *   pending → submitted → shipped → fulfilled
 *                         ↓
 *                       error (retryable)
 *
 * Table schema:
 *   PK: shopifyOrderId (string) — Shopify order GID
 *   Attributes: poNumber, synnexOrderId, status, trackingNumbers,
 *               carrier, errorMessage, createdAt, updatedAt
 */

const { DynamoDBClient, PutItemCommand, UpdateItemCommand, ScanCommand, GetItemCommand } = require('@aws-sdk/client-dynamodb');
const { marshall, unmarshall } = require('@aws-sdk/util-dynamodb');

let client;

function getClient() {
  if (!client) client = new DynamoDBClient({});
  return client;
}

function tableName() {
  return process.env.ORDERS_TABLE;
}

/**
 * Save a new order in state (status: pending).
 * Persists shipTo and lineItems so submit-orders can read them back from DynamoDB.
 */
async function saveOrder(order) {
  const now = new Date().toISOString();
  await getClient().send(new PutItemCommand({
    TableName: tableName(),
    Item: marshall({
      shopifyOrderId: order.shopifyOrderId,
      shopifyOrderName: order.shopifyOrderName,
      poNumber: order.poNumber,
      email: order.email || '',
      shipTo: order.shipTo || {},
      lineItems: order.lineItems || [],
      synnexOrderId: '',
      status: 'pending',
      trackingNumbers: [],
      carrier: '',
      errorMessage: '',
      createdAt: now,
      updatedAt: now,
    }),
    // Avoid overwriting an order that's already being processed
    ConditionExpression: 'attribute_not_exists(shopifyOrderId)',
  }));
}

/**
 * Update order status after TD Synnex submission.
 */
async function markSubmitted(shopifyOrderId, { synnexOrderId }) {
  await update(shopifyOrderId, {
    ':status': 'submitted',
    ':synnexOrderId': synnexOrderId || '',
    ':updatedAt': new Date().toISOString(),
  }, 'SET #status = :status, synnexOrderId = :synnexOrderId, updatedAt = :updatedAt');
}

/**
 * Update order status when TD Synnex reports it as shipped.
 */
async function markShipped(shopifyOrderId, { trackingNumbers, carrier }) {
  await update(shopifyOrderId, {
    ':status': 'shipped',
    ':trackingNumbers': trackingNumbers || [],
    ':carrier': carrier || '',
    ':updatedAt': new Date().toISOString(),
  }, 'SET #status = :status, trackingNumbers = :trackingNumbers, carrier = :carrier, updatedAt = :updatedAt');
}

/**
 * Update order status when Shopify fulfillment is created.
 */
async function markFulfilled(shopifyOrderId) {
  await update(shopifyOrderId, {
    ':status': 'fulfilled',
    ':updatedAt': new Date().toISOString(),
  }, 'SET #status = :status, updatedAt = :updatedAt');
}

/**
 * Record an error on an order (keeps it retryable).
 */
async function markError(shopifyOrderId, errorMessage) {
  await update(shopifyOrderId, {
    ':status': 'error',
    ':errorMessage': String(errorMessage).slice(0, 1000),
    ':updatedAt': new Date().toISOString(),
  }, 'SET #status = :status, errorMessage = :errorMessage, updatedAt = :updatedAt');
}

async function update(shopifyOrderId, values, expression) {
  await getClient().send(new UpdateItemCommand({
    TableName: tableName(),
    Key: marshall({ shopifyOrderId }),
    UpdateExpression: expression,
    ExpressionAttributeNames: { '#status': 'status' },
    ExpressionAttributeValues: marshall(values),
  }));
}

/**
 * Get orders in a given status.
 * @param {'pending'|'submitted'|'shipped'|'error'} status
 */
async function getOrdersByStatus(status) {
  const result = await getClient().send(new ScanCommand({
    TableName: tableName(),
    FilterExpression: '#status = :status',
    ExpressionAttributeNames: { '#status': 'status' },
    ExpressionAttributeValues: marshall({ ':status': status }),
  }));
  return (result.Items || []).map(item => unmarshall(item));
}

/**
 * Get a single order by Shopify order ID.
 */
async function getOrder(shopifyOrderId) {
  const result = await getClient().send(new GetItemCommand({
    TableName: tableName(),
    Key: marshall({ shopifyOrderId }),
  }));
  return result.Item ? unmarshall(result.Item) : null;
}

module.exports = { saveOrder, markSubmitted, markShipped, markFulfilled, markError, getOrdersByStatus, getOrder };
