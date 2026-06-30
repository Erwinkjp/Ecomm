# Uniwide — Government Micro-Lead Generator (Google Apps Script)

Pulls federal contract opportunities from the **SAM.gov public Opportunities API**, filters to the
IT/office product categories we sell (by NAICS + PSC), harvests each notice's **contracting POC
(name / email / phone)**, de-duplicates, and writes them as scored leads into a Google Sheet. Runs daily.

## Why this works for "micro" sales
True micro-purchases (< $10k federal micro-purchase threshold) aren't publicly posted on SAM.gov —
agencies only must post solicitations above ~$25k. So instead of chasing purchase orders, this tool
builds a **contact list of the contracting officers / buying offices actively procuring our product
categories**. They can put micro-purchases on a **Government Purchase Card (GPC)** — i.e., buy straight
off our Shopify store (which already accepts cards). The lead is the *buyer*, and you reach out directly.

## Setup
1. **Get a SAM.gov API key** (free): sam.gov → sign in → *Account Details* → *API Key*. Copy it.
2. **New Apps Script project**: script.google.com → New project. Paste `Code.gs`. (Optional: also paste
   `appsscript.json` via Project Settings → "Show appsscript.json manifest".)
3. **Store the key**: Project Settings → *Script Properties* → add `SAM_API_KEY` = your key.
   (Or run `setApiKey('yourkey')` once from the editor, then delete that line.)
4. **Bind a sheet**: create a Google Sheet, Extensions → Apps Script (so the script is container-bound),
   OR just run `setup()` and it creates a standalone "Uniwide Gov Leads" spreadsheet.
5. **Run `setup()`** once → grant permissions. It builds the sheet, installs a daily 6am trigger, and
   does an initial pull. Use `testRun()` for one-off pulls anytime.
6. *(Optional)* set `DIGEST_EMAIL` in `CONFIG` to get a daily email of new leads.

## Tuning (top of `Code.gs`, the `CONFIG` object)
- `NAICS` — product categories queried server-side. Defaults cover IT reseller + office supplies.
- `PSC_KEEP_PREFIX` — Product Service Codes kept (70xx IT, 75xx office, 58xx telecom).
- `PTYPES_KEEP` — notice types: `r` Sources Sought, `k` Combined Synopsis/Solicitation, `o` Solicitation,
  `p` Presolicitation, `s` Special Notice, `i` Intent to Bundle.
- `LOOKBACK_DAYS` — days back per run (2 = daily with overlap).
- `STATES` — restrict place-of-performance (e.g. `['TX','OK']`); empty = nationwide.
- `REQUIRE_EMAIL` — only keep notices with a POC email (default true).

## Lead scoring (Priority 0–100)
Higher = earlier signal + small-business-friendly + reachable. Sources Sought and Combined
Synopsis/Solicitation score highest (you can shape or immediately quote those); small-business /
8(a) / WOSB / SDVOSB / HUBZone set-asides get a boost; a POC email adds points.

## Notes / limits
- SAM.gov public API has **daily rate limits**; the script paginates politely (400ms) and caps pages.
  If you add many NAICS codes or large lookbacks you may hit limits — keep it lean.
- To actually transact: micro-purchases (<$10k) via GPC need **no SAM registration** from the vendor —
  they just buy with a card. For awards above the micro-purchase threshold you'll want an active
  **SAM.gov entity registration (UEI)** and possibly a GSA Schedule. (Out of scope for this tool.)
- Outreach to POCs: these are public solicitation contacts — keep outreach relevant and professional.
