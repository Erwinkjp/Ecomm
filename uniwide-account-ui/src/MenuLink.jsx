import {
  reactExtension,
  Link,
  Card,
  BlockStack,
  Heading,
  Text,
} from '@shopify/ui-extensions-react/customer-account';

// Surfaces a link to the full Company Standards page from the account profile.
// (Full-page extensions are reached via the "extension:<handle>/<page-target>" path.)
export default reactExtension('customer-account.profile.block.render', () => (
  <Card padding>
    <BlockStack spacing="tight">
      <Heading level={2}>Company Standards</Heading>
      <Text appearance="subdued">Your saved product lists for fast reordering.</Text>
      <Link to="extension:company-standards/customer-account.page.render">
        Open Company Standards
      </Link>
    </BlockStack>
  </Card>
));
