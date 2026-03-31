"""Phase 1: Synnex XML → DynamoDB products + outbox."""

from __future__ import annotations

import hashlib
import json
from typing import Any, Dict, List

from bridge.config import (
    get_synnex_xml_config,
    synnex_xml_msrp_as_compare_at,
    synnex_xml_sync_prices,
)
from bridge.ddb.repositories import OutboxRepository, ProductsRepository, SyncStateRepository
from bridge.models.product import OutboxPayload
from bridge.shopify.client import get_variant_skus_and_inventory_item_ids
from bridge.synnex.xml_client import get_price_availability_from_xml, is_xml_configured


def _hash_payload(sku: str, qty: int, price: float | None, msrp: float | None) -> str:
    blob = json.dumps({"sku": sku, "qty": qty, "price": price, "msrp": msrp}, sort_keys=True)
    return hashlib.sha256(blob.encode()).hexdigest()


async def run_ingest() -> Dict[str, Any]:
    xml_cfg = get_synnex_xml_config()
    if not is_xml_configured(xml_cfg):
        raise RuntimeError("SYNNEX XML P&A not configured (set SYNNEX_XML_URL, *_CUSTOMER_NO, *_USERNAME, *_PASSWORD)")

    variants = await get_variant_skus_and_inventory_item_ids()
    part_numbers = sorted({v["sku"] for v in variants if v.get("sku")})
    if not part_numbers:
        return {"ok": True, "message": "No variants with SKUs in Shopify", "enqueued": 0}

    by_sku = {v["sku"]: v for v in variants}
    rows = await get_price_availability_from_xml(part_numbers, xml_cfg)

    products = ProductsRepository()
    outbox = OutboxRepository()
    state = SyncStateRepository()

    sync_prices = synnex_xml_sync_prices()
    msrp_compare = synnex_xml_msrp_as_compare_at()
    enqueued = 0
    updated = 0

    for row in rows:
        sku = row["part_number"]
        qty = int(row.get("quantity_available") or 0)
        price = row.get("price")
        if price is not None:
            price = float(price)
        msrp = row.get("msrp")
        if msrp is not None:
            msrp = float(msrp)

        h = _hash_payload(sku, qty, price, msrp)
        prev = products.get_product(sku)
        prev_hash = (prev or {}).get("content_hash")
        if prev_hash == h:
            continue

        products.put_product(
            sku,
            quantity=qty,
            price=price,
            content_hash=h,
            raw=row,
        )
        updated += 1

        v = by_sku.get(sku)
        if not v:
            continue

        compare_at = float(msrp) if (msrp_compare and msrp) else None
        sell_price = price
        payload = OutboxPayload(
            sku=sku,
            inventory_item_id=v["inventory_item_id"],
            variant_id=v["variant_id"],
            quantity=qty,
            price=sell_price if sync_prices else None,
            compare_at_price=compare_at if sync_prices else None,
        )
        outbox.enqueue(payload)
        enqueued += 1

    state.put_state(
        "ingest",
        {
            "last_run": str(len(rows)),
            "variants": len(part_numbers),
            "products_updated": updated,
            "outbox_enqueued": enqueued,
        },
    )

    return {
        "ok": True,
        "rows_from_synnex": len(rows),
        "products_updated": updated,
        "outbox_enqueued": enqueued,
    }
