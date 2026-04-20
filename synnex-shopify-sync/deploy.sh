#!/usr/bin/env bash
# Deploy the Synnex→Shopify sync Lambda to AWS.
#
# Usage:
#   source .env && ./deploy.sh

set -euo pipefail
cd "$(dirname "$0")"

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
    add("ShopifyAccessToken",     "SHOPIFY_ACCESS_TOKEN"),
    add("SynnexXmlCustomerNo",    "SYNNEX_XML_CUSTOMER_NO",  required=True),
    add("SynnexXmlUsername",      "SYNNEX_XML_USERNAME",     required=True),
    add("SynnexXmlPassword",      "SYNNEX_XML_PASSWORD",     required=True),
    add("PriceMarkupPercent",     "PRICE_MARKUP_PERCENT"),
    add("ShopifyStore",           "SHOPIFY_STORE"),
    add("ShopifyLocationId",      "SHOPIFY_LOCATION_ID"),
    add("SynnexSftpUsername",     "SYNNEX_SFTP_USERNAME"),
    add("SynnexSftpRemotePath",   "SYNNEX_SFTP_REMOTE_PATH"),
    add("SynnexSftpPassword",     "SYNNEX_SFTP_PASSWORD"),
    add("SynnexSftpSecretArn",    "SYNNEX_SFTP_SECRET_ARN"),
    add("SynnexSftpZipEntry",     "SYNNEX_SFTP_ZIP_ENTRY"),
    add("SynnexSyncFilterBrands",     "SYNNEX_SYNC_FILTER_BRANDS"),
    add("SynnexSyncFilterCategories", "SYNNEX_SYNC_FILTER_CATEGORIES"),
    add("SynnexSyncAllowlist",    "SYNNEX_SYNC_ALLOWLIST"),
    add("SynnexSyncLimit",        "SYNNEX_SYNC_LIMIT",  always=True),
    add("IcecatUsername",         "ICECAT_USERNAME"),
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
