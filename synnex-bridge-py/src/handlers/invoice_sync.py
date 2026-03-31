"""Scheduled: invoice metadata → Shopify order metafields."""

from __future__ import annotations

import asyncio
import json
import logging
from typing import Any, Dict

from bridge.sync.invoice_sync import run_invoice_sync

logger = logging.getLogger()
logger.setLevel(logging.INFO)


def lambda_handler(event: Dict[str, Any], context: Any) -> Dict[str, Any]:
    try:
        result = asyncio.run(run_invoice_sync())
        return {"statusCode": 200, "body": json.dumps(result)}
    except Exception as e:  # noqa: BLE001
        logger.exception("invoice_sync failed")
        return {"statusCode": 500, "body": json.dumps({"ok": False, "error": str(e)})}
