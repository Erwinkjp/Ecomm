"""DynamoDB repositories (products, sync state, outbox, orders)."""

from __future__ import annotations

import json
import os
import time
import uuid
from decimal import Decimal
from typing import Any, Dict, List, Optional

import boto3
from boto3.dynamodb.conditions import Attr, Key

from bridge.models.product import OutboxPayload


def _table_name(env_key: str) -> str:
    name = os.environ.get(env_key, "").strip()
    if not name:
        raise ValueError(f"{env_key} is required")
    return name


def _to_decimals(obj: Any) -> Any:
    if isinstance(obj, float):
        return Decimal(str(obj))
    if isinstance(obj, dict):
        return {k: _to_decimals(v) for k, v in obj.items()}
    if isinstance(obj, list):
        return [_to_decimals(v) for v in obj]
    return obj


class ProductsRepository:
    def __init__(self) -> None:
        self._ddb = boto3.resource("dynamodb")
        self._table = self._ddb.Table(_table_name("PRODUCTS_TABLE_NAME"))

    def put_product(
        self,
        sku: str,
        quantity: int,
        price: Optional[float],
        content_hash: str,
        raw: Optional[Dict[str, Any]] = None,
    ) -> None:
        now = str(int(time.time()))
        item: Dict[str, Any] = {
            "sku": sku,
            "quantity": quantity,
            "content_hash": content_hash,
            "updated_at": now,
        }
        if price is not None:
            item["price"] = Decimal(str(price))
        if raw:
            item["raw_json"] = json.dumps(raw, default=str)
        self._table.put_item(Item=item)

    def get_product(self, sku: str) -> Optional[Dict[str, Any]]:
        r = self._table.get_item(Key={"sku": sku})
        return r.get("Item")


class SyncStateRepository:
    def __init__(self) -> None:
        self._ddb = boto3.resource("dynamodb")
        self._table = self._ddb.Table(_table_name("SYNC_STATE_TABLE_NAME"))

    def get_state(self, pk: str) -> Optional[Dict[str, Any]]:
        r = self._table.get_item(Key={"pk": pk})
        return r.get("Item")

    def put_state(self, pk: str, data: Dict[str, Any]) -> None:
        item = {"pk": pk, **data}
        self._table.put_item(Item=item)


class OutboxRepository:
    STATUS_PENDING = "pending"
    STATUS_DONE = "done"
    STATUS_FAILED = "failed"

    def __init__(self) -> None:
        self._ddb = boto3.resource("dynamodb")
        self._table = self._ddb.Table(_table_name("OUTBOX_TABLE_NAME"))

    def enqueue(self, payload: OutboxPayload) -> str:
        oid = str(uuid.uuid4())
        now = int(time.time())
        item = {
            "id": oid,
            "status": self.STATUS_PENDING,
            "created_at": now,
            "sku": payload.sku,
            "payload": _to_decimals(payload.to_dict()),
        }
        self._table.put_item(Item=item)
        return oid

    def list_pending(self, limit: int = 25) -> List[Dict[str, Any]]:
        """Query GSI status + created_at."""
        r = self._table.query(
            IndexName="StatusIndex",
            KeyConditionExpression=Key("status").eq(self.STATUS_PENDING),
            ScanIndexForward=True,
            Limit=limit,
        )
        return r.get("Items", [])

    def mark_done(self, outbox_id: str) -> None:
        self._table.update_item(
            Key={"id": outbox_id},
            UpdateExpression="SET #s = :d",
            ExpressionAttributeNames={"#s": "status"},
            ExpressionAttributeValues={":d": self.STATUS_DONE},
        )

    def mark_failed(self, outbox_id: str, error: str) -> None:
        self._table.update_item(
            Key={"id": outbox_id},
            UpdateExpression="SET #s = :f, last_error = :e",
            ExpressionAttributeNames={"#s": "status"},
            ExpressionAttributeValues={
                ":f": self.STATUS_FAILED,
                ":e": error[:2000],
            },
        )


class OrdersRepository:
    """Shopify order id → PO / fulfillment state (Phase 2–3)."""

    def __init__(self) -> None:
        self._ddb = boto3.resource("dynamodb")
        self._table = self._ddb.Table(_table_name("ORDERS_TABLE_NAME"))

    def put_order(
        self,
        shopify_order_id: str,
        po_number: Optional[str] = None,
        status: str = "pending_po",
        payload: Optional[Dict[str, Any]] = None,
    ) -> None:
        now = str(int(time.time()))
        item: Dict[str, Any] = {
            "shopify_order_id": shopify_order_id,
            "status": status,
            "updated_at": now,
        }
        if po_number:
            item["po_number"] = po_number
        if payload:
            item["payload_json"] = json.dumps(payload, default=str)
        self._table.put_item(Item=item)

    def get_order(self, shopify_order_id: str) -> Optional[Dict[str, Any]]:
        r = self._table.get_item(Key={"shopify_order_id": shopify_order_id})
        return r.get("Item")

    def update_po(self, shopify_order_id: str, po_number: str, status: str) -> None:
        self._table.update_item(
            Key={"shopify_order_id": shopify_order_id},
            UpdateExpression="SET po_number = :p, #s = :st, updated_at = :u",
            ExpressionAttributeNames={"#s": "status"},
            ExpressionAttributeValues={
                ":p": po_number,
                ":st": status,
                ":u": str(int(time.time())),
            },
        )

    def list_by_status(self, status: str, limit: int = 50) -> List[Dict[str, Any]]:
        r = self._table.scan(
            FilterExpression=Attr("status").eq(status),
            Limit=limit,
        )
        return r.get("Items", [])

    def list_needing_invoice(self, limit: int = 50) -> List[Dict[str, Any]]:
        """Orders with PO but no invoice metafield synced yet."""
        r = self._table.scan(
            FilterExpression=Attr("status").eq("po_confirmed")
            & Attr("invoice_synced").not_exists(),
            Limit=limit,
        )
        return r.get("Items", [])

    def mark_invoice_synced(self, shopify_order_id: str) -> None:
        self._table.update_item(
            Key={"shopify_order_id": shopify_order_id},
            UpdateExpression="SET invoice_synced = :t, updated_at = :u",
            ExpressionAttributeValues={":t": True, ":u": str(int(time.time()))},
        )

    def update_status(self, shopify_order_id: str, status: str) -> None:
        self._table.update_item(
            Key={"shopify_order_id": shopify_order_id},
            UpdateExpression="SET #s = :st, updated_at = :u",
            ExpressionAttributeNames={"#s": "status"},
            ExpressionAttributeValues={":st": status, ":u": str(int(time.time()))},
        )
