import {
  reactExtension,
  useApi,
  BlockStack,
  InlineStack,
  Card,
  Page,
  Text,
  Button,
  Stepper,
  Banner,
  Spinner,
} from '@shopify/ui-extensions-react/customer-account';
import { useEffect, useState } from 'react';

export default reactExtension('customer-account.page.render', () => <CompanyStandards />);

const STORE = 'https://uniwidemerchandise.com';
const LAMBDA = 'https://q92q8ia1y1.execute-api.us-east-1.amazonaws.com';

function CompanyStandards() {
  const api = useApi();
  const [loading, setLoading] = useState(true);
  const [company, setCompany] = useState('');
  const [items, setItems] = useState([]);
  const [qtys, setQtys] = useState([]);
  const [error, setError] = useState('');

  useEffect(() => {
    (async () => {
      try {
        const pcRaw = api?.authenticatedAccount?.purchasingCompany;
        const pc = (pcRaw && typeof pcRaw === 'object' && 'current' in pcRaw) ? pcRaw.current : pcRaw;
        const companyId = pc?.company?.id;
        if (!companyId) { setError('This page is available to business (company) accounts.'); return; }

        const locationId = pc?.location?.id || '';
        const q = `companyId=${encodeURIComponent(companyId)}` + (locationId ? `&locationId=${encodeURIComponent(locationId)}` : '');
        const res = await fetch(`${LAMBDA}/b2b/standards?${q}`);
        const data = await res.json();
        const arr = Array.isArray(data?.products) ? data.products : [];
        setCompany(data?.company || '');
        setItems(arr);
        setQtys(arr.map((i) => Math.max(1, i.qty || 1)));
      } catch (e) {
        setError('Could not load Company Standards: ' + (e?.message || String(e)));
      } finally { setLoading(false); }
    })();
  }, []);

  const num = (g) => String(g).split('/').pop();
  const money = (n) => (n == null ? null : `$${Number(n).toFixed(2)}`);
  const setQty = (i, v) => setQtys((q) => q.map((x, idx) => (idx === i ? Math.max(1, v) : x)));
  const orderAllUrl = items.length
    ? `${STORE}/cart/${items.map((it, i) => `${num(it.variantId)}:${qtys[i] || 1}`).join(',')}`
    : null;

  if (loading) return <Page title="Company Standards"><Spinner /></Page>;

  return (
    <Page title="Company Standards">
      <BlockStack spacing="loose">
        {error ? <Banner status="warning">{error}</Banner> : null}
        <Text>
          {company ? `${company}'s approved products.` : 'Your approved products.'} Set quantities and order in one click.
        </Text>

        {items.length > 0 ? (
          <Button kind="primary" to={orderAllUrl}>Order all ({items.length})</Button>
        ) : null}

        <Card padding>
          <BlockStack spacing="base">
            {items.length === 0 ? (
              <Text appearance="subdued">No standard products yet — your account manager will add them shortly.</Text>
            ) : (
              items.map((it, i) => {
                const hasSaving = it.retailPrice != null && it.b2bPrice != null && it.b2bPrice < it.retailPrice;
                const saving = hasSaving ? it.retailPrice - it.b2bPrice : 0;
                const pct = hasSaving ? Math.round((saving / it.retailPrice) * 100) : 0;
                return (
                  <InlineStack key={i} inlineAlignment="space-between" blockAlignment="center">
                    <BlockStack spacing="none">
                      <Text>{it.title}</Text>
                      {it.b2bPrice != null ? (
                        <InlineStack spacing="tight" blockAlignment="center">
                          {hasSaving ? <Text appearance="subdued">Retail {money(it.retailPrice)}</Text> : null}
                          <Text emphasis="bold">Your price {money(it.b2bPrice)}</Text>
                          {hasSaving ? <Text appearance="success">Save {money(saving)} ({pct}%)</Text> : null}
                        </InlineStack>
                      ) : null}
                    </BlockStack>
                    <InlineStack spacing="base" blockAlignment="center">
                      <Stepper label="Qty" value={qtys[i] || 1} min={1} onChange={(v) => setQty(i, v)} />
                      <Button kind="secondary" to={`${STORE}/cart/${num(it.variantId)}:${qtys[i] || 1}`}>Order</Button>
                    </InlineStack>
                  </InlineStack>
                );
              })
            )}
          </BlockStack>
        </Card>
      </BlockStack>
    </Page>
  );
}
