'use client';

import { useState, useEffect, Suspense } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';

const RETURN_REASONS = [
  'Item damaged / DOA',
  'Wrong item received',
  'Changed my mind',
  'Compatibility issue',
  'Other',
];

function formatCurrency(amount, currencyCode) {
  if (amount == null) return '—';
  return new Intl.NumberFormat(undefined, {
    style: 'currency',
    currency: currencyCode || 'USD',
  }).format(parseFloat(amount));
}

function ReturnsForm() {
  const searchParams = useSearchParams();

  // Pre-fill order number if coming from /order-status
  const [orderNumber, setOrderNumber] = useState(searchParams.get('order') || '');
  const [email, setEmail] = useState('');
  const [lookupLoading, setLookupLoading] = useState(false);
  const [lookupError, setLookupError] = useState(null);
  const [order, setOrder] = useState(null);

  const [selectedItem, setSelectedItem] = useState(null);
  const [reason, setReason] = useState('');
  const [customerNote, setCustomerNote] = useState('');
  const [submitLoading, setSubmitLoading] = useState(false);
  const [submitError, setSubmitError] = useState(null);
  const [confirmation, setConfirmation] = useState(null);

  // If order number was passed via URL, focus the email field
  useEffect(() => {
    if (searchParams.get('order')) {
      document.getElementById('returns-email')?.focus();
    }
  }, [searchParams]);

  async function handleLookup(e) {
    e.preventDefault();
    setLookupError(null);
    setOrder(null);
    setSelectedItem(null);
    setReason('');
    setLookupLoading(true);

    try {
      const res = await fetch('/api/order-lookup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orderNumber, email }),
      });
      const data = await res.json();
      if (!res.ok) {
        setLookupError(data.error || 'Could not find your order.');
      } else {
        // Only show line items that are eligible to return
        const eligible = data.order.lineItems?.nodes?.filter((li) => li.refundableQuantity > 0) ?? [];
        if (eligible.length === 0) {
          setLookupError('There are no items eligible for return on this order.');
        } else {
          setOrder({ ...data.order, eligibleItems: eligible });
        }
      }
    } catch {
      setLookupError('Network error. Please try again.');
    } finally {
      setLookupLoading(false);
    }
  }

  async function handleSubmit(e) {
    e.preventDefault();
    if (!selectedItem || !reason) return;
    setSubmitError(null);
    setSubmitLoading(true);

    try {
      const res = await fetch('/api/returns', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          orderNumber,
          email,
          lineItemId: selectedItem.id,
          quantity: selectedItem.refundableQuantity,
          reason,
          customerNote,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setSubmitError(data.error || 'Could not submit your return.');
      } else {
        setConfirmation(data);
      }
    } catch {
      setSubmitError('Network error. Please try again.');
    } finally {
      setSubmitLoading(false);
    }
  }

  // ── Confirmation screen ──────────────────────────────────────────────────
  if (confirmation) {
    return (
      <div className="return-confirmation">
        <div className="return-confirmation__icon">✅</div>
        <h2>Return submitted</h2>
        {confirmation.rmaNumber && (
          <p className="return-confirmation__rma">
            RMA # <strong>{confirmation.rmaNumber}</strong>
          </p>
        )}
        <p>{confirmation.message}</p>
        <div style={{ display: 'flex', gap: '0.75rem', justifyContent: 'center', flexWrap: 'wrap', marginTop: '1.5rem' }}>
          <Link href="/order-status" className="btn btn--ghost">Check another order</Link>
          <Link href="/" className="btn btn--primary">Back to shop</Link>
        </div>
      </div>
    );
  }

  return (
    <>
      {/* Step 1 — Order lookup */}
      <section className="returns-step">
        <h2 className="returns-step__title">
          <span className="returns-step__number">1</span> Find your order
        </h2>
        <form onSubmit={handleLookup} className="lookup-form">
          <div className="lookup-form__row">
            <div className="lookup-form__field">
              <label htmlFor="returns-order">Order number</label>
              <input
                id="returns-order"
                type="text"
                placeholder="#1042"
                value={orderNumber}
                onChange={(e) => setOrderNumber(e.target.value)}
                required
                autoComplete="off"
              />
            </div>
            <div className="lookup-form__field">
              <label htmlFor="returns-email">Email address</label>
              <input
                id="returns-email"
                type="email"
                placeholder="you@example.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                autoComplete="email"
              />
            </div>
          </div>
          <button type="submit" className="btn btn--primary" disabled={lookupLoading}>
            {lookupLoading ? 'Looking up…' : 'Find order'}
          </button>
        </form>
        {lookupError && <div className="lookup-error" role="alert">{lookupError}</div>}
      </section>

      {/* Step 2 — Select item */}
      {order && (
        <section className="returns-step">
          <h2 className="returns-step__title">
            <span className="returns-step__number">2</span> Select the item to return
          </h2>
          <p style={{ color: 'var(--muted)', fontSize: '0.9rem', marginBottom: '1rem' }}>
            Order {order.name} · {order.eligibleItems.length} item(s) eligible
          </p>
          <ul className="return-items-list">
            {order.eligibleItems.map((li) => (
              <li
                key={li.id}
                onClick={() => setSelectedItem(li)}
                className={`return-item ${selectedItem?.id === li.id ? 'is-selected' : ''}`}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => e.key === 'Enter' && setSelectedItem(li)}
              >
                <div className="return-item__check">
                  {selectedItem?.id === li.id ? '●' : '○'}
                </div>
                <div className="return-item__info">
                  <p className="return-item__title">{li.title}</p>
                  {li.sku && <p className="return-item__sku">SKU: {li.sku}</p>}
                  <p className="return-item__qty">{li.refundableQuantity} returnable</p>
                </div>
                <div className="return-item__price">
                  {formatCurrency(
                    li.originalUnitPriceSet?.shopMoney?.amount * li.refundableQuantity,
                    li.originalUnitPriceSet?.shopMoney?.currencyCode
                  )}
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* Step 3 — Reason + submit */}
      {selectedItem && (
        <section className="returns-step">
          <h2 className="returns-step__title">
            <span className="returns-step__number">3</span> Select a reason
          </h2>
          <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
            <ul className="reason-list">
              {RETURN_REASONS.map((r) => (
                <li
                  key={r}
                  onClick={() => setReason(r)}
                  className={`reason-item ${reason === r ? 'is-selected' : ''}`}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => e.key === 'Enter' && setReason(r)}
                >
                  <span className="reason-item__dot">{reason === r ? '●' : '○'}</span>
                  {r}
                </li>
              ))}
            </ul>

            <div className="lookup-form__field" style={{ marginTop: '0.5rem' }}>
              <label htmlFor="customerNote">Additional details <span style={{ color: 'var(--muted)' }}>(optional)</span></label>
              <textarea
                id="customerNote"
                rows={3}
                placeholder="Describe the issue, e.g. screen has dead pixels, item arrived crushed…"
                value={customerNote}
                onChange={(e) => setCustomerNote(e.target.value)}
                style={{
                  padding: '0.75rem 1rem',
                  borderRadius: 'var(--radius)',
                  border: '1px solid var(--border)',
                  background: 'var(--bg)',
                  color: 'var(--text)',
                  fontFamily: 'inherit',
                  fontSize: '0.95rem',
                  resize: 'vertical',
                  width: '100%',
                }}
              />
            </div>

            <div className="returns-policy-note">
              📦 After submitting, you&apos;ll receive a prepaid return label by email within 1 business day.
              Ship to our distribution center and your refund will be issued within 5–10 business days of receipt.
            </div>

            {submitError && <div className="lookup-error" role="alert">{submitError}</div>}

            <button
              type="submit"
              className="btn btn--primary"
              disabled={!reason || submitLoading}
              style={{ alignSelf: 'flex-start' }}
            >
              {submitLoading ? 'Submitting…' : 'Submit return request'}
            </button>
          </form>
        </section>
      )}
    </>
  );
}

export default function ReturnsPage() {
  return (
    <div className="container" style={{ padding: '2rem 1.25rem 4rem', maxWidth: 720 }}>
      <p style={{ marginBottom: '0.5rem' }}>
        <Link href="/" style={{ color: 'var(--muted)' }}>← Home</Link>
      </p>
      <h1 style={{ fontSize: '1.75rem', marginBottom: '0.25rem' }}>Returns</h1>
      <p style={{ color: 'var(--muted)', marginBottom: '2rem' }}>
        Returns are accepted within 30 days of delivery. Items must be unused and in original packaging.
      </p>
      <Suspense fallback={<p style={{ color: 'var(--muted)' }}>Loading…</p>}>
        <ReturnsForm />
      </Suspense>
    </div>
  );
}
