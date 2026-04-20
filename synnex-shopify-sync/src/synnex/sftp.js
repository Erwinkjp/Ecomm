'use strict';

/**
 * TD Synnex SFTP catalog download.
 *
 * The catalog ZIP (e.g. 698655.zip) contains a single large .ap flat file
 * (~360 MB uncompressed). We iterate line-by-line using indexOf rather than
 * .split() so we don't build a second copy of the entire file in memory.
 */

const SftpClient = require('ssh2-sftp-client');
const AdmZip = require('adm-zip');
const { SecretsManagerClient, GetSecretValueCommand } = require('@aws-sdk/client-secrets-manager');
const { config } = require('../config');

let secretsClient;

async function getSftpPassword() {
  const { password, secretArn } = config.synnex.sftp;
  if (secretArn) {
    if (!secretsClient) secretsClient = new SecretsManagerClient({});
    const resp = await secretsClient.send(new GetSecretValueCommand({ SecretId: secretArn }));
    const secret = JSON.parse(resp.SecretString || '{}');
    return secret.password || secret.Password;
  }
  return password;
}

async function connectSftp() {
  const { host, port, username } = config.synnex.sftp;
  const password = await getSftpPassword();
  const sftp = new SftpClient();
  await sftp.connect({ host, port, username, password, readyTimeout: 30_000 });
  return sftp;
}

function extractEntry(buffer, preferredEntry) {
  const zip = new AdmZip(buffer);
  const entries = zip.getEntries().filter(e => !e.isDirectory);

  if (preferredEntry) {
    const entry = entries.find(e => e.entryName === preferredEntry || e.name === preferredEntry);
    if (!entry) throw new Error(`ZIP entry not found: ${preferredEntry}`);
    return entry.getData().toString('utf8');
  }

  for (const ext of ['.ap', '.csv', '.xml', '.txt']) {
    const entry = entries.find(e => e.name.toLowerCase().endsWith(ext));
    if (entry) return entry.getData().toString('utf8');
  }

  if (entries.length === 0) throw new Error('ZIP archive contains no files');
  return entries[0].getData().toString('utf8');
}

/**
 * Download catalog from SFTP and iterate line-by-line.
 *
 * Calls onHeader(headerLine) once, then onRow(dataLine) for each row.
 * onRow may return false to stop early (used with limit).
 *
 * @param {{ onHeader: (line: string) => void, onRow: (line: string) => boolean }} callbacks
 */
async function streamCatalogLines({ onHeader, onRow }) {
  const { remotePath, zipEntry } = config.synnex.sftp;
  const sftp = await connectSftp();

  try {
    const buffer = await sftp.get(remotePath);
    const raw = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);

    const content = remotePath.toLowerCase().endsWith('.zip')
      ? extractEntry(raw, zipEntry)
      : raw.toString('utf8');

    // Find and emit the header line
    let pos = 0;
    const firstNewline = content.indexOf('\n', pos);
    if (firstNewline === -1) throw new Error('Catalog file has no newlines — possibly corrupt or wrong format.');
    const headerLine = content.slice(0, firstNewline).replace(/\r$/, '');
    onHeader(headerLine);
    pos = firstNewline + 1;

    // Iterate rows without building an array
    while (pos < content.length) {
      const nextNewline = content.indexOf('\n', pos);
      const end = nextNewline === -1 ? content.length : nextNewline;
      const line = content.slice(pos, end).replace(/\r$/, '').trim();
      pos = end + 1;

      if (!line) continue;
      if (onRow(line) === false) break;
    }
  } finally {
    await sftp.end().catch(() => {});
  }
}

/**
 * List entries inside the remote ZIP without extracting content. Useful for debugging.
 */
async function listZipEntries() {
  const { remotePath } = config.synnex.sftp;
  const sftp = await connectSftp();
  try {
    const buffer = await sftp.get(remotePath);
    const raw = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
    const zip = new AdmZip(raw);
    return zip.getEntries().map(e => ({
      name: e.entryName,
      size: e.header.size,
      isDirectory: e.isDirectory,
    }));
  } finally {
    await sftp.end().catch(() => {});
  }
}

module.exports = { streamCatalogLines, listZipEntries };
