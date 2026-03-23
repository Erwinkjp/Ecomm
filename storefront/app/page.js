import ProductCarousel from '@/components/ProductCarousel';
import DiscountSignup from '@/components/DiscountSignup';
import { getFeaturedProductsForCarousel } from '@/lib/shopify';

export default async function HomePage() {
  const { products, collectionTitle, error } = await getFeaturedProductsForCarousel(12);

  return (
    <>
      <section className="hero">
        <div className="container">
          <h1>Gear that keeps you building</h1>
          <p>
            Hot picks from our catalog — CPUs, displays, peripherals, and everything in between.
            Browse by category above or scroll the carousel for staff favorites.
          </p>
        </div>
      </section>

      <section className="guides-section" id="guides" aria-labelledby="guides-heading">
        <div className="container">
          <h2 id="guides-heading">Guides &amp; resources</h2>
          <p className="guides-section__lead">
            We&apos;re building setup tips, compatibility notes, and buying guides. Check back soon — or open{' '}
            <strong>Products</strong> in the header to browse the full catalog by category.
          </p>
        </div>
      </section>

      <section className="carousel-section">
        <div className="container">
          <div className="carousel-section__head">
            <h2>{collectionTitle || 'Hot products'}</h2>
            {error ? (
              <span style={{ color: '#f87171' }}>{error}</span>
            ) : (
              <span>Swipe or scroll sideways</span>
            )}
          </div>
          <ProductCarousel products={products} />
        </div>
      </section>

      <div className="container">
        <DiscountSignup />
      </div>
    </>
  );
}
