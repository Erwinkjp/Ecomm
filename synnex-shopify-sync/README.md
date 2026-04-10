# Synnex → Shopify Sync (AWS Lambda)

AWS Lambda application that syncs **product data** and **inventory** from **TD Synnex** to **Shopify**. It can run on a schedule (e.g. hourly) or be invoked on demand via API Gateway or direct invocation.

## Features

- **TD Synnex** data source (first match wins):
  1. **Real-time XML P&A** — when `SYNNEX_XML_*` is fully set; US prod: `https://ec.us.tdsynnex.com/SynnexXML/PriceAvailability` (price + qty) or `.../SynnexXML/Availability` (qty only); uses Shopify variant SKUs as part numbers.
  2. **Flat file** — CSV (S3, URL, or SFTP).
  3. **REST API** — Partner JSON when XML is not configured and no file source is configured (paths from OpenAPI).
- **Shopify**: Admin GraphQL — `productSet` for product create/update and `inventorySetQuantities` for stock levels.
- **Sync modes**:
  - Full sync: create/update products in Shopify and set inventory.
  - Inventory-only: `syncProducts: false` — update quantities for existing SKUs only.

## Prerequisites

- **TD Synnex**: EC Express account and API access (e.g. Price & Availability API). Request access via helpdeskus@tdsynnex.com if needed.
- **Shopify**: Dev Dashboard app — **Client ID** and **Client secret** ([client credentials](https://shopify.dev/docs/apps/build/dev-dashboard/get-api-access-tokens)); Admin API scopes for products and inventory; a **location ID** for stock updates.
- **Node.js 22+** and **AWS SAM CLI** for build/deploy.

## Environment variables

**Shopify:**

| Variable | Required | Description |
|----------|----------|-------------|
| `SHOPIFY_STORE` | Yes | Store hostname (e.g. `your-store` from `your-store.myshopify.com`) |
| `SHOPIFY_CLIENT_ID` | Yes | Dev Dashboard → app → **Settings** → **Credentials** → Client ID |
| `SHOPIFY_CLIENT_SECRET` | Yes | Same place → Client secret |
| `SHOPIFY_LOCATION_ID` | Yes | Location GID for inventory (e.g. `gid://shopify/Location/123456`) |

The Lambda uses Shopify’s [client credentials grant](https://shopify.dev/docs/apps/build/dev-dashboard/get-api-access-tokens): it exchanges the Client ID and secret for a session (refreshed automatically before expiry).

**Synnex — REST API** (default if no file source is configured):

Authentication — use **one** of:

| Variable | Required | Description |
|----------|----------|-------------|
| `SYNNEX_OAUTH_CLIENT_ID` + `SYNNEX_OAUTH_CLIENT_SECRET` | Recommended | Partner API **OAuth2 client credentials** from TD Synnex (same app as OpenAPI “Authentication”). The Lambda calls `SYNNEX_TOKEN_URL`, caches the bearer, and refreshes before expiry — **you do not log in by hand**. |
| `SYNNEX_TOKEN_URL` | No | Default `https://sso.us.tdsynnex.com/oauth2/v1/token`. For Canada SSO use your spec’s CA host (e.g. `https://sso.ca.tdsynnex.com/oauth2/v1/token`). |
| `SYNNEX_OAUTH_SCOPE` | No | Set only if your token endpoint requires a `scope` field. |
| `SYNNEX_API_KEY` | Legacy | Static key mode: same value as Bearer + `x-api-key`. Omit when using OAuth. |

| Variable | Required | Description |
|----------|----------|-------------|
| `SYNNEX_BASE_URL` | No | API host (e.g. `https://api.us.tdsynnex.com` production US; default `https://api.synnex.com`) |
| `SYNNEX_PRODUCTS_PATH` | Often yes | **GET** path from your OpenAPI, including leading `/` (e.g. `/api/v1/...`). `https://api.us.tdsynnex.com` does **not** expose `/v1/products`. The Partner portal “Endpoints” page often lists **orders/invoices only** — catalog feeds live under another operation in the same OpenAPI JSON. |
| `SYNNEX_PRICE_AVAILABILITY_PATH` | Often yes | **POST** path for price/availability from OpenAPI (default `/v1/price-availability` is often wrong on US Partner API). |

**Synnex — real-time XML P&A** (used when **all** of the following are set; **takes priority** over flat file and REST):

| Variable | Required | Description |
|----------|----------|-------------|
| `SYNNEX_XML_URL` | Yes | Default in SAM: `https://ec.us.tdsynnex.com/SynnexXML/PriceAvailability`. For **availability only**, use `https://ec.us.tdsynnex.com/SynnexXML/Availability`. |
| `SYNNEX_XML_CUSTOMER_NO` | Yes | Customer number from TD Synnex |
| `SYNNEX_XML_USERNAME` | Yes | XML service username |
| `SYNNEX_XML_PASSWORD` | Yes | XML service password |
| `SYNNEX_XML_REQUEST_VERSION` | No | e.g. `2.3` on `<priceRequest>` for mfg P/N style calls (per TD Synnex spec) |
| `SYNNEX_XML_LIST_BY` | No | `synnexSKU` (default) or `mfgPN` — which tag is used inside each `<skuList>` |
| `SYNNEX_XML_SKU_CHUNK_SIZE` | No | SKUs per request (default `40`, max `200`) |
| `SYNNEX_XML_SYNC_PRICES` | No | `true` (default): update Shopify variant prices from XML; `false`: inventory only |
| `SYNNEX_XML_MSRP_AS_COMPARE_AT` | No | `true`: map MSRP/list tags to compare-at price when present |

Request/response tag names may need to match your official XML spec (`src/synnex/xmlClient.js`). Contact **XMLGROUP@TDSYNNEX.COM** for the exact schema if responses are empty or errors occur.

**Synnex — Flat file** (set **either** S3 or URL):

| Variable | Description |
|----------|-------------|
| `SYNNEX_FILE_S3_BUCKET` | S3 bucket containing the file (use with `SYNNEX_FILE_S3_KEY`) |
| `SYNNEX_FILE_S3_KEY` | S3 object key |
| `SYNNEX_FILE_URL` | Or: URL to fetch the file (e.g. pre-signed or internal) |
| `SYNNEX_FILE_FORMAT` | Do not set to `xml` — XML content is rejected. Use delimited flat files only. |
| `SYNNEX_FILE_DELIMITER` | Optional; default `,` (flat only) |
| `SYNNEX_FILE_HAS_HEADER` | Optional; default `true` |
| `SYNNEX_COL_PART_NUMBER`, `SYNNEX_COL_QTY`, `SYNNEX_COL_PRICE`, etc. | Column names if different from default |

**Synnex — SFTP** (ZIP or flat file; checked before S3/URL):

| Variable | Description |
|----------|-------------|
| `SYNNEX_SFTP_HOST` | SFTP host (e.g. `sftp.us.tdsynnex.com`) |
| `SYNNEX_SFTP_PORT` | Optional; default `22` |
| `SYNNEX_SFTP_USERNAME` | SFTP username |
| `SYNNEX_SFTP_REMOTE_PATH` | Remote file path (e.g. `/698655.zip` or `/synnex-products-77112023.zip`) |
| `SYNNEX_SFTP_PASSWORD` | SFTP password (prefer `SYNNEX_SFTP_SECRET_ARN` in production) |
| `SYNNEX_SFTP_SECRET_ARN` | Optional; Secrets Manager secret ARN with a `password` key (overrides `SYNNEX_SFTP_PASSWORD`) |

When the remote path is a `.zip`, the Lambda prefers `.csv`, then `.txt`, then a non-`.xml` entry (flat/CSV content only).

**Sync allowlist (only sync a subset of products):**

If you have a large catalog (e.g. millions of products) and only want a subset on Shopify, set one of:

| Variable | Description |
|----------|-------------|
| `SYNNEX_SYNC_ALLOWLIST` | Comma-separated part numbers (SKUs). Only these are synced. |
| `SYNNEX_SYNC_ALLOWLIST_S3_BUCKET` + `SYNNEX_SYNC_ALLOWLIST_S3_KEY` | S3 file with one part number per line. Use for large lists (e.g. 100k+ SKUs). |

When set, the sync **only** creates/updates products whose part number is in the allowlist. Leave both unset to sync all products from the source.

**Filter by brand or category (only sync certain items):**

| Variable | Description |
|----------|-------------|
| `SYNNEX_SYNC_FILTER_BRANDS` | Comma-separated brand/manufacturer names. Only products whose manufacturer (or brand) matches one of these are synced. Case-insensitive. |
| `SYNNEX_SYNC_FILTER_CATEGORIES` | Comma-separated category names. Only products whose category matches one of these are synced. Case-insensitive. |

If both are set, a product must match **both** a brand and a category to be synced. Items must expose `manufacturer`/`brand` and `category` (REST and flat-file rows supply these columns).

**Other:** `SHOPIFY_API_VERSION` (default `2025-01`).

## Build and run locally

```bash
cd synnex-shopify-sync
npm install
```

Create a `.env` (or set env vars) and run the handler locally:

```bash
# Optional: use dotenv or export vars
export SHOPIFY_STORE=your-store
export SHOPIFY_CLIENT_ID=your-client-id
export SHOPIFY_CLIENT_SECRET=your-client-secret
export SHOPIFY_LOCATION_ID="gid://shopify/Location/123456"
# TD Synnex Partner API (OAuth — recommended)
export SYNNEX_OAUTH_CLIENT_ID=...
export SYNNEX_OAUTH_CLIENT_SECRET=...
# export SYNNEX_TOKEN_URL=https://sso.us.tdsynnex.com/oauth2/v1/token
export SYNNEX_BASE_URL=https://api.us.tdsynnex.com

# Invoke with SAM (uses events/sync.json)
npm run invoke
```

Or run with a custom event (e.g. inventory-only, limit 5):

```bash
echo '{"syncProducts":false,"limit":5}' > events/custom.json
sam local invoke SynnexShopifySyncFunction --event events/custom.json
```

## Deploy with AWS SAM

1. Build:

   ```bash
   npm run package
   ```

2. Deploy (first time use `--guided` to set stack name, region, and parameter overrides):

   ```bash
   sam deploy --guided
   ```

   You will be prompted for:

   - `ShopifyStore`, `ShopifyClientId`, `ShopifyClientSecret`, `ShopifyLocationId`
   - `SynnexOAuthClientId`, `SynnexOAuthClientSecret` (optional `SynnexTokenUrl`, `SynnexBaseUrl`, paths) — or legacy `SynnexApiKey`
   - For **XML P&A**: `SynnexXmlUrl` (defaults to PriceAvailability US), `SynnexXmlCustomerNo`, `SynnexXmlUsername`, `SynnexXmlPassword`, optional chunk/version/price flags

   Example (Partner API OAuth):

   ```bash
   sam deploy --parameter-overrides \
     ShopifyStore=your-store \
     ShopifyClientId=your-client-id \
     ShopifyClientSecret=your-client-secret \
     ShopifyLocationId="gid://shopify/Location/123456" \
     SynnexOAuthClientId=your-synnex-oauth-client-id \
     SynnexOAuthClientSecret=your-synnex-oauth-secret \
     SynnexBaseUrl=https://api.us.tdsynnex.com \
     SynnexProductsPath=/api/v1/YOUR_CATALOG_PATH_FROM_OPENAPI \
     SynnexPriceAvailabilityPath=/api/v1/YOUR_PRICE_PATH_FROM_OPENAPI
   ```

3. After deploy, the function runs on the **schedule** defined in `template.yaml` (default: `rate(1 hour)`). Change or disable it under `Events.ScheduleSync` if needed.

## Lambda event payload

- **Scheduled (EventBridge)**: No body; runs full sync with default options.
- **Direct / API Gateway**:
  - `syncProducts` (boolean, default `true`): create/update products from Synnex.
  - `limit` (number, optional): max products to process in one run.

Example:

```json
{
  "syncProducts": true,
  "limit": 50
}
```

## Project structure

```
synnex-shopify-sync/
├── src/
│   ├── index.js           # Lambda handler
│   ├── synnex/
│   │   └── client.js       # TD Synnex REST client
│   ├── shopify/
│   │   └── client.js       # Shopify GraphQL (productSet, inventorySetQuantities)
│   └── sync/
│       ├── sync.js         # Sync orchestration
│       └── transform.js    # Synnex → Shopify mapping
├── events/
│   └── sync.json          # Sample event for local invoke
├── template.yaml          # AWS SAM template
└── package.json
```

## TD Synnex data sources

- **Real-time XML P&A**: When fully configured, this source runs **before** flat file or REST. Production US endpoints above (`PriceAvailability` vs `Availability`). Sync loads **all variant SKUs from Shopify**, queries Synnex in chunks, then updates inventory (and optionally prices).
- **Flat file**: Delimited CSV only (not bulk XML files). Used when XML is **not** configured.
- **REST API**: Partner JSON when neither XML nor a file source is configured; requires correct `SYNNEX_PRODUCTS_PATH` / `SYNNEX_PRICE_AVAILABILITY_PATH` from OpenAPI when available.

### Keeping file data from going stale

- Upload new flat files on a schedule to a fixed S3 key, or trigger the Lambda on S3 `ObjectCreated`, or align EventBridge schedule with your file drop cadence.

## Shopify API notes

- **productSet**: Creates or updates a product; we use Synnex part number as SKU and derive handle from it.
- **inventorySetQuantities**: Sets absolute inventory at a location; we use `ignoreCompareQuantity: true` for source-of-truth sync. For high concurrency, consider using compare-and-set (see Shopify docs).

## License

MIT
