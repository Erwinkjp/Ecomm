"""Environment-backed configuration."""

from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Optional


def _truthy(val: str | None, default: bool = False) -> bool:
    if val is None or val == "":
        return default
    return val.strip().lower() in ("1", "true", "yes", "on")


@dataclass(frozen=True)
class ShopifyConfig:
    store: str
    access_token: str
    location_id: str
    api_version: str = "2025-01"


@dataclass(frozen=True)
class SynnexXmlConfig:
    url: str
    customer_no: str
    username: str
    password: str
    request_version: str = ""
    sku_chunk_size: int = 40


def get_shopify_config() -> ShopifyConfig:
    store = os.environ.get("SHOPIFY_STORE", "").strip()
    if not store:
        raise ValueError("SHOPIFY_STORE is required (e.g. your-store.myshopify.com)")
    token = os.environ.get("SHOPIFY_ACCESS_TOKEN", "").strip()
    if not token:
        raise ValueError("SHOPIFY_ACCESS_TOKEN is required")
    loc = os.environ.get("SHOPIFY_LOCATION_ID", "").strip()
    if not loc:
        raise ValueError("SHOPIFY_LOCATION_ID is required")
    api_version = os.environ.get("SHOPIFY_API_VERSION", "2025-01").strip() or "2025-01"
    return ShopifyConfig(
        store=store.replace(".myshopify.com", ""),
        access_token=token,
        location_id=loc,
        api_version=api_version,
    )


def get_synnex_xml_config() -> Optional[SynnexXmlConfig]:
    url = os.environ.get("SYNNEX_XML_URL", "").strip()
    customer = os.environ.get("SYNNEX_XML_CUSTOMER_NO", "").strip()
    user = os.environ.get("SYNNEX_XML_USERNAME", "").strip()
    password = os.environ.get("SYNNEX_XML_PASSWORD", "").strip()
    if not (url and customer and user and password):
        return None
    chunk = int(os.environ.get("SYNNEX_XML_SKU_CHUNK_SIZE", "40") or "40")
    chunk = max(1, min(chunk, 200))
    ver = os.environ.get("SYNNEX_XML_REQUEST_VERSION", "").strip()
    return SynnexXmlConfig(
        url=url,
        customer_no=customer,
        username=user,
        password=password,
        request_version=ver,
        sku_chunk_size=chunk,
    )


def synnex_xml_sync_prices() -> bool:
    return _truthy(os.environ.get("SYNNEX_XML_SYNC_PRICES"), True)


def synnex_xml_msrp_as_compare_at() -> bool:
    return _truthy(os.environ.get("SYNNEX_XML_MSRP_AS_COMPARE_AT"), False)
