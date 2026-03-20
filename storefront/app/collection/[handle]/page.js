import Image from 'next/image';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getProductsFromCollection, productCheckoutUrl } from '@/lib/shopify';
import { NAV_CATEGORIES } from '@/lib/categories';

function formatPrice(amount, currencyCode) {
  if (amount == null) return '—';
  return new Intl.NumberFormat(undefined, {
    style: 'currency',
    currency: currencyCode || 'USD',
  }).format(parseFloat(amount));
}

export async function generateMetadata({ params }) {
  const cat = NAV_CATEGORIES.find((c) => c.handle === params.handle);
  return {
    title: cat ? `${cat.label} | Vantedge Systems` : 'Collection | Vantedge Systems',
  };
}

export default async function CollectionPage({ params }) {
  const known = NAV_CATEGORIES.some((c) => c.handle === params.handle);
  const { products, collectionTitle, error } = await getProductsFromCollection(params.handle, 24);

  if (!collectionTitle && !error && products.length === 0 && !known) {
    notFound();
  }

  const label = NAV_CATEGORIES.find((c) => c.handle === params.handle)?.label || collectionTitle;

  return (
    <div className="container" style={{ padding: '2rem 1.25rem 3rem' }}>
      <p style={{ marginBottom: '0.5rem' }}>
        <Link href="/" style={{ color: 'var(--muted)' }}>
          ← Home
        </Link>
      </p>
      <h1 style={{ fontSize: '1.75rem', marginBottom: '0.5rem' }}>{label || params.handle}</h1>
      {error && <p style={{ color: '#f87171', marginBottom: '1rem' }}>{error}</p>}
      {!products.length && !error && (
        <p style={{ color: 'var(--muted)' }}>
          No products in this collection yet. Add products to the <strong>{params.handle}</strong>{' '}
          collection in Shopify Admin.
        </p>
      )}
      <ul
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))',
          gap: '1.25rem',
          listStyle: 'none',
          marginTop: '1.5rem',
        }}
      >
        {products.map((p) => {
          const img = p.featuredImage?.url;
          const price = p.priceRange?.minVariantPrice;
          const href = productCheckoutUrl(p.handle);
          return (
            <li key={p.id}>
              <article
                style={{
                  background: 'var(--surface)',
                  border: '1px solid var(--border)',
                  borderRadius: 'var(--radius)',
                  overflow: 'hidden',
                }}
              >
                <Link href={href} target="_blank" rel="noopener noreferrer">
                  <div style={{ aspectRatio: '4/3', background: 'var(--bg)', position: 'relative' }}>
                    {img ? (
                      <Image src={img} alt={p.featuredImage?.altText || p.title} fill sizes="280px" style={{ objectFit: 'cover' }} />
                    ) : null}
                  </div>
                </Link>
                <div style={{ padding: '1rem' }}>
                  <Link href={href} target="_blank" rel="noopener noreferrer">
                    <h2 style={{ fontSize: '0.95rem', fontWeight: 600, marginBottom: '0.35rem' }}>{p.title}</h2>
                  </Link>
                  <p style={{ color: 'var(--accent)', fontWeight: 700 }}>
                    {formatPrice(price?.amount, price?.currencyCode)}
                  </p>
                </div>
              </article>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
