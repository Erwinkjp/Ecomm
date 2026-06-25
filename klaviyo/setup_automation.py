#!/usr/bin/env python3
"""
Klaviyo Automation Setup — Uniwide Merchandise
===============================================
Creates templates, flows, segment, and winback campaign via Klaviyo API v2024.

Usage:
    export KLAVIYO_API_KEY=pk_...
    python3 setup_automation.py

What this script creates:
  1. Email templates (8 total — Welcome ×3, Abandoned Cart ×2, Post-Purchase ×2, Winback ×1)
  2. Welcome Series flow  (list-triggered, 3 emails over 6 days)
  3. Abandoned Cart flow  (metric-triggered on Started Checkout, 2 emails)
  4. Post-Purchase flow   (metric-triggered on Placed Order, 2 emails)
  5. Winback campaign     (one-off email to inactive customers)
  6. "Business Buyers - High Value" segment (2+ orders OR $1,000+ spend)

Note on flows: Klaviyo's REST API creates the flow shell and associates triggers.
Flow action sequences (time delays, email send nodes) must be wired in the
Klaviyo UI after this script runs — the script prints a step-by-step guide.
Metric-triggered flows (Abandoned Cart, Post-Purchase) require the Shopify
integration to be active so Klaviyo has received at least one event.
"""

import os
import sys
import json
import time
import requests
from datetime import datetime, timezone, timedelta

# ─── Config ───────────────────────────────────────────────────────────────────

def _load_dotenv():
    """Load KEY=VALUE / `export KEY=VALUE` lines from a .env into os.environ
    (without overwriting anything already set). Checks, in order:
    $KLAVIYO_ENV_FILE, ./.env, then ../synnex-shopify-sync/.env relative to this script."""
    here = os.path.dirname(os.path.abspath(__file__))
    candidates = [
        os.environ.get("KLAVIYO_ENV_FILE"),
        os.path.join(os.getcwd(), ".env"),
        os.path.join(here, ".env"),
        os.path.join(here, "..", "synnex-shopify-sync", ".env"),
    ]
    for path in candidates:
        if not path or not os.path.isfile(path):
            continue
        with open(path) as fh:
            for line in fh:
                line = line.strip()
                if not line or line.startswith("#"):
                    continue
                if line.startswith("export "):
                    line = line[len("export "):]
                if "=" not in line:
                    continue
                k, v = line.split("=", 1)
                k, v = k.strip(), v.strip().strip('"').strip("'")
                if k and k not in os.environ:
                    os.environ[k] = v
        break  # first existing file wins


_load_dotenv()

# Private API key (the "secret", starts with pk_). KLAVIYO_API_KEY kept for back-compat.
API_KEY    = os.environ.get("KLAVIYO_PRIVATE_KEY") or os.environ.get("KLAVIYO_API_KEY") or ""
PUBLIC_KEY = os.environ.get("KLAVIYO_PUBLIC_KEY", "")
BASE_URL   = "https://a.klaviyo.com/api"
REVISION   = "2024-10-15"

if not API_KEY:
    sys.exit("ERROR: KLAVIYO_PRIVATE_KEY is not set. Add it to your .env "
             "(KLAVIYO_PRIVATE_KEY=pk_...) and re-run, or `source .env` first.")
if not API_KEY.startswith("pk_"):
    sys.exit(f"ERROR: KLAVIYO_PRIVATE_KEY should be a PRIVATE key starting with 'pk_' "
             f"(got '{API_KEY[:6]}...'). Use the Private API Key from Klaviyo → Settings → API Keys.")

# The Shopify-connected list that new subscribers join (found in account)
WELCOME_LIST_ID = os.environ.get("KLAVIYO_WELCOME_LIST_ID", "SAMsQ3")   # "Email List"

HEADERS = {
    "Authorization": f"Klaviyo-API-Key {API_KEY}",
    "revision":      REVISION,
    "Content-Type":  "application/json",
    "Accept":        "application/json",
}

# Track results for the final summary
results = {
    "templates":  {"created": [], "failed": []},
    "flows":      {"created": [], "failed": []},
    "segment":    {"created": [], "failed": []},
    "campaign":   {"created": [], "failed": []},
}


# ─── HTTP helpers ─────────────────────────────────────────────────────────────

def post(endpoint: str, payload: dict) -> dict | None:
    """POST to Klaviyo API, return parsed JSON or None on failure."""
    url = f"{BASE_URL}/{endpoint}/"
    try:
        r = requests.post(url, headers=HEADERS, json=payload, timeout=30)
        if r.status_code in (200, 201, 202):
            return r.json()
        print(f"  ✗ POST /{endpoint} → {r.status_code}: {r.text[:300]}")
        return None
    except requests.RequestException as e:
        print(f"  ✗ POST /{endpoint} network error: {e}")
        return None


def get(endpoint: str, params: dict = None) -> dict | None:
    """GET from Klaviyo API, return parsed JSON or None on failure."""
    url = f"{BASE_URL}/{endpoint}/"
    try:
        r = requests.get(url, headers=HEADERS, params=params, timeout=30)
        if r.status_code == 200:
            return r.json()
        print(f"  ✗ GET /{endpoint} → {r.status_code}: {r.text[:200]}")
        return None
    except requests.RequestException as e:
        print(f"  ✗ GET /{endpoint} network error: {e}")
        return None


def patch(endpoint: str, payload: dict) -> dict | None:
    """PATCH to Klaviyo API, return parsed JSON or None on failure."""
    url = f"{BASE_URL}/{endpoint}/"
    try:
        r = requests.patch(url, headers=HEADERS, json=payload, timeout=30)
        if r.status_code in (200, 202):
            return r.json()
        print(f"  ✗ PATCH /{endpoint} → {r.status_code}: {r.text[:300]}")
        return None
    except requests.RequestException as e:
        print(f"  ✗ PATCH /{endpoint} network error: {e}")
        return None


# ─── HTML email builder ───────────────────────────────────────────────────────

def make_html(subject: str, preheader: str, headline: str, body_html: str, cta_label: str, cta_url: str) -> str:
    """
    Returns a full, self-contained HTML email using Uniwide brand guidelines:
    - Dark navy header (#1a2744)
    - White body
    - Blue CTA button (#1d4ed8)
    - 600px max width, mobile-responsive inline CSS
    """
    return f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="X-UA-Compatible" content="IE=edge">
<title>{subject}</title>
<!--[if mso]><noscript><xml><o:OfficeDocumentSettings><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml></noscript><![endif]-->
<style>
  body{{margin:0;padding:0;background:#f4f6f9;font-family:Arial,Helvetica,sans-serif;}}
  table{{border-collapse:collapse;}}
  img{{border:0;display:block;}}
  .email-wrapper{{background:#f4f6f9;padding:24px 0;}}
  .email-card{{background:#ffffff;max-width:600px;margin:0 auto;border-radius:8px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,.08);}}
  .header{{background:#1a2744;padding:28px 40px;text-align:center;}}
  .header-logo{{color:#ffffff;font-size:22px;font-weight:700;letter-spacing:.5px;text-decoration:none;}}
  .header-tagline{{color:#94a3c0;font-size:12px;margin-top:4px;}}
  .body-content{{padding:40px 40px 32px;}}
  .headline{{color:#1a2744;font-size:24px;font-weight:700;line-height:1.3;margin:0 0 16px;}}
  .body-text{{color:#374151;font-size:15px;line-height:1.7;margin:0 0 16px;}}
  .highlight-box{{background:#f0f4ff;border-left:4px solid #1d4ed8;border-radius:4px;padding:16px 20px;margin:24px 0;}}
  .highlight-box p{{margin:6px 0;color:#1a2744;font-size:14px;}}
  .highlight-box strong{{color:#1d4ed8;}}
  .cta-wrapper{{text-align:center;margin:32px 0 24px;}}
  .cta-btn{{display:inline-block;background:#1d4ed8;color:#ffffff !important;font-size:15px;font-weight:700;text-decoration:none;padding:14px 36px;border-radius:6px;letter-spacing:.3px;}}
  .divider{{border:none;border-top:1px solid #e5e7eb;margin:28px 0;}}
  .footer{{background:#f8fafc;padding:24px 40px;text-align:center;border-top:1px solid #e5e7eb;}}
  .footer p{{color:#9ca3af;font-size:12px;line-height:1.6;margin:4px 0;}}
  .footer a{{color:#6b7280;text-decoration:underline;}}
  @media(max-width:620px){{
    .body-content{{padding:28px 24px 24px;}}
    .footer{{padding:20px 24px;}}
    .headline{{font-size:20px;}}
  }}
</style>
</head>
<body>
<!-- Preheader (hidden preview text) -->
<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;">{preheader}&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;</div>

<div class="email-wrapper">
  <table width="100%" cellpadding="0" cellspacing="0" role="presentation">
    <tr><td align="center">
      <div class="email-card">

        <!-- Header -->
        <div class="header">
          <div class="header-logo">Uniwide Merchandise</div>
          <div class="header-tagline">Business Tech, Simplified</div>
        </div>

        <!-- Body -->
        <div class="body-content">
          <h1 class="headline">{headline}</h1>
          {body_html}

          <div class="cta-wrapper">
            <a href="{cta_url}" class="cta-btn">{cta_label}</a>
          </div>

          <hr class="divider">
          <p class="body-text" style="font-size:13px;color:#6b7280;">
            Questions? Reply to this email or visit
            <a href="https://www.uniwidemerchandise.com" style="color:#1d4ed8;">uniwidemerchandise.com</a>.
            Our team is here to help.
          </p>
        </div>

        <!-- Footer -->
        <div class="footer">
          <p>Uniwide Merchandise &mdash; Business Tech for Australian Teams</p>
          <p>
            <a href="{{{{ unsubscribe_url }}}}">Unsubscribe</a> &nbsp;|&nbsp;
            <a href="{{{{ organization.website_url }}}}">Visit our store</a>
          </p>
          <p style="margin-top:8px;">
            &copy; 2025 Uniwide Merchandise. All rights reserved.
          </p>
        </div>

      </div>
    </td></tr>
  </table>
</div>
</body>
</html>"""


# ─── Email content definitions ─────────────────────────────────────────────────

EMAILS = {

    # ── Welcome Series ─────────────────────────────────────────────────────────

    "welcome_1": {
        "name":     "Uniwide | Welcome — Brand Intro",
        "subject":  "Welcome to Uniwide — Your Business Tech Partner",
        "preview":  "Trusted brands, competitive pricing, and 9,000+ products for your team.",
        "headline": "Great to have you here.",
        "cta":      "Shop Laptops",
        "cta_url":  "https://www.uniwidemerchandise.com/collections/laptops",
        "body": """
            <p class="body-text">
                Welcome to Uniwide Merchandise — the go-to destination for Australian businesses
                looking for reliable tech at competitive prices.
            </p>
            <p class="body-text">
                Whether you're equipping a new hire, upgrading a whole team, or sourcing accessories
                in bulk, we've built this store with business buyers like you in mind.
            </p>
            <div class="highlight-box">
                <p><strong>9,000+ products</strong> across laptops, monitors, keyboards, mice &amp; more</p>
                <p><strong>Trusted brands</strong> including Lenovo, Dell, Apple, Acer &amp; Logitech</p>
                <p><strong>Business pricing</strong> available for bulk and repeat orders</p>
                <p><strong>Fast fulfilment</strong> with 1–2 business day dispatch on in-stock items</p>
            </div>
            <p class="body-text">
                Start exploring our full laptop range — from everyday business notebooks to
                high-performance workstations.
            </p>
        """,
    },

    "welcome_2": {
        "name":     "Uniwide | Welcome — Business Pricing",
        "subject":  "Business pricing that works for your whole team",
        "preview":  "Bulk discounts, free shipping over $500, and a 30-day return guarantee.",
        "headline": "Pricing built for business buyers.",
        "cta":      "Request a Business Quote",
        "cta_url":  "https://www.uniwidemerchandise.com/pages/contact",
        "body": """
            <p class="body-text">
                Sourcing tech for a team shouldn't feel like a hassle. At Uniwide, we make it
                straightforward — competitive prices, clear policies, and a catalogue built for
                professional buyers.
            </p>
            <div class="highlight-box">
                <p><strong>Bulk discounts</strong> — contact us for custom pricing on 10+ units</p>
                <p><strong>Free shipping</strong> on all orders over $500</p>
                <p><strong>30-day returns</strong> on all products, no questions asked</p>
                <p><strong>Account management</strong> available for repeat business customers</p>
            </div>
            <p class="body-text">
                IT managers and procurement teams love our quote process — just tell us what
                you need and we'll come back with competitive per-unit pricing.
            </p>
            <p class="body-text">
                Ready to talk volume? Hit the button below and our team will get back to you
                within one business day.
            </p>
        """,
    },

    "welcome_3": {
        "name":     "Uniwide | Welcome — First Order Offer",
        "subject":  "Here's 5% off your first order — offer ends soon",
        "preview":  "Use WELCOME5 at checkout. Don't leave your team waiting.",
        "headline": "Your welcome gift: 5% off.",
        "cta":      "Shop All Products — Use WELCOME5",
        "cta_url":  "https://www.uniwidemerchandise.com/collections/all",
        "body": """
            <p class="body-text">
                You've had a chance to explore the store — now let's get your first order done.
            </p>
            <div class="highlight-box">
                <p style="font-size:18px;font-weight:700;color:#1a2744;">
                    Use code <strong style="color:#1d4ed8;">WELCOME5</strong> for 5% off your first order
                </p>
                <p>Valid on all products. One use per account. Expires in 7 days.</p>
            </div>
            <p class="body-text">
                Whether it's a single laptop or a full team refresh — now is the best time to
                lock in the lowest price.
            </p>
            <p class="body-text">
                With 9,000+ products across all major business tech categories, there's a good
                chance we have exactly what you need — in stock and ready to ship.
            </p>
            <p class="body-text" style="font-size:13px;color:#6b7280;">
                Discount applies at checkout. Cannot be combined with other offers.
            </p>
        """,
    },

    # ── Abandoned Cart ─────────────────────────────────────────────────────────

    "abandoned_cart_1": {
        "name":     "Uniwide | Abandoned Cart — Reminder",
        "subject":  "You left something behind",
        "preview":  "Business tech moves fast — popular items sell out quickly.",
        "headline": "Your cart is waiting for you.",
        "cta":      "Return to My Cart",
        "cta_url":  "{{ event.extra.checkout_url }}",
        "body": """
            <p class="body-text">
                Hi {{ first_name|default:'there' }},
            </p>
            <p class="body-text">
                You left some items in your cart. No rush — but stock on popular business
                tech moves quickly and we'd hate for you to miss out.
            </p>
            <div class="highlight-box">
                <p><strong>Your cart includes:</strong></p>
                {% for item in event.extra.line_items %}
                <p style="margin:8px 0;">
                    &bull; {{ item.title }}
                    {% if item.quantity > 1 %} &times;{{ item.quantity }}{% endif %}
                    — <strong>${{ item.price }}</strong>
                </p>
                {% endfor %}
            </div>
            <p class="body-text">
                All Uniwide orders over $500 ship free, and every product comes with our
                30-day return guarantee — so you can buy with confidence.
            </p>
        """,
    },

    "abandoned_cart_2": {
        "name":     "Uniwide | Abandoned Cart — Final Reminder",
        "subject":  "Still thinking it over? Your cart expires soon",
        "preview":  "Free shipping on orders over $500. Your items are still available.",
        "headline": "Last chance to grab your items.",
        "cta":      "Complete My Purchase",
        "cta_url":  "{{ event.extra.checkout_url }}",
        "body": """
            <p class="body-text">
                Hi {{ first_name|default:'there' }},
            </p>
            <p class="body-text">
                We noticed your cart is still sitting there. This is your final nudge —
                we want to make sure you don't miss out on the items you selected.
            </p>
            <div class="highlight-box">
                <p><strong>Don't forget:</strong></p>
                <p>&bull; <strong>Free shipping</strong> on all orders over $500</p>
                <p>&bull; <strong>30-day returns</strong> — buy with confidence</p>
                <p>&bull; <strong>Business pricing</strong> available for bulk orders</p>
            </div>
            <p class="body-text">
                If you have any questions before purchasing — about specs, compatibility,
                or volume pricing — reply to this email and our team will help you out.
            </p>
            <p class="body-text">
                Your cart will expire soon. Grab your items before they're gone.
            </p>
        """,
    },

    # ── Post-Purchase ──────────────────────────────────────────────────────────

    "post_purchase_1": {
        "name":     "Uniwide | Post-Purchase — Thank You + Upsell",
        "subject":  "Your order is confirmed — thank you!",
        "preview":  "Complete your setup with accessories your team will love.",
        "headline": "Order confirmed. Thanks for choosing Uniwide.",
        "cta":      "Shop Accessories",
        "cta_url":  "https://www.uniwidemerchandise.com/collections/accessories",
        "body": """
            <p class="body-text">
                Hi {{ first_name|default:'there' }},
            </p>
            <p class="body-text">
                Your order has been confirmed and our team is getting it ready for dispatch.
                You'll receive a shipping notification with tracking details shortly.
            </p>
            <div class="highlight-box">
                <p><strong>Order #{{ event.extra.order_number }}</strong></p>
                <p>Estimated dispatch: 1–2 business days</p>
                <p>Shipping policy: Free on orders over $500</p>
            </div>
            <p class="body-text">
                <strong>Complete your setup</strong> — if you picked up a laptop or desktop,
                consider pairing it with:
            </p>
            <p class="body-text">
                &bull; <strong>Monitors</strong> — dual-screen productivity for your team<br>
                &bull; <strong>Keyboards &amp; mice</strong> — ergonomic options for all-day use<br>
                &bull; <strong>Docking stations</strong> — one cable for everything<br>
                &bull; <strong>Headsets</strong> — built for remote meetings and focus work
            </p>
            <p class="body-text">
                All accessories are in stock and ready to ship alongside your next order.
            </p>
        """,
    },

    "post_purchase_2": {
        "name":     "Uniwide | Post-Purchase — Review + Bulk Pricing",
        "subject":  "How's your new tech? Share your experience",
        "preview":  "Leave a quick review — and discover bulk pricing for your next order.",
        "headline": "Enjoying your purchase?",
        "cta":      "Leave a Review",
        "cta_url":  "https://www.uniwidemerchandise.com/pages/reviews",
        "body": """
            <p class="body-text">
                Hi {{ first_name|default:'there' }},
            </p>
            <p class="body-text">
                It's been a week since your order arrived — we hope everything is working
                perfectly for your team. If you have a moment, we'd love to hear about
                your experience.
            </p>
            <p class="body-text">
                Reviews help other business buyers make confident decisions, and your
                feedback helps us serve you better.
            </p>
            <hr class="divider">
            <p class="body-text">
                <strong>Planning your next order?</strong>
            </p>
            <div class="highlight-box">
                <p><strong>Bulk pricing</strong> — significant discounts on orders of 10+ units</p>
                <p><strong>Dedicated account management</strong> for repeat business customers</p>
                <p><strong>Priority fulfilment</strong> for larger business orders</p>
            </div>
            <p class="body-text">
                Whether it's a seasonal refresh or an ongoing tech rollout, get in touch and
                we'll put together a custom quote for your team.
            </p>
        """,
    },

    # ── Winback ───────────────────────────────────────────────────────────────

    "winback": {
        "name":     "Uniwide | Winback — 10% Off",
        "subject":  "We miss you — here's 10% off to come back",
        "preview":  "It's been a while. Use WINBACK10 for 10% off your next order.",
        "headline": "It's been a while. We've missed you.",
        "cta":      "Shop Now — Use WINBACK10",
        "cta_url":  "https://www.uniwidemerchandise.com/collections/all",
        "body": """
            <p class="body-text">
                Hi {{ first_name|default:'there' }},
            </p>
            <p class="body-text">
                We noticed it's been a while since your last order, and we wanted to reach
                out with something to welcome you back.
            </p>
            <div class="highlight-box">
                <p style="font-size:18px;font-weight:700;color:#1a2744;">
                    Use code <strong style="color:#1d4ed8;">WINBACK10</strong> for 10% off your next order
                </p>
                <p>Valid on all products. Expires in 14 days. One use per account.</p>
            </div>
            <p class="body-text">
                A lot has changed since your last visit — we've expanded to 9,000+ products,
                added new brands, and improved our bulk pricing for business accounts.
            </p>
            <p class="body-text">
                Whether you're replacing aging hardware, equipping new team members, or
                planning a full office refresh — we'd love to help.
            </p>
            <p class="body-text" style="font-size:13px;color:#6b7280;">
                Discount applies at checkout. Cannot be combined with other offers.
            </p>
        """,
    },
}


# ─── Step 1: Create email templates ───────────────────────────────────────────

def create_templates() -> dict[str, str]:
    """
    Creates all 8 email templates in Klaviyo.
    Returns a dict of {key: template_id} for use in flow/campaign setup.
    """
    print("\n📧 Creating email templates...")
    template_ids = {}

    for key, cfg in EMAILS.items():
        html = make_html(
            subject  = cfg["subject"],
            preheader= cfg["preview"],
            headline = cfg["headline"],
            body_html= cfg["body"],
            cta_label= cfg["cta"],
            cta_url  = cfg["cta_url"],
        )
        # Plain-text fallback
        plain = (
            f"{cfg['headline']}\n\n"
            f"{cfg['subject']}\n\n"
            f"Visit us at https://www.uniwidemerchandise.com\n\n"
            f"Unsubscribe: {{ unsubscribe_url }}"
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
            template_ids[key] = tid
            results["templates"]["created"].append(cfg["name"])
            print(f"  ✓ {cfg['name']}  →  {tid}")
        else:
            results["templates"]["failed"].append(cfg["name"])
            print(f"  ✗ Failed: {cfg['name']}")

    return template_ids


# ─── Step 2: Create flows ──────────────────────────────────────────────────────

def get_metric_id(name: str) -> str | None:
    """Look up a Klaviyo metric by name (e.g. 'Placed Order')."""
    resp = get("metrics")
    if not resp:
        return None
    for m in resp.get("data", []):
        if m["attributes"]["name"] == name:
            return m["id"]
    # Follow cursor pagination if more pages exist
    next_url = resp.get("links", {}).get("next")
    while next_url:
        try:
            r = requests.get(next_url, headers=HEADERS, timeout=30)
            if r.status_code != 200:
                break
            resp = r.json()
            for m in resp.get("data", []):
                if m["attributes"]["name"] == name:
                    return m["id"]
            next_url = resp.get("links", {}).get("next")
        except requests.RequestException:
            break
    return None


def create_flow(name: str, trigger_type: str, trigger_payload: dict | None = None) -> str | None:
    """
    Creates a Klaviyo flow shell with the given name and trigger.
    trigger_type: "list" | "metric" | "segment"
    trigger_payload: extra attributes merged into the trigger relationship data
    """
    payload: dict = {
        "data": {
            "type": "flow",
            "attributes": {
                "name":   name,
                "status": "draft",
            },
        }
    }

    # Attach trigger relationship when IDs are known
    if trigger_payload:
        payload["data"]["relationships"] = {
            "flow-triggers": {
                "data": [trigger_payload]
            }
        }

    resp = post("flows", payload)
    if resp and "data" in resp:
        fid = resp["data"]["id"]
        results["flows"]["created"].append(name)
        print(f"  ✓ Flow created: '{name}'  →  {fid}")
        return fid
    else:
        results["flows"]["failed"].append(name)
        print(f"  ✗ Failed to create flow: '{name}'")
        return None


def create_flows(template_ids: dict[str, str]) -> dict[str, str | None]:
    """
    Klaviyo's REST API does not expose a POST /flows endpoint — flows must be
    created in the UI. This function prints an exact step-by-step wiring guide
    using the template IDs we just created.
    """
    print("\n🔁 Flows — Klaviyo API does not support programmatic flow creation.")
    print("  ℹ Use the guide below to build each flow in Klaviyo UI → Flows → Create Flow.")
    _print_flow_setup_guide(template_ids, {})
    return {}


def _print_flow_setup_guide(template_ids: dict[str, str], flow_ids: dict[str, str | None]) -> None:
    """
    Klaviyo's API creates the flow shell only; email actions + time delays must
    be added in the UI. Print an exact step-by-step guide so nothing is missed.
    """
    t = template_ids   # alias for brevity

    print("""
┌─────────────────────────────────────────────────────────────────────┐
│  KLAVIYO FLOW SETUP GUIDE — Complete these steps in the UI          │
│  Klaviyo → Flows → [flow name] → Edit                               │
└─────────────────────────────────────────────────────────────────────┘

 1. WELCOME SERIES  (triggered: joined Email List)
    ┌─ Send Email immediately ──────────────────────────────────────┐
    │  Template ID: {w1}
    │  Subject:    "Welcome to Uniwide — Your Business Tech Partner"│
    └───────────────────────────────────────────────────────────────┘
    ┌─ Time Delay: 2 days ──────────────────────────────────────────┐
    └───────────────────────────────────────────────────────────────┘
    ┌─ Send Email ──────────────────────────────────────────────────┐
    │  Template ID: {w2}
    │  Subject:    "Business pricing that works for your whole team"│
    └───────────────────────────────────────────────────────────────┘
    ┌─ Time Delay: 4 days ──────────────────────────────────────────┐
    └───────────────────────────────────────────────────────────────┘
    ┌─ Send Email ──────────────────────────────────────────────────┐
    │  Template ID: {w3}
    │  Subject:    "Here's 5% off your first order — offer ends soon"│
    └───────────────────────────────────────────────────────────────┘

 2. ABANDONED CART  (trigger: "Started Checkout" metric — set in UI if not auto)
    ┌─ Time Delay: 1 hour ──────────────────────────────────────────┐
    └───────────────────────────────────────────────────────────────┘
    ┌─ Send Email ──────────────────────────────────────────────────┐
    │  Template ID: {ac1}
    │  Subject:    "You left something behind"                      │
    └───────────────────────────────────────────────────────────────┘
    ┌─ Time Delay: 23 hours ────────────────────────────────────────┐
    └───────────────────────────────────────────────────────────────┘
    ┌─ Send Email ──────────────────────────────────────────────────┐
    │  Template ID: {ac2}
    │  Subject:    "Still thinking it over? Your cart expires soon" │
    └───────────────────────────────────────────────────────────────┘

 3. POST-PURCHASE  (trigger: "Placed Order" metric — set in UI if not auto)
    ┌─ Time Delay: 1 day ───────────────────────────────────────────┐
    └───────────────────────────────────────────────────────────────┘
    ┌─ Send Email ──────────────────────────────────────────────────┐
    │  Template ID: {pp1}
    │  Subject:    "Your order is confirmed — thank you!"          │
    └───────────────────────────────────────────────────────────────┘
    ┌─ Time Delay: 6 days ──────────────────────────────────────────┐
    └───────────────────────────────────────────────────────────────┘
    ┌─ Send Email ──────────────────────────────────────────────────┐
    │  Template ID: {pp2}
    │  Subject:    "How's your new tech? Share your experience"    │
    └───────────────────────────────────────────────────────────────┘
""".format(
        w1  = t.get("welcome_1",        "NOT CREATED"),
        w2  = t.get("welcome_2",        "NOT CREATED"),
        w3  = t.get("welcome_3",        "NOT CREATED"),
        ac1 = t.get("abandoned_cart_1", "NOT CREATED"),
        ac2 = t.get("abandoned_cart_2", "NOT CREATED"),
        pp1 = t.get("post_purchase_1",  "NOT CREATED"),
        pp2 = t.get("post_purchase_2",  "NOT CREATED"),
    ))


# ─── Step 3: Create segment ────────────────────────────────────────────────────

def create_segment() -> str | None:
    """
    Creates the 'Business Buyers - High Value' segment shell.
    Conditions (2+ orders OR $1,000+ lifetime spend) require the Shopify
    integration to be active — add them in the Klaviyo UI after connecting Shopify.
    """
    print("\n👥 Creating segment: Business Buyers - High Value...")

    payload = {
        "data": {
            "type": "segment",
            "attributes": {
                "name": "Business Buyers - High Value",
                "definition": {
                    "condition_groups": []
                },
            }
        }
    }

    resp = post("segments", payload)
    if resp and "data" in resp:
        sid = resp["data"]["id"]
        results["segment"]["created"].append("Business Buyers - High Value")
        print(f"  ✓ Segment created  →  {sid}")
        print("  ℹ Add conditions in Klaviyo UI after connecting Shopify:")
        print("    Group 1: Placed Order ≥ 2 times (all time)")
        print("    Group 2 (OR): Placed Order revenue sum ≥ $1,000 (all time)")
        return sid
    else:
        results["segment"]["failed"].append("Business Buyers - High Value")
        print("  ✗ Segment creation failed — create manually in Klaviyo UI.")
        print("    Logic: (Placed Order ≥ 2 times) OR (Lifetime Revenue ≥ $1,000)")
        return None


# ─── Step 4: Create winback campaign ──────────────────────────────────────────

def create_winback_campaign(template_ids: dict[str, str], segment_id: str | None) -> str | None:
    """
    Creates the Winback campaign as a draft targeting the Business Buyers segment
    (or all profiles if the segment wasn't created). Uses the winback template.
    The campaign is left in 'draft' status — schedule it in the Klaviyo UI.
    """
    print("\n📣 Creating Winback campaign...")

    winback_template_id = template_ids.get("winback")
    if not winback_template_id:
        print("  ✗ Winback template was not created — skipping campaign.")
        results["campaign"]["failed"].append("Winback Campaign")
        return None

    # Build audience — use segment if available, otherwise warn
    audiences: dict = {}
    if segment_id:
        audiences = {"included": [segment_id]}
    else:
        print("  ⚠ No segment ID — campaign will target all profiles. Update in UI.")

    # Datetime is required by the API; set 30 days out as a placeholder.
    # Update the actual send time in Klaviyo UI before activating.
    send_dt = (datetime.now(timezone.utc) + timedelta(days=30)).strftime("%Y-%m-%dT%H:%M:%S+00:00")

    payload = {
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
                        "datetime": send_dt,
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
                                    "from_email":     "hello@uniwidemerchandise.com",
                                    "from_label":     "Uniwide Merchandise",
                                    "reply_to_email": "hello@uniwidemerchandise.com",
                                },
                            },
                        }
                    ]
                },
            },
        }
    }

    resp = post("campaigns", payload)
    if not (resp and "data" in resp):
        results["campaign"]["failed"].append("Winback Campaign")
        print("  ✗ Campaign creation failed.")
        return None

    campaign_id = resp["data"]["id"]
    print(f"  ✓ Campaign created  →  {campaign_id}")

    # Fetch the auto-created message ID so we can assign the template
    time.sleep(1)
    msg_resp = get(f"campaigns/{campaign_id}/campaign-messages")
    if not (msg_resp and msg_resp.get("data")):
        print("  ⚠ Could not fetch campaign message ID — assign template manually.")
        results["campaign"]["created"].append("Winback Campaign (no template)")
        return campaign_id

    message_id = msg_resp["data"][0]["id"]

    # Assign the HTML template to the message
    assign_payload = {
        "data": {
            "type": "campaign-message",
            "id":   message_id,
            "relationships": {
                "template": {
                    "data": {"type": "template", "id": winback_template_id}
                }
            },
        }
    }
    assign_resp = post("campaign-message-assign-template", assign_payload)
    if assign_resp:
        print(f"  ✓ Template assigned  →  message {message_id}")
        results["campaign"]["created"].append("Winback Campaign")
    else:
        print("  ⚠ Template assignment failed — assign manually in Klaviyo UI.")
        results["campaign"]["created"].append("Winback Campaign (template unassigned)")

    print(f"""
  📋 Winback campaign is in DRAFT — finish setup in Klaviyo:
     Campaigns → "Winback — 10% Off (WINBACK10)" → Schedule
     Recommended: target customers inactive for 90+ days.
     Add filter: "Last Ordered Date > 90 days ago" in audience settings.
""")
    return campaign_id


# ─── Final summary ────────────────────────────────────────────────────────────

def print_summary() -> None:
    total_ok  = sum(len(v["created"]) for v in results.values())
    total_err = sum(len(v["failed"])  for v in results.values())

    print("\n" + "═" * 60)
    print("  SETUP COMPLETE — SUMMARY")
    print("═" * 60)

    sections = {
        "Templates": results["templates"],
        "Segment":   results["segment"],
        "Campaign":  results["campaign"],
    }
    print("\n  ℹ Flows — Created manually in Klaviyo UI (API creation not supported)")
    print("    See the flow setup guide printed above for template IDs and timing.")


    for label, data in sections.items():
        if data["created"]:
            print(f"\n  ✓ {label}")
            for name in data["created"]:
                print(f"      · {name}")
        if data["failed"]:
            print(f"\n  ✗ {label} (FAILED — check output above)")
            for name in data["failed"]:
                print(f"      · {name}")

    print(f"\n  Total created: {total_ok}   Total failed: {total_err}")

    if total_err > 0:
        print("\n  ⚠ Some items failed. Check error messages above.")
        print("    Common causes: duplicate names, missing Shopify integration,")
        print("    or API permission scope not enabled for this key.")

    print("""
  NEXT STEPS:
    1. Open Klaviyo → Flows and wire up email actions using the
       template IDs printed in the setup guide above.
    2. Connect Shopify integration (Settings → Integrations → Shopify)
       so Abandoned Cart and Post-Purchase triggers activate automatically.
    3. Open the Winback campaign → Schedule it for the right send time.
    4. Review each flow in the UI and set to 'Live' when ready.
""")


# ─── Main ─────────────────────────────────────────────────────────────────────

def main() -> None:
    print("=" * 60)
    print("  Klaviyo Automation Setup — Uniwide Merchandise")
    print(f"  API revision: {REVISION}")
    print("=" * 60)

    # Verify the API key works before doing anything
    test = get("accounts")
    if test is None:
        print("\n✗ API key check failed — verify KLAVIYO_API_KEY is correct.")
        sys.exit(1)
    print(f"\n✓ Connected to Klaviyo account.")

    template_ids = create_templates()
    create_flows(template_ids)   # prints guide; API creation not supported
    segment_id   = create_segment()
    _            = create_winback_campaign(template_ids, segment_id)

    print_summary()


if __name__ == "__main__":
    main()
