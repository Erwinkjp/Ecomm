"""
TD Synnex order / PO / invoice surface (REST or account-specific APIs).

Replace stubs with real HTTP calls when your account exposes endpoints.
"""

from __future__ import annotations

import json
import os
import uuid
from typing import Any, Dict, List, Optional

import httpx

from bridge.models.product import InvoiceMetadata, PurchaseOrderResult, SynnexLineItem


async def create_purchase_order(
    shopify_order: Dict[str, Any],
    line_items: List[SynnexLineItem],
) -> PurchaseOrderResult:
    """
    Submit a purchase order to TD Synnex (Phase 2).

    Default: POST to SYNNEX_PO_BASE_URL if set; otherwise returns a deterministic stub
    for integration testing (no network).
    """
    base = os.environ.get("SYNNEX_PO_BASE_URL", "").strip()
    key = os.environ.get("SYNNEX_API_KEY", "").strip()
    if base and key:
        payload = {
            "shopify_order_id": shopify_order.get("id"),
            "line_items": [
                {
                    "part_number": li.part_number,
                    "quantity": li.quantity,
                    "unit_price": li.unit_price,
                }
                for li in line_items
            ],
        }
        headers = {"Authorization": f"Bearer {key}", "Content-Type": "application/json"}
        async with httpx.AsyncClient(timeout=60.0) as client:
            r = await client.post(f"{base.rstrip('/')}/purchase-orders", json=payload, headers=headers)
        r.raise_for_status()
        data = r.json()
        return PurchaseOrderResult(
            po_number=str(data.get("po_number") or data.get("id") or ""),
            status=str(data.get("status") or "submitted"),
            raw=data if isinstance(data, dict) else {"body": data},
        )

    stub_po = f"STUB-PO-{uuid.uuid4().hex[:12].upper()}"
    return PurchaseOrderResult(
        po_number=stub_po,
        status="stub",
        raw={"order": shopify_order.get("id"), "lines": len(line_items)},
    )


async def poll_po_status(po_number: str) -> Dict[str, Any]:
    """Poll Synnex for PO status and tracking (Phase 2 fulfillment back-sync)."""
    base = os.environ.get("SYNNEX_PO_BASE_URL", "").strip()
    key = os.environ.get("SYNNEX_API_KEY", "").strip()
    if base and key:
        async with httpx.AsyncClient(timeout=30.0) as client:
            r = await client.get(
                f"{base.rstrip('/')}/purchase-orders/{po_number}",
                headers={"Authorization": f"Bearer {key}"},
            )
        if r.status_code == 404:
            return {"status": "unknown", "tracking": None}
        r.raise_for_status()
        return r.json() if r.headers.get("content-type", "").startswith("application/json") else {"raw": r.text}

    return {"status": "stub_shipped", "tracking_number": None, "carrier": None}


async def fetch_invoice_metadata(
    po_number: str,
    shopify_order_numeric_id: str,
) -> Optional[InvoiceMetadata]:
    """
    Phase 3: invoice metadata for Shopify metafields.

    If SYNNEX_INVOICE_BASE_URL + SYNNEX_API_KEY are set, GET invoice by PO.
    Otherwise returns None (no-op).
    """
    base = os.environ.get("SYNNEX_INVOICE_BASE_URL", "").strip()
    key = os.environ.get("SYNNEX_API_KEY", "").strip()
    if not (base and key):
        return None
    url = f"{base.rstrip('/')}/invoices"
    params = {"po": po_number}
    async with httpx.AsyncClient(timeout=30.0) as client:
        r = await client.get(url, params=params, headers={"Authorization": f"Bearer {key}"})
    if r.status_code == 404:
        return None
    r.raise_for_status()
    try:
        data = r.json()
    except json.JSONDecodeError:
        return None
    invoice_number = data.get("invoice_number") or data.get("number")
    invoice_date = data.get("invoice_date") or data.get("date")
    pdf_url = data.get("pdf_url") or data.get("url")
    return InvoiceMetadata(
        order_id=shopify_order_numeric_id,
        invoice_number=str(invoice_number) if invoice_number else None,
        invoice_date=str(invoice_date) if invoice_date else None,
        pdf_url=str(pdf_url) if pdf_url else None,
        raw=data if isinstance(data, dict) else {},
    )
