"""Shared product / sync types."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional


@dataclass
class ProductRecord:
    sku: str
    quantity: int
    price: Optional[float] = None
    currency: str = "USD"
    msrp: Optional[float] = None
    content_hash: str = ""
    updated_at: str = ""
    raw: Dict[str, Any] = field(default_factory=dict)


@dataclass
class OutboxPayload:
    """Queued work for Shopify worker."""

    sku: str
    inventory_item_id: str
    variant_id: str
    quantity: int
    price: Optional[float] = None
    compare_at_price: Optional[float] = None

    def to_dict(self) -> Dict[str, Any]:
        return {
            "sku": self.sku,
            "inventory_item_id": self.inventory_item_id,
            "variant_id": self.variant_id,
            "quantity": self.quantity,
            "price": self.price,
            "compare_at_price": self.compare_at_price,
        }

    @classmethod
    def from_dict(cls, d: Dict[str, Any]) -> "OutboxPayload":
        return cls(
            sku=str(d["sku"]),
            inventory_item_id=str(d["inventory_item_id"]),
            variant_id=str(d["variant_id"]),
            quantity=int(d["quantity"]),
            price=float(d["price"]) if d.get("price") is not None else None,
            compare_at_price=float(d["compare_at_price"])
            if d.get("compare_at_price") is not None
            else None,
        )


@dataclass
class SynnexLineItem:
    part_number: str
    quantity: int
    unit_price: Optional[float] = None


@dataclass
class PurchaseOrderResult:
    """Result of submitting a PO to TD Synnex (Phase 2)."""

    po_number: str
    status: str = "submitted"
    raw: Dict[str, Any] = field(default_factory=dict)


@dataclass
class InvoiceMetadata:
    """Invoice exposure for Shopify metafields (Phase 3)."""

    order_id: str
    invoice_number: Optional[str] = None
    invoice_date: Optional[str] = None
    pdf_url: Optional[str] = None
    raw: Dict[str, Any] = field(default_factory=dict)
