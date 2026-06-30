import {
  reactExtension,
  useApi,
  Card,
  BlockStack,
  Heading,
  Text,
  Button,
} from '@shopify/ui-extensions-react/customer-account';

// Entry point: renders a card linking to the full Company Standards page, on the
// account landing (order index). Only shown to B2B buyers (a purchasing company is
// present) — retail customers see nothing.
export default reactExtension('customer-account.order-index.block.render', () => <CompanyStandardsLink />);

function CompanyStandardsLink() {
  const api = useApi();
  const pcRaw = api?.authenticatedAccount?.purchasingCompany;
  const pc = (pcRaw && typeof pcRaw === 'object' && 'current' in pcRaw) ? pcRaw.current : pcRaw;
  const companyId = pc?.company?.id;
  if (!companyId) return null; // hide for non-B2B (retail) customers

  return (
    <Card padding>
      <BlockStack spacing="tight">
        <Heading level={2}>Company Standards</Heading>
        <Text appearance="subdued">Your company's approved products — reorder in one click.</Text>
        <Button to="extension:company-standards/customer-account.page.render">
          Open Company Standards
        </Button>
      </BlockStack>
    </Card>
  );
}
