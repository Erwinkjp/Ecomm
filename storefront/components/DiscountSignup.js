'use client';

import { useState } from 'react';

export default function DiscountSignup() {
  const [email, setEmail] = useState('');
  const [status, setStatus] = useState('idle');
  const [message, setMessage] = useState('');

  async function onSubmit(e) {
    e.preventDefault();
    setStatus('loading');
    setMessage('');

    try {
      const res = await fetch('/api/subscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email.trim() }),
      });
      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        setStatus('error');
        setMessage(data.error || 'Something went wrong. Try again.');
        return;
      }

      setStatus('success');
      setMessage(data.message || "You're on the list — check your inbox for deals.");
      setEmail('');
    } catch {
      setStatus('error');
      setMessage('Network error. Please try again.');
    }
  }

  return (
    <section className="discount-strip" aria-labelledby="discount-heading">
      <h2 id="discount-heading">Get exclusive discounts</h2>
      <p>
        Sign up with your email and we&apos;ll send you promo codes, flash sales, and new arrivals
        — no spam, unsubscribe anytime.
      </p>
      <form className="discount-form" onSubmit={onSubmit}>
        <input
          type="email"
          name="email"
          autoComplete="email"
          placeholder="you@example.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
          disabled={status === 'loading'}
          aria-label="Email for discounts"
        />
        <button type="submit" className="btn btn--primary" disabled={status === 'loading'}>
          {status === 'loading' ? 'Signing up…' : 'Sign me up'}
        </button>
        {message && (
          <p
            className={`discount-form__message ${
              status === 'success' ? 'discount-form__message--ok' : 'discount-form__message--err'
            }`}
            role="status"
          >
            {message}
          </p>
        )}
      </form>
    </section>
  );
}
