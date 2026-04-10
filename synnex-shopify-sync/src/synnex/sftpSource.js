/**
 * TD Synnex SFTP source: connect to SFTP, download file (ZIP or flat text), return content.
 * Set SYNNEX_SFTP_HOST, SYNNEX_SFTP_USERNAME, SYNNEX_SFTP_REMOTE_PATH, and either
 * SYNNEX_SFTP_PASSWORD or SYNNEX_SFTP_SECRET_ARN (Secrets Manager secret with "password" key).
 */
async function getSftpPassword() {
  const secretArn = process.env.SYNNEX_SFTP_SECRET_ARN;
  if (secretArn) {
    const { SecretsManagerClient, GetSecretValueCommand } = require('@aws-sdk/client-secrets-manager');
    const client = new SecretsManagerClient({});
    const res = await client.send(new GetSecretValueCommand({ SecretId: secretArn }));
    const raw = res.SecretString;
    if (!raw) throw new Error('SFTP secret has no SecretString');
    const parsed = JSON.parse(raw);
    return parsed.password || parsed.SYNNEX_SFTP_PASSWORD || raw;
  }
  const password = process.env.SYNNEX_SFTP_PASSWORD;
  if (password) return password;
  throw new Error('Set SYNNEX_SFTP_PASSWORD or SYNNEX_SFTP_SECRET_ARN for SFTP source');
}

/**
 * Download remote file via SFTP and return its content as a string.
 * If the remote path is a .zip, extracts a data file (CSV preferred, then TXT; see code order).
 */
async function getFileContentFromSftp() {
  const SftpClient = require('ssh2-sftp-client');
  const host = process.env.SYNNEX_SFTP_HOST;
  const username = process.env.SYNNEX_SFTP_USERNAME;
  const remotePath = process.env.SYNNEX_SFTP_REMOTE_PATH;
  const port = parseInt(process.env.SYNNEX_SFTP_PORT || '22', 10);

  if (!host || !username || !remotePath) {
    throw new Error('Set SYNNEX_SFTP_HOST, SYNNEX_SFTP_USERNAME, and SYNNEX_SFTP_REMOTE_PATH for SFTP source');
  }

  const password = await getSftpPassword();
  const sftp = new SftpClient();

  try {
    await sftp.connect({ host, port, username, password });
    const data = await sftp.get(remotePath);
    const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);

    const isZip = remotePath.toLowerCase().endsWith('.zip');
    if (isZip) {
      const AdmZip = require('adm-zip');
      let zip = new AdmZip(buffer);
      let entries = zip.getEntries().filter((e) => !e.isDirectory);

      // If the only entry is a nested .zip (e.g. TD Synnex sends zip-in-zip), open it and use inner contents
      if (entries.length === 1 && entries[0].entryName.toLowerCase().endsWith('.zip')) {
        zip = new AdmZip(entries[0].getData());
        entries = zip.getEntries().filter((e) => !e.isDirectory);
      }

      const files = entries.map((e) => e.entryName);
      const list = files.length ? files.join(', ') : '(empty)';

      // Optional: use exact entry name from env (e.g. "data/export.csv")
      const exactEntry = process.env.SYNNEX_SFTP_ZIP_ENTRY?.trim();
      if (exactEntry) {
        const entry = entries.find((e) => e.entryName === exactEntry);
        if (entry) return entry.getData().toString('utf8');
        throw new Error(`ZIP entry "${exactEntry}" not found. ZIP contains: ${list}`);
      }

      // Otherwise: CSV, then TXT, then first non-.xml file, else first entry (flat/CSV only downstream)
      const lower = (n) => n.toLowerCase();
      const dataEntry =
        entries.find((e) => lower(e.entryName).endsWith('.csv')) ||
        entries.find((e) => lower(e.entryName).endsWith('.txt')) ||
        entries.find((e) => !lower(e.entryName).endsWith('.xml')) ||
        entries[0];
      if (!dataEntry) throw new Error(`No data file found in ZIP. ZIP contains: ${list}`);
      return dataEntry.getData().toString('utf8');
    }

    return buffer.toString('utf8');
  } finally {
    await sftp.end();
  }
}

/**
 * Connect to SFTP, download the zip, and return only the list of entries (name + size).
 * Does not read file contents — use this to see what's inside the zip without opening it locally.
 */
async function listZipEntriesFromSftp() {
  const SftpClient = require('ssh2-sftp-client');
  const host = process.env.SYNNEX_SFTP_HOST;
  const username = process.env.SYNNEX_SFTP_USERNAME;
  const remotePath = process.env.SYNNEX_SFTP_REMOTE_PATH;
  const port = parseInt(process.env.SYNNEX_SFTP_PORT || '22', 10);

  if (!host || !username || !remotePath) {
    throw new Error('Set SYNNEX_SFTP_HOST, SYNNEX_SFTP_USERNAME, and SYNNEX_SFTP_REMOTE_PATH');
  }

  const password = await getSftpPassword();
  const sftp = new SftpClient();

  try {
    await sftp.connect({ host, port, username, password });
    const data = await sftp.get(remotePath);
    const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);

    if (!remotePath.toLowerCase().endsWith('.zip')) {
      return { remotePath, isZip: false, entries: [], message: 'Remote file is not a .zip' };
    }

    const AdmZip = require('adm-zip');
    const zip = new AdmZip(buffer);
    const entries = zip.getEntries().filter((e) => !e.isDirectory).map((e) => ({
      name: e.entryName,
      size: e.header?.size ?? e.header?.compressedSize ?? 0,
    }));
    return { remotePath, isZip: true, entries };
  } finally {
    await sftp.end();
  }
}

function isSftpConfigured() {
  const host = process.env.SYNNEX_SFTP_HOST;
  const username = process.env.SYNNEX_SFTP_USERNAME;
  const path = process.env.SYNNEX_SFTP_REMOTE_PATH;
  const hasCreds = process.env.SYNNEX_SFTP_PASSWORD || process.env.SYNNEX_SFTP_SECRET_ARN;
  return !!(host && username && path && hasCreds);
}

module.exports = {
  getFileContentFromSftp,
  listZipEntriesFromSftp,
  isSftpConfigured,
};
