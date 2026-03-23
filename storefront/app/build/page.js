import Link from 'next/link';

export const metadata = {
  title: 'Build list | Vantedge Systems',
  description: 'Plan your next PC build with compatible parts.',
};

export default function BuildPage() {
  return (
    <div className="container" style={{ padding: '3rem 1.25rem', maxWidth: '640px' }}>
      <h1 style={{ fontSize: '1.75rem', marginBottom: '0.75rem' }}>Build list</h1>
      <p style={{ color: 'var(--muted)', marginBottom: '1.5rem' }}>
        A full compatibility builder (like PCPartPicker) can plug in here later. For now, browse{' '}
        <Link href="/" style={{ color: 'var(--accent)' }}>home</Link> or{' '}
        <Link href="/collection/pc-parts" style={{ color: 'var(--accent)' }}>PC parts</Link> to add
        gear to your cart on Shopify.
      </p>
      <Link href="/" className="btn btn--primary">
        Back to shop
      </Link>
    </div>
  );
}
