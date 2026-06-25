#!/bin/bash
shopify theme push \
  --store=uniwide-merchadise \
  --theme=159504793824 \
  --allow-live \
  --only=snippets/breadcrumbs.liquid \
  --only=snippets/shop-by-sidebar.liquid \
  --only=snippets/spec-sheet.liquid \
  --only=sections/main-product.liquid \
  --only=sections/shop-by-hero.liquid \
  --only=sections/main-collection-product-grid.liquid \
  --only=sections/featured-collection.liquid \
  --only=sections/main-order.liquid \
  --only=sections/page-returns.liquid
