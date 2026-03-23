'use client';

import { useState } from 'react';
import Link from 'next/link';

const FULFILLMENT_STEPS = ['Order placed', 'Processing', 'Shipped', 'Delivered'];

function fulfillmentStepIndex(status) {
  if (!status) return 0;
  const s = status.toUpperCase();
  if (s === 'FULFILLED' || s === 'DELIVERED') return 3;
  if (s === 'IN_TRANSIT' || s === 'IN_PROGRESS' || s === 'PARTIALLY_FULFILLED') return 2;
  if (s === 'PENDING' || s === 'OPEN' || s === 'UNFULFILLED') return 1;
  return 1;
}

function formatCurrency(amount, currencyCode) {
  if (amount == null) return '—';
  return new Intl.NumberFormat(undefined, {
    style: 'currency',
    currency: currencyCode || 'USD',
  }).format(parseFloat(amount));
}

function formatDate(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function TrackingBar({ step }) {
  return (
    <div className="tracking-bar">
      {FULFILLMENT_STEPS.map((label, i) => (
        <div key={label} className={`tracking-bar__step ${i <= step ? 'is-done' : ''} ${i === step ? 'is-current' : ''}`}>
          <div className="tracking-bar__dot">
            {i < step ? '✓' : ''}
          </div>
          <span className="tracking-bar__label">{label}</span>
          {i < FULFILLMENT_STEPS.length - 1 && (
            <div className={`tracking-bar__line ${i < step ? 'is-done' : ''}`} />
          )}
        </div>
      ))}
    </div>
  );
}

function OrderDetail({ order }) {
  const step = fulfillmentStepIndex(order.displayFulfillmentStatus);
  const tracking = order.fulfillments?.flatMap((f) => f.trackingInfo) ?? [];
  const lineItems = order.lineItems?.nodes ?? [];
  const money = order.totalPriceSet?.shopMoney;
  const isCancelled = Boolean(order.cancelledAt);

  return (
    <div className="order-detail">
      {/* Header row */}
      <div className="order-detail__header">
        <div>
          <h2 className="order-detail__name">{order.name}</h2>
          <p className="order-detail__meta">Placed {formatDate(order.createdAt)}</p>
        </div>
        <div className="order-detail__total">
          <span>{formatCurrency(money?.amount, money?.currencyCode)}</span>
          <span className={`status-pill ${isCancelled ? 'status-pill--cancelled' : step === 3 ? 'status-pill--delivered' : 'status-pill--active'}`}>
            {isCancelled ? 'Cancelled' : order.displayFulfillmentStatus?.replace(/_/g, ' ')}
          </span>
        </div>
      </div>

      {/* Progress bar */}
      {!isCancelled && <TrackingBar step={step} />}

      {/* Tracking numbers */}
      {tracking.length > 0 && (
        <div className="order-detail__tracking-list">
          {tracking.map((t, i) => (
            <div key={i} className="tracking-entry">
              <div className="tracking-entry__carrier">{t.company || 'Carrier'}</div>
              <div className="tracking-entry__number">{t.number}</div>
              {t.url && (
                <a href={t.url} target="_blank" rel="noopener noreferrer" className="tracking-entry__link">
                  Track on {t.company || 'carrier site'} →
                </a>
              )}
            </div>
          ))}
        </div>
      )}
      {!isCancelled && tracking.length === 0 && step < 2 && (
        <p className="order-detail__no-tracking">Tracking will appear here once your order ships.</p>
      )}

      {/* Line items */}
      <ul className="order-items">
        {lineItems.map((li) => (
          <li key={li.id} className="order-item">
            {li.image?.url && (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={li.image.url} alt={li.image.altText || li.title} className="order-item__img" />
            )}
            <div className="order-item__info">
              <p className="order-item__title">{li.title}</p>
              {li.sku && <p className="order-item__sku">SKU: {li.sku}</p>}
              <p className="order-item__qty">Qty: {li.quantity}</p>
            </div>
            <div className="order-item__price">
              {formatCurrency(
                li.originalUnitPriceSet?.shopMoney?.amount * li.quantity,
                li.originalUnitPriceSet?.shopMoney?.currencyCode
              )}
            </div>
          </li>
        ))}
      </ul>

      {/* Return CTA — only for delivered, non-cancelled orders with returnable items */}
      {step === 3 && !isCancelled && lineItems.some((li) => li.refundableQuantity > 0) && (
        <div className="order-detail__return-cta">
          <p>Not happy with your order?</p>
          <Link
            href={`/returns?order=${encodeURIComponent(order.name)}`}
            className="btn btn--ghost"
          >
            Start a return →
          </Link>
        </div>
      )}
    </div>
  );
}

export default function OrderStatusPage() {
  const [orderNumber, setOrderNumber] = useState('');
  const [email, setEmail] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [order, setOrder] = useState(null);

  async function handleLookup(e) {
    e.preventDefault();
    setError(null);
    setOrder(null);
    setLoading(true);

    try {
      const res = await fetch('/api/order-lookup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orderNumber, email }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || 'Something went wrong.');
      } else {
        setOrder(data.order);
      }
    } catch {
      setError('Network error. Please check your connection and try again.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="container" style={{ padding: '2rem 1.25rem 4rem', maxWidth: 720 }}>
      <p style={{ marginBottom: '0.5rem' }}>
        <Link href="/" style={{ color: 'var(--muted)' }}>← Home</Link>
      </p>
      <h1 style={{ fontSize: '1.75rem', marginBottom: '0.25rem' }}>Order Status</h1>
      <p style={{ color: 'var(--muted)', marginBottom: '2rem' }}>
        Enter your order number and the email you used at checkout.
      </p>

      <form onSubmit={handleLookup} className="lookup-form">
        <div className="lookup-form__row">
          <div className="lookup-form__field">
            <label htmlFor="orderNumber">Order number</label>
            <input
              id="orderNumber"
              type="text"
              placeholder="#1042"
              value={orderNumber}
              onChange={(e) => setOrderNumber(e.target.value)}
              required
              autoComplete="off"
            />
          </div>
          <div className="lookup-form__field">
            <label htmlFor="email">Email address</label>
            <input
              id="email"
              type="email"
              placeholder="you@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              autoComplete="email"
            />
          </div>
        </div>
        <button type="submit" className="btn btn--primary" disabled={loading}>
          {loading ? 'Looking up…' : 'Find my order'}
        </button>
      </form>

      {error && (
        <div className="lookup-error" role="alert">{error}</div>
      )}

      {order && <OrderDetail order={order} />}
    </div>
  );
}
