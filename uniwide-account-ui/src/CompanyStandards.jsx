import {
  reactExtension,
  useApi,
  BlockStack,
  InlineStack,
  Card,
  Page,
  Heading,
  Text,
  Button,
  TextField,
  Banner,
  Divider,
  Spinner,
} from '@shopify/ui-extensions-react/customer-account';
import { useEffect, useState, useCallback } from 'react';

export default reactExtension('customer-account.page.render', () => <CompanyStandards />);

const STORE = 'https://uniwidemerchandise.com';
const NS = '$app:standards';
const KEY = 'lists';

// Lists are stored on the COMPANY metafield, so every invited buyer
// (finance / IT / procurement) at the company sees & edits the same set.
// Each named list is a "tab". Shape:
//   [{ label: "Standard Laptop Build", items: [{variantId, title, qty}] }, ...]

function CompanyStandards() {
  const { query } = useApi();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [companyId, setCompanyId] = useState(null);
  const [companyName, setCompanyName] = useState('');
  const [lists, setLists] = useState([]);
  const [active, setActive] = useState(0);
  const [newList, setNewList] = useState('');
  const [adding, setAdding] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const res = await query(`
          query {
            customer {
              companyContacts(first: 1) {
                edges { node { company {
                  id
                  name
                  metafield(namespace: "${NS}", key: "${KEY}") { value }
                } } }
              }
            }
          }
        `);
        const co = res?.data?.customer?.companyContacts?.edges?.[0]?.node?.company;
        if (!co?.id) { setError('This page is available to business (company) accounts.'); setLoading(false); return; }
        setCompanyId(co.id);
        setCompanyName(co.name || '');
        try { setLists(JSON.parse(co.metafield?.value || '[]')); } catch { setLists([]); }
      } catch (e) {
        setError(e?.message || 'Could not load Company Standards.');
      } finally { setLoading(false); }
    })();
  }, [query]);

  // Persist the shared lists onto the COMPANY metafield
  const save = useCallback(async (next) => {
    setLists(next);
    if (!companyId) return;
    try {
      const r = await query(
        `mutation Save($metafields: [MetafieldsSetInput!]!) {
           metafieldsSet(metafields: $metafields) { userErrors { field message } }
         }`,
        { variables: { metafields: [{
            ownerId: companyId, namespace: NS, key: KEY, type: 'json', value: JSON.stringify(next),
          }] } }
      );
      const errs = r?.data?.metafieldsSet?.userErrors;
      if (errs?.length) setError(errs[0].message);
    } catch (e) {
      // If buyer-context can't write company metafields, route writes through the
      // Lambda (Admin API) instead — see README "shared-write fallback".
      setError(`Saved locally, but could not sync to the company: ${e?.message || e}`);
    }
  }, [companyId, query]);

  const addList = () => {
    const label = newList.trim(); if (!label) return;
    const next = [...lists, { label, items: [] }];
    save(next); setActive(next.length - 1); setNewList(''); setAdding(false);
  };
  const deleteList = (i) => {
    const next = lists.filter((_, idx) => idx !== i);
    save(next); setActive(Math.max(0, Math.min(active, next.length - 1)));
  };
  const removeItem = (ii) =>
    save(lists.map((l, idx) => idx === active ? { ...l, items: l.items.filter((_, j) => j !== ii) } : l));

  const variantNum = (gid) => String(gid).split('/').pop();
  const reorderUrl = (items) => `${STORE}/cart/${items.map((it) => `${variantNum(it.variantId)}:${it.qty || 1}`).join(',')}`;

  if (loading) return <Page title="Company Standards"><Spinner /></Page>;

  const current = lists[active];

  return (
    <Page title="Company Standards">
      <BlockStack spacing="loose">
        {error ? <Banner status="warning">{error}</Banner> : null}
        <Text>
          {companyName ? `Shared product lists for ${companyName}.` : 'Shared company product lists.'}
          {' '}Everyone on your account sees and edits these. Build labeled lists for fast reordering.
        </Text>

        {/* ── Tabs (one per list) ── */}
        <InlineStack spacing="tight">
          {lists.map((l, i) => (
            <Button key={i} kind={i === active ? 'primary' : 'secondary'} onPress={() => setActive(i)}>
              {l.label} ({l.items.length})
            </Button>
          ))}
          {adding ? (
            <InlineStack spacing="tight" blockAlignment="end">
              <TextField label="List name" value={newList} onChange={setNewList} />
              <Button kind="primary" onPress={addList}>Save</Button>
              <Button kind="plain" onPress={() => { setAdding(false); setNewList(''); }}>Cancel</Button>
            </InlineStack>
          ) : (
            <Button kind="plain" onPress={() => setAdding(true)}>+ New list</Button>
          )}
        </InlineStack>

        {/* ── Active list ── */}
        {!current ? (
          <Text appearance="subdued">No lists yet — create one (e.g. "Standard Laptop Build", "Branch Office Kit").</Text>
        ) : (
          <Card padding>
            <BlockStack spacing="base">
              <InlineStack inlineAlignment="space-between" blockAlignment="center">
                <Heading level={2}>{current.label}</Heading>
                <InlineStack spacing="base">
                  {current.items.length > 0 ? (
                    <Button kind="primary" to={reorderUrl(current.items)}>Reorder all ({current.items.length})</Button>
                  ) : null}
                  <Button kind="plain" appearance="critical" onPress={() => deleteList(active)}>Delete list</Button>
                </InlineStack>
              </InlineStack>
              <Divider />
              {current.items.length === 0 ? (
                <Text appearance="subdued">No products yet. (v2: add from your company catalog via the product picker.)</Text>
              ) : current.items.map((it, ii) => (
                <InlineStack key={ii} inlineAlignment="space-between" blockAlignment="center">
                  <Text>{it.title}{it.qty > 1 ? ` ×${it.qty}` : ''}</Text>
                  <InlineStack spacing="base">
                    <Button kind="plain" to={`${STORE}/cart/${variantNum(it.variantId)}:${it.qty || 1}`}>Add to cart</Button>
                    <Button kind="plain" appearance="critical" onPress={() => removeItem(ii)}>Remove</Button>
                  </InlineStack>
                </InlineStack>
              ))}
            </BlockStack>
          </Card>
        )}
      </BlockStack>
    </Page>
  );
}
