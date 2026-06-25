'use strict';

(function () {
  // ── Tab switching ────────────────────────────────────────────────────────────

  const tabs = document.querySelectorAll('.b2b-tab');
  const panels = document.querySelectorAll('.b2b-panel');

  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      const target = tab.dataset.tab;
      tabs.forEach(t => {
        t.classList.toggle('active', t === tab);
        t.setAttribute('aria-selected', t === tab ? 'true' : 'false');
      });
      panels.forEach(p => p.classList.toggle('active', p.dataset.panel === target));
    });
  });

  // ── Standards search + chip filtering ────────────────────────────────────────

  const searchInput = document.getElementById('b2b-standards-search');
  const chips = document.querySelectorAll('.b2b-chip[data-filter]');
  const cards = document.querySelectorAll('.b2b-product-card[data-title]');
  const emptyState = document.getElementById('b2b-standards-empty');

  let activeFilter = 'all';
  let searchQuery = '';

  function filterCards() {
    let visible = 0;
    cards.forEach(card => {
      const title    = (card.dataset.title    || '').toLowerCase();
      const vendor   = (card.dataset.vendor   || '').toLowerCase();
      const category = (card.dataset.category || '').toLowerCase();
      const sku      = (card.dataset.sku      || '').toLowerCase();

      const matchesSearch = !searchQuery
        || title.includes(searchQuery)
        || vendor.includes(searchQuery)
        || sku.includes(searchQuery);

      const matchesFilter = activeFilter === 'all'
        || category === activeFilter
        || vendor === activeFilter;

      const show = matchesSearch && matchesFilter;
      card.style.display = show ? '' : 'none';
      if (show) visible++;
    });
    if (emptyState) emptyState.style.display = visible === 0 ? '' : 'none';
  }

  if (searchInput) {
    searchInput.addEventListener('input', () => {
      searchQuery = searchInput.value.trim().toLowerCase();
      filterCards();
    });
  }

  chips.forEach(chip => {
    chip.addEventListener('click', () => {
      activeFilter = chip.dataset.filter;
      chips.forEach(c => c.classList.toggle('active', c === chip));
      filterCards();
    });
  });

  // ── Toast notification ───────────────────────────────────────────────────────

  function showToast(message, isError = false) {
    const toast = document.getElementById('b2b-toast');
    if (!toast) return;
    toast.textContent = message;
    toast.classList.toggle('error', isError);
    toast.classList.add('show');
    clearTimeout(toast._timer);
    toast._timer = setTimeout(() => toast.classList.remove('show'), 3500);
  }

  // ── Cart helpers ─────────────────────────────────────────────────────────────

  async function addToCart(variantId, quantity) {
    const res = await fetch('/cart/add.js', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: Number(variantId), quantity }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.description || `HTTP ${res.status}`);
    }
    return res.json();
  }

  function bumpCartCount(qty) {
    // Works with Dawn's cart bubble — update the accessible label and count span
    const bubble = document.querySelector('.cart-count-bubble');
    if (!bubble) return;
    const spans = bubble.querySelectorAll('span');
    // First span is visually hidden aria label, second is the visible number
    const countSpan = spans.length >= 2 ? spans[1] : spans[0];
    if (!countSpan) return;
    const current = parseInt(countSpan.textContent, 10) || 0;
    countSpan.textContent = current + qty;
    bubble.removeAttribute('hidden');
  }

  // ── Single add-to-cart (event delegation) ────────────────────────────────────

  document.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-add-to-cart]');
    if (!btn) return;

    const card = btn.closest('.b2b-product-card');
    const variantId = card?.dataset.variantId;
    if (!variantId) return;

    const qtyInput = card.querySelector('.b2b-qty-input');
    const quantity = Math.max(1, parseInt(qtyInput?.value || '1', 10));

    const originalText = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'Adding…';

    try {
      await addToCart(variantId, quantity);
      bumpCartCount(quantity);
      showToast(`Added ${quantity}× to cart`);
      btn.textContent = 'Added!';
      setTimeout(() => {
        btn.textContent = originalText;
        btn.disabled = false;
      }, 1500);
    } catch (err) {
      showToast(err.message, true);
      btn.textContent = originalText;
      btn.disabled = false;
    }
  });

  // ── Add all visible ───────────────────────────────────────────────────────────

  const addAllBtn = document.getElementById('b2b-add-all');
  if (addAllBtn) {
    addAllBtn.addEventListener('click', async () => {
      const visibleCards = [...cards].filter(c => c.style.display !== 'none');
      if (!visibleCards.length) return;

      addAllBtn.disabled = true;
      const originalText = addAllBtn.textContent;
      addAllBtn.textContent = `Adding ${visibleCards.length}…`;

      let added = 0;
      let failed = 0;

      for (const card of visibleCards) {
        const variantId = card.dataset.variantId;
        if (!variantId) continue;
        const qty = Math.max(1, parseInt(card.querySelector('.b2b-qty-input')?.value || '1', 10));
        try {
          await addToCart(variantId, qty);
          added += qty;
        } catch {
          failed++;
        }
      }

      bumpCartCount(added);

      if (failed > 0) {
        showToast(`Added ${added} item${added !== 1 ? 's' : ''} — ${failed} unavailable`, true);
      } else {
        showToast(`Added ${added} item${added !== 1 ? 's' : ''} to cart`);
      }

      addAllBtn.textContent = originalText;
      addAllBtn.disabled = false;
    });
  }

  // ── Qty stepper buttons ───────────────────────────────────────────────────────

  document.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-qty-step]');
    if (!btn) return;
    const input = btn.closest('.b2b-qty-wrap')?.querySelector('.b2b-qty-input');
    if (!input) return;
    const step = parseInt(btn.dataset.qtyStep, 10);
    const current = parseInt(input.value, 10) || 1;
    input.value = Math.max(1, current + step);
  });
})();
