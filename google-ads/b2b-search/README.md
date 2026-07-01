# Uniwide B2B Search campaign — ready to import

Ready-to-load Google Ads Search campaign targeting procurement / IT buyers across
Government, Education, Business, Healthcare, and AV. Lead-gen focused: ads drive to
each vertical's solutions page to request a bulk quote.

## Files
- `keywords.csv` — 5 ad groups, phrase + exact keywords (45 rows)
- `ads.csv` — one Responsive Search Ad per ad group (all headlines <=30, descriptions <=90, paths <=15, validated)
- `negatives.csv` / `negatives.txt` — 32 campaign negative keywords (waste blockers)

## Create the campaign first (Google Ads UI), then import assets
Editor imports keywords/ads into an existing campaign + ad groups, so set these up first:

1. **New campaign** → Goal: **Leads** → Type: **Search**.
2. **Networks:** Search only. UNCHECK Search Partners and Display Network (cleaner data to start).
3. **Locations:** United States (or your target states). **Language:** English.
4. **Budget:** $15–25/day.
5. **Bidding:** **Maximize Conversions** (switch to Target CPA once you have ~15–30 form conversions).
6. **Conversion:** must have lead conversion tracking live first (form submit / quote request). Without it, this optimizes blind.
7. Create the 5 ad groups by name: `Government`, `Education`, `Business`, `Healthcare`, `AV`.

## Import with Google Ads Editor
1. Download **Google Ads Editor** (free desktop app) → sign in → download your account.
2. **Account → Import → From file** → select `keywords.csv`. Review changes → **Keep**.
3. Repeat for `ads.csv`.
4. **Post** changes to push live.
5. **Negatives:** easiest via UI — Tools → Shared library → **Negative keyword lists** → paste `negatives.txt` → attach the list to this campaign. (Or import `negatives.csv` in Editor.)

## After launch — first 2 weeks
- Check the **Search Terms report** every few days; add irrelevant terms as negatives (the `guardrails.js` script also auto-mines these).
- Landing pages point to `/collections/<vertical>-solutions`. **Make sure each has a visible "Request a Quote" form/CTA** — that is the conversion. If you have a dedicated intake page, change the Final URL in `ads.csv` to it before importing.
- Pause keywords with clicks but zero conversions after ~30–50 clicks.
- Once conversions flow, install `../guardrails.js` (Google Ads → Tools → Scripts) and later flip it live.

## Notes
- AV ad group currently lands on `/collections/business-solutions` (no AV-specific collection yet) — point it at an AV page if you create one.
- Keep ad groups tightly themed; if one keyword pulls volume, break it into its own ad group with a matching RSA.
