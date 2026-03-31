"""Scheduled: outbox → Shopify."""

from __future__ import annotations

import asyncio
import json
import logging
from typing import Any, Dict

logger = logging.getLogger()
logger.setLevel(logging.INFO)


def lambda_handler(event: Dict[str, Any], context: Any) -> Dict[str, Any]:
    from bridge.sync.shopify_worker import run_shopify_sync_worker

    try:
        result = asyncio.run(run_shopify_sync_worker())
        return {"statusCode": 200, "body": json.dumps(result)}
    except Exception as e:  # noqa: BLE001
        logger.exception("shopify sync worker failed")
        return {"statusCode": 500, "body": json.dumps({"ok": False, "error": str(e)})}
