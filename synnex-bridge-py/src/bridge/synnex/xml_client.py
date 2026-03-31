"""
TD Synnex Real-Time XML Price & Availability (P&A).
POST application/x-www-form-urlencoded with xmldata=<XML>.
"""

from __future__ import annotations

import re
from typing import Any, Dict, List, Optional


def _escape_xml(s: str | None) -> str:
    if s is None:
        return ""
    return (
        str(s)
        .replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace('"', "&quot;")
        .replace("'", "&apos;")
    )


def _get_tag(blob: str, name: str) -> str:
    m = re.search(rf"<{re.escape(name)}[^>]*>([^<]*)</{re.escape(name)}>", blob, re.I)
    return m.group(1).strip() if m else ""


def _sum_warehouse_qty(block: str) -> int:
    total = 0
    for m in re.finditer(
        r"<AvailabilityByWarehouse>([\s\S]*?)</AvailabilityByWarehouse>", block, re.I
    ):
        inner = m.group(1)
        q = _get_tag(inner, "qty")
        total += int(q or "0") or 0
    return total


def _parse_availability_by_warehouse(block: str) -> List[Dict[str, Any]]:
    out: List[Dict[str, Any]] = []
    for m in re.finditer(
        r"<AvailabilityByWarehouse>([\s\S]*?)</AvailabilityByWarehouse>", block, re.I
    ):
        wh = m.group(1)
        info_m = re.search(r"<warehouseInfo>([\s\S]*?)</warehouseInfo>", wh, re.I)
        info = info_m.group(1) if info_m else wh
        out.append(
            {
                "warehouse_number": _get_tag(info, "number"),
                "zipcode": _get_tag(info, "zipcode"),
                "city": _get_tag(info, "city"),
                "addr": _get_tag(info, "addr"),
                "qty": int(_get_tag(wh, "qty") or "0") or 0,
                "on_order_quantity": int(_get_tag(wh, "onOrderQuantity"))
                if _get_tag(wh, "onOrderQuantity")
                else None,
                "estimated_arrival_date": _get_tag(wh, "estimatedArrivalDate") or None,
            }
        )
    return out


def parse_price_availability_response(xml_text: str) -> List[Dict[str, Any]]:
    results: List[Dict[str, Any]] = []
    for m in re.finditer(
        r"<PriceAvailabilityList>([\s\S]*?)</PriceAvailabilityList>", xml_text, re.I
    ):
        block = m.group(1)
        part = _get_tag(block, "synnexSKU") or _get_tag(block, "SynnexSKU")
        if not part:
            continue
        status = _get_tag(block, "status") or _get_tag(block, "Status") or ""
        global_status = _get_tag(block, "GlobalProductStatusCode") or ""
        total_qty = _get_tag(block, "totalQuantity")
        if total_qty != "":
            qty_available = int(total_qty) or 0
        else:
            qty_available = _sum_warehouse_qty(block)
        sk = status.lower().replace(" ", "")
        gs = global_status.lower()
        if (
            "notfound" in sk
            or "notauthorized" in sk
            or sk == "discontinued"
            or "discontinued" in gs
        ):
            qty_available = 0
        price_str = _get_tag(block, "price")
        parsed_price: Optional[float] = None
        if price_str != "":
            try:
                parsed_price = float(price_str)
            except ValueError:
                parsed_price = None
        warehouses = _parse_availability_by_warehouse(block)
        msrp_s = _get_tag(block, "msrp")
        msrp: Optional[float] = None
        if msrp_s:
            try:
                msrp = float(msrp_s)
            except ValueError:
                msrp = None
        results.append(
            {
                "part_number": part,
                "quantity_available": qty_available,
                "price": parsed_price,
                "currency": "USD",
                "status": status or None,
                "global_product_status_code": global_status or None,
                "description": _get_tag(block, "description") or None,
                "mfg_pn": _get_tag(block, "mfgPN") or None,
                "mfg_code": _get_tag(block, "mfgCode") or None,
                "msrp": msrp,
                "availability_by_warehouse": warehouses or None,
            }
        )
    return [r for r in results if r.get("part_number")]


def build_price_availability_request(
    part_numbers: List[str],
    xml_cfg,
) -> str:
    version_attr = ""
    if getattr(xml_cfg, "request_version", None) and str(xml_cfg.request_version).strip():
        v = _escape_xml(str(xml_cfg.request_version).strip())
        version_attr = f' version="{v}"'
    sku_lists = "".join(
        f"<skuList><synnexSKU>{_escape_xml(sku)}</synnexSKU>"
        f"<lineNumber>{i + 1}</lineNumber></skuList>"
        for i, sku in enumerate(part_numbers)
    )
    return f"""<?xml version="1.0" encoding="UTF-8"?>
<priceRequest{version_attr}>
  <customerNo>{_escape_xml(xml_cfg.customer_no)}</customerNo>
  <userName>{_escape_xml(xml_cfg.username)}</userName>
  <password>{_escape_xml(xml_cfg.password)}</password>
  {sku_lists}
</priceRequest>"""


def _chunk(items: List[str], size: int) -> List[List[str]]:
    return [items[i : i + size] for i in range(0, len(items), size)]


async def get_price_availability_from_xml(
    part_numbers: List[str],
    xml_cfg,
) -> List[Dict[str, Any]]:
    import httpx

    if not part_numbers:
        return []
    chunk_size = getattr(xml_cfg, "sku_chunk_size", 40) or 40
    merged: List[Dict[str, Any]] = []
    async with httpx.AsyncClient(timeout=120.0) as client:
        for chunk in _chunk(part_numbers, chunk_size):
            xml_body = build_price_availability_request(chunk, xml_cfg)
            body = {"xmldata": xml_body}
            r = await client.post(
                xml_cfg.url,
                data=body,
                headers={"Content-Type": "application/x-www-form-urlencoded"},
            )
            text = r.text
            if r.status_code >= 400:
                raise RuntimeError(f"Synnex XML P&A error {r.status_code}: {text[:500]}")
            parsed = parse_price_availability_response(text)
            if not parsed and text.strip():
                if re.search(r"error|fault|invalid", text, re.I):
                    raise RuntimeError(f"Synnex XML response error: {text[:500]}")
            merged.extend(parsed)
    return merged


def is_xml_configured(xml_cfg) -> bool:
    return xml_cfg is not None
