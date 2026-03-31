"""Phase 2: poll Synnex PO status → Shopify order metafields (tracking)."""

from __future__ import annotations

from typing import Any, Dict

from bridge.ddb.repositories import OrdersRepository
from bridge.shopify.client import order_update_metafields
from bridge.synnex.orders_client import poll_po_status


async def run_po_status_sync() -> Dict[str, Any]:
    repo = OrdersRepository()
    rows = repo.list_by_status("po_submitted", limit=40)
    updated = 0
    for row in rows:
        po = row.get("po_number")
        gid = row.get("shopify_order_id")
        if not po or not gid:
            continue
        st = await poll_po_status(str(po))
        status = str(st.get("status") or "")
        tracking = st.get("tracking_number")
        pairs = [("po_status", status)]
        if tracking:
            pairs.append(("tracking_number", str(tracking)))
        carrier = st.get("carrier")
        if carrier:
            pairs.append(("carrier", str(carrier)))
        await order_update_metafields(str(gid), "synnex", pairs)
        if tracking or status in ("stub_shipped", "shipped", "complete"):
            repo.update_status(str(gid), "po_confirmed")
            updated += 1
    return {"ok": True, "checked": len(rows), "confirmed": updated}
