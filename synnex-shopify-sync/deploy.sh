#!/usr/bin/env bash
# Deploy stack. Secrets are read from the environment (not committed).
# Usage:
#   export SHOPIFY_CLIENT_ID=...
#   export SHOPIFY_CLIENT_SECRET=...
#   ./deploy.sh
#
# Optional: SHOPIFY_STORE (default uniwide-merchandise), SHOPIFY_LOCATION_ID (default gid from your Locations URL)
# Optional: SYNNEX_SFTP_PASSWORD — passed to SynnexSftpPassword (TD Synnex SFTP; host/user/path default in template.yaml)
set -euo pipefail
cd "$(dirname "$0")"

: "${SHOPIFY_CLIENT_ID:?Set SHOPIFY_CLIENT_ID (Dev Dashboard → Credentials → Client ID)}"
: "${SHOPIFY_CLIENT_SECRET:?Set SHOPIFY_CLIENT_SECRET (Dev Dashboard → Credentials → Client secret)}"

SHOPIFY_STORE="${SHOPIFY_STORE:-uniwide-merchandise}"
SHOPIFY_LOCATION_ID="${SHOPIFY_LOCATION_ID:-gid://shopify/Location/90596933875}"
SYNNEX_SFTP_PASSWORD="${SYNNEX_SFTP_PASSWORD:-}"

sam build
sam deploy --no-confirm-changeset \
  --parameter-overrides \
  "ShopifyStore=${SHOPIFY_STORE}" \
  "ShopifyClientId=${SHOPIFY_CLIENT_ID}" \
  "ShopifyClientSecret=${SHOPIFY_CLIENT_SECRET}" \
  "ShopifyLocationId=${SHOPIFY_LOCATION_ID}" \
  "SynnexSftpPassword=${SYNNEX_SFTP_PASSWORD}"
