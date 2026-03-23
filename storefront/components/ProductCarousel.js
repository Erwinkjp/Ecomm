import Image from 'next/image';
import Link from 'next/link';
import { productCheckoutUrl } from '@/lib/shopify';

function formatPrice(amount, currencyCode) {
  if (amount == null) return '—';
  return new Intl.NumberFormat(undefined, {
    style: 'currency',
    currency: currencyCode || 'USD',
  }).format(parseFloat(amount));
}

export default function ProductCarousel({ products }) {
  if (!products?.length) {
    return (
      <div className="placeholder-grid">
        <div className="placeholder-card">
          Add a <strong>featured</strong> collection in Shopify and set{' '}
          <code>NEXT_PUBLIC_FEATURED_COLLECTION_HANDLE</code> in <code>.env.local</code>
          to show hot products here.
        </div>
      </div>
    );
  }

  return (
    <div className="carousel" aria-label="Featured products">
      {products.map((p) => {
        const img = p.featuredImage?.url;
        const alt = p.featuredImage?.altText || p.title;
        const price = p.priceRange?.minVariantPrice;
        const href = productCheckoutUrl(p.handle);

        const variant = p.variants?.nodes?.[0];
        const qty = variant?.quantityAvailable ?? null;
        const available = variant?.availableForSale ?? true;
        const stockLabel = !available || qty === 0 ? 'Out of stock' : qty != null && qty <= 5 ? `Low stock` : null;
        const stockClass = !available || qty === 0 ? 'stock-badge stock-badge--out' : 'stock-badge stock-badge--low';

        return (
          <article key={p.id} className="carousel-card">
            <Link href={href} className="carousel-card__image" target="_blank" rel="noopener noreferrer">
              {img ? (
                <Image src={img} alt={alt} width={400} height={300} sizes="280px" />
              ) : (
                <div
                  style={{
                    width: '100%',
                    height: '100%',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    color: 'var(--muted)',
                    fontSize: '0.85rem',
                  }}
                >
                  No image
                </div>
              )}
              {stockLabel && (
                <span className={stockClass}>{stockLabel}</span>
              )}
            </Link>
            <div className="carousel-card__body">
              {(p.vendor || p.productType) && (
                <p className="carousel-card__meta">
                  {[p.vendor, p.productType].filter(Boolean).join(' · ')}
                </p>
              )}
              <Link href={href} target="_blank" rel="noopener noreferrer">
                <h3 className="carousel-card__title">{p.title}</h3>
              </Link>
              <p className="carousel-card__price">
                {formatPrice(price?.amount, price?.currencyCode)}
              </p>
            </div>
          </article>
        );
      })}
    </div>
  );
}
