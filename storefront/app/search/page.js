'use client';

import { useState } from 'react';
import Link from 'next/link';

export default function SearchPage() {
  const [q, setQ] = useState('');

  function submit(e) {
    e.preventDefault();
    const domain = process.env.NEXT_PUBLIC_SHOPIFY_STORE_DOMAIN;
    const base =
      process.env.NEXT_PUBLIC_STORE_URL ||
      (domain ? `https://${domain}` : '');
    if (!base) return;
    window.location.href = `${base.replace(/\/$/, '')}/search?q=${encodeURIComponent(q.trim())}`;
  }

  return (
    <div className="container" style={{ padding: '3rem 1.25rem', maxWidth: '560px' }}>
      <p style={{ marginBottom: '1rem' }}>
        <Link href="/" style={{ color: 'var(--muted)' }}>
          ← Home
        </Link>
      </p>
      <h1 style={{ fontSize: '1.75rem', marginBottom: '1rem' }}>Search products</h1>
      <p style={{ color: 'var(--muted)', marginBottom: '1.25rem', fontSize: '0.95rem' }}>
        Search runs on your Shopify storefront (same catalog as checkout).
      </p>
      <form onSubmit={submit} style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
        <input
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search CPUs, monitors, keyboards…"
          className="discount-form input-like"
          style={{
            flex: '1 1 220px',
            padding: '0.75rem 1rem',
            borderRadius: 'var(--radius)',
            border: '1px solid var(--border)',
            background: 'var(--bg)',
            color: 'var(--text)',
            fontSize: '1rem',
          }}
        />
        <button type="submit" className="btn btn--primary">
          Search
        </button>
      </form>
    </div>
  );
}
