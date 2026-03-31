"""Shopify Admin GraphQL client."""

from __future__ import annotations

from typing import Any, Dict, List, Optional

import httpx

from bridge.config import ShopifyConfig, get_shopify_config


async def graphql(
    query: str,
    variables: Optional[Dict[str, Any]] = None,
    config: Optional[ShopifyConfig] = None,
) -> Dict[str, Any]:
    cfg = config or get_shopify_config()
    url = f"https://{cfg.store}.myshopify.com/admin/api/{cfg.api_version}/graphql.json"
    async with httpx.AsyncClient(timeout=120.0) as client:
        r = await client.post(
            url,
            headers={
                "Content-Type": "application/json",
                "X-Shopify-Access-Token": cfg.access_token,
            },
            json={"query": query, "variables": variables or {}},
        )
    text = r.text
    if r.status_code >= 400:
        raise RuntimeError(f"Shopify GraphQL HTTP {r.status_code}: {text[:800]}")
    data = r.json()
    if data.get("errors"):
        msgs = "; ".join(e.get("message", str(e)) for e in data["errors"])
        raise RuntimeError(f"Shopify GraphQL errors: {msgs}")
    if data.get("data") is None:
        raise RuntimeError("Shopify response missing data")
    return data["data"]


async def get_variant_skus_and_inventory_item_ids(
    config: Optional[ShopifyConfig] = None,
) -> List[Dict[str, str]]:
    out: List[Dict[str, str]] = []
    cursor: Optional[str] = None
    q = """
    query variants($cursor: String) {
      productVariants(first: 250, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id
          sku
          inventoryItem { id }
        }
      }
    }
    """
    while True:
        data = await graphql(q, {"cursor": cursor}, config)
        pv = data["productVariants"]
        for n in pv["nodes"]:
            if n.get("id") and n.get("sku") and n.get("inventoryItem", {}).get("id"):
                out.append(
                    {
                        "sku": n["sku"],
                        "variant_id": n["id"],
                        "inventory_item_id": n["inventoryItem"]["id"],
                    }
                )
        if pv["pageInfo"]["hasNextPage"]:
            cursor = pv["pageInfo"]["endCursor"]
        else:
            break
    return out


async def inventory_set_quantities(
    quantities: List[Dict[str, Any]],
    location_id: Optional[str] = None,
    idempotency_key: Optional[str] = None,
    config: Optional[ShopifyConfig] = None,
) -> None:
    cfg = config or get_shopify_config()
    loc = location_id or cfg.location_id
    key = idempotency_key or f"synnex-bridge-{id(quantities)}"
    input_payload = {
        "name": "available",
        "reason": "correction",
        "referenceDocumentUri": f"synnex-bridge://lambda/{key}",
        "ignoreCompareQuantity": True,
        "quantities": [
            {
                "inventoryItemId": q["inventory_item_id"],
                "locationId": loc,
                "quantity": int(q["quantity"]),
                "compareQuantity": q.get("compare_quantity"),
            }
            for q in quantities
        ],
    }
    mutation = """
    mutation inventorySetQuantities($input: InventorySetQuantitiesInput!) {
      inventorySetQuantities(input: $input) {
        userErrors { code field message }
      }
    }
    """
    data = await graphql(mutation, {"input": input_payload}, cfg)
    errs = data.get("inventorySetQuantities", {}).get("userErrors") or []
    if errs:
        raise RuntimeError(
            "inventorySetQuantities: " + "; ".join(e.get("message", str(e)) for e in errs)
        )


async def update_variant_pricing(
    variant_id: str,
    price: float,
    compare_at_price: Optional[float] = None,
    config: Optional[ShopifyConfig] = None,
) -> None:
    inp: Dict[str, Any] = {
        "id": variant_id,
        "price": f"{float(price):.2f}",
    }
    if compare_at_price is not None and float(compare_at_price) > 0:
        inp["compareAtPrice"] = f"{float(compare_at_price):.2f}"
    mutation = """
    mutation productVariantUpdate($input: ProductVariantInput!) {
      productVariantUpdate(input: $input) {
        userErrors { field message }
      }
    }
    """
    data = await graphql(mutation, {"input": inp}, config)
    errs = data.get("productVariantUpdate", {}).get("userErrors") or []
    if errs:
        raise RuntimeError(
            "productVariantUpdate: " + "; ".join(e.get("message", str(e)) for e in errs)
        )


async def order_update_metafields(
    order_id: str,
    namespace: str,
    pairs: List[tuple[str, str]],
    config: Optional[ShopifyConfig] = None,
) -> None:
    """Set simple single_line_text_field metafields on an order (Phase 3)."""
    metafields = [
        {
            "ownerId": order_id,
            "namespace": namespace,
            "key": key,
            "type": "single_line_text_field",
            "value": value,
        }
        for key, value in pairs
    ]
    mutation = """
    mutation metafieldsSet($metafields: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $metafields) {
        userErrors { field message }
      }
    }
    """
    data = await graphql(mutation, {"metafields": metafields}, config)
    errs = data.get("metafieldsSet", {}).get("userErrors") or []
    if errs:
        raise RuntimeError("metafieldsSet: " + "; ".join(e.get("message", str(e)) for e in errs))
