#!/usr/bin/env python3
"""
welcome_flow.py — Uniwide Merchandise
Builds the consumer WELCOME flow in Klaviyo as a DRAFT (never goes live, never
sends). It:
  1. Upserts 3 branded welcome email templates (idempotent by name).
  2. Creates a list-triggered flow (trigger = added to the signup "Email List")
     with 3 emails and time delays, in Draft status.

    python3 welcome_flow.py            # build templates + draft flow
    python3 welcome_flow.py --force    # create a 2nd flow even if one exists

Uses the live offer WELCOME10 (10% off) to match the signup popup — NOT the
deactivated WELCOME15. Reads KLAVIYO_PRIVATE_KEY from .env (auto-loaded from
../synnex-shopify-sync/.env). Flows are created in Draft by default; review and
set live yourself in Klaviyo -> Flows.
"""
import os, sys, json, time, ssl, urllib.request, urllib.error

try:
    import certifi
    SSL_CTX = ssl.create_default_context(cafile=certifi.where())
except Exception:
    SSL_CTX = ssl._create_unverified_context()


# -- .env loader (same locations as push_emails.py) --
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

API_KEY = os.environ.get("KLAVIYO_PRIVATE_KEY") or os.environ.get("KLAVIYO_API_KEY") or ""
if not API_KEY.startswith("pk_"):
    sys.exit("ERROR: set KLAVIYO_PRIVATE_KEY=pk_... in your .env")

BASE          = "https://a.klaviyo.com/api"
REV_TEMPLATES = "2024-10-15"     # matches the working push_emails.py
REV_FLOWS     = "2026-04-15"     # Create Flow API revision
LIST_ID       = os.environ.get("KLAVIYO_WELCOME_LIST_ID", "SAMsQ3")   # signup "Email List"
SITE          = "https://uniwidemerchandise.com"
FROM_EMAIL    = os.environ.get("KLAVIYO_FROM_EMAIL", "erwinkaijordanprado@gmail.com")
FROM_NAME     = "Uniwide Merchandise"
REPLY_TO      = "customersupport@uniwidemerchandise.com"
LOGO_URL      = os.environ.get("KLAVIYO_LOGO_URL", "https://d3k81ch9hvuctc.cloudfront.net/company/XhQyvC/images/602d783f-081a-41be-91cd-9e87cf94d32a.png")
FLOW_NAME     = "Uniwide | Welcome Series (WELCOME10)"
FORCE         = "--force" in sys.argv


def call(method, endpoint, payload=None, revision=REV_TEMPLATES):
    url = f"{BASE}/{endpoint}/"
    headers = {"Authorization": f"Klaviyo-API-Key {API_KEY}", "revision": revision,
               "content-type": "application/json", "accept": "application/json"}
    data = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=30, context=SSL_CTX) as r:
            body = r.read().decode()
            return (json.loads(body) if body else {}), None
    except urllib.error.HTTPError as e:
        return None, f"{e.code}: {e.read().decode()[:400]}"
    except Exception as e:
        return None, str(e)


def get_url(full_url, revision=REV_TEMPLATES):
    headers = {"Authorization": f"Klaviyo-API-Key {API_KEY}", "revision": revision, "accept": "application/json"}
    req = urllib.request.Request(full_url, headers=headers, method="GET")
    with urllib.request.urlopen(req, timeout=30, context=SSL_CTX) as r:
        return json.loads(r.read().decode())


# -- Branded HTML wrapper (identical look to push_emails.py) --
def html(preheader, headline, body_html, cta_label, cta_url):
    footer = ('<tr><td style="padding:24px 32px;background:#0b1220;color:#9aa4b2;font-size:12px;'
              'line-height:18px;text-align:center">Uniwide Merchandise &nbsp;&bull;&nbsp; '
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


SHOP = f"{SITE}/collections/all-products"

# -- The 3 welcome emails (live offer = WELCOME10 / 10% off) --
EMAILS = [
    {"key": "w1",
     "name": "Uniwide | Welcome #1 - 10% Off (WELCOME10)",
     "subject": "Welcome to Uniwide - here's 10% off your first order",
     "preheader": "Use code WELCOME10 at checkout. Business tech from brands you trust.",
     "headline": "Welcome - here's 10% off to get started",
     "cta": "Shop the catalog", "url": SHOP,
     "body": "<p>Thanks for joining Uniwide Merchandise. We supply business-grade IT - laptops, desktops, monitors, networking and more - from the brands your team already trusts, at competitive distribution pricing.</p>"
             "<p style='font-size:18px'><b>Take 10% off your first order with code <span style='color:#0ea5e9'>WELCOME10</span>.</b></p>"
             "<p>Buying for a team or whole organization? We offer <b>volume pricing</b> and <b>Net-30 terms</b> for qualified businesses - just reply and ask.</p>"},

    {"key": "w2",
     "name": "Uniwide | Welcome #2 - Why Uniwide",
     "subject": "Why teams buy their tech from Uniwide",
     "preheader": "Trusted brands, distribution pricing, fast shipping - your 10% is still good.",
     "headline": "The easiest way to buy business tech",
     "cta": "Browse best sellers", "url": SHOP,
     "body": "<p>Still deciding? Here's why businesses choose Uniwide Merchandise:</p>"
             "<ul><li><b>Brands you trust</b> - the same gear from the makers your IT team already knows.</li>"
             "<li><b>Distribution pricing</b> - competitive prices straight from the channel.</li>"
             "<li><b>Fast shipping</b> from the nearest warehouse, with tracking.</li>"
             "<li><b>Real support</b> - reply to any email and a human helps.</li></ul>"
             "<p>Your welcome offer is still active - <b>10% off with code <span style='color:#0ea5e9'>WELCOME10</span>.</b></p>"},

    {"key": "w3",
     "name": "Uniwide | Welcome #3 - Last Call",
     "subject": "Last call: your 10% off is about to expire",
     "preheader": "Use WELCOME10 before it's gone - plus volume pricing for teams.",
     "headline": "Your 10% off is about to expire",
     "cta": "Use my 10% now", "url": SHOP,
     "body": "<p>This is a friendly last call on your welcome discount. Lock in your first order before it expires.</p>"
             "<p style='font-size:18px'><b>10% off with code <span style='color:#0ea5e9'>WELCOME10</span>.</b></p>"
             "<p>Outfitting a team or organization? Ask us about <b>volume pricing</b> and <b>Net-30 terms</b> - reply to this email and we'll build you a quote.</p>"},
]


def existing_templates():
    out, url = {}, f"{BASE}/templates/"
    while url:
        j = get_url(url)
        for t in j.get("data", []):
            out[t["attributes"]["name"]] = t["id"]
        url = (j.get("links") or {}).get("next")
    return out


def upsert_templates():
    print("\nUpserting 3 welcome templates...")
    existing = existing_templates()
    ids = {}
    for e in EMAILS:
        body = html(e["preheader"], e["headline"], e["body"], e["cta"], e["url"])
        if e["name"] in existing:
            tid = existing[e["name"]]
            _, err = call("PATCH", f"templates/{tid}",
                          {"data": {"type": "template", "id": tid, "attributes": {"name": e["name"], "html": body}}})
            print(f"  {'updated ' if not err else 'FAIL '+err} {e['name']}")
        else:
            data, err = call("POST", "templates", {"data": {"type": "template",
                          "attributes": {"name": e["name"], "editor_type": "CODE", "html": body}}})
            tid = data["data"]["id"] if data else None
            print(f"  {'created ' if tid else 'FAIL '+str(err)} {e['name']}")
        if tid:
            ids[e["key"]] = tid
        time.sleep(0.3)
    return ids


def flow_exists(name):
    try:
        j = get_url(f"{BASE}/flows/", revision=REV_FLOWS)
    except Exception:
        return False
    return any(f.get("attributes", {}).get("name") == name for f in j.get("data", []))


WEEKDAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"]


def email_action(temp_id, next_id, e, template_id):
    return {
        "temporary_id": temp_id,
        "type": "send-email",
        "links": {"next": next_id},
        "data": {
            "message": {
                "from_email": FROM_EMAIL,
                "from_label": FROM_NAME,
                "reply_to_email": REPLY_TO,
                "cc_email": None, "bcc_email": None,
                "subject_line": e["subject"],
                "preview_text": e["preheader"],
                "template_id": template_id,
                "smart_sending_enabled": True,
                "transactional": False,
                "add_tracking_params": False,
                "custom_tracking_params": None,
                "additional_filters": None,
                "name": e["name"],
            },
            "status": "draft",
        },
    }


def delay_action(temp_id, next_id, days):
    return {
        "temporary_id": temp_id,
        "type": "time-delay",
        "links": {"next": next_id},
        "data": {
            "unit": "days", "value": days, "secondary_value": 0,
            "timezone": "profile", "delay_until_time": None,
            "delay_until_weekdays": WEEKDAYS,
        },
    }


def create_flow(tids):
    print("\nCreating Welcome flow (DRAFT)...")
    if flow_exists(FLOW_NAME) and not FORCE:
        print(f"  A flow named '{FLOW_NAME}' already exists. Skipping (use --force to make another).")
        return
    actions = [
        email_action("a1", "d1", EMAILS[0], tids["w1"]),
        delay_action("d1", "a2", 2),
        email_action("a2", "d2", EMAILS[1], tids["w2"]),
        delay_action("d2", "a3", 3),
        email_action("a3", None, EMAILS[2], tids["w3"]),
    ]
    payload = {"data": {"type": "flow", "attributes": {
        "name": FLOW_NAME,
        "definition": {
            "triggers": [{"type": "list", "id": LIST_ID}],
            "profile_filter": None,
            "entry_action_id": "a1",
            "actions": actions,
        },
    }}}
    data, err = call("POST", "flows", payload, revision=REV_FLOWS)
    if err:
        print("  FAIL flow create:", err)
        print("  (Templates are in place; fix and re-run - templates won't duplicate.)")
        return
    fid = data["data"]["id"]
    print(f"  created flow (DRAFT) -> {fid}")
    print(f"  Review at: https://www.klaviyo.com/flows/{fid}/edit")


if __name__ == "__main__":
    tids = upsert_templates()
    missing = [e["key"] for e in EMAILS if e["key"] not in tids]
    if missing:
        sys.exit(f"\nTemplate(s) failed: {missing}. Fix and re-run before creating the flow.")
    create_flow(tids)
    print("\nDone. Flow is in DRAFT - review in Klaviyo -> Flows, then set Live yourself. Nothing was sent.")
