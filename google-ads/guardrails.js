/**
 * Uniwide Merchandise - Google Ads Guardrails + Daily Report
 * ----------------------------------------------------------
 * A Google Ads SCRIPT (not the API - no developer token needed). It protects a
 * thin-margin, consumer-first reseller account from the two ways paid search
 * loses money: overspending, and paying for clicks that never convert (or convert
 * below your break-even ROAS). It also mines wasted-spend search terms and emails
 * a daily digest.
 *
 * WHAT IT DOES (every run):
 *   1. SPEND CAP   - if month-to-date cost >= MONTHLY_BUDGET, pause all enabled
 *                    campaigns (hard stop so a runaway can't blow the budget).
 *   2. ROAS GUARD  - for each campaign past MIN_SPEND_FOR_JUDGMENT in the window,
 *                    if ROAS < TARGET_ROAS, pause it (you're losing money on it).
 *   3. NEG MINING  - find search terms with cost >= WASTED_SPEND_THRESHOLD and
 *                    zero conversions; report them (optionally auto-add as account
 *                    negative keywords when ADD_NEGATIVES = true).
 *   4. REPORT      - email a summary to ALERT_EMAIL.
 *
 * SAFETY: DRY_RUN = true by default. It logs/emails what it WOULD do but changes
 * nothing. Watch it for a few days, confirm the numbers look right, then flip to
 * false. ROAS guard also self-disables if the account has ~no conversion tracking
 * yet (so it won't pause everything just because conversions aren't wired up).
 *
 * INSTALL:
 *   Google Ads -> Tools -> Bulk actions -> Scripts -> +  -> paste this ->
 *   Authorize -> set a schedule (Daily, early morning) -> Run.
 *   Requires conversion tracking to be LIVE for the ROAS guard to mean anything.
 */

// ===============================  CONFIG  ===============================
var CONFIG = {
  DRY_RUN: true,                  // true = report only, change nothing. Flip to false when confident.
  ALERT_EMAIL: '',                // e.g. 'erwin@uniwidemerchandise.com' - REQUIRED for the email report.

  // Spend control
  MONTHLY_BUDGET: 1500,           // hard month-to-date ceiling in account currency. Pauses everything at/over.

  // ROAS guard (conv. value / cost). 15% gross margin => break-even ROAS ~6.7x.
  // Set above break-even so you only keep profitable campaigns. Tune to your true margin.
  TARGET_ROAS: 7.0,
  MIN_SPEND_FOR_JUDGMENT: 50,     // don't judge a campaign's ROAS until it has spent at least this much.
  LOOKBACK: 'LAST_30_DAYS',       // window for ROAS judgment (LAST_7_DAYS / LAST_14_DAYS / LAST_30_DAYS).

  // Negative-keyword mining
  WASTED_SPEND_THRESHOLD: 25,     // a search term costing >= this with 0 conversions is "wasted".
  ADD_NEGATIVES: false,           // true = auto-add wasted terms as account-level exact negatives.
  NEG_LIST_NAME: 'Auto - Wasted Spend', // shared negative-keyword list to add them to (created if missing).

  CURRENCY: '$'
};

// ===============================  MAIN  ===============================
function main() {
  var lines = [];
  var log = function (s) { Logger.log(s); lines.push(s); };
  log('Uniwide Google Ads guardrails - ' + (CONFIG.DRY_RUN ? 'DRY RUN (no changes)' : 'LIVE (changes applied)'));
  log('Account: ' + AdsApp.currentAccount().getName() + '  (' + AdsApp.currentAccount().getCustomerId() + ')');
  log('');

  var actions = { paused: [], wasted: [], negativesAdded: 0 };

  // 1) Monthly spend cap ------------------------------------------------
  var mtd = monthToDateCost_();
  log('Month-to-date spend: ' + money_(mtd) + ' / ' + money_(CONFIG.MONTHLY_BUDGET) + ' cap');
  if (mtd >= CONFIG.MONTHLY_BUDGET) {
    log('  !! Budget cap reached - pausing ALL enabled campaigns.');
    var capped = pauseAllCampaigns_();
    capped.forEach(function (n) { actions.paused.push(n + ' (budget cap)'); });
  }
  log('');

  // 2) ROAS guard -------------------------------------------------------
  var trackingOk = accountHasConversionTracking_();
  if (!trackingOk) {
    log('ROAS guard SKIPPED: account shows ~no conversions yet. Wire up conversion tracking first.');
  } else {
    log('ROAS guard (target >= ' + CONFIG.TARGET_ROAS + 'x over ' + CONFIG.LOOKBACK + '):');
    var it = AdsApp.campaigns()
      .withCondition('Status = ENABLED')
      .forDateRange(CONFIG.LOOKBACK)
      .withCondition('Cost >= ' + CONFIG.MIN_SPEND_FOR_JUDGMENT)
      .get();
    while (it.hasNext()) {
      var c = it.next();
      var stats = c.getStatsFor(CONFIG.LOOKBACK);
      var cost = stats.getCost();
      var value = stats.getConversionValue ? stats.getConversionValue() : 0;
      var roas = cost > 0 ? value / cost : 0;
      var verdict = roas < CONFIG.TARGET_ROAS ? 'PAUSE' : 'keep';
      log('  ' + pad_(c.getName(), 34) + ' cost ' + money_(cost) +
          '  value ' + money_(value) + '  ROAS ' + roas.toFixed(2) + 'x  -> ' + verdict);
      if (roas < CONFIG.TARGET_ROAS) {
        if (!CONFIG.DRY_RUN) c.pause();
        actions.paused.push(c.getName() + ' (ROAS ' + roas.toFixed(2) + 'x)');
      }
    }
  }
  log('');

  // 3) Wasted-spend search terms ---------------------------------------
  log('Wasted search terms (cost >= ' + money_(CONFIG.WASTED_SPEND_THRESHOLD) + ', 0 conversions, ' + CONFIG.LOOKBACK + '):');
  var wasted = findWastedTerms_();
  if (!wasted.length) {
    log('  none');
  } else {
    wasted.forEach(function (w) { log('  ' + pad_(w.term, 40) + ' cost ' + money_(w.cost) + '  clicks ' + w.clicks); });
    actions.wasted = wasted;
    if (CONFIG.ADD_NEGATIVES && !CONFIG.DRY_RUN) {
      actions.negativesAdded = addNegatives_(wasted.map(function (w) { return w.term; }));
      log('  Added ' + actions.negativesAdded + ' negatives to list "' + CONFIG.NEG_LIST_NAME + '".');
    } else if (CONFIG.ADD_NEGATIVES) {
      log('  (DRY RUN) would add ' + wasted.length + ' negatives to "' + CONFIG.NEG_LIST_NAME + '".');
    }
  }
  log('');

  // 4) Report -----------------------------------------------------------
  log('Summary: ' + actions.paused.length + ' campaign(s) to pause, ' +
      actions.wasted.length + ' wasted term(s), ' + actions.negativesAdded + ' negative(s) added.');
  if (CONFIG.ALERT_EMAIL) {
    MailApp.sendEmail({
      to: CONFIG.ALERT_EMAIL,
      subject: '[Google Ads] Uniwide guardrails - ' + (CONFIG.DRY_RUN ? 'DRY RUN' : 'LIVE') +
               ' - ' + actions.paused.length + ' paused, ' + actions.wasted.length + ' wasted',
      body: lines.join('\n')
    });
  }
}

// ===============================  HELPERS  ===============================

function monthToDateCost_() {
  var now = new Date();
  var tz = AdsApp.currentAccount().getTimeZone();
  var first = Utilities.formatDate(new Date(now.getFullYear(), now.getMonth(), 1), tz, 'yyyyMMdd');
  var today = Utilities.formatDate(now, tz, 'yyyyMMdd');
  var total = 0;
  var rows = AdsApp.report(
    "SELECT metrics.cost_micros FROM campaign " +
    "WHERE segments.date BETWEEN '" + first + "' AND '" + today + "'"
  ).rows();
  while (rows.hasNext()) { total += (rows.next()['metrics.cost_micros'] || 0) / 1e6; }
  return total;
}

function pauseAllCampaigns_() {
  var names = [];
  var it = AdsApp.campaigns().withCondition('Status = ENABLED').get();
  while (it.hasNext()) {
    var c = it.next();
    names.push(c.getName());
    if (!CONFIG.DRY_RUN) c.pause();
  }
  return names;
}

/** Heuristic: does the account have any conversions in the window? If not, skip ROAS pausing. */
function accountHasConversionTracking_() {
  var s = AdsApp.currentAccount().getStatsFor(CONFIG.LOOKBACK);
  try { return s.getConversions() > 0; } catch (e) { return false; }
}

function findWastedTerms_() {
  var out = [];
  var range = dateRangeClause_(CONFIG.LOOKBACK);
  var rows = AdsApp.report(
    "SELECT search_term_view.search_term, metrics.cost_micros, metrics.clicks, metrics.conversions " +
    "FROM search_term_view WHERE " + range
  ).rows();
  while (rows.hasNext()) {
    var r = rows.next();
    var cost = (r['metrics.cost_micros'] || 0) / 1e6;
    var conv = Number(r['metrics.conversions'] || 0);
    if (cost >= CONFIG.WASTED_SPEND_THRESHOLD && conv === 0) {
      out.push({ term: r['search_term_view.search_term'], cost: cost, clicks: Number(r['metrics.clicks'] || 0) });
    }
  }
  out.sort(function (a, b) { return b.cost - a.cost; });
  return out;
}

function addNegatives_(terms) {
  var list = getOrCreateNegList_(CONFIG.NEG_LIST_NAME);
  if (!list) return 0;
  var n = 0;
  terms.forEach(function (t) { list.addNegativeKeyword('[' + t + ']'); n++; });
  return n;
}

function getOrCreateNegList_(name) {
  var it = AdsApp.negativeKeywordLists().withCondition('Name = "' + name + '"').get();
  if (it.hasNext()) return it.next();
  if (CONFIG.DRY_RUN) return null;
  var op = AdsApp.newNegativeKeywordListBuilder().withName(name).build();
  return op.isSuccessful() ? op.getResult() : null;
}

function dateRangeClause_(token) {
  var now = new Date();
  var tz = AdsApp.currentAccount().getTimeZone();
  var days = token === 'LAST_7_DAYS' ? 7 : token === 'LAST_14_DAYS' ? 14 : 30;
  var from = new Date(now.getTime() - days * 86400000);
  return "segments.date BETWEEN '" + Utilities.formatDate(from, tz, 'yyyyMMdd') +
         "' AND '" + Utilities.formatDate(now, tz, 'yyyyMMdd') + "'";
}

function money_(n) { return CONFIG.CURRENCY + Number(n || 0).toFixed(2); }
function pad_(s, n) { s = String(s); while (s.length < n) s += ' '; return s.slice(0, n); }
