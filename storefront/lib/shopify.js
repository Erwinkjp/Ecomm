const domain = process.env.NEXT_PUBLIC_SHOPIFY_STORE_DOMAIN;
const token = process.env.NEXT_PUBLIC_SHOPIFY_STOREFRONT_ACCESS_TOKEN;

function isConfigured() {
  return Boolean(domain && token);
}

async function storefrontFetch({ query, variables = {} }) {
  if (!isConfigured()) {
    return { data: null, errors: [{ message: 'Shopify not configured' }] };
  }

  const res = await fetch(`https://${domain}/api/2024-10/graphql.json`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Storefront-Access-Token': token,
    },
    body: JSON.stringify({ query, variables }),
    next: { revalidate: 60 },
  });

  const json = await res.json();
  return json;
}

const PRODUCT_CARD_FRAGMENT = `
  fragment ProductCard on Product {
    id
    handle
    title
    vendor
    productType
    featuredImage {
      url
      altText
    }
    priceRange {
      minVariantPrice {
        amount
        currencyCode
      }
    }
    variants(first: 1) {
      nodes {
        sku
        availableForSale
        quantityAvailable
      }
    }
  }
`;

export async function getProductsFromCollection(handle, first = 12) {
  const query = `
    ${PRODUCT_CARD_FRAGMENT}
    query CollectionProducts($handle: String!, $first: Int!) {
      collection(handle: $handle) {
        id
        title
        products(first: $first) {
          edges {
            node {
              ...ProductCard
            }
          }
        }
      }
    }
  `;

  const { data, errors } = await storefrontFetch({
    query,
    variables: { handle, first },
  });

  if (errors?.length) return { products: [], collectionTitle: null, error: errors[0].message };
  const edges = data?.collection?.products?.edges ?? [];
  return {
    products: edges.map((e) => e.node),
    collectionTitle: data?.collection?.title ?? null,
    error: null,
  };
}

export async function getFeaturedProductsForCarousel(first = 8) {
  const handle =
    process.env.NEXT_PUBLIC_FEATURED_COLLECTION_HANDLE || 'featured';
  return getProductsFromCollection(handle, first);
}

/** Public storefront product URL (myshopify or set NEXT_PUBLIC_STORE_URL for custom domain). */
export function productCheckoutUrl(handle) {
  const base =
    process.env.NEXT_PUBLIC_STORE_URL ||
    (domain ? `https://${domain}` : '');
  if (!base) return '#';
  return `${base.replace(/\/$/, '')}/products/${handle}`;
}

export { isConfigured };
