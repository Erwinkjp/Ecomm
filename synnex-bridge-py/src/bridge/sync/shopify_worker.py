"""Drain outbox → Shopify inventory + optional price updates."""

from __future__ import annotations

from decimal import Decimal
from typing import Any, Dict, List

from bridge.ddb.repositories import OutboxRepository
from bridge.models.product import OutboxPayload
from bridge.shopify.client import inventory_set_quantities, update_variant_pricing


def _sanitize(obj: Any) -> Any:
    if isinstance(obj, Decimal):
        if obj % 1 == 0:
            return int(obj)
        return float(obj)
    if isinstance(obj, dict):
        return {k: _sanitize(v) for k, v in obj.items()}
    if isinstance(obj, list):
        return [_sanitize(v) for v in obj]
    return obj


async def run_shopify_sync_worker(batch_size: int = 25) -> Dict[str, Any]:
    outbox = OutboxRepository()
    pending = outbox.list_pending(limit=batch_size)
    if not pending:
        return {"ok": True, "processed": 0, "message": "No pending outbox items"}

    jobs: List[tuple[str, OutboxPayload]] = []
    inventory_batch: List[Dict[str, Any]] = []

    for item in pending:
        oid = item["id"]
        raw = _sanitize(item.get("payload") or {})
        if not isinstance(raw, dict):
            outbox.mark_failed(oid, "payload not a map")
            continue
        try:
            payload = OutboxPayload.from_dict(raw)
        except (KeyError, TypeError, ValueError) as e:
            outbox.mark_failed(oid, f"bad payload: {e}")
            continue
        inventory_batch.append(
            {
                "inventory_item_id": payload.inventory_item_id,
                "quantity": payload.quantity,
            }
        )
        jobs.append((oid, payload))

    try:
        await inventory_set_quantities(inventory_batch)
    except Exception as e:  # noqa: BLE001
        for oid, _ in jobs:
            outbox.mark_failed(oid, f"inventory: {e}")
        return {"ok": False, "error": str(e), "failed": len(jobs)}

    prices_updated = 0
    done = 0
    for oid, payload in jobs:
        try:
            if payload.price is not None:
                await update_variant_pricing(
                    payload.variant_id,
                    payload.price,
                    payload.compare_at_price,
                )
                prices_updated += 1
            outbox.mark_done(oid)
            done += 1
        except Exception as e:  # noqa: BLE001
            outbox.mark_failed(oid, str(e))

    return {
        "ok": True,
        "processed": done,
        "prices_updated": prices_updated,
    }
