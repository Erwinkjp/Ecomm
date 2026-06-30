#!/usr/bin/env bash
# Deploy the Synnex→Shopify sync Lambda to AWS.
#
# Usage:
#   source .env && ./deploy.sh

set -euo pipefail
cd "$(dirname "$0")"

# Clear any stale session token — long-term IAM keys must not have a session token set
unset AWS_SESSION_TOKEN

# ── Required ──────────────────────────────────────────────────────────────────
: "${SHOPIFY_CLIENT_ID:?Set SHOPIFY_CLIENT_ID in .env}"
: "${SHOPIFY_CLIENT_SECRET:?Set SHOPIFY_CLIENT_SECRET in .env}"
: "${SYNNEX_XML_CUSTOMER_NO:?Set SYNNEX_XML_CUSTOMER_NO in .env}"
: "${SYNNEX_XML_USERNAME:?Set SYNNEX_XML_USERNAME in .env}"
: "${SYNNEX_XML_PASSWORD:?Set SYNNEX_XML_PASSWORD in .env}"

# ── Build parameter string for samconfig (shlex-quoted so spaces work) ────────
PARAMS_STRING="$(python3 - <<'PYEOF'
import os, shlex

def add(key, env, required=False, always=False):
    val = os.environ.get(env, "").strip()
    if not val:
        if required:
            raise ValueError(f"Missing required env var: {env}")
        # always=True forces the empty value through so CloudFormation clears it
        return f"{key}=''" if always else None
    # shlex.quote wraps the value in single quotes if it contains spaces/commas
    return f"{key}={shlex.quote(val)}"

parts = [
    add("ShopifyClientId",        "SHOPIFY_CLIENT_ID",       required=True),
    add("ShopifyClientSecret",    "SHOPIFY_CLIENT_SECRET",   required=True),
    # Force client_credentials auth: clear the static token so getAccessToken() always mints
    # a fresh token from CLIENT_ID/SECRET. Never goes stale, auto-includes newly-released
    # scopes, and removes the need to ever manually swap SHOPIFY_ACCESS_TOKEN on scope changes.
    "ShopifyAccessToken=''",
    add("SynnexXmlCustomerNo",    "SYNNEX_XML_CUSTOMER_NO",  required=True),
    add("SynnexXmlUsername",      "SYNNEX_XML_USERNAME",     required=True),
    add("SynnexXmlPassword",      "SYNNEX_XML_PASSWORD",     required=True),
    add("PriceMarkupPercent",     "PRICE_MARKUP_PERCENT"),
    add("PriceMinActive",         "PRICE_MIN_ACTIVE"),
    add("JunkMaxPrice",           "JUNK_MAX_PRICE"),
    add("ShopifyStore",           "SHOPIFY_STORE"),
    add("ShopifyLocationId",      "SHOPIFY_LOCATION_ID"),
    add("SynnexSftpUsername",     "SYNNEX_SFTP_USERNAME"),
    add("SynnexSftpRemotePath",   "SYNNEX_SFTP_REMOTE_PATH"),
    add("SynnexSftpPassword",     "SYNNEX_SFTP_PASSWORD"),
    add("SynnexSftpSecretArn",    "SYNNEX_SFTP_SECRET_ARN"),
    add("SynnexSftpZipEntry",     "SYNNEX_SFTP_ZIP_ENTRY"),
    add("SynnexSyncFilterBrands",     "SYNNEX_SYNC_FILTER_BRANDS",     always=True),
    add("SynnexSyncFilterCategories", "SYNNEX_SYNC_FILTER_CATEGORIES", always=True),
    add("SynnexSyncAllowlist",    "SYNNEX_SYNC_ALLOWLIST",    always=True),
    add("SynnexSyncLimit",        "SYNNEX_SYNC_LIMIT",        always=True),
    add("IcecatUsername",         "ICECAT_USERNAME"),
    add("IcecatAppKey",           "ICECAT_APP_KEY",          always=True),
    add("FedExClientId",          "FEDEX_CLIENT_ID"),
    add("FedExClientSecret",      "FEDEX_CLIENT_SECRET"),
    add("FedExAccountNumber",     "FEDEX_ACCOUNT_NUMBER"),
    add("UpsClientId",            "UPS_CLIENT_ID"),
    add("UpsClientSecret",        "UPS_CLIENT_SECRET"),
    add("ShippingFreightBufferPct", "SHIPPING_FREIGHT_BUFFER_PCT"),
    add("ShippingHandlingFee",      "SHIPPING_HANDLING_FEE"),
    add("SynnexOrderUrl",         "SYNNEX_ORDER_URL"),
    add("SynnexOrderStatusUrl",   "SYNNEX_ORDER_STATUS_URL"),
    add("SynnexRmaUrl",           "SYNNEX_RMA_URL",          always=True),
    add("SynnexRmaStatusUrl",     "SYNNEX_RMA_STATUS_URL",   always=True),
]

print(" ".join(p for p in parts if p))
PYEOF
)"

# ── Write a temp samconfig so SAM reads params from file (not CLI args) ───────
SAMCONFIG="$(mktemp /tmp/samconfig-XXXXXX.toml)"
trap 'rm -f "$SAMCONFIG"' EXIT

cat > "$SAMCONFIG" <<TOML
version = 0.1

[default.global.parameters]
region = "us-east-1"

[default.deploy.parameters]
stack_name         = "synnex-shopify-sync"
resolve_s3         = true
s3_prefix          = "synnex-shopify-sync"
confirm_changeset  = false
capabilities       = "CAPABILITY_IAM"
disable_rollback   = false
parameter_overrides = "${PARAMS_STRING}"
TOML

echo "Parameters loaded. Building..."

# ── Build & Deploy ────────────────────────────────────────────────────────────
sam build

sam deploy --config-file "$SAMCONFIG"

# ── Re-register Shopify webhooks after every deploy ───────────────────────────
# Shopify auto-disables webhooks on repeated delivery failures (e.g. during redeploys).
# Re-registering after each deploy keeps them alive. Existing webhooks for the same
# topic+address are returned as-is; this is idempotent.
echo "Re-registering Shopify webhooks..."
LAMBDA_URL=$(aws cloudformation describe-stacks \
  --stack-name synnex-shopify-sync \
  --query "Stacks[0].Outputs[?OutputKey=='ApiBaseUrl'].OutputValue" \
  --output text --region us-east-1 2>/dev/null)

if [ -n "$LAMBDA_URL" ] && [ -n "$SHOPIFY_STORE" ] && [ -n "$SHOPIFY_ACCESS_TOKEN" ]; then
  node - <<JSEOF
const https = require('https');
const store = '${SHOPIFY_STORE}';
const token = '${SHOPIFY_ACCESS_TOKEN}';
const base  = '${LAMBDA_URL}';
const hooks = [
  ['orders/paid',      '/webhook/orders'],
  ['orders/cancelled', '/webhook/orders-cancelled'],
  ['refunds/create',   '/webhook/refunds'],
  ['returns/request',  '/webhook/returns'],
  ['returns/approve',  '/webhook/returns'],
];
(async () => {
  for (const [topic, path] of hooks) {
    await new Promise((res, rej) => {
      const body = JSON.stringify({ webhook: { topic, address: base + path, format: 'json' } });
      const req = https.request({
        hostname: store + '.myshopify.com',
        path: '/admin/api/2026-01/webhooks.json', method: 'POST',
        headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
      }, r => { let d=''; r.on('data',c=>d+=c); r.on('end',()=>{ const j=JSON.parse(d); console.log(j.webhook ? '  ✓ '+j.webhook.topic : '  already exists: '+topic); res(); }); });
      req.on('error', rej); req.write(body); req.end();
    });
  }
})();
JSEOF
else
  echo "  Skipped (SHOPIFY_STORE or SHOPIFY_ACCESS_TOKEN not set)"
fi
