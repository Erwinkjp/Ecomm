"""Phase 3: invoice metadata → Shopify order metafields."""

from __future__ import annotations

import os
from typing import Any, Dict

from bridge.ddb.repositories import OrdersRepository
from bridge.shopify.client import order_update_metafields
from bridge.synnex.orders_client import fetch_invoice_metadata


async def run_invoice_sync() -> Dict[str, Any]:
    if not os.environ.get("SYNNEX_INVOICE_BASE_URL", "").strip():
        return {
            "ok": True,
            "skipped": True,
            "reason": "SYNNEX_INVOICE_BASE_URL not set (configure for Phase 3)",
        }

    repo = OrdersRepository()
    rows = repo.list_needing_invoice(limit=40)
    synced = 0
    for row in rows:
        gid = row.get("shopify_order_id")
        po = row.get("po_number")
        if not gid or not po:
            continue
        numeric = str(gid).split("/")[-1] if gid else ""
        inv = await fetch_invoice_metadata(str(po), numeric)
        if not inv:
            continue
        pairs = []
        if inv.invoice_number:
            pairs.append(("invoice_number", inv.invoice_number))
        if inv.invoice_date:
            pairs.append(("invoice_date", inv.invoice_date))
        if inv.pdf_url:
            pairs.append(("invoice_pdf_url", inv.pdf_url))
        if not pairs:
            continue
        await order_update_metafields(str(gid), "synnex_invoice", pairs)
        repo.mark_invoice_synced(str(gid))
        synced += 1
    return {"ok": True, "candidates": len(rows), "invoice_metafields_set": synced}
