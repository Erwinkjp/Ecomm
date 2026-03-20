/**
 * Load optional allowlist of part numbers (SKUs) to sync. If set, only these are synced.
 * Env: SYNNEX_SYNC_ALLOWLIST (comma-separated) or SYNNEX_SYNC_ALLOWLIST_S3_BUCKET + SYNNEX_SYNC_ALLOWLIST_S3_KEY (file, one part number per line).
 * Returns Set of part numbers, or null if no allowlist configured (sync all).
 */
async function loadAllowlist() {
  const listEnv = process.env.SYNNEX_SYNC_ALLOWLIST;
  if (listEnv && listEnv.trim()) {
    const set = new Set(
      listEnv
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    );
    return set.size > 0 ? set : null;
  }

  const bucket = process.env.SYNNEX_SYNC_ALLOWLIST_S3_BUCKET;
  const key = process.env.SYNNEX_SYNC_ALLOWLIST_S3_KEY;
  if (bucket && key) {
    const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3');
    const client = new S3Client({});
    const res = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    const chunks = [];
    for await (const chunk of res.Body) chunks.push(chunk);
    const text = Buffer.concat(chunks).toString('utf-8');
    const set = new Set(
      text
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter(Boolean)
    );
    return set.size > 0 ? set : null;
  }

  return null;
}

module.exports = { loadAllowlist };
