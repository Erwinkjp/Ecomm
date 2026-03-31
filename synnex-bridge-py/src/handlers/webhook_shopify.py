"""
API Gateway: Shopify webhooks (orders/paid) → verify HMAC → SQS.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import logging
import os
from typing import Any, Dict

import boto3

logger = logging.getLogger()
logger.setLevel(logging.INFO)


def _verify_shopify_hmac(body: bytes, hmac_header: str | None) -> bool:
    secret = os.environ.get("SHOPIFY_WEBHOOK_SECRET", "").strip()
    if not secret or not hmac_header:
        return False
    digest = hmac.new(secret.encode("utf-8"), body, hashlib.sha256).digest()
    expected = base64.b64encode(digest).decode()
    return hmac.compare_digest(expected, hmac_header)


def lambda_handler(event: Dict[str, Any], context: Any) -> Dict[str, Any]:
    queue_url = os.environ.get("ORDER_WEBHOOK_QUEUE_URL", "").strip()
    if not queue_url:
        return {"statusCode": 500, "body": json.dumps({"error": "ORDER_WEBHOOK_QUEUE_URL not set"})}

    body_b = (event.get("body") or "").encode("utf-8") if isinstance(event.get("body"), str) else b""
    if event.get("isBase64Encoded"):
        body_b = base64.b64decode(event.get("body") or "")

    headers = {k.lower(): v for k, v in (event.get("headers") or {}).items()}
    hmac_header = headers.get("x-shopify-hmac-sha256")

    if not _verify_shopify_hmac(body_b, hmac_header):
        logger.warning("invalid or missing HMAC")
        return {"statusCode": 401, "body": json.dumps({"error": "Unauthorized"})}

    topic = headers.get("x-shopify-topic", "")
    if topic and "orders/" not in topic:
        return {"statusCode": 200, "body": json.dumps({"ignored": True, "topic": topic})}

    try:
        payload = json.loads(body_b.decode("utf-8") or "{}")
    except json.JSONDecodeError:
        return {"statusCode": 400, "body": json.dumps({"error": "Invalid JSON"})}

    sqs = boto3.client("sqs")
    sqs.send_message(QueueUrl=queue_url, MessageBody=json.dumps({"topic": topic, "payload": payload}))

    return {"statusCode": 200, "body": json.dumps({"ok": True})}
