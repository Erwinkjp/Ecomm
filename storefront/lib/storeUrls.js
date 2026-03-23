/**
 * Shopify Online Store customer URLs (work when using default storefront domain).
 */
export function getShopifyAccountLoginUrl() {
  const d = process.env.NEXT_PUBLIC_SHOPIFY_STORE_DOMAIN;
  if (!d) return '#';
  return `https://${d}/account/login`;
}

export function getShopifyAccountRegisterUrl() {
  const d = process.env.NEXT_PUBLIC_SHOPIFY_STORE_DOMAIN;
  if (!d) return '#';
  return `https://${d}/account/register`;
}

export function getShopifySearchUrl(query = '') {
  const base =
    process.env.NEXT_PUBLIC_STORE_URL ||
    (process.env.NEXT_PUBLIC_SHOPIFY_STORE_DOMAIN
      ? `https://${process.env.NEXT_PUBLIC_SHOPIFY_STORE_DOMAIN}`
      : '');
  if (!base) return '#';
  const q = query ? `?q=${encodeURIComponent(query)}` : '';
  return `${base.replace(/\/$/, '')}/search${q}`;
}
