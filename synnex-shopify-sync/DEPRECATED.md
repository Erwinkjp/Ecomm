# Legacy Node sync (deprecation)

This package (`synnex-shopify-sync`) is the original **Node.js** scheduled Lambda that syncs TD Synnex XML P&A to Shopify.

**Replacement:** use the Python SAM application in **`../synnex-bridge-py/`**, which adds:

- DynamoDB as the source of truth (products, sync state, outbox, orders)
- Separate ingest and Shopify sync workers
- HTTP API + SQS for Shopify webhooks → Synnex PO (Phase 2)
- Scheduled PO status and invoice → Shopify order metafields (Phase 2–3)

**Cutover:** deploy `synnex-bridge-py`, run parity tests (inventory, price, order flow), then disable or remove this stack’s EventBridge schedule and point Shopify webhooks to the new API URL. Do not run both stacks against the same Shopify catalog without coordination.
