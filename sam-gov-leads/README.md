# Uniwide — Government TECH Micro-Lead Dashboard (Google Apps Script)

Pulls federal contract opportunities from the **SAM.gov public Opportunities API**, filters to the
**technology** categories we sell (IT hardware/software/peripherals/services by NAICS + PSC), harvests each
notice's **contracting POC (name / email / phone)**, de-duplicates, scores them, and writes them to a backing
Google Sheet. It then serves a **live, shareable HTML dashboard** (Apps Script Web App) with real-time-ish
counts, new-lead alerts, a "≤ $15k / micro-buy" filter, and click-to-email POC links.

## Why this works for sub-$15k "micro" sales
True micro-purchases (below the federal micro-purchase threshold) **aren't publicly posted** on SAM.gov —
agencies put them on a **Government Purchase Card (GPC)**. So this tool builds a list of the **tech buying
offices + POCs actively procuring our categories**. They can buy straight off our Shopify store on a card,
no contract needed. The lead is the *buyer*; you reach out directly. "Est. Value" appears only when an agency
publishes one (mostly award notices); early-stage notices show **TBD**.

## Files
- `Code.gs` — sync engine + web-app endpoints (`doGet`, `getDashboardData`, `syncNow`).
- `Dashboard.html` — the shareable dashboard UI. In the Apps Script editor create an **HTML file named
  `Dashboard`** (the editor adds no extension) and paste this in.
- `appsscript.json` — manifest. Pre-set to deploy the web app as **Anyone (no login)** so your dad just opens a link.

## Setup
1. **Get a SAM.gov API key** (free): sam.gov → sign in → *Account Details* → *API Key*.
2. **New Apps Script project** (script.google.com → New project):
   - Paste `Code.gs`.
   - Add an HTML file named `Dashboard` (＋ → HTML) and paste `Dashboard.html`.
   - Project Settings → enable **"Show appsscript.json manifest file"** → paste `appsscript.json`.
3. **Store the key**: Project Settings → *Script Properties* →
   `Property = SAM_API_KEY`  (this exact name) , `Value = <your key>`. **Save.**
4. **Run `setup()`** once → grant permissions. Builds the sheet, installs an **hourly** sync trigger, first pull.
5. **Deploy the dashboard**: *Deploy* → *New deployment* → gear → **Web app** →
   *Execute as: Me* · *Who has access: Anyone* → **Deploy** → copy the **Web app URL** and send it to your dad.
   (Re-deploy after code edits, or use *Manage deployments* → edit → *New version* to update in place.)

## Tuning (`CONFIG` at top of `Code.gs`)
- `NAICS` — technology categories queried server-side (computer/peripheral wholesale, mfg, software, IT services).
- `PSC_KEEP_PREFIX` — `70` IT/ADP equipment & software, `58` comms/electronics, `D3` IT & telecom services.
- `VALUE_CAP` — micro-buy dollar ceiling (default **15000**) used for the flag, the score boost, and the default filter.
- `PTYPES_KEEP` — notice types: `r` Sources Sought, `k` Combined Synopsis/Solicitation, `o` Solicitation, `p` Presolicitation, `s` Special Notice, `i` Intent to Bundle.
- `LOOKBACK_DAYS` — days back per run (3 = hourly with overlap). `STATES` — restrict place-of-performance (e.g. `['TX','OK']`); empty = nationwide.
- `REQUIRE_EMAIL` — only keep notices with a POC email (default true). `DIGEST_EMAIL` — optional email alert of new leads.

## Lead scoring (Priority 0–100)
Higher = earlier signal + small-business-friendly + reachable + confirmed micro-sized. Sources Sought and
Combined Synopsis/Solicitation score highest; small-business / 8(a) / WOSB / SDVOSB / HUBZone set-asides get a
boost; a POC email and a published value ≤ `VALUE_CAP` add points.

## Notes / limits
- SAM.gov's public API has **daily rate limits**; the script paginates politely (400ms) and caps pages.
- The dashboard reads the backing sheet (fast) and auto-refreshes every 60s; the **hourly trigger** keeps the
  sheet fresh. The **"Sync now"** button does a live pull on demand (can take a minute).
- Micro-purchases via GPC need **no SAM registration** from the vendor — they just buy with a card. Awards above
  the micro-purchase threshold need an active **SAM.gov entity registration (UEI)** and possibly a GSA Schedule.
- Outreach to POCs uses public solicitation contacts — keep it relevant and professional.
