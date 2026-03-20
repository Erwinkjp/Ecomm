# Synnex → Shopify Sync (AWS Lambda)

AWS Lambda application that syncs **product data** and **inventory** from **TD Synnex** to **Shopify**. It can run on a schedule (e.g. hourly) or be invoked on demand via API Gateway or direct invocation.

## Features

- **TD Synnex** data source (one of):
  - **SFTP**: Download ZIP/XML from TD Synnex SFTP (e.g. nightly Price & Availability file); extract in Lambda and sync.
  - **REST API**: Products + price/availability endpoints (when available).
  - **Flat file**: Price & Availability or Hourly Inventory flat file from S3 or URL.
  - **Real-Time XML**: XML Price & Availability service; part numbers = Shopify product SKUs (inventory-only sync).
- **Shopify**: Uses Admin GraphQL API — `productSet` for product create/update and `inventorySetQuantities` for stock levels.
- **Sync modes**:
  - Full sync: create/update products in Shopify and set inventory (REST or file source).
  - Inventory-only: update quantities for existing products by SKU (all sources; XML is inventory-only by design).

## Prerequisites

- **TD Synnex**: EC Express account and API access (e.g. Price & Availability API). Request access via helpdeskus@tdsynnex.com if needed.
- **Shopify**: Store with Admin API access token scopes `write_products` and `write_inventory`, and a location ID for inventory.
- **Node.js 22+** and **AWS SAM CLI** for build/deploy.

## Environment variables

**Shopify (always):**

| Variable | Required | Description |
|----------|----------|-------------|
| `SHOPIFY_STORE` | Yes | Store hostname (e.g. `your-store` from `your-store.myshopify.com`) |
| `SHOPIFY_ACCESS_TOKEN` | Yes | Admin API access token |
| `SHOPIFY_LOCATION_ID` | Yes | Location GID for inventory (e.g. `gid://shopify/Location/123456`) |

**Synnex — REST API** (default if no file/XML configured):

| Variable | Required | Description |
|----------|----------|-------------|
| `SYNNEX_API_KEY` | Yes* | TD Synnex API key |
| `SYNNEX_BASE_URL` | No | Default `https://api.synnex.com` |
| `SYNNEX_PRODUCTS_PATH` | No | Products path (default `/v1/products`) |
| `SYNNEX_PRICE_AVAILABILITY_PATH` | No | Price/availability path |

**Synnex — Flat file** (set **either** S3 or URL):

| Variable | Description |
|----------|-------------|
| `SYNNEX_FILE_S3_BUCKET` | S3 bucket containing the file (use with `SYNNEX_FILE_S3_KEY`) |
| `SYNNEX_FILE_S3_KEY` | S3 object key |
| `SYNNEX_FILE_URL` | Or: URL to fetch the file (e.g. pre-signed or internal) |
| `SYNNEX_FILE_FORMAT` | Optional: `xml` or `flat`. Auto-detected if unset (XML when content looks like XML) |
| `SYNNEX_FILE_DELIMITER` | Optional; default `,` (flat only) |
| `SYNNEX_FILE_HAS_HEADER` | Optional; default `true` |
| `SYNNEX_COL_PART_NUMBER`, `SYNNEX_COL_QTY`, `SYNNEX_COL_PRICE`, etc. | Column names if different from default |

**Synnex — SFTP** (ZIP/XML file from TD Synnex SFTP; checked before S3/URL):

| Variable | Description |
|----------|-------------|
| `SYNNEX_SFTP_HOST` | SFTP host (e.g. `sftp.us.tdsynnex.com`) |
| `SYNNEX_SFTP_PORT` | Optional; default `22` |
| `SYNNEX_SFTP_USERNAME` | SFTP username |
| `SYNNEX_SFTP_REMOTE_PATH` | Remote file path (e.g. `/698655.zip` or `/synnex-products-77112023.zip`) |
| `SYNNEX_SFTP_PASSWORD` | SFTP password (prefer `SYNNEX_SFTP_SECRET_ARN` in production) |
| `SYNNEX_SFTP_SECRET_ARN` | Optional; Secrets Manager secret ARN with a `password` key (overrides `SYNNEX_SFTP_PASSWORD`) |

When the remote path is a `.zip`, the Lambda downloads it, extracts the first `.xml` entry in memory, and parses it with the same XML parser used for S3/URL files.

**Sync allowlist (only sync a subset of products):**

If you have a large catalog (e.g. millions of products) and only want a subset on Shopify, set one of:

| Variable | Description |
|----------|-------------|
| `SYNNEX_SYNC_ALLOWLIST` | Comma-separated part numbers (SKUs). Only these are synced. |
| `SYNNEX_SYNC_ALLOWLIST_S3_BUCKET` + `SYNNEX_SYNC_ALLOWLIST_S3_KEY` | S3 file with one part number per line. Use for large lists (e.g. 100k+ SKUs). |

When set, the sync **only** creates/updates products whose part number is in the allowlist. The XML is filtered during parse so memory stays manageable. Leave both unset to sync all products from the source.

**Filter by brand or category (only sync certain items):**

| Variable | Description |
|----------|-------------|
| `SYNNEX_SYNC_FILTER_BRANDS` | Comma-separated brand/manufacturer names. Only products whose manufacturer (or brand) matches one of these are synced. Case-insensitive. |
| `SYNNEX_SYNC_FILTER_CATEGORIES` | Comma-separated category names. Only products whose category matches one of these are synced. Case-insensitive. |

If both are set, a product must match **both** a brand and a category to be synced. The XML (or flat file) must include manufacturer and category fields; tag names are configurable with `SYNNEX_XML_MANUFACTURER_TAG` and `SYNNEX_XML_CATEGORY_TAG` (defaults: `manufacturer,brand,vendor,Mfr` and `category,cat,productCategory`). Use this when you only want particular brands or categories (e.g. "HP,Dell" or "Laptops,Monitors") instead of the full catalog.

**Synnex — Real-Time XML** (Price & Availability):

| Variable | Description |
|----------|-------------|
| `SYNNEX_XML_URL` | XML service endpoint URL (from TD Synnex XML spec) |
| `SYNNEX_XML_CUSTOMER_NO` | Customer number |
| `SYNNEX_XML_USERNAME` | Username |
| `SYNNEX_XML_PASSWORD` | Password |

When XML is configured, the sync uses **inventory-only** mode: it loads all product variant SKUs from Shopify, queries Synnex XML for price/availability for those SKUs, then updates Shopify inventory. No new products are created from XML.

*Not required when using only file or XML source.

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
export SHOPIFY_ACCESS_TOKEN=shpat_xxx
export SHOPIFY_LOCATION_ID="gid://shopify/Location/123456"
export SYNNEX_API_KEY=your-synnex-key

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

   - `ShopifyStore`, `ShopifyAccessToken`, `ShopifyLocationId`
   - `SynnexApiKey`, optionally `SynnexBaseUrl`

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

- **REST API**: Use when Synnex provides product and price/availability REST endpoints. Set `SYNNEX_API_KEY` (and optional paths).
- **Flat file**: Use when Synnex provides EDI/flat files (e.g. *Price & Availability Flat File*, *Hourly Inventory Status*). Put the file in S3 or behind a URL and set `SYNNEX_FILE_S3_BUCKET`/`SYNNEX_FILE_S3_KEY` or `SYNNEX_FILE_URL`. Match column names to the spec (env vars or edit `src/synnex/fileSource.js`).
- **XML file**: Use when you **download XML files** from the TD Synnex site (e.g. price/availability or catalog export). Set `SYNNEX_FILE_FORMAT=xml` (or rely on auto-detect) and point `SYNNEX_FILE_URL` or S3 at the file. The parser looks for `<item>` or `<product>` blocks and tags like `synnexSKU`, `qtyAvailable`, `unitPrice`; override with `SYNNEX_XML_PART_TAG`, `SYNNEX_XML_QTY_TAG`, `SYNNEX_XML_PRICE_TAG` if your XML uses different names.
- **Real-Time XML**: Use the *XML Real Time Price & Availability Query Tool*. Download the spec from the TD Synnex XML services page; set `SYNNEX_XML_URL`, `SYNNEX_XML_CUSTOMER_NO`, `SYNNEX_XML_USERNAME`, `SYNNEX_XML_PASSWORD`. The sync uses your **Shopify product SKUs** as the part-number list and updates inventory only. Request/response tag names in `src/synnex/xmlClient.js` may need to match the official spec (contact XMLGROUP@TDSYNNEX.COM if needed).

### Using downloaded XML files

1. Download the XML from the TD Synnex portal (e.g. price/availability or catalog).
2. Put the file where the Lambda can read it:
   - **S3**: Upload to a bucket and set `SYNNEX_FILE_S3_BUCKET` and `SYNNEX_FILE_S3_KEY` (e.g. `synnex-files/pa-2025-03-11.xml`). For “latest” file you can use a fixed key and overwrite it each time you upload.
   - **URL**: Host the file behind a URL (e.g. internal server or pre-signed S3 URL) and set `SYNNEX_FILE_URL`.
3. Set `SYNNEX_FILE_FORMAT=xml` (optional; XML is auto-detected if the content starts with `<?xml` or `<`).
4. Run the sync (schedule or manual). The Lambda reads the file and pushes products/inventory to Shopify.

### Keeping file data from going stale

Downloaded files are only as fresh as the last time you updated them. To keep Shopify in sync:

- **Option A — Upload on a schedule**: Use a **scheduled job** (e.g. cron on your machine, or a second Lambda + EventBridge) that logs into the TD Synnex site (or pulls from a Synnex-provided URL), downloads the XML, and uploads it to S3 (same key every time). The existing **hourly** Lambda run will then always read the latest file. So “freshness” = how often that upload runs (e.g. every 4 hours).
- **Option B — Sync when a new file lands**: Trigger the sync Lambda when a **new file** appears in S3 (S3 event → Lambda). You (or a script) upload the downloaded XML to S3; the Lambda runs once per upload and syncs that file. Data is as fresh as your last upload.
- **Option C — More frequent schedule**: If you upload the file daily, set the Lambda schedule to `rate(1 day)` so it runs after the new file is in place. If you upload every few hours, run the Lambda at the same interval.

Using **Option A or B** avoids manual steps and keeps data from going stale.

## Shopify API notes

- **productSet**: Creates or updates a product; we use Synnex part number as SKU and derive handle from it.
- **inventorySetQuantities**: Sets absolute inventory at a location; we use `ignoreCompareQuantity: true` for source-of-truth sync. For high concurrency, consider using compare-and-set (see Shopify docs).

## License

MIT
