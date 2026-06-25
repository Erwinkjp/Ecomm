'use strict';

/**
 * TD SYNNEX Electronic RMA (eRMA) client — sibling of orderSubmit.js / orderStatus.js.
 *
 * ⚠️ SPEC-PENDING: the exact RMA XML schema (endpoint path, request element names,
 * return reason codes, response fields) is NOT public and must come from the TD SYNNEX
 * rep / integration team. The structures below follow the established SynnexB2B pattern
 * (same Credential + CustomerNumber envelope as Order/POStatus) as a best guess and are
 * marked `SPEC TODO`. The functions are GUARDED on config.synnex.order.rmaUrl, so nothing
 * fires until the endpoint is configured and the schema confirmed.
 *
 * Endpoints (set once known): SYNNEX_RMA_URL, SYNNEX_RMA_STATUS_URL.
 */

const { XMLParser } = require('fast-xml-parser');
const { config } = require('../config');

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  textNodeName: '#text',
  parseAttributeValue: true,
  trimValues: true,
  isArray: name => name === 'Item' || name === 'Package',
});

function escapeXml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function isRmaConfigured() {
  return Boolean(config.synnex.order.rmaUrl && config.synnex.xml.username && config.synnex.xml.password);
}

/**
 * Map a Shopify return reason to a TD SYNNEX return reason code.
 * SPEC TODO: replace with the real code list from the RMA spec.
 */
const SHOPIFY_TO_SYNNEX_REASON = {
  DEFECTIVE: 'DEFECTIVE',
  NOT_AS_DESCRIBED: 'NOT_AS_DESCRIBED',
  WRONG_ITEM: 'WRONG_ITEM',
  UNWANTED: 'BUYER_REMORSE',
  SIZE_TOO_SMALL: 'BUYER_REMORSE',
  SIZE_TOO_LARGE: 'BUYER_REMORSE',
  OTHER: 'OTHER',
};
function mapReason(shopifyReason) {
  return SHOPIFY_TO_SYNNEX_REASON[String(shopifyReason || '').toUpperCase()] || 'OTHER';
}

/**
 * Build the CreateRMARequest XML per TD SYNNEX's spec (2026-06-17 docs).
 * Flat credentials (no <Credential> wrapper); keys off the TD SYNNEX <OrderNo>
 * (Sales Order number, i.e. synnexOrderId — NOT the PO). Each item carries the RMA
 * lineNumber (attribute), the original OrderLineNo, SKU (or MfgPN), the device SerialNo
 * (REQUIRED), a ReasonCode, and a ConditionCode.
 *
 * @param {{ synnexOrderId:string, lineItems:Array<{synnexSku?,mfrPartNumber?,orderLineNo?,serialNo?,reason?,conditionCode?}> }} ret
 */
function buildRmaXml(ret) {
  const { customerNo, username, password } = config.synnex.xml;
  const itemLines = (ret.lineItems || []).map((item, i) => {
    const numericSku = /^\d+$/.test(String(item.synnexSku || ''));
    const idLine = numericSku
      ? `<SKU>${escapeXml(item.synnexSku)}</SKU>`
      : `<MfgPN>${escapeXml(item.mfrPartNumber || item.synnexSku)}</MfgPN>`;
    return `  <Item lineNumber="${i + 1}">
    <OrderLineNo>${escapeXml(item.orderLineNo || (i + 1))}</OrderLineNo>
    ${idLine}
    <SerialNo>${escapeXml(item.serialNo || '')}</SerialNo>
    <ReasonCode>${escapeXml(mapReason(item.reason))}</ReasonCode>
    <ConditionCode>${escapeXml(item.conditionCode || 'N')}</ConditionCode>
  </Item>`;
  }).join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<CreateRMARequest>
  <UserID>${escapeXml(username)}</UserID>
  <Password>${escapeXml(password)}</Password>
  <CustomerNumber>${escapeXml(customerNo)}</CustomerNumber>
  <OrderNo>${escapeXml(ret.synnexOrderId)}</OrderNo>
${itemLines}
</CreateRMARequest>`;
}

async function postXml(url, xmlBody) {
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `xmldata=${encodeURIComponent(xmlBody)}`,
    signal: AbortSignal.timeout(30_000),
  });
  if (!resp.ok) throw new Error(`TD SYNNEX RMA HTTP ${resp.status}: ${resp.statusText}`);
  return resp.text();
}

/**
 * Create an RMA at TD SYNNEX for a prior order.
 * @returns {Promise<{ rmaNumber:string, status:string, returnLabelUrl?:string, message:string }>}
 */
async function createRma(ret) {
  if (!isRmaConfigured()) {
    throw new Error('RMA endpoint not configured — awaiting TD SYNNEX RMA spec (set SYNNEX_RMA_URL).');
  }
  const xml = buildRmaXml(ret);
  const text = await postXml(config.synnex.order.rmaUrl, xml);
  return parseRmaResponse(text);
}

/**
 * Check the status of an existing RMA.
 * @returns {Promise<{ rmaNumber:string, status:string, returnTracking:string[], message:string }>}
 */
async function checkRmaStatus({ rmaNumber, poNumber }) {
  if (!isRmaConfigured()) {
    throw new Error('RMA endpoint not configured — awaiting TD SYNNEX RMA spec (set SYNNEX_RMA_STATUS_URL).');
  }
  const { customerNo, username, password } = config.synnex.xml;
  // SPEC TODO: confirm status-request element names + how to key (RMANumber vs PONumber).
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<SynnexB2B>
  <Credential><UserID>${escapeXml(username)}</UserID><Password>${escapeXml(password)}</Password></Credential>
  <RMAStatusRequest>
    <CustomerNumber>${escapeXml(customerNo)}</CustomerNumber>
    ${rmaNumber ? `<RMANumber>${escapeXml(rmaNumber)}</RMANumber>` : `<PONumber>${escapeXml(poNumber)}</PONumber>`}
  </RMAStatusRequest>
</SynnexB2B>`;
  const text = await postXml(config.synnex.order.rmaStatusUrl || config.synnex.order.rmaUrl, xml);
  return parseRmaStatusResponse(text);
}

/* ── Response parsers — SPEC TODO: align field names with the real response ───── */

function text(node) {
  if (node == null) return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (typeof node === 'object' && '#text' in node) return String(node['#text']);
  return '';
}

function parseRmaResponse(xml) {
  // Per spec: <CreateRMAResponse><Status>Created</Status><RMANumber>234255</RMANumber></CreateRMAResponse>
  // or failure: <Status>Failed</Status><Reason>...</Reason>
  const doc = parser.parse(xml);
  const r = doc?.CreateRMAResponse || doc?.SynnexB2B?.CreateRMAResponse || {};
  const status = text(r?.Status).trim();
  const rmaNumber = text(r?.RMANumber);
  const reason = text(r?.Reason);
  if (status.toLowerCase() !== 'created') {
    throw new Error(`TD SYNNEX RMA failed: ${reason || status || 'unknown response'}`);
  }
  return { rmaNumber, status, message: reason };
}

function parseRmaStatusResponse(xml) {
  const doc = parser.parse(xml);
  const r = doc?.SynnexB2B?.RMAStatusResponse || doc?.RMAStatusResponse || {};
  const rmaNumber = text(r?.RMANumber);
  const status = (text(r?.Code) || text(r?.Status)).trim().toLowerCase();
  const item = Array.isArray(r?.Items?.Item) ? r.Items.Item[0] : r?.Items?.Item;
  const trk = text(item?.TrackingNumber) || text(item?.Packages?.Package?.[0]?.TrackingNumber);
  return {
    rmaNumber,
    status,
    returnTracking: trk ? [String(trk).trim()] : [],
    message: text(r?.Reason) || text(r?.Message) || '',
  };
}

module.exports = { createRma, checkRmaStatus, isRmaConfigured, mapReason };
