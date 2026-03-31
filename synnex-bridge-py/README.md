# Shopify ↔ TD Synnex bridge (Python / SAM)

This stack implements the phased bridge: **Synnex ingest → DynamoDB → Shopify** (Phase 1), **Shopify webhooks → SQS → PO** (Phase 2), and **invoice metadata → order metafields** (Phase 3).

## Layout

- `src/bridge/synnex/` — XML P&A client and order/invoice REST stubs (replace with your account’s APIs).
- `src/bridge/shopify/` — Admin GraphQL helpers.
- `src/bridge/ddb/` — DynamoDB repositories (products, sync state, outbox, orders).
- `src/bridge/sync/` — Orchestration (ingest, Shopify worker, PO status, invoice sync).
- `src/handlers/` — Lambda entry points.
- `template.yaml` — DynamoDB tables, HTTP API webhook, SQS, scheduled Lambdas.

## Build

Runtime is **python3.12**. Build requires Python 3.12 on your PATH, or Docker:

```bash
sam build
# or
sam build --use-container
```

## Deploy

Provide Shopify and Synnex parameters (see `template.yaml` Parameters). Example:

```bash
sam deploy --guided
```

Register the **WebhookUrl** output in Shopify (e.g. `orders/paid`) using the same secret as `ShopifyWebhookParameter`. Phase 2/3 REST URLs (`SynnexPoBaseUrl`, `SynnexInvoiceBaseUrl`) are optional until you wire real endpoints.

The legacy Node stack lives in `../synnex-shopify-sync/`; see `DEPRECATED.md` there for cutover notes.
