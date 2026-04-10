/**
 * TD Synnex file-based data source (flat / delimited files only).
 * Sources (checked in order): SFTP, S3, or SYNNEX_FILE_URL.
 */
const { parseFlatFile } = require('./flatFileParser');
const { getFileContentFromSftp, isSftpConfigured } = require('./sftpSource');

async function loadFileContent() {
  if (isSftpConfigured()) {
    return getFileContentFromSftp();
  }

  const s3Bucket = process.env.SYNNEX_FILE_S3_BUCKET;
  const s3Key = process.env.SYNNEX_FILE_S3_KEY;
  const fileUrl = process.env.SYNNEX_FILE_URL;

  if (s3Bucket && s3Key) {
    const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3');
    const client = new S3Client({});
    const res = await client.send(new GetObjectCommand({ Bucket: s3Bucket, Key: s3Key }));
    const chunks = [];
    for await (const chunk of res.Body) chunks.push(chunk);
    return Buffer.concat(chunks).toString('utf-8');
  }

  if (fileUrl) {
    const res = await fetch(fileUrl);
    if (!res.ok) throw new Error(`Synnex file fetch failed ${res.status}: ${fileUrl}`);
    return res.text();
  }

  throw new Error('Set SFTP (SYNNEX_SFTP_*), SYNNEX_FILE_S3_BUCKET + SYNNEX_FILE_S3_KEY, or SYNNEX_FILE_URL for file-based sync');
}

function parseSynnexFlatFile(content) {
  const delimiter = process.env.SYNNEX_FILE_DELIMITER || ',';
  const hasHeader = process.env.SYNNEX_FILE_HAS_HEADER !== 'false';
  const partCol = process.env.SYNNEX_COL_PART_NUMBER || 'partNumber';
  const qtyCol = process.env.SYNNEX_COL_QTY || 'quantityAvailable';
  const priceCol = process.env.SYNNEX_COL_PRICE || 'price';
  const descCol = process.env.SYNNEX_COL_DESCRIPTION || 'description';

  const rows = parseFlatFile(content, { delimiter, hasHeader });
  return rows
    .map((row) => ({
      partNumber: row[partCol] || row['Part Number'] || row['part_number'] || '',
      description: row[descCol] || row['Description'] || undefined,
      quantityAvailable: parseInt(row[qtyCol] || row['Quantity'] || row['Qty'] || '0', 10) || 0,
      price: parseFloat(row[priceCol] || row['Price'] || '') || undefined,
      currency: row['currency'] || row['Currency'] || 'USD',
      manufacturer: row['manufacturer'] || row['Manufacturer'],
      category: row['category'] || row['Category'],
    }))
    .filter((p) => p.partNumber);
}

function assertNotXmlContent(content) {
  const format = (process.env.SYNNEX_FILE_FORMAT || '').toLowerCase();
  const trimmed = content.trimStart();
  if (format === 'xml' || trimmed.startsWith('<?xml') || trimmed.startsWith('<')) {
    throw new Error(
      'XML files are not supported. Use a delimited flat file (CSV) or the REST API (SYNNEX_BASE_URL).'
    );
  }
}

async function getProductsWithAvailabilityFromFile(allowlist = null) {
  const content = await loadFileContent();
  assertNotXmlContent(content);
  const flat = parseSynnexFlatFile(content);
  if (allowlist) return flat.filter((p) => allowlist.has(p.partNumber));
  return flat;
}

function isFileSourceConfigured() {
  return Boolean(
    isSftpConfigured() ||
    (process.env.SYNNEX_FILE_S3_BUCKET && process.env.SYNNEX_FILE_S3_KEY) ||
    process.env.SYNNEX_FILE_URL
  );
}

module.exports = {
  loadFileContent,
  parseSynnexFlatFile,
  getProductsWithAvailabilityFromFile,
  isFileSourceConfigured,
};
