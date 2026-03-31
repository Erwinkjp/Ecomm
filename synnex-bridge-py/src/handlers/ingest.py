"""Scheduled: Synnex XML → DynamoDB + outbox."""

from __future__ import annotations

import asyncio
import json
import logging
from typing import Any, Dict

logger = logging.getLogger()
logger.setLevel(logging.INFO)


def lambda_handler(event: Dict[str, Any], context: Any) -> Dict[str, Any]:
    from bridge.sync.ingest import run_ingest

    try:
        result = asyncio.run(run_ingest())
        return {"statusCode": 200, "body": json.dumps(result)}
    except Exception as e:  # noqa: BLE001
        logger.exception("ingest failed")
        return {"statusCode": 500, "body": json.dumps({"ok": False, "error": str(e)})}
