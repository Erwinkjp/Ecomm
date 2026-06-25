'use strict';

/**
 * Approved product catalog — DynamoDB-backed list of every TD Synnex SKU
 * we've chosen to sell in Shopify.
 *
 * Table schema:
 *   PK: synnexSku (String)  — TD Synnex catalog ID, used by the XML P&A API
 *
 *   mfrPartNumber          — manufacturer part number (also stored as Shopify barcode)
 *   description            — raw TD Synnex product description
 *   manufacturer           — brand name exactly as it appears in the catalog
 *   category               — raw TD Synnex category code/name
 *   productType            — human-readable type mapped from category (e.g. "Laptops")
 *   tags                   — Shopify search tags (e.g. ["lenovo", "laptop", "notebook"])
 *   shopifyProductId       — Shopify GID so we can update without another lookup
 *   shopifyVariantId       — Shopify variant GID
 *   shopifyInventoryItemId — Shopify inventory item GID (for inventory updates)
 *   addedAt                — ISO timestamp when first discovered
 *   lastSyncedAt           — ISO timestamp of last successful Shopify upsert
 */

const { DynamoDBClient, PutItemCommand, ScanCommand, QueryCommand } = require('@aws-sdk/client-dynamodb');
const { marshall, unmarshall } = require('@aws-sdk/util-dynamodb');

// GSI that lets us resolve a manufacturer part number → the numeric TD Synnex
// catalog ID (synnexSku). Defined in template.yaml on the products table.
const MFR_PART_INDEX = 'mfrPartNumber-index';

let client;

function getClient() {
  if (!client) client = new DynamoDBClient({});
  return client;
}

function tableName() {
  return process.env.PRODUCTS_TABLE;
}

/**
 * Upsert a product into the approved catalog table.
 * Safe to call repeatedly — overwrites previous entry for the same SKU.
 */
async function saveProduct(product) {
  if (!tableName()) return;
  const now = new Date().toISOString();
  await getClient().send(new PutItemCommand({
    TableName: tableName(),
    Item: marshall({
      synnexSku:              product.synnexSku,
      mfrPartNumber:          product.mfrPartNumber          || '',
      description:            product.description            || '',
      manufacturer:           product.manufacturer           || '',
      category:               product.category               || '',
      unspsc:                 product.unspsc                 || '',
      productType:            product.productType            || '',
      tags:                   product.tags                   || [],
      shopifyProductId:       product.shopifyProductId       || '',
      shopifyVariantId:       product.shopifyVariantId       || '',
      shopifyInventoryItemId: product.shopifyInventoryItemId || '',
      addedAt:                product.addedAt                || now,
      lastSyncedAt:           now,
    }, { removeUndefinedValues: true }),
  }));
}

/**
 * Return every product in the approved catalog table, paginating automatically.
 */
async function getAllProducts() {
  if (!tableName()) return [];
  const items = [];
  let lastKey;
  do {
    const resp = await getClient().send(new ScanCommand({
      TableName: tableName(),
      ExclusiveStartKey: lastKey,
    }));
    items.push(...(resp.Items || []).map(i => unmarshall(i)));
    lastKey = resp.LastEvaluatedKey;
  } while (lastKey);
  return items;
}

/**
 * Resolve a manufacturer part number to its catalog record — used at order time
 * to translate the Shopify variant SKU (which holds the mfr part number) into the
 * numeric TD Synnex catalog ID (synnexSku) that the order API requires.
 *
 * If several catalog rows share the same mfr part number, prefer the one actually
 * listed in Shopify (has a shopifyVariantId), since that's the one being ordered.
 *
 * @param {string} mfrPartNumber
 * @returns {Promise<object|null>}
 */
async function getProductByMfrPart(mfrPartNumber) {
  if (!tableName() || !mfrPartNumber) return null;
  const resp = await getClient().send(new QueryCommand({
    TableName: tableName(),
    IndexName: MFR_PART_INDEX,
    KeyConditionExpression: 'mfrPartNumber = :m',
    ExpressionAttributeValues: marshall({ ':m': mfrPartNumber }),
  }));
  const items = (resp.Items || []).map(i => unmarshall(i));
  if (items.length === 0) return null;
  return items.find(p => p.shopifyVariantId) || items[0];
}

/**
 * Return the number of products in the approved catalog (cheap COUNT scan).
 */
async function getProductCount() {
  if (!tableName()) return 0;
  const resp = await getClient().send(new ScanCommand({
    TableName: tableName(),
    Select: 'COUNT',
  }));
  return resp.Count || 0;
}

/**
 * Scan one page of the catalog table, resumable via an opaque cursor.
 * @param {{ exclusiveStartKey?: object, limit?: number }} opts
 * @returns {Promise<{ items: object[], lastKey: object|undefined }>}
 */
async function scanProductsPage({ exclusiveStartKey, limit = 500 } = {}) {
  if (!tableName()) return { items: [], lastKey: undefined };
  const resp = await getClient().send(new ScanCommand({
    TableName: tableName(),
    ExclusiveStartKey: exclusiveStartKey,
    Limit: limit,
  }));
  return {
    items: (resp.Items || []).map(i => unmarshall(i)),
    // Keep LastEvaluatedKey in raw DynamoDB AttributeValue form — it is passed back
    // verbatim as ExclusiveStartKey (which the low-level ScanCommand requires) and is
    // JSON-serializable for cursor persistence.
    lastKey: resp.LastEvaluatedKey || undefined,
  };
}

/**
 * Tiny key/value job-state store kept inside the products table under a sentinel
 * PK (synnexSku). Lets a resumable scheduled job persist its scan cursor + stats
 * across Lambda invocations. The sentinel row is ignored by normal catalog reads.
 */
async function getJobState(key) {
  if (!tableName()) return null;
  const resp = await getClient().send(new QueryCommand({
    TableName: tableName(),
    KeyConditionExpression: 'synnexSku = :k',
    ExpressionAttributeValues: marshall({ ':k': `__jobstate__${key}` }),
  }));
  const item = (resp.Items || [])[0];
  if (!item) return null;
  const row = unmarshall(item);
  try { return JSON.parse(row.state); } catch (_) { return null; }
}

async function putJobState(key, state) {
  if (!tableName()) return;
  await getClient().send(new PutItemCommand({
    TableName: tableName(),
    Item: marshall({ synnexSku: `__jobstate__${key}`, state: JSON.stringify(state), updatedAt: new Date().toISOString() }),
  }));
}

module.exports = { saveProduct, getAllProducts, getProductByMfrPart, getProductCount, scanProductsPage, getJobState, putJobState };
