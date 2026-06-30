#!/usr/bin/env python3
"""
push_emails.py — Uniwide Merchandise
Creates/updates 10 branded email templates in Klaviyo (core program + 5 industry
emails), removes the broken duplicate "Abandoned Cart" templates from the earlier
run, and creates a 15%-off LAUNCH campaign as a DRAFT (never sends).

    python3 push_emails.py            # upsert templates + cleanup + draft campaign
    python3 push_emails.py --no-clean # skip deleting the duplicate templates

Reads KLAVIYO_PRIVATE_KEY from .env (auto-loaded from ../synnex-shopify-sync/.env).
"""
import os, sys, json, time, ssl, urllib.request, urllib.error

# macOS system Python often lacks CA certs for urllib; use certifi if present.
try:
    import certifi
    SSL_CTX = ssl.create_default_context(cafile=certifi.where())
except Exception:
    SSL_CTX = ssl._create_unverified_context()


# ── .env loader ───────────────────────────────────────────────────────────────
def _load_dotenv():
    here = os.path.dirname(os.path.abspath(__file__))
    for path in [os.environ.get("KLAVIYO_ENV_FILE"), os.path.join(os.getcwd(), ".env"),
                 os.path.join(here, ".env"), os.path.join(here, "..", "synnex-shopify-sync", ".env")]:
        if path and os.path.isfile(path):
            for line in open(path):
                line = line.strip()
                if not line or line.startswith("#"):
                    continue
                if line.startswith("export "):
                    line = line[7:]
                if "=" in line:
                    k, v = line.split("=", 1)
                    os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))
            return


_load_dotenv()

API_KEY    = os.environ.get("KLAVIYO_PRIVATE_KEY") or os.environ.get("KLAVIYO_API_KEY") or ""
if not API_KEY.startswith("pk_"):
    sys.exit("ERROR: set KLAVIYO_PRIVATE_KEY=pk_... in your .env")
BASE       = "https://a.klaviyo.com/api"
REVISION   = "2024-10-15"
LIST_ID    = os.environ.get("KLAVIYO_WELCOME_LIST_ID", "SAMsQ3")     # "Email List"
SITE       = "https://uniwidemerchandise.com"
FROM_EMAIL = os.environ.get("KLAVIYO_FROM_EMAIL", "erwinkaijordanprado@gmail.com")  # default verified sender
FROM_NAME  = "Uniwide Merchandise"
REPLY_TO   = "customersupport@uniwidemerchandise.com"
# Hosted on Klaviyo's CDN (uniwide-logo-dark-header-900w.png) — light logo for the blue header bar.
LOGO_URL   = os.environ.get("KLAVIYO_LOGO_URL", "https://d3k81ch9hvuctc.cloudfront.net/company/XhQyvC/images/602d783f-081a-41be-91cd-9e87cf94d32a.png")
CLEAN      = "--no-clean" not in sys.argv

HEADERS = {"Authorization": f"Klaviyo-API-Key {API_KEY}", "revision": REVISION,
           "content-type": "application/json", "accept": "application/json"}

# Broken duplicate templates from the earlier buggy run (all "Abandoned Cart").
JUNK_TEMPLATE_IDS = ["WR2V9E","TCArFj","WgnSGt","UgEYrH","XYbvRy","TxXbjV","XevGQ4","UXXMhM","S2HQeh","RsiMR4"]


def call(method, endpoint, payload=None):
    url = f"{BASE}/{endpoint}/"
    data = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(url, data=data, headers=HEADERS, method=method)
    try:
        with urllib.request.urlopen(req, timeout=30, context=SSL_CTX) as r:
            body = r.read().decode()
            return (json.loads(body) if body else {}), None
    except urllib.error.HTTPError as e:
        return None, f"{e.code}: {e.read().decode()[:300]}"
    except Exception as e:
        return None, str(e)


# ── Branded HTML wrapper (table-based for email clients) ──────────────────────
def html(preheader, headline, body_html, cta_label, cta_url):
    footer = ('<tr><td style="padding:24px 32px;background:#0b1220;color:#9aa4b2;font-size:12px;'
              'line-height:18px;text-align:center">Uniwide Merchandise &nbsp;•&nbsp; '
              'Business technology, simplified.<br>Questions? '
              '<a href="mailto:customersupport@uniwidemerchandise.com" style="color:#7dd3fc">'
              'customersupport@uniwidemerchandise.com</a><br><br>'
              'You\'re receiving this because you signed up at uniwidemerchandise.com.<br>'
              '<a href="{% unsubscribe %}" style="color:#7dd3fc">Unsubscribe</a></td></tr>')
    return (
        '<!doctype html><html><body style="margin:0;background:#eef1f5;font-family:Helvetica,Arial,sans-serif">'
        f'<span style="display:none;max-height:0;overflow:hidden;color:#eef1f5">{preheader}</span>'
        '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#eef1f5">'
        '<tr><td align="center" style="padding:24px 12px">'
        '<table role="presentation" width="600" cellpadding="0" cellspacing="0" '
        'style="background:#ffffff;border-radius:10px;overflow:hidden;max-width:600px;width:100%">'
        '<tr><td style="background:#0ea5e9;padding:18px 32px">'
        f'<img src="{LOGO_URL}" alt="Uniwide Merchandise" width="200" height="54" '
        'style="display:block;border:0;outline:none;text-decoration:none;height:auto;width:200px;max-width:200px"></td></tr>'
        f'<tr><td style="padding:32px 32px 8px"><h1 style="margin:0 0 12px;font-size:24px;color:#0b1220;'
        f'line-height:1.25">{headline}</h1><div style="font-size:15px;line-height:1.6;color:#334155">{body_html}</div></td></tr>'
        f'<tr><td style="padding:8px 32px 32px"><a href="{cta_url}" style="display:inline-block;background:#0ea5e9;'
        f'color:#fff;text-decoration:none;font-weight:600;font-size:15px;padding:13px 26px;border-radius:6px">{cta_label}</a></td></tr>'
        + footer +
        '</table></td></tr></table></body></html>'
    )


def C(handle):  # collection url
    return f"{SITE}/collections/{handle}"


# ── The 10 emails ─────────────────────────────────────────────────────────────
EMAILS = [
    {"key":"welcome","name":"Uniwide | Welcome #1 — 15% Off","subject":"Welcome to Uniwide — here's 15% off your first order",
     "preheader":"Use code WELCOME15 at checkout. Business tech from brands you trust.",
     "headline":"Welcome — here's 15% off to get started","cta":"Shop the catalog","url":C("all-products"),
     "body":"<p>Thanks for joining Uniwide Merchandise. We supply business-grade IT — laptops, desktops, monitors, networking, and more — from the brands your team already trusts, at competitive distribution pricing.</p>"
            "<p style='font-size:18px'><b>Take 15% off your first order with code <span style='color:#0ea5e9'>WELCOME15</span>.</b></p>"
            "<p>Need to buy for a team or a whole organization? We offer <b>volume pricing</b> and <b>Net-30 terms</b> for qualified businesses — just reply and ask.</p>"},

    {"key":"abandoned","name":"Uniwide | Abandoned Checkout — Reminder","subject":"You left something in your cart",
     "preheader":"Your items are still available — finish checking out in a click.",
     "headline":"Still thinking it over?","cta":"Complete your order","url":f"{SITE}/cart",
     "body":"<p>You left some items in your cart at Uniwide Merchandise. They're still available — but stock and pricing can change quickly.</p>"
            "<p>Pick up right where you left off, and reach out if you'd like a <b>volume quote</b> or have questions about specs.</p>"},

    {"key":"postpurchase","name":"Uniwide | Post-Purchase — Thank You","subject":"Thanks for your order!",
     "preheader":"Here's what happens next — plus how to set up a business account.",
     "headline":"Thank you for your order","cta":"Track your order","url":f"{SITE}/account",
     "body":"<p>We appreciate your business. Your order is being processed and ships from the nearest warehouse — you'll get tracking as soon as it's on the way.</p>"
            "<p>Buying for a business? <b>Set up a company account</b> for faster reordering, volume pricing, and Net-30 terms. Just reply to this email and we'll get you set up.</p>"},

    {"key":"winback","name":"Uniwide | Winback — 10% Off","subject":"We miss you — here's 10% off",
     "preheader":"It's been a while. Take 10% off your next order with WELCOMEBACK10.",
     "headline":"It's been a while — here's 10% off","cta":"Shop new arrivals","url":C("all-products"),
     "body":"<p>We've added a lot of new inventory since your last visit. Come see what's new across laptops, monitors, networking, and more.</p>"
            "<p style='font-size:18px'><b>Take 10% off with code <span style='color:#0ea5e9'>WELCOMEBACK10</span>.</b></p>"},

    {"key":"launch","name":"Uniwide | Launch — 15% Off Everything","subject":"Now open: business tech, simplified — 15% off everything",
     "preheader":"Laptops, monitors, networking & more — 15% off with code LAUNCH15.",
     "headline":"Now open. 15% off everything.","cta":"Shop the launch","url":C("all-products"),
     "body":"<p>Uniwide Merchandise is your one-stop source for business technology — competitively priced, fast to ship, and backed by real support.</p>"
            "<p style='font-size:18px'><b>To celebrate, take 15% off everything with code <span style='color:#0ea5e9'>LAUNCH15</span>.</b></p>"
            "<p>Laptops &amp; desktops, monitors, networking, storage, power, printers and more — plus <b>volume pricing</b> and <b>Net-30 terms</b> for organizations.</p>"},

    {"key":"edu","name":"Uniwide | Industry — Education","subject":"Tech that scales for schools & districts",
     "preheader":"Chromebooks, projectors, labs & networking — volume pricing + Net-30.",
     "headline":"Outfit classrooms and campuses for less","cta":"Shop Education solutions","url":C("education-solutions"),
     "body":"<p>From 1:1 device programs to computer labs and AV, Uniwide helps schools and districts deploy reliable technology on budget.</p>"
            "<ul><li>Chromebooks, laptops &amp; carts for 1:1 programs</li><li>Projectors, displays &amp; classroom AV</li><li>Networking &amp; Wi-Fi for campus coverage</li></ul>"
            "<p><b>Volume pricing, Net-30 terms, and PO-friendly checkout</b> for schools. Reply for a district quote.</p>"},

    {"key":"gov","name":"Uniwide | Industry — Government","subject":"TAA-friendly IT with Net-30 terms",
     "preheader":"Hardware for agencies — volume pricing, Net-30, and PO support.",
     "headline":"Procurement-friendly IT for government","cta":"Shop Government solutions","url":C("government-solutions"),
     "body":"<p>Uniwide supplies federal, state, and local agencies with the hardware they need — from secure endpoints to networking and power.</p>"
            "<ul><li>Laptops, desktops &amp; secure endpoints</li><li>Networking, power &amp; surveillance</li><li>Volume pricing with Net-30 and PO checkout</li></ul>"
            "<p>Need TAA-compliant options or a formal quote? Reply and our team will help.</p>"},

    {"key":"health","name":"Uniwide | Industry — Healthcare","subject":"Reliable IT for healthcare teams",
     "preheader":"Workstations, carts, displays & security for clinical environments.",
     "headline":"Dependable technology for healthcare","cta":"Shop Healthcare solutions","url":C("healthcare-solutions"),
     "body":"<p>Clinical environments demand reliable, secure hardware. Uniwide equips hospitals, clinics, and practices with the right tools.</p>"
            "<ul><li>Workstations, all-in-ones &amp; medical-grade displays</li><li>Input devices, carts &amp; peripherals</li><li>Security cameras &amp; access hardware</li></ul>"
            "<p><b>Volume pricing and Net-30 terms</b> for healthcare organizations. Reply for a tailored quote.</p>"},

    {"key":"finance","name":"Uniwide | Industry — Finance","subject":"Secure technology for financial services",
     "preheader":"Endpoints, networking & security built for compliance-minded teams.",
     "headline":"Secure, compliant tech for finance","cta":"Shop Finance solutions","url":C("finance-solutions"),
     "body":"<p>Banks, credit unions, and financial firms trust Uniwide for secure, dependable IT that supports compliance and uptime.</p>"
            "<ul><li>Business laptops &amp; desktops</li><li>Networking, firewalls &amp; secure infrastructure</li><li>Power protection &amp; surveillance</li></ul>"
            "<p><b>Volume pricing and Net-30 terms</b> for financial institutions. Reply for a quote.</p>"},

    {"key":"business","name":"Uniwide | Industry — Business","subject":"Outfit your team for less",
     "preheader":"Laptops, monitors & accessories for growing businesses — volume + Net-30.",
     "headline":"Everything your team needs to work","cta":"Shop Business solutions","url":C("business-solutions"),
     "body":"<p>Whether you're equipping five people or five hundred, Uniwide makes it easy to outfit your team with the right technology.</p>"
            "<ul><li>Laptops, desktops &amp; monitors</li><li>Networking, storage &amp; power</li><li>Accessories, peripherals &amp; cables</li></ul>"
            "<p><b>Volume pricing and Net-30 terms</b> for businesses. Reply and we'll build you a quote.</p>"},

    # ── New-customer welcome emails (vertical-specific onboarding) ──
    {"key":"welcome_gov","name":"Uniwide | Welcome — Government","subject":"Welcome to Uniwide — procurement-friendly IT for your agency",
     "preheader":"TAA-friendly options, Net-30 terms, PO checkout — and 15% off to start.",
     "headline":"Welcome — IT built for public-sector buying","cta":"Shop Government solutions","url":C("government-solutions"),
     "body":"<p>Thanks for joining Uniwide Merchandise. We help federal, state, and local agencies source hardware the way procurement actually works.</p>"
            "<ul><li>TAA-friendly options on request</li><li>Net-30 terms &amp; PO-friendly checkout</li><li>Volume pricing and formal quotes</li></ul>"
            "<p style='font-size:18px'><b>Start with 15% off using code <span style='color:#0ea5e9'>WELCOME15</span>.</b> Need a quote or contract pricing? Just reply.</p>"},

    {"key":"welcome_edu","name":"Uniwide | Welcome — Schools","subject":"Welcome to Uniwide — tech that scales for your school",
     "preheader":"Chromebooks, projectors, labs & networking — volume pricing + Net-30.",
     "headline":"Welcome — let's equip your classrooms","cta":"Shop Education solutions","url":C("education-solutions"),
     "body":"<p>Thanks for joining Uniwide Merchandise. We help schools and districts deploy reliable technology on budget.</p>"
            "<ul><li>Chromebooks, laptops &amp; carts for 1:1 programs</li><li>Projectors, displays &amp; classroom AV</li><li>Campus networking &amp; Wi-Fi</li></ul>"
            "<p style='font-size:18px'><b>Start with 15% off using code <span style='color:#0ea5e9'>WELCOME15</span>.</b> PO-friendly checkout and Net-30 available — reply for a district quote.</p>"},

    {"key":"welcome_smb","name":"Uniwide | Welcome — Small Business","subject":"Welcome to Uniwide — outfit your team for less",
     "preheader":"Laptops, monitors & accessories — volume pricing and Net-30 terms.",
     "headline":"Welcome — everything your team needs to work","cta":"Shop Business solutions","url":C("business-solutions"),
     "body":"<p>Thanks for joining Uniwide Merchandise. Whether you're equipping five people or five hundred, we make outfitting your team simple and affordable.</p>"
            "<ul><li>Laptops, desktops &amp; monitors</li><li>Networking, storage &amp; power</li><li>Accessories, peripherals &amp; cables</li></ul>"
            "<p style='font-size:18px'><b>Start with 15% off using code <span style='color:#0ea5e9'>WELCOME15</span>.</b> Ask us about volume pricing and Net-30 terms.</p>"},

    # ── B2B onboarding — manual send when a new business customer is set up ──
    {"key":"b2b_onboarding","name":"Uniwide | B2B Onboarding — Your Company Account","subject":"Your Uniwide business account is ready",
     "preheader":"Sign in to see your Company Standards, pricing, and reorder in one click.",
     "headline":"Welcome — your company account is ready","cta":"Access your account","url":f"{SITE}/account",
     "body":"<p>Your Uniwide Merchandise <b>company account</b> is set up. You now have access to your negotiated business pricing, Net-30 terms, and your <b>Company Standards</b> — the products we've approved for your team, ready to reorder in one click.</p>"
            "<p><b>How to sign in (no password):</b></p>"
            "<ol><li>Click <b>Access your account</b> below.</li><li>Enter this work email — we'll send a 6-digit code.</li><li>Enter the code and you're in.</li></ol>"
            "<p>Inside, open <b>Company Standards</b> to set quantities and order your approved products instantly. Need to adjust your standards or add users? Reply here or contact "
            "<a href='mailto:customersupport@uniwidemerchandise.com' style='color:#0ea5e9'>customersupport@uniwidemerchandise.com</a>.</p>"},
]


def existing_templates():
    # paginate so re-runs PATCH existing templates instead of creating duplicates
    return {t["attributes"]["name"]: t["id"] for t in list_all_templates()}


def upsert_templates():
    print("\n📧 Upserting 10 templates...")
    existing = existing_templates()
    ids = {}
    for e in EMAILS:
        body = html(e["preheader"], e["headline"], e["body"], e["cta"], e["url"])
        attrs = {"name": e["name"], "editor_type": "CODE", "html": body}
        if e["name"] in existing:
            tid = existing[e["name"]]
            _, err = call("PATCH", f"templates/{tid}", {"data": {"type": "template", "id": tid, "attributes": {"name": e["name"], "html": body}}})
            print(f"  {'✓ updated' if not err else '✗ '+err} {e['name']}")
        else:
            data, err = call("POST", "templates", {"data": {"type": "template", "attributes": attrs}})
            tid = data["data"]["id"] if data else None
            print(f"  {'✓ created' if tid else '✗ '+str(err)} {e['name']}")
        if tid:
            ids[e["key"]] = tid
        time.sleep(0.3)
    return ids


def _get_url(full_url):
    req = urllib.request.Request(full_url, headers=HEADERS, method="GET")
    with urllib.request.urlopen(req, timeout=30, context=SSL_CTX) as r:
        return json.loads(r.read().decode())


def list_all_templates():
    out, url = [], f"{BASE}/templates/"
    while url:
        j = _get_url(url)
        out.extend(j.get("data", []))
        url = (j.get("links") or {}).get("next")
    return out


def cleanup_dupes(keep_ids):
    """Delete every 'Uniwide |' template EXCEPT the curated keepers (keep_ids).
    Non-'Uniwide |' templates (Klaviyo defaults / hand-made) are never touched."""
    if not CLEAN:
        return
    print("\n🧹 Removing duplicate 'Uniwide |' templates (keeping the curated set)...")
    all_t = list_all_templates()
    targets = [t for t in all_t if t["attributes"]["name"].startswith("Uniwide |") and t["id"] not in keep_ids]
    print(f"  found {len(all_t)} templates; {len(targets)} duplicates to remove; keeping {len(keep_ids)} curated.")
    deleted = 0
    for t in targets:
        _, e = call("DELETE", f"templates/{t['id']}")
        if not e:
            deleted += 1
        else:
            print(f"    · skip {t['id']}: {e.split(':')[0]}")
        time.sleep(0.12)
    print(f"  ✓ deleted {deleted} duplicate templates.")


def create_launch_campaign(launch_template_id):
    print("\n📣 Creating 15%-off LAUNCH campaign (DRAFT — will not send)...")
    if not launch_template_id:
        print("  ✗ launch template missing — skipping campaign."); return
    send_dt = time.strftime("%Y-%m-%dT%H:%M:%S+00:00", time.gmtime(time.time() + 30 * 86400))
    payload = {"data": {"type": "campaign", "attributes": {
        "name": "Uniwide Launch — 15% Off (LAUNCH15)",
        "audiences": {"included": [LIST_ID]},
        "send_options": {"use_smart_sending": True},
        "tracking_options": {"is_tracking_clicks": True, "is_tracking_opens": True},
        "send_strategy": {"method": "static", "options_static": {"datetime": send_dt, "is_local": False}},
        "campaign-messages": {"data": [{"type": "campaign-message", "attributes": {
            "channel": "email", "label": "Launch Email",
            "content": {"subject": "Now open: business tech, simplified — 15% off everything",
                        "preview_text": "Laptops, monitors, networking & more — 15% off with code LAUNCH15.",
                        "from_email": FROM_EMAIL, "from_label": FROM_NAME, "reply_to_email": REPLY_TO}}}]},
    }}}
    data, err = call("POST", "campaigns", payload)
    if err:
        print("  ✗ campaign create failed:", err); return
    cid = data["data"]["id"]
    print(f"  ✓ campaign created (DRAFT) → {cid}")
    time.sleep(1)
    msg, err = call("GET", f"campaigns/{cid}/campaign-messages")
    mid = msg["data"][0]["id"] if (msg and msg.get("data")) else None
    if mid:
        _, err = call("POST", "campaign-message-assign-template",
                      {"data": {"type": "campaign-message", "id": mid,
                                "relationships": {"template": {"data": {"type": "template", "id": launch_template_id}}}}})
        print(f"  {'✓ template assigned' if not err else '⚠ assign failed: '+err}")
    print("  📋 DRAFT only — review at Klaviyo → Campaigns, set sender/segment, then send.")


if __name__ == "__main__":
    ids = upsert_templates()
    cleanup_dupes(set(ids.values()))
    if "--no-campaign" not in sys.argv:
        create_launch_campaign(ids.get("launch"))
    print("\nDone. Curated templates in place; duplicates removed; nothing sent.")
