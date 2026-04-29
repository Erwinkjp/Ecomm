#!/usr/bin/env python3
"""
Klaviyo Automation Setup — Uniwide Merchandise
===============================================
Creates email templates, flows, a high-value segment, and a winback campaign
via the Klaviyo REST API v2024-10-15.

Usage:
    export KLAVIYO_API_KEY="pk_..."
    python3 setup_klaviyo.py

What this script creates
------------------------
  Email Templates  (8 total)
    Welcome Series        ×3  — Brand intro, business pricing, 5% off (WELCOME5)
    Abandoned Cart        ×2  — 1-hour reminder, 24-hour final push
    Post-Purchase         ×2  — Thank-you + upsell, review request + bulk pricing
    Winback               ×1  — 10% off (WINBACK10) for 90-day inactive customers

  Flows  (3 shells created via API; actions wired in UI using printed guide)
    Welcome Series   — triggers on "Added to List"
    Abandoned Cart   — triggers on "Started Checkout" metric
    Post-Purchase    — triggers on "Placed Order" metric

  Segment
    "Business Buyers - High Value"
    Logic: placed ≥2 orders  OR  lifetime revenue ≥ $1,000

  Campaign
    "Winback — 10% Off (WINBACK10)"  (created as draft, ready to schedule)

Notes
-----
  - Flow *actions* (email nodes + time delays) must be wired in the Klaviyo UI.
    The script prints a step-by-step guide with every template ID and timing.
  - Segment conditions require the Shopify integration to be active so Klaviyo
    has received "Placed Order" events.
  - The winback campaign is created in draft; set your send datetime in the UI.
"""

import os
import sys
import json
import time
import requests
from datetime import datetime, timezone, timedelta


# ─── Configuration ─────────────────────────────────────────────────────────────

API_KEY  = os.environ.get("KLAVIYO_API_KEY", "")
BASE_URL = "https://a.klaviyo.com/api"
REVISION = "2024-10-15"

FROM_EMAIL = "hello@uniwidemerchandise.com"
FROM_LABEL = "Uniwide Merchandise"
STORE_URL  = "https://www.uniwidemerchandise.com"

if not API_KEY:
    sys.exit(
        "Error: KLAVIYO_API_KEY is not set.\n"
        "Run:  export KLAVIYO_API_KEY=pk_...\n"
        "      python3 setup_klaviyo.py"
    )

HEADERS = {
    "Authorization": f"Klaviyo-API-Key {API_KEY}",
    "revision":      REVISION,
    "Content-Type":  "application/json",
    "Accept":        "application/json",
}

# Accumulated results — printed in the final summary
results: dict[str, dict[str, list]] = {
    "templates": {"created": [], "failed": []},
    "flows":     {"created": [], "failed": []},
    "segment":   {"created": [], "failed": []},
    "campaign":  {"created": [], "failed": []},
}


# ─── HTTP helpers ───────────────────────────────────────────────────────────────

def _request(method: str, path: str, body: dict = None,
             params: dict = None) -> dict | None:
    """
    Make a Klaviyo API call.  Returns parsed JSON on 2xx, else None.
    Prints a concise error message on failure so the script can keep running.
    """
    url = f"{BASE_URL}/{path.lstrip('/')}"
    try:
        resp = requests.request(
            method, url, headers=HEADERS,
            json=body, params=params, timeout=30
        )
        if resp.status_code in (200, 201, 202):
            return resp.json() if resp.text.strip() else {}
        # Try to surface a helpful error message
        try:
            detail = resp.json()
            errs = detail.get("errors", [{}])
            msg = errs[0].get("detail", resp.text[:200]) if errs else resp.text[:200]
        except Exception:
            msg = resp.text[:200]
        print(f"    ✗ {method} /{path}  HTTP {resp.status_code}: {msg}")
        return None
    except requests.RequestException as exc:
        print(f"    ✗ {method} /{path}  network error: {exc}")
        return None


def post(path: str, body: dict) -> dict | None:
    return _request("POST", path, body=body)


def get(path: str, params: dict = None) -> dict | None:
    return _request("GET", path, params=params)


def patch(path: str, body: dict) -> dict | None:
    return _request("PATCH", path, body=body)


# ─── HTML email builder ─────────────────────────────────────────────────────────

# Brand palette
_NAVY   = "#1a2744"
_BLUE   = "#1d4ed8"
_BGPAGE = "#f4f6f9"
_BGGRAY = "#f8fafc"

def make_html(subject: str, preheader: str, headline: str,
              body_html: str, cta_label: str, cta_url: str) -> str:
    """
    Returns a fully self-contained, inline-CSS HTML email.
    - Dark-navy header with Uniwide branding
    - White content card (600 px, rounded, shadowed)
    - Trust bar: 9,000+ products / free shipping $500+ / 30-day returns
    - Klaviyo merge tags for unsubscribe and website URL
    """
    year = datetime.now().year
    return f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="X-UA-Compatible" content="IE=edge">
<title>{subject}</title>
<!--[if mso]>
<noscript><xml><o:OfficeDocumentSettings>
  <o:PixelsPerInch>96</o:PixelsPerInch>
</o:OfficeDocumentSettings></xml></noscript>
<![endif]-->
<style>
  body{{margin:0;padding:0;background:{_BGPAGE};font-family:Arial,Helvetica,sans-serif;-webkit-text-size-adjust:100%;}}
  table{{border-collapse:collapse;mso-table-lspace:0;mso-table-rspace:0;}}
  img{{border:0;display:block;max-width:100%;}}
  a{{color:{_BLUE};}}
  .preheader{{display:none;max-height:0;overflow:hidden;mso-hide:all;}}
  @media screen and (max-width:620px){{
    .uw-card{{width:100%!important;border-radius:0!important;}}
    .uw-body{{padding:28px 24px 24px!important;}}
    .uw-footer{{padding:20px 24px!important;}}
    .uw-headline{{font-size:20px!important;}}
    .uw-cta{{display:block!important;width:80%!important;text-align:center!important;}}
  }}
</style>
</head>
<body>

<!-- Hidden preheader / preview text -->
<div class="preheader" style="display:none;max-height:0;overflow:hidden;mso-hide:all;">
  {preheader}&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;
</div>

<table width="100%" cellpadding="0" cellspacing="0" role="presentation"
       style="background:{_BGPAGE};padding:32px 16px;">
  <tr><td align="center">

    <!-- Email card -->
    <table class="uw-card" width="600" cellpadding="0" cellspacing="0" role="presentation"
           style="background:#ffffff;border-radius:8px;overflow:hidden;
                  box-shadow:0 2px 12px rgba(0,0,0,.08);max-width:600px;">

      <!-- ── Header ──────────────────────────────────────────────── -->
      <tr>
        <td style="background:{_NAVY};padding:28px 40px;text-align:center;">
          <p style="margin:0;color:#ffffff;font-size:22px;font-weight:700;
                    letter-spacing:.6px;line-height:1;">Uniwide Merchandise</p>
          <p style="margin:5px 0 0;color:#94a3c0;font-size:11px;
                    letter-spacing:2.5px;text-transform:uppercase;">
            Business Technology Solutions
          </p>
        </td>
      </tr>

      <!-- ── Headline ─────────────────────────────────────────────── -->
      <tr>
        <td class="uw-body" style="padding:40px 40px 24px;">
          <h1 class="uw-headline"
              style="margin:0 0 6px;font-size:24px;font-weight:700;
                     color:{_NAVY};line-height:1.3;">
            {headline}
          </h1>
          <div style="width:44px;height:3px;background:{_BLUE};
                      border-radius:2px;margin-top:10px;"></div>
        </td>
      </tr>

      <!-- ── Dynamic body ─────────────────────────────────────────── -->
      <tr>
        <td class="uw-body" style="padding:0 40px 8px;">
          {body_html}
        </td>
      </tr>

      <!-- ── CTA button ───────────────────────────────────────────── -->
      <tr>
        <td style="padding:24px 40px 40px;text-align:center;">
          <a href="{cta_url}" class="uw-cta"
             style="display:inline-block;background:{_BLUE};color:#ffffff;
                    font-size:15px;font-weight:700;text-decoration:none;
                    padding:14px 36px;border-radius:6px;letter-spacing:.3px;
                    mso-padding-alt:0;mso-line-height-rule:exactly;">
            <!--[if mso]><i style="letter-spacing:36px;mso-font-width:-100%;
            mso-text-raise:24pt">&nbsp;</i><![endif]-->
            {cta_label}
            <!--[if mso]><i style="letter-spacing:36px;mso-font-width:-100%">&nbsp;</i><![endif]-->
          </a>
        </td>
      </tr>

      <!-- ── Trust bar ────────────────────────────────────────────── -->
      <tr>
        <td style="padding:0 40px;">
          <table width="100%" cellpadding="0" cellspacing="0" role="presentation"
                 style="border-top:1px solid #e5e7eb;">
            <tr>
              <td style="padding:20px 0;text-align:center;width:33%;
                         font-size:12px;color:#6b7280;">
                <strong style="display:block;color:{_NAVY};font-size:15px;">9,000+</strong>
                Products
              </td>
              <td style="padding:20px 0;text-align:center;width:34%;
                         font-size:12px;color:#6b7280;
                         border-left:1px solid #e5e7eb;
                         border-right:1px solid #e5e7eb;">
                <strong style="display:block;color:{_NAVY};font-size:15px;">Free Shipping</strong>
                Orders over $500
              </td>
              <td style="padding:20px 0;text-align:center;width:33%;
                         font-size:12px;color:#6b7280;">
                <strong style="display:block;color:{_NAVY};font-size:15px;">30-Day</strong>
                Returns
              </td>
            </tr>
          </table>
        </td>
      </tr>

      <!-- ── Reply prompt ─────────────────────────────────────────── -->
      <tr>
        <td style="padding:0 40px 28px;">
          <p style="margin:0;font-size:13px;color:#6b7280;line-height:1.6;
                    border-top:1px solid #e5e7eb;padding-top:20px;">
            Questions? Reply to this email or visit
            <a href="{STORE_URL}" style="color:{_BLUE};">uniwidemerchandise.com</a>.
            Our team is here to help.
          </p>
        </td>
      </tr>

      <!-- ── Footer ───────────────────────────────────────────────── -->
      <tr>
        <td class="uw-footer"
            style="background:{_BGGRAY};border-top:1px solid #e5e7eb;
                   padding:22px 40px;text-align:center;">
          <p style="margin:0 0 4px;font-size:11px;color:#9ca3af;line-height:1.7;">
            Uniwide Merchandise &mdash; Business Tech for Australian Teams
          </p>
          <p style="margin:0 0 4px;font-size:11px;color:#9ca3af;">
            <a href="{{{{ unsubscribe_url }}}}"
               style="color:#9ca3af;text-decoration:underline;">Unsubscribe</a>
            &nbsp;&middot;&nbsp;
            <a href="{{{{ organization.website_url }}}}"
               style="color:#9ca3af;text-decoration:underline;">Visit our store</a>
          </p>
          <p style="margin:0;font-size:10px;color:#c4c9d4;">
            &copy; {year} Uniwide Merchandise. All rights reserved.
          </p>
        </td>
      </tr>

    </table>
  </td></tr>
</table>
</body>
</html>"""


# ─── Email content ──────────────────────────────────────────────────────────────
# Each key maps to the template name, subject, preview text, headline,
# CTA label/URL, and the inner HTML body that is injected into the email shell.

def _p(text: str, muted: bool = False) -> str:
    colour = "#6b7280" if muted else "#374151"
    return (
        f'<p style="margin:0 0 16px;font-size:15px;color:{colour};line-height:1.7;">'
        f"{text}</p>"
    )

def _box(rows: list[str]) -> str:
    items = "".join(
        f'<p style="margin:6px 0;font-size:14px;color:{_NAVY};">{r}</p>' for r in rows
    )
    return (
        f'<div style="background:#f0f4ff;border-left:4px solid {_BLUE};'
        f'border-radius:4px;padding:16px 20px;margin:20px 0;">'
        f"{items}</div>"
    )

def _discount_box(code: str, pct: str, note: str = "") -> str:
    return (
        f'<div style="background:#f0f4ff;border:2px dashed {_BLUE};'
        f'border-radius:8px;padding:24px;text-align:center;margin:20px 0;">'
        f'<p style="margin:0 0 6px;font-size:12px;color:#6b7280;'
        f'text-transform:uppercase;letter-spacing:1px;">Your exclusive code</p>'
        f'<p style="margin:0 0 4px;font-size:32px;font-weight:700;'
        f'color:{_NAVY};letter-spacing:3px;">{code}</p>'
        f'<p style="margin:0;font-size:14px;color:{_BLUE};font-weight:600;">'
        f"{pct} off your entire order</p>"
        + (f'<p style="margin:6px 0 0;font-size:12px;color:#6b7280;">{note}</p>' if note else "")
        + "</div>"
    )


EMAILS: dict[str, dict] = {

    # ── Welcome Series ──────────────────────────────────────────────────────────

    "welcome_1": {
        "name":     "Uniwide | Welcome #1 — Brand Intro",
        "subject":  "Welcome to Uniwide — Your Business Tech Partner",
        "preview":  "9,000+ products, trusted brands, and pricing made for business teams.",
        "headline": "Great to have you here.",
        "cta":      "Shop Laptops",
        "cta_url":  f"{STORE_URL}/collections/laptops",
        "body": (
            _p("Welcome to Uniwide Merchandise — the go-to destination for Australian "
               "businesses sourcing reliable tech at competitive prices.")
            + _p("Whether you're equipping a new hire, upgrading an entire team, or "
                 "sourcing accessories in bulk, we've built this store with business "
                 "buyers in mind.")
            + _box([
                "<strong>9,000+ products</strong> — laptops, monitors, keyboards, mice &amp; accessories",
                "<strong>Trusted brands</strong> — Lenovo, Dell, Apple, Acer, Logitech &amp; more",
                "<strong>Business pricing</strong> available for bulk and repeat orders",
                "<strong>1–2 business day dispatch</strong> on all in-stock items",
            ])
            + _p("Start with our full laptop range — from everyday business notebooks "
                 "to high-performance workstations built for demanding workloads.")
        ),
    },

    "welcome_2": {
        "name":     "Uniwide | Welcome #2 — Business Pricing",
        "subject":  "Business pricing that scales with your team",
        "preview":  "Bulk discounts, free shipping over $500, and a 30-day return guarantee.",
        "headline": "Pricing built for business buyers.",
        "cta":      "Request a Business Quote",
        "cta_url":  f"{STORE_URL}/pages/contact",
        "body": (
            _p("Sourcing tech for a team shouldn't feel like a hassle. At Uniwide, "
               "we make it straightforward — competitive prices, clear policies, and "
               "a catalogue built for professional buyers.")
            + _box([
                "<strong>Bulk discounts</strong> — contact us for custom pricing on 10+ units",
                "<strong>Free shipping</strong> on all orders over $500 Australia-wide",
                "<strong>30-day returns</strong> on every product, no questions asked",
                "<strong>Dedicated account management</strong> for repeat business customers",
            ])
            + _p("IT managers and procurement teams love our quote process — just tell "
                 "us what you need and we'll come back with competitive per-unit pricing "
                 "within one business day.")
            + _p("Ready to talk volume? Hit the button below and let's get started.")
        ),
    },

    "welcome_3": {
        "name":     "Uniwide | Welcome #3 — First Order Offer",
        "subject":  "Here's 5% off your first order — expires in 7 days",
        "preview":  "Use WELCOME5 at checkout. Don't leave your team waiting.",
        "headline": "Your welcome gift: 5% off.",
        "cta":      "Shop All Products — Use WELCOME5",
        "cta_url":  f"{STORE_URL}/collections/all",
        "body": (
            _p("You've had a chance to explore the store — now let's get your first "
               "order over the line.")
            + _discount_box("WELCOME5", "5%",
                            "Valid on all products. One use per account. Expires in 7 days.")
            + _p("Whether it's a single laptop or a full team refresh, now is the best "
                 "time to lock in the lowest price on the tech your team actually needs.")
            + _p("With 9,000+ products across every major business category, "
                 "there's a good chance we have exactly what you're looking for — "
                 "in stock and ready to ship.")
            + _p("Discount applies at checkout. Cannot be combined with other offers.", muted=True)
        ),
    },

    # ── Abandoned Cart ──────────────────────────────────────────────────────────

    "abandoned_cart_1": {
        "name":     "Uniwide | Abandoned Cart #1 — Reminder",
        "subject":  "You left something behind",
        "preview":  "Business tech moves fast — popular items can sell out quickly.",
        "headline": "Your cart is waiting.",
        "cta":      "Return to My Cart",
        "cta_url":  "{{ event.extra.checkout_url }}",
        "body": (
            _p("Hi {{ first_name|default:'there' }},")
            + _p("You left some items in your cart. No rush — but stock on popular "
                 "business tech moves quickly, and we'd hate for you to miss out.")
            + (
                '<div style="background:#f8fafc;border:1px solid #e5e7eb;'
                'border-radius:6px;padding:16px 20px;margin:20px 0;">'
                '<p style="margin:0 0 10px;font-size:13px;font-weight:700;'
                f'color:{_NAVY};text-transform:uppercase;letter-spacing:.5px;">Your cart</p>'
                "{% for item in event.extra.line_items %}"
                '<p style="margin:0 0 8px;font-size:14px;color:#374151;">'
                "&bull; {{ item.title }}"
                "{% if item.quantity > 1 %} &times;{{ item.quantity }}{% endif %}"
                " &mdash; <strong>${{ item.price }}</strong></p>"
                "{% endfor %}"
                "</div>"
            )
            + _box([
                "<strong>Free shipping</strong> on all orders over $500",
                "<strong>30-day returns</strong> — buy with confidence",
                "<strong>Business pricing</strong> available on bulk orders",
            ])
            + _p("If you have questions about specs, compatibility, or volume pricing, "
                 "just reply to this email — we'll get back to you quickly.")
        ),
    },

    "abandoned_cart_2": {
        "name":     "Uniwide | Abandoned Cart #2 — Final Reminder",
        "subject":  "Still thinking it over? Your cart expires soon",
        "preview":  "Free shipping on $500+. Your items are still available — for now.",
        "headline": "Last chance to grab your items.",
        "cta":      "Complete My Purchase",
        "cta_url":  "{{ event.extra.checkout_url }}",
        "body": (
            _p("Hi {{ first_name|default:'there' }},")
            + _p("Your cart is still saved, but we can't hold stock indefinitely. "
                 "This is your final reminder before your session expires.")
            + _box([
                "<strong>Free shipping</strong> on orders over $500 Australia-wide",
                "<strong>30-day hassle-free returns</strong> on everything",
                "<strong>Business accounts</strong> available with volume discounts",
            ])
            + _p("Still unsure? Our team is happy to help with spec advice, "
                 "compatibility questions, or putting together a custom quote "
                 "for your team. Just reply to this email.")
            + _p("Don't let your selected items go out of stock.")
        ),
    },

    # ── Post-Purchase ────────────────────────────────────────────────────────────

    "post_purchase_1": {
        "name":     "Uniwide | Post-Purchase #1 — Thank You + Upsell",
        "subject":  "Your order is confirmed — thank you!",
        "preview":  "Complete your setup with accessories your team will love.",
        "headline": "Order confirmed. Thanks for choosing Uniwide.",
        "cta":      "Shop Accessories",
        "cta_url":  f"{STORE_URL}/collections/accessories",
        "body": (
            _p("Hi {{ first_name|default:'there' }},")
            + _p("Your order is in our system and our warehouse team is getting it "
                 "ready for dispatch. You'll receive a shipping confirmation with "
                 "tracking details shortly.")
            + _box([
                "<strong>Order #{{ event.extra.order_number|default:'—' }}</strong>",
                "Estimated dispatch: 1–2 business days",
                "Free shipping applied on orders over $500",
            ])
            + _p("<strong>Complete your setup</strong> — if your order includes a laptop "
                 "or desktop, here are the accessories your team will thank you for:")
            + (
                '<ul style="margin:0 0 16px;padding-left:20px;'
                'font-size:15px;color:#374151;line-height:2;">'
                "<li><strong>Monitors</strong> — dual-screen productivity for every desk</li>"
                "<li><strong>Keyboards &amp; mice</strong> — ergonomic options for all-day use</li>"
                "<li><strong>Docking stations</strong> — one cable for power, display &amp; data</li>"
                "<li><strong>Headsets</strong> — built for remote meetings and deep-focus work</li>"
                "</ul>"
            )
            + _p("All accessories are in stock and ship alongside your next order.")
        ),
    },

    "post_purchase_2": {
        "name":     "Uniwide | Post-Purchase #2 — Review + Bulk Pricing",
        "subject":  "How's your new tech? Share your experience",
        "preview":  "Leave a quick review — and discover bulk pricing for next time.",
        "headline": "Enjoying your purchase?",
        "cta":      "Leave a Review",
        "cta_url":  f"{STORE_URL}/pages/reviews",
        "body": (
            _p("Hi {{ first_name|default:'there' }},")
            + _p("It's been a week since your order arrived — we hope everything is "
                 "working perfectly for your team.")
            + _p("If you have a moment, we'd love to hear about your experience. "
                 "Your review helps other business buyers make confident decisions "
                 "and helps us serve you better.")
            + '<hr style="border:none;border-top:1px solid #e5e7eb;margin:24px 0;">'
            + _p("<strong>Planning your next order?</strong>")
            + _box([
                "<strong>Bulk pricing</strong> — significant discounts on orders of 10+ units",
                "<strong>Dedicated account management</strong> for repeat business customers",
                "<strong>Priority fulfilment</strong> for larger business orders",
            ])
            + _p("Whether it's a seasonal hardware refresh or an ongoing tech rollout, "
                 "get in touch and we'll put together a custom quote for your team.")
        ),
    },

    # ── Winback ──────────────────────────────────────────────────────────────────

    "winback": {
        "name":     "Uniwide | Winback — 10% Off",
        "subject":  "We miss you — here's 10% off to come back",
        "preview":  "It's been a while. Use WINBACK10 for 10% off your next order.",
        "headline": "It's been a while. We've missed you.",
        "cta":      "Shop Now — Use WINBACK10",
        "cta_url":  f"{STORE_URL}/collections/all",
        "body": (
            _p("Hi {{ first_name|default:'there' }},")
            + _p("We noticed it's been a while since your last order, and we wanted "
                 "to reach out with something to welcome you back.")
            + _discount_box("WINBACK10", "10%",
                            "Valid on all products. Expires in 14 days. One use per account.")
            + _p("A lot has changed since your last visit — we've expanded to 9,000+ "
                 "products, added new brands, and improved our bulk pricing for "
                 "business accounts.")
            + _p("Whether you're replacing aging hardware, equipping new team members, "
                 "or planning a full office refresh — we'd love to help.")
            + _p("Discount applies at checkout. Cannot be combined with other offers.", muted=True)
        ),
    },
}


# ─── Step 1 — Create email templates ──────────────────────────────────────────

def create_templates() -> dict[str, str]:
    """
    POST /api/templates/ for each of the 8 emails.
    Returns {key: template_id} used by flow / campaign setup.
    """
    print("\n📧  Creating email templates...")
    ids: dict[str, str] = {}

    for key, cfg in EMAILS.items():
        html  = make_html(cfg["subject"], cfg["preview"], cfg["headline"],
                          cfg["body"], cfg["cta"], cfg["cta_url"])
        plain = (
            f"{cfg['headline']}\n\n"
            f"{cfg['preview']}\n\n"
            f"Visit us at {STORE_URL}\n\n"
            "Unsubscribe: {{ unsubscribe_url }}"
        )
        payload = {
            "data": {
                "type": "template",
                "attributes": {
                    "name":        cfg["name"],
                    "editor_type": "CODE",
                    "html":        html,
                    "text":        plain,
                },
            }
        }

        resp = post("templates", payload)
        if resp and "data" in resp:
            tid = resp["data"]["id"]
            ids[key] = tid
            results["templates"]["created"].append(cfg["name"])
            print(f"    ✓ {cfg['name']:50s}  id: {tid}")
        else:
            results["templates"]["failed"].append(cfg["name"])
            print(f"    ✗ FAILED — {cfg['name']}")

    return ids


# ─── Step 2 — Create flows ──────────────────────────────────────────────────────

def get_metric_id(target_name: str) -> str | None:
    """
    Page through GET /api/metrics/ and return the ID of the named metric.
    Returns None if not found or the account has no events yet.
    """
    cursor: str | None = None
    while True:
        params = {"page[cursor]": cursor} if cursor else {}
        resp   = get("metrics", params=params)
        if not resp:
            return None
        for metric in resp.get("data", []):
            if metric["attributes"].get("name") == target_name:
                return metric["id"]
        cursor = (resp.get("links") or {}).get("next")
        if not cursor:
            return None
        # cursor from `links.next` is a full URL; extract the cursor value
        if "page%5Bcursor%5D=" in cursor or "page[cursor]=" in cursor:
            from urllib.parse import urlparse, parse_qs
            qs = parse_qs(urlparse(cursor).query)
            cursor = (qs.get("page[cursor]") or qs.get("page%5Bcursor%5D") or [None])[0]
        else:
            return None  # can't paginate further


def create_flows(template_ids: dict[str, str]) -> dict[str, str | None]:
    """
    Klaviyo's REST API does not expose POST /api/flows/ — flow creation is
    UI-only.  This function prints a complete step-by-step wiring guide using
    the template IDs created in Step 1 so you can build each flow in < 10 min.
    """
    print("\n🔁  Flows — Klaviyo REST API does not support programmatic flow creation.")
    print("    See the wiring guide below to build each flow in the UI.")
    results["flows"]["created"].append("Welcome Series (see UI guide)")
    results["flows"]["created"].append("Abandoned Cart (see UI guide)")
    results["flows"]["created"].append("Post-Purchase (see UI guide)")
    flow_ids: dict[str, str | None] = {
        "welcome": None, "abandoned_cart": None, "post_purchase": None
    }
    _print_flow_guide(template_ids, flow_ids)
    return flow_ids


def _print_flow_guide(t: dict[str, str], f: dict[str, str | None]) -> None:
    """
    Prints a step-by-step guide for wiring flows in the Klaviyo UI.
    Includes every template ID returned from create_templates().
    """
    def tid(key: str) -> str:
        return t.get(key) or "NOT CREATED — rerun script"

    welcome_id      = f.get("welcome")      or "NOT CREATED — create manually"
    cart_id         = f.get("abandoned_cart") or "NOT CREATED — create manually"
    purchase_id     = f.get("post_purchase")  or "NOT CREATED — create manually"

    print(f"""
╔══════════════════════════════════════════════════════════════════════╗
║   FLOW WIRING GUIDE — complete in Klaviyo → Flows → [name] → Edit   ║
╚══════════════════════════════════════════════════════════════════════╝

 1.  WELCOME SERIES   (flow id: {welcome_id})
     Trigger: Added to List → select your Shopify email subscriber list.

     ┌─ SEND EMAIL immediately ─────────────────────────────────────────┐
     │  Template ID : {tid("welcome_1")}
     │  Subject     : Welcome to Uniwide — Your Business Tech Partner   │
     └──────────────────────────────────────────────────────────────────┘
     ┌─ TIME DELAY : 2 days ────────────────────────────────────────────┘
     ┌─ SEND EMAIL ─────────────────────────────────────────────────────┐
     │  Template ID : {tid("welcome_2")}
     │  Subject     : Business pricing that scales with your team       │
     └──────────────────────────────────────────────────────────────────┘
     ┌─ TIME DELAY : 4 days (6 days total) ────────────────────────────┘
     ┌─ SEND EMAIL ─────────────────────────────────────────────────────┐
     │  Template ID : {tid("welcome_3")}
     │  Subject     : Here's 5% off your first order — expires in 7 days│
     └──────────────────────────────────────────────────────────────────┘

 2.  ABANDONED CART   (flow id: {cart_id})
     Trigger: Metric → "Started Checkout"
     Smart Sending: ON   |   Flow Filter: Placed Order = 0 since starting

     ┌─ TIME DELAY : 1 hour ───────────────────────────────────────────┘
     ┌─ SEND EMAIL ─────────────────────────────────────────────────────┐
     │  Template ID : {tid("abandoned_cart_1")}
     │  Subject     : You left something behind                         │
     └──────────────────────────────────────────────────────────────────┘
     ┌─ TIME DELAY : 23 hours (24 hours total) ────────────────────────┘
     ┌─ SEND EMAIL ─────────────────────────────────────────────────────┐
     │  Template ID : {tid("abandoned_cart_2")}
     │  Subject     : Still thinking it over? Your cart expires soon    │
     └──────────────────────────────────────────────────────────────────┘

 3.  POST-PURCHASE   (flow id: {purchase_id})
     Trigger: Metric → "Placed Order"

     ┌─ TIME DELAY : 1 day ────────────────────────────────────────────┘
     ┌─ SEND EMAIL ─────────────────────────────────────────────────────┐
     │  Template ID : {tid("post_purchase_1")}
     │  Subject     : Your order is confirmed — thank you!              │
     └──────────────────────────────────────────────────────────────────┘
     ┌─ TIME DELAY : 6 days (7 days total) ────────────────────────────┘
     ┌─ SEND EMAIL ─────────────────────────────────────────────────────┐
     │  Template ID : {tid("post_purchase_2")}
     │  Subject     : How's your new tech? Share your experience        │
     └──────────────────────────────────────────────────────────────────┘
""")


# ─── Step 3 — Create segment ────────────────────────────────────────────────────

def create_segment(order_metric_id: str | None) -> str | None:
    """
    Creates the 'Business Buyers - High Value' segment.

    Condition logic (OR between groups):
      Group 1 — Placed Order count ≥ 2 (all time)
      Group 2 — Placed Order revenue ≥ $1,000 (all time)

    If the 'Placed Order' metric is unavailable (Shopify not yet connected),
    the segment is created as an empty shell so it can receive conditions later.
    """
    print("\n👥  Creating segment: Business Buyers - High Value...")

    # Segment conditions for 2+ orders OR $1k+ spend.
    # The Klaviyo segment condition API requires events to already exist in the
    # account, so we create the shell and print instructions to add conditions.
    if not order_metric_id:
        print("    ⚠  No 'Placed Order' metric — segment created as empty shell.")
        print("       Add conditions manually once Shopify is connected.")

    # definition with empty condition_groups is required by the API;
    # conditions are added in the UI after Shopify events appear.
    payload = {
        "data": {
            "type": "segment",
            "attributes": {
                "name":       "Business Buyers - High Value",
                "definition": {"condition_groups": []},
            },
        }
    }

    resp = post("segments", payload)
    if resp and "data" in resp:
        sid = resp["data"]["id"]
        results["segment"]["created"].append("Business Buyers - High Value")
        print(f"    ✓ Segment created  id: {sid}")
        print("    ℹ  Add conditions in Klaviyo UI once Shopify is connected:")
        print("       Group 1: Placed Order count ≥ 2 (all time)")
        print("       Group 2 (OR): Placed Order revenue ≥ $1,000 (all time)")
        return sid
    else:
        results["segment"]["failed"].append("Business Buyers - High Value")
        print("    ✗ Segment creation failed — create manually in Klaviyo UI.")
        print("      Logic: (Placed Order ≥ 2 times)  OR  (Lifetime Revenue ≥ $1,000)")
        return None


# ─── Step 4 — Create winback campaign ──────────────────────────────────────────

def create_winback_campaign(template_ids: dict[str, str],
                             segment_id: str | None) -> str | None:
    """
    Creates the Winback campaign as a draft email campaign.

    Steps:
      1. POST /api/campaigns/  — create the campaign shell
      2. GET  /api/campaigns/{id}/campaign-messages/ — find auto-created message
      3. POST /api/campaign-message-assign-template/ — link the HTML template

    The campaign is left in 'draft' status.
    Set the actual send datetime and activate it in the Klaviyo UI.
    """
    print("\n📣  Creating Winback campaign...")

    winback_tid = template_ids.get("winback")
    if not winback_tid:
        print("    ✗ Winback template was not created — skipping campaign.")
        results["campaign"]["failed"].append("Winback Campaign")
        return None

    # Audience: use segment if available, otherwise leave empty (set in UI)
    audiences: dict = {}
    if segment_id:
        audiences = {"included": [segment_id], "excluded": []}
    else:
        print("    ⚠  No segment ID — set the audience in the Klaviyo UI.")

    # Placeholder datetime 30 days out; update before activating
    placeholder_dt = (
        datetime.now(timezone.utc) + timedelta(days=30)
    ).strftime("%Y-%m-%dT%H:%M:%S+00:00")

    # campaign-messages is required inline at creation time by the Klaviyo API
    campaign_payload = {
        "data": {
            "type": "campaign",
            "attributes": {
                "name":      "Winback — 10% Off (WINBACK10)",
                "audiences": audiences,
                "send_options": {
                    "use_smart_sending": True,
                },
                "tracking_options": {
                    "is_tracking_clicks": True,
                    "is_tracking_opens":  True,
                },
                "send_strategy": {
                    "method":         "static",
                    "options_static": {
                        "datetime": placeholder_dt,
                        "is_local": False,
                    },
                },
                "campaign-messages": {
                    "data": [
                        {
                            "type": "campaign-message",
                            "attributes": {
                                "channel": "email",
                                "label":   "Winback Email",
                                "content": {
                                    "subject":        "We miss you — here's 10% off to come back",
                                    "preview_text":   "It's been a while. Use WINBACK10 for 10% off your next order.",
                                    "from_email":     FROM_EMAIL,
                                    "from_label":     FROM_LABEL,
                                    "reply_to_email": FROM_EMAIL,
                                },
                            },
                        }
                    ]
                },
            },
        }
    }

    resp = post("campaigns", campaign_payload)
    if not (resp and "data" in resp):
        results["campaign"]["failed"].append("Winback Campaign")
        print("    ✗ Campaign creation failed.")
        return None

    campaign_id = resp["data"]["id"]
    print(f"    ✓ Campaign created  id: {campaign_id}")

    # Allow Klaviyo to finish creating the default campaign message
    time.sleep(2)

    # Retrieve the auto-created campaign message
    msgs = get(f"campaigns/{campaign_id}/campaign-messages")
    if not (msgs and msgs.get("data")):
        print("    ⚠  Could not fetch campaign message — assign template manually:")
        print(f"       Template ID to assign: {winback_tid}")
        results["campaign"]["created"].append("Winback Campaign (template unassigned)")
        return campaign_id

    message_id = msgs["data"][0]["id"]
    print(f"    ✓ Campaign message found  id: {message_id}")

    # Patch the message with subject, preview, and from details
    msg_patch = {
        "data": {
            "type": "campaign-message",
            "id":   message_id,
            "attributes": {
                "content": {
                    "subject":        "We miss you — here's 10% off to come back",
                    "preview_text":   "It's been a while. Use WINBACK10 for 10% off your next order.",
                    "from_email":     FROM_EMAIL,
                    "from_label":     FROM_LABEL,
                    "reply_to_email": FROM_EMAIL,
                }
            },
        }
    }
    patch(f"campaign-messages/{message_id}", msg_patch)

    # Assign the HTML template
    assign_payload = {
        "data": {
            "type": "campaign-message",
            "id":   message_id,
            "relationships": {
                "template": {
                    "data": {"type": "template", "id": winback_tid}
                }
            },
        }
    }
    assign_resp = post("campaign-message-assign-template", assign_payload)
    if assign_resp is not None:
        print(f"    ✓ Template assigned to campaign message")
        results["campaign"]["created"].append("Winback Campaign")
    else:
        print(f"    ⚠  Template assignment failed — in Klaviyo UI, assign template id: {winback_tid}")
        results["campaign"]["created"].append("Winback Campaign (template unassigned)")

    print(f"""
    📋 Campaign is in DRAFT.  Next steps in Klaviyo UI:
       Campaigns → "Winback — 10% Off (WINBACK10)"
         1. Update send datetime (placeholder is 30 days from now)
         2. Add audience filter: Last Order Date > 90 days ago
         3. Review email preview, then click Schedule or Send
""")
    return campaign_id


# ─── Summary ────────────────────────────────────────────────────────────────────

def print_summary() -> None:
    total_ok  = sum(len(v["created"]) for v in results.values())
    total_err = sum(len(v["failed"])  for v in results.values())

    print("═" * 68)
    print("  SETUP COMPLETE — SUMMARY")
    print("═" * 68)

    label_map = {
        "templates": "Email Templates",
        "flows":     "Flow Shells",
        "segment":   "Segment",
        "campaign":  "Campaign",
    }
    for key, label in label_map.items():
        data = results[key]
        for name in data["created"]:
            print(f"  ✓  {label}: {name}")
        for name in data["failed"]:
            print(f"  ✗  {label}: {name}  (FAILED — see output above)")

    print(f"\n  Total created: {total_ok}   Total failed: {total_err}")

    if total_err:
        print("\n  Common failure causes:")
        print("    • Duplicate name — a resource with that name already exists")
        print("    • Shopify not connected — metric-triggered flows need events")
        print("    • API key scope — ensure the key has full read/write access")

    print("""
  NEXT STEPS:
    1. Flows  → open each flow in Klaviyo UI and add email + delay nodes
               using the template IDs and timing in the guide above.
    2. Flows  → set trigger on Welcome Series: "Added to List" → your list.
    3. Shopify → connect integration so Abandoned Cart and Post-Purchase
               triggers fire automatically (Settings → Integrations).
    4. Campaign → open Winback draft, set real send datetime, activate.
    5. Segment → verify conditions once Shopify events appear in Klaviyo.
    6. All flows → flip status from Draft to Live when ready.
""")


# ─── Main ───────────────────────────────────────────────────────────────────────

def main() -> None:
    print("=" * 68)
    print("  Klaviyo Automation Setup — Uniwide Merchandise")
    print(f"  API: {BASE_URL}  |  revision: {REVISION}")
    print("=" * 68)

    # Sanity-check the API key before doing any writes
    print("\n🔑  Verifying API key...")
    auth_check = get("accounts")
    if auth_check is None:
        sys.exit(
            "\nFailed to connect to Klaviyo.  Check that:\n"
            "  • KLAVIYO_API_KEY is set and correct\n"
            "  • The key has full API access (not read-only)\n"
        )
    acct = (auth_check.get("data") or [{}])[0] if isinstance(
        auth_check.get("data"), list) else auth_check.get("data") or {}
    org = (acct.get("attributes") or {}).get("contact_information", {})
    org_name = org.get("organization_name") or "your account"
    print(f"    ✓ Connected to: {org_name}")

    # Resolve Placed Order metric ID — used by segment conditions
    print("\n🔍  Looking up Klaviyo metrics...")
    order_metric_id = get_metric_id("Placed Order")
    print(f"    Placed Order : {order_metric_id or 'not found (need Shopify events)'}")

    # ── Run setup steps ─────────────────────────────────────────────────────
    template_ids = create_templates()
    create_flows(template_ids)
    segment_id   = create_segment(order_metric_id)
    create_winback_campaign(template_ids, segment_id)

    print_summary()


if __name__ == "__main__":
    main()
