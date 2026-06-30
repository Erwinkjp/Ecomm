# Uniwide — Customer Account UI Extension: "Company Standards"

A per-customer **Company Standards** page inside the Shopify (new) customer account.
Each logged-in buyer sees a page they control: products they've saved into named lists,
with one-click reorder. It is inherently **per customer / per company** because it reads
the authenticated buyer's identity + company context and stores their lists on their own
record.

> Native B2B catalogs already scope *which products a company can buy* and *at what price*.
> This extension adds the **buyer-curated, labeled "Company Standards" page** on top —
> the Insight-style experience — which native B2B does not provide.

---

## Architecture

| Concern | Approach |
|---|---|
| **Where it renders** | Full page in the new customer account, target `customer-account.page.render`, surfaced via a menu link from `customer-account.profile.block.render` (or order-index block). |
| **Per-customer identity** | The extension's `useApi().query` runs against the **Customer Account API** as the logged-in buyer — so it only ever sees *their* data. For B2B it reads the buyer's company + location. |
| **Where lists live** | A **company metafield** in the app-reserved namespace `$app:standards` / key `lists` — a JSON array of named lists (each list = a **tab**): `[{ "label": "...", "items": [{ "variantId": "...", "title": "...", "qty": 1 }] }]`. Stored on the **company** so all invited buyers (finance / IT / procurement) share & edit the same lists. |
| **Multiple lists** | Each named list renders as a **tab** at the top of the page; "+ New list" adds a tab. Any invited user can create/edit/delete lists and reorder from them. |
| **Adding products** | v1: add by variant (from a product the buyer is viewing, or a simple variant-id/SKU entry). v2: a Storefront-API-backed search/picker scoped to the company's catalog. |
| **Reorder** | Each item has an **Add to cart** action via the customer-account `CartLineUpdate`/checkout deep-link; "Reorder list" adds every item at once. |

### Why metafields (not a DB)
No external infra, it travels with the company record, it's readable/writable by the
extension via the Customer Account API, and it survives plan changes.

### Shared-write fallback (important)
Reading the company metafield in buyer context is fine. **Writing** a *company* metafield
from a buyer session may be restricted depending on the buyer's role/permissions. If
`metafieldsSet` returns a permission error in `shopify app dev`, route writes through the
Lambda instead: add a small `POST /b2b/standards` endpoint that takes `{companyId, lists}`
and writes via the **Admin API** using `client_credentials` (which has `write_companies`).
The extension calls that endpoint instead of `metafieldsSet`. (Reads stay client-side.)
Since only a few trusted users (finance/IT/procurement) are invited and they hold the
Location-admin role, direct writes may well work — validate with `shopify app dev` first.

---

## One-time setup (interactive CLI — run these in your terminal)

These need browser auth + org/app selection, so they can't run headless:

```bash
cd "…/Ecomm/uniwide-account-ui"
shopify app init .            # or: shopify app config link  (to attach to an existing app)
shopify app generate extension --template customer_account_ui --name company-standards
```

That generates `extensions/company-standards/` with the correct, version-matched
`shopify.extension.toml` + `src/`. Then drop in the code from `src/CompanyStandards.jsx`
below (replace the generated component).

### Metafield definition (so the extension can read/write the lists)
Create a **company** metafield definition (Admin → Settings → Custom data → Companies, or via
the CLI app config) owned by this app:
- **Namespace/key:** `$app:standards.lists`
- **Type:** `json`
- **Access:** grant the app **read & write** to this metafield (in `shopify.app.toml`
  customer-account metafield access), so the extension can read it for any buyer and persist
  shared lists. If buyer-context writes are blocked, use the Lambda fallback above.

---

## Extension config (`extensions/company-standards/shopify.extension.toml`)

```toml
api_version = "2025-01"

[[extensions]]
name = "Company Standards"
handle = "company-standards"
type = "ui_extension"

  [[extensions.targeting]]
  target = "customer-account.page.render"
  module = "./src/CompanyStandards.jsx"

  [[extensions.targeting]]
  target = "customer-account.profile.block.render"   # adds the nav link to the page
  module = "./src/MenuLink.jsx"

  [extensions.capabilities]
  api_access = true

  # Allow reading/writing the buyer's own standards metafield
  [[extensions.metafields]]
  namespace = "$app:standards"
  key = "lists"
```

---

## Deploy / test (interactive)

```bash
shopify app dev        # live-previews the extension in your store's customer account
shopify app deploy     # ships it; then enable it for the account in Admin
```

`shopify app dev` gives you a preview URL — open the customer account as the Acme buyer
(erwinprado.inc@gmail.com) and you'll see the **Company Standards** menu item + page.

---

## Notes / next decisions
- **Model:** ✅ company-shared lists, tabbed (decided). Stored on the company metafield so
  the few invited buyers (finance / IT / procurement) share one set of labeled lists.
- **Invites:** keep it to a handful of contacts — Admin → Customers → Companies → Acme →
  add contacts, assign the Location-admin (ordering) role to those you want to manage lists.
- **Product picker (v2):** wire the Storefront API with the buyer's catalog context so the
  "Add product" flow searches only the company's approved catalog.
- The `src/CompanyStandards.jsx` here is a working first draft against the current
  customer-account React API — validate field names with `shopify app dev` (the live
  schema introspection will flag any that need tweaking for your API version).
