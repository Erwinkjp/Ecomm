import {
  reactExtension,
  useBuyerJourneyIntercept,
  BlockStack,
  InlineStack,
  Text,
  Checkbox,
  Pressable,
  ScrollView,
  View,
} from '@shopify/ui-extensions-react/checkout';
import { useEffect, useState } from 'react';

// Checkout Terms & Agreement gate: shows an expandable, scrollable Terms block plus a
// required checkbox, and blocks progress to payment until the buyer agrees.
// Terms text comes from the Lambda /checkout/terms (shop metafield custom.checkout_terms).
const LAMBDA = 'https://q92q8ia1y1.execute-api.us-east-1.amazonaws.com';

export default reactExtension('purchase.checkout.block.render', () => <TermsGate />);

function TermsGate() {
  const [open, setOpen] = useState(false);
  const [agreed, setAgreed] = useState(false);
  const [paragraphs, setParagraphs] = useState([]);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const res = await fetch(`${LAMBDA}/checkout/terms`);
        const data = await res.json();
        if (active) setParagraphs(Array.isArray(data?.paragraphs) ? data.paragraphs : []);
      } catch (_) { /* leave empty; checkbox still gates */ }
    })();
    return () => { active = false; };
  }, []);

  // Block the buyer from continuing to payment until the box is checked.
  useBuyerJourneyIntercept(({ canBlockProgress }) => {
    if (canBlockProgress && !agreed) {
      return {
        behavior: 'block',
        reason: 'Terms not accepted',
        errors: [{ message: 'Please read and accept the Terms & Agreement to continue.' }],
      };
    }
    return { behavior: 'allow' };
  });

  return (
    <View border="base" cornerRadius="base" padding="base">
      <BlockStack spacing="base">
        <Pressable onPress={() => setOpen((o) => !o)}>
          <InlineStack spacing="tight" blockAlignment="center">
            <Text emphasis="bold">Terms &amp; Agreement</Text>
            <Text appearance="subdued">{open ? '— hide' : '— read'}</Text>
          </InlineStack>
        </Pressable>

        {open ? (
          <ScrollView maxBlockSize={260}>
            <BlockStack spacing="base">
              {paragraphs.length
                ? paragraphs.map((p, i) => (
                    <Text key={i} size="small" appearance="subdued">{p}</Text>
                  ))
                : <Text size="small" appearance="subdued">Loading terms…</Text>}
            </BlockStack>
          </ScrollView>
        ) : null}

        <Checkbox checked={agreed} onChange={(v) => setAgreed(v)}>
          I have read and agree to the Terms &amp; Agreement.
        </Checkbox>
      </BlockStack>
    </View>
  );
}
