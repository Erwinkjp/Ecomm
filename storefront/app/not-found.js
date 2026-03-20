import Link from 'next/link';

export default function NotFound() {
  return (
    <div className="container" style={{ padding: '4rem 1.25rem', textAlign: 'center' }}>
      <h1 style={{ fontSize: '1.5rem', marginBottom: '0.75rem' }}>Page not found</h1>
      <p style={{ color: 'var(--muted)', marginBottom: '1.5rem' }}>
        That collection or page doesn&apos;t exist yet.
      </p>
      <Link href="/" className="btn btn--primary">
        Back to home
      </Link>
    </div>
  );
}
