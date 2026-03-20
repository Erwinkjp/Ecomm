# Vantedge Systems storefront (Next.js + Shopify)

Marketing site with:

- **Hot products carousel** — pulls from a Shopify collection (default handle: `featured`).
- **Top bar “Shop by category”** — dropdown for **PC Parts**, **Peripherals**, **Monitors**, **Misc** (each links to `/collection/{handle}`).
- **Discount email signup** — form posts to `/api/subscribe` (extend with webhook or email provider).

## Setup

1. **Shopify Admin → Settings → Apps → Develop apps**  
   Create a **Headless** or **Custom storefront** app and add the **Storefront API** with read access to products and collections.

2. Copy `.env.example` to `.env.local`:

   ```bash
   cp .env.example .env.local
   ```

   - `NEXT_PUBLIC_SHOPIFY_STORE_DOMAIN` — e.g. `your-store.myshopify.com`
   - `NEXT_PUBLIC_SHOPIFY_STOREFRONT_ACCESS_TOKEN` — Storefront API token
   - `NEXT_PUBLIC_FEATURED_COLLECTION_HANDLE` — collection for the home carousel (create a collection named “Featured” with handle `featured`, or change this env)
   - Optional: `NEXT_PUBLIC_STORE_URL` — your **public** shop URL if you use a custom domain (e.g. `https://shop.yourdomain.com`). If unset, links use `https://{store}.myshopify.com`.

3. **Create collections** in Shopify with these **handles** (URL & handle must match):

   | Nav label     | Collection handle |
   |---------------|-------------------|
   | PC Parts      | `pc-parts`        |
   | Peripherals   | `peripherals`     |
   | Monitors      | `monitors`        |
   | Misc          | `misc`            |

   Edit handles in `lib/categories.js` if you prefer different URLs.

4. Run locally:

   ```bash
   npm install
   npm run dev
   ```

## Email signup (discounts)

- By default, `/api/subscribe` **logs** the email on the server and returns success (good for UX design / dev).
- To forward signups to Zapier, Make, Klaviyo, etc., set **`SUBSCRIBE_WEBHOOK_URL`** in `.env.local` to a POST URL that accepts JSON `{ email, source, subscribedAt }`.
- For **Shopify Email** or **Customer accounts**, you’ll typically use Shopify’s forms or an app; swap the form action or API route when you choose a provider.

## Deploy

Vercel, Netlify, or any Node host. Set the same env vars in the project settings.
