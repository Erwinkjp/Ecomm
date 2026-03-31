"""
SQS consumer: paid order → TD Synnex PO (Phase 2).
"""

from __future__ import annotations

import asyncio
import json
import logging
from typing import Any, Dict, List

logger = logging.getLogger()
logger.setLevel(logging.INFO)


def _line_items_from_shopify_order(order: Dict[str, Any]) -> List:
    from bridge.models.product import SynnexLineItem

    out: List[SynnexLineItem] = []
    for li in order.get("line_items") or []:
        if not isinstance(li, dict):
            continue
        sku = (li.get("sku") or "").strip()
        if not sku:
            continue
        qty = int(li.get("quantity") or 0)
        price = li.get("price")
        try:
            unit_price = float(price) if price is not None else None
        except (TypeError, ValueError):
            unit_price = None
        out.append(SynnexLineItem(part_number=sku, quantity=qty, unit_price=unit_price))
    return out


def _order_gid(order: Dict[str, Any]) -> str:
    oid = order.get("id")
    if oid is None:
        return ""
    s = str(oid)
    if s.startswith("gid://"):
        return s
    return f"gid://shopify/Order/{s}"


async def _process_record(body: str) -> Dict[str, Any]:
    from bridge.ddb.repositories import OrdersRepository
    from bridge.synnex.orders_client import create_purchase_order

    msg = json.loads(body)
    order = msg.get("payload") or {}
    if not order.get("id"):
        return {"skipped": True, "reason": "no order id"}

    financial = (order.get("financial_status") or "").lower()
    if financial and financial not in ("paid", "partially_paid"):
        return {"skipped": True, "reason": financial}

    lines = _line_items_from_shopify_order(order)
    if not lines:
        return {"skipped": True, "reason": "no line items with SKU"}

    po = await create_purchase_order(order, lines)
    gid = _order_gid(order)

    repo = OrdersRepository()
    repo.put_order(
        gid,
        po_number=po.po_number,
        status="po_submitted",
        payload={"po": po.raw, "order": order.get("id")},
    )
    return {"ok": True, "po_number": po.po_number, "order_gid": gid}


async def _process_all(records: List[Dict[str, Any]]) -> List[Dict[str, str]]:
    failures: List[Dict[str, str]] = []
    for rec in records:
        mid = rec.get("messageId") or ""
        body = rec.get("body") or ""
        try:
            await _process_record(body)
        except Exception as e:  # noqa: BLE001
            logger.exception("order processing failed: %s", e)
            if mid:
                failures.append({"itemIdentifier": mid})
    return failures


def lambda_handler(event: Dict[str, Any], context: Any) -> Dict[str, Any]:
    records = event.get("Records") or []
    failures = asyncio.run(_process_all(records))
    return {"batchItemFailures": failures}
