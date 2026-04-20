'use strict';

/**
 * Parse TD Synnex catalog files into normalized product objects.
 *
 * Supports two formats delivered via SFTP:
 *
 * 1. Flat file (.ap, .csv, .txt) — pipe-delimited or comma-delimited.
 *    TD Synnex "All Products" (.ap) files use pipe | as the delimiter.
 *    The first row is a header row with column names.
 *
 * 2. XML (.xml) — SynnexB2B format.
 *    <SynnexB2B><PriceAvailability><Items><Item>...</Item></Items></PriceAvailability></SynnexB2B>
 *
 * Format is detected automatically from file content.
 */

const { XMLParser } = require('fast-xml-parser');

// ─── XML Parser ───────────────────────────────────────────────────────────────

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  textNodeName: '#text',
  parseAttributeValue: true,
  trimValues: true,
  isArray: name => name === 'Item',
});

function xmlText(node) {
  if (node == null) return undefined;
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (typeof node === 'object' && '#text' in node) return String(node['#text']);
  return undefined;
}

function xmlAttr(node, name) {
  if (node == null || typeof node !== 'object') return undefined;
  const val = node[`@_${name}`];
  return val != null ? String(val) : undefined;
}

function findXmlItems(doc) {
  if (doc?.SynnexB2B?.PriceAvailability?.Items?.Item) return doc.SynnexB2B.PriceAvailability.Items.Item;
  if (doc?.SynnexB2B?.Items?.Item) return doc.SynnexB2B.Items.Item;
  const wrapper = doc?.catalog || doc?.products || doc?.Catalog || doc?.Products;
  if (wrapper) {
    const items = wrapper.Item || wrapper.item || wrapper.product || wrapper.Product;
    if (items) return Array.isArray(items) ? items : [items];
  }
  return null;
}

function mapXmlItem(raw) {
  const status = xmlText(raw.StatusCode) || xmlText(raw.status) || 'A';
  if (status === 'D' || status === 'N') return null;

  const synnexSku = xmlText(raw.SynnexSKU) || xmlText(raw.synnexSKU) || xmlText(raw.SKU);
  const mfrPartNumber = xmlText(raw.MfrPN) || xmlText(raw.mfrPN) || xmlText(raw.MfgPN) || xmlText(raw.partNumber);
  if (!synnexSku && !mfrPartNumber) return null;

  const qty = parseFloat(xmlText(raw.AvailableQty) || xmlText(raw.TotalAvailableQty) || '0');
  const price = parseFloat(xmlText(raw.Price) || xmlText(raw.UnitPrice) || '0');
  const msrpVal = parseFloat(xmlText(raw.MSRP) || xmlText(raw.ListPrice) || '0');

  return {
    synnexSku: synnexSku || mfrPartNumber,
    mfrPartNumber: mfrPartNumber || synnexSku,
    description: xmlText(raw.Description) || xmlText(raw.ProductName) || '',
    manufacturer: xmlText(raw.Mfr) || xmlText(raw.Manufacturer) || xmlText(raw.Brand) || '',
    manufacturerCode: xmlAttr(raw.Mfr, 'code') || '',
    category: xmlText(raw.Category) || xmlText(raw.ProductType) || '',
    categoryCode: xmlAttr(raw.Category, 'code') || '',
    statusCode: status,
    price: Number.isFinite(price) ? price : 0,
    msrp: msrpVal > 0 && Number.isFinite(msrpVal) ? msrpVal : undefined,
    quantityAvailable: Number.isFinite(qty) ? Math.max(0, qty) : 0,
    upc: xmlText(raw.UPC) || '',
    weight: parseFloat(xmlText(raw.Weight) || '0') || undefined,
  };
}

function parseXml(content) {
  const doc = xmlParser.parse(content);
  const items = findXmlItems(doc);
  if (!items || items.length === 0) {
    throw new Error('No product items found in XML. Check that the file uses a recognized root structure (SynnexB2B, catalog, products).');
  }
  return items.map(mapXmlItem).filter(Boolean);
}

// ─── Flat File Parser (.ap, .csv, .txt) ──────────────────────────────────────

/**
 * TD Synnex column name aliases.
 * Maps various header names to our internal field names.
 */
const COLUMN_MAP = {
  synnexSku:       ['synnexsku', 'synnex_sku', 'sku', 'synnexitem', 'mfr_part_no', 'vendorpartnumber'],
  mfrPartNumber:   ['mfrpn', 'mfr_pn', 'mfrpartnumber', 'mfg_part_no', 'manufacturerpartnumber', 'vendorpartnumber', 'mfgpartno'],
  description:     ['description', 'productdescription', 'product_description', 'desc', 'productname', 'product_name', 'name'],
  manufacturer:    ['mfr', 'manufacturer', 'brand', 'vendor', 'vendorname', 'mfrname'],
  category:        ['category', 'categoryname', 'category_name', 'cat', 'producttype', 'product_type', 'catname'],
  categoryCode:    ['catcode', 'cat_code', 'categorycode', 'category_code'],
  statusCode:      ['status', 'statuscode', 'status_code', 'productstatus'],
  price:           ['price', 'unitprice', 'unit_price', 'cost', 'sellprice', 'sell_price', 'resellerprice'],
  msrp:            ['msrp', 'listprice', 'list_price', 'suggestedretailprice', 'srp'],
  quantityAvailable: ['qty', 'quantity', 'availableqty', 'available_qty', 'availqty', 'avail', 'stock', 'onhand'],
  upc:             ['upc', 'upccode', 'upc_code', 'barcode', 'ean'],
  weight:          ['weight', 'shippingweight', 'shipping_weight', 'weightlbs'],
};

function buildColumnIndex(headers) {
  const normalized = headers.map(h => h.toLowerCase().replace(/[^a-z0-9]/g, ''));
  const index = {};
  for (const [field, aliases] of Object.entries(COLUMN_MAP)) {
    const col = aliases.findIndex(alias => normalized.includes(alias));
    if (col !== -1) {
      index[field] = normalized.indexOf(aliases[col]);
    }
  }
  return index;
}

function splitRow(line, delimiter) {
  const fields = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      inQuotes = !inQuotes;
    } else if (!inQuotes && line.slice(i, i + delimiter.length) === delimiter) {
      fields.push(current.trim());
      current = '';
      i += delimiter.length - 1;
    } else {
      current += ch;
    }
  }
  fields.push(current.trim());
  return fields;
}

function detectDelimiter(firstLine) {
  const counts = { '|': 0, '\t': 0, ',': 0 };
  for (const ch of firstLine) {
    if (ch in counts) counts[ch]++;
  }
  return Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
}

function mapFlatRow(fields, idx) {
  const get = (field) => {
    const col = idx[field];
    return col !== undefined ? (fields[col] || '').trim() : '';
  };

  const status = get('statusCode') || 'A';
  if (status === 'D' || status === 'N' || status === 'I') return null;

  const synnexSku = get('synnexSku');
  const mfrPartNumber = get('mfrPartNumber');
  if (!synnexSku && !mfrPartNumber) return null;

  const price = parseFloat(get('price')) || 0;
  const msrpVal = parseFloat(get('msrp')) || 0;
  const qty = parseFloat(get('quantityAvailable')) || 0;
  const weight = parseFloat(get('weight')) || undefined;

  return {
    synnexSku: synnexSku || mfrPartNumber,
    mfrPartNumber: mfrPartNumber || synnexSku,
    description: get('description'),
    manufacturer: get('manufacturer'),
    manufacturerCode: '',
    category: get('category'),
    categoryCode: get('categoryCode'),
    statusCode: status,
    price: Number.isFinite(price) ? price : 0,
    msrp: msrpVal > 0 && Number.isFinite(msrpVal) ? msrpVal : undefined,
    quantityAvailable: Number.isFinite(qty) ? Math.max(0, qty) : 0,
    upc: get('upc'),
    weight: weight && Number.isFinite(weight) ? weight : undefined,
  };
}

/**
 * Detect whether this is a TD Synnex proprietary .ap format.
 * These files have a first line like: `698655~HDR~...` (tilde-delimited, no named columns).
 */
function isTdSynnexApFormat(headerLine) {
  const fields = headerLine.split('~');
  return fields.length >= 3 && (fields[1] === 'HDR' || fields[1] === 'DTL');
}

/**
 * Parse a single DTL row from the TD Synnex .ap fixed-position format.
 * Column positions are fixed — there is no header row with names.
 *
 * Confirmed positions from live data:
 *   [0]  Customer account number
 *   [1]  Record type (HDR / DTL / TRL)
 *   [2]  Manufacturer/vendor part number (e.g. AP9513, 940-000110)
 *   [3]  Vendor-prefixed part number (e.g. APC-AP9513)
 *   [4]  Synnex internal catalog ID — used as <synnexSKU> in the XML P&A API
 *   [5]  Status code (A=active, D=discontinued, I=inactive)
 *   [6]  Product description
 *   [7]  Manufacturer name
 *   [8]  Manufacturer code (numeric)
 *   [9]  Available quantity
 *   [12] Reseller/cost price
 *   [13] MSRP (suggested retail)
 *   [27] Weight (lbs)
 *   [33] UPC barcode
 *   [35] Category name
 */
function mapApRow(fields) {
  if (fields[1] !== 'DTL') return null; // skip HDR, TRL, and any other record types

  const status = (fields[5] || '').trim();
  if (status === 'D' || status === 'I' || status === 'N') return null;

  // Field [4] is the Synnex internal catalog ID — this is what the XML P&A API accepts
  const synnexSku = (fields[4] || '').trim();
  // Field [2] is the manufacturer/vendor part number (e.g. AP9513, 940-000110)
  const mfrPartNumber = (fields[2] || '').trim();
  if (!synnexSku && !mfrPartNumber) return null;

  const qty = parseFloat(fields[9]) || 0;
  const price = parseFloat(fields[12]) || 0;
  const msrpVal = parseFloat(fields[13]) || 0;
  const weight = parseFloat(fields[27]) || undefined;

  return {
    synnexSku,
    mfrPartNumber,
    description: (fields[6] || '').trim(),
    manufacturer: (fields[7] || '').trim(),
    manufacturerCode: '',
    category: (fields[35] || '').trim(),
    categoryCode: (fields[8] || '').trim(),
    statusCode: status || 'A',
    price: Number.isFinite(price) ? price : 0,
    msrp: msrpVal > 0 && Number.isFinite(msrpVal) ? msrpVal : undefined,
    quantityAvailable: Number.isFinite(qty) ? Math.max(0, qty) : 0,
    upc: (fields[33] || '').trim(),
    weight: weight && Number.isFinite(weight) ? weight : undefined,
  };
}

function parseFlatFile(content) {
  const lines = content.split(/\r?\n/).filter(l => l.trim());
  if (lines.length < 2) throw new Error('Catalog flat file has fewer than 2 lines — no data rows found.');

  const firstLine = lines[0];

  // TD Synnex .ap fixed-position format (tilde-delimited, no named column header)
  if (isTdSynnexApFormat(firstLine)) {
    return lines
      .map(line => mapApRow(line.split('~')))
      .filter(Boolean);
  }

  // Generic named-column flat file (CSV, TSV, pipe-delimited with a header row)
  const delimiter = detectDelimiter(firstLine);
  const headers = splitRow(firstLine, delimiter);
  const columnIndex = buildColumnIndex(headers);

  if (!columnIndex.synnexSku && !columnIndex.mfrPartNumber) {
    throw new Error(
      `Could not map required SKU column from headers: [${headers.slice(0, 10).join(', ')}...]\n` +
      'Expected a column like: SynnexSKU, MfrPN, SKU, VendorPartNumber'
    );
  }

  const products = [];
  for (let i = 1; i < lines.length; i++) {
    const fields = splitRow(lines[i], delimiter);
    const product = mapFlatRow(fields, columnIndex);
    if (product) products.push(product);
  }
  return products;
}

// ─── Main Export ──────────────────────────────────────────────────────────────

/**
 * Parse a TD Synnex catalog file (XML or flat/pipe-delimited).
 * Format is detected automatically from the file content.
 * Used for small/test files. For large .ap files use createLineParser().
 *
 * @param {string} content - Raw file content (UTF-8)
 * @returns {object[]} Normalized product objects
 */
function parseCatalogXml(content) {
  const trimmed = content.trimStart();
  if (trimmed.startsWith('<')) {
    return parseXml(content);
  }
  return parseFlatFile(content);
}

/**
 * Create a stateful line-by-line parser for large flat catalog files.
 * Call onHeader(headerLine) to initialize, then call parseLine(dataLine)
 * for each subsequent row. Returns null for rows that should be skipped.
 *
 * @param {string} headerLine - The first (header) line of the file
 * @returns {(dataLine: string) => object|null} parseLine function
 */
function createLineParser(headerLine) {
  // TD Synnex .ap fixed-position format — no named columns, just split by ~
  if (isTdSynnexApFormat(headerLine)) {
    return function parseLine(line) {
      return mapApRow(line.split('~'));
    };
  }

  // Generic named-column flat file
  const delimiter = detectDelimiter(headerLine);
  const headers = splitRow(headerLine, delimiter);
  const idx = buildColumnIndex(headers);

  if (!idx.synnexSku && !idx.mfrPartNumber) {
    throw new Error(
      `Could not map required SKU column from headers: [${headers.slice(0, 10).join(', ')}...]\n` +
      'Expected a column like: SynnexSKU, MfrPN, SKU, VendorPartNumber'
    );
  }

  return function parseLine(line) {
    const fields = splitRow(line, delimiter);
    return mapFlatRow(fields, idx);
  };
}

module.exports = { parseCatalogXml, createLineParser };
