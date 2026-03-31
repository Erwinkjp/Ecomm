"""Scheduled: Synnex PO status → Shopify order metafields."""

from __future__ import annotations

import asyncio
import json
import logging
from typing import Any, Dict

from bridge.sync.po_status import run_po_status_sync

logger = logging.getLogger()
logger.setLevel(logging.INFO)


def lambda_handler(event: Dict[str, Any], context: Any) -> Dict[str, Any]:
    try:
        result = asyncio.run(run_po_status_sync())
        return {"statusCode": 200, "body": json.dumps(result)}
    except Exception as e:  # noqa: BLE001
        logger.exception("po_status_sync failed")
        return {"statusCode": 500, "body": json.dumps({"ok": False, "error": str(e)})}
