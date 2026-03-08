# Synnex → Shopify Sync (AWS Lambda)

AWS Lambda application that syncs **product data** and **inventory** from **TD Synnex** to **Shopify**. It can run on a schedule (e.g. hourly) or be invoked on demand via API Gateway or direct invocation.

## Features

- **TD Synnex**: Fetches products and price/availability from TD Synnex REST APIs (configurable base URL and paths).
- **Shopify**: Uses Admin GraphQL API — `productSet` for product create/update and `inventorySetQuantities` for stock levels.
- **Sync modes**:
  - Full sync: create/update products in Shopify and set inventory.
  - Inventory-only: update quantities for existing products by SKU.

## Prerequisites

- **TD Synnex**: EC Express account and API access (e.g. Price & Availability API). Request access via helpdeskus@tdsynnex.com if needed.
- **Shopify**: Store with Admin API access token scopes `write_products` and `write_inventory`, and a location ID for inventory.
- **Node.js 20+** and **AWS SAM CLI** for build/deploy.

## Environment variables

| Variable | Required | Description |
|----------|----------|-------------|
| `SHOPIFY_STORE` | Yes | Store hostname (e.g. `your-store` from `your-store.myshopify.com`) |
| `SHOPIFY_ACCESS_TOKEN` | Yes | Admin API access token |
| `SHOPIFY_LOCATION_ID` | Yes | Location GID for inventory (e.g. `gid://shopify/Location/123456`) |
| `SYNNEX_API_KEY` | Yes | TD Synnex API key |
| `SYNNEX_BASE_URL` | No | Default `https://api.synnex.com` (override for sandbox) |
| `SYNNEX_PRODUCTS_PATH` | No | Products endpoint path (default `/v1/products`) |
| `SYNNEX_PRICE_AVAILABILITY_PATH` | No | Price/availability path (default `/v1/price-availability`) |
| `SHOPIFY_API_VERSION` | No | GraphQL API version (default `2025-01`) |

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

## TD Synnex API notes

Exact REST paths and response shapes can differ by region and product. The client assumes:

- **Products**: GET (or POST) returning an array or `{ products }` / `{ data }`.
- **Price & Availability**: POST with `{ partNumbers: string[] }`, returning an array of `{ partNumber, quantityAvailable, price?, currency? }`.

Adjust `SYNNEX_PRODUCTS_PATH` and `SYNNEX_PRICE_AVAILABILITY_PATH` in `src/synnex/client.js` to match your TD Synnex API contract. Use sandbox credentials and `SYNNEX_BASE_URL` for testing.

## Shopify API notes

- **productSet**: Creates or updates a product; we use Synnex part number as SKU and derive handle from it.
- **inventorySetQuantities**: Sets absolute inventory at a location; we use `ignoreCompareQuantity: true` for source-of-truth sync. For high concurrency, consider using compare-and-set (see Shopify docs).

## License

MIT
