/**
 * Leads.gs - multi-source open-lead aggregation for the dashboard.
 * ---------------------------------------------------------------
 * Adds Grants.gov OPEN grant opportunities (forecasted + posted) alongside the
 * SAM.gov contract leads that Code.gs already syncs, and exposes
 * getUnifiedDashboardData() which the dashboard reads to show BOTH sources with
 * a Source filter. Designed to be extended: add another open source by writing a
 * sync + a normalizer that appends {source, ...} rows here.
 *
 * NOTE: Grants.gov lists funding opportunities orgs APPLY for (not purchase RFQs),
 * so treat grant rows as a softer, indirect signal (orgs that win tech/education/
 * health grants then buy equipment) vs the direct SAM.gov contract leads.
 *
 * SETUP: run setupGrants() once (builds the Grant Leads tab + daily trigger + first
 * pull). The dashboard automatically shows grants once the tab has rows.
 */

var GRANTS = {
  API: 'https://api.grants.gov/v1/api/search2',
  DETAIL_URL: 'https://www.grants.gov/search-results-detail/',
  // Keyword groups queried one-by-one, then merged + de-duplicated. Tune freely.
  KEYWORDS: [
    'computer equipment', 'laptops', 'classroom technology',
    'information technology equipment', 'medical imaging equipment',
    'audiovisual equipment', 'network infrastructure', 'telehealth equipment',
  ],
  STATUSES: 'forecasted|posted',   // OPEN only (not closed/archived)
  ROWS: 50,                        // per keyword per run
  SHEET_NAME: 'Grant Leads',
};

var GRANT_HEADERS = ['First Seen', 'Title', 'Agency', 'CFDA', 'Opp Number', 'Status',
  'Open Date', 'Close Date', 'Doc Type', 'Link', 'Grant ID'];

// ===============================  SETUP + SYNC  ===============================

function setupGrants() {
  ensureGrantSheet_();
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'syncGrants') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('syncGrants').timeBased().everyDays(1).atHour(6).create();
  Logger.log('Grants setup complete. Sheet "%s" ready and daily trigger installed.', GRANTS.SHEET_NAME);
  syncGrants();
}

/** Manual one-off grants pull. Returns count added. */
function syncGrants() {
  var sheet = ensureGrantSheet_();
  var existing = readExistingGrantIds_(sheet);
  var seen = {};
  var newRows = [];
  var stamp = new Date().toISOString();

  GRANTS.KEYWORDS.forEach(function (kw) {
    var opps = fetchGrants_(kw);
    opps.forEach(function (o) {
      var id = String(o.id || '');
      if (!id || existing[id] || seen[id]) return;
      seen[id] = true;
      newRows.push([
        stamp, o.title || '', o.agency || '', (o.cfdaList || []).join(', '),
        o.number || '', o.oppStatus || '', o.openDate || '', o.closeDate || '',
        o.docType || '', GRANTS.DETAIL_URL + id, id,
      ]);
    });
    Utilities.sleep(300);
  });

  if (newRows.length) {
    sheet.getRange(sheet.getLastRow() + 1, 1, newRows.length, GRANT_HEADERS.length).setValues(newRows);
  }
  Logger.log('Grants sync complete: %s new grant(s) added.', newRows.length);
  return newRows.length;
}

function fetchGrants_(keyword) {
  var payload = { rows: GRANTS.ROWS, keyword: keyword, oppStatuses: GRANTS.STATUSES };
  var res;
  try {
    res = UrlFetchApp.fetch(GRANTS.API, {
      method: 'post', contentType: 'application/json',
      payload: JSON.stringify(payload), muteHttpExceptions: true,
    });
  } catch (e) {
    Logger.log('Grants fetch error (%s): %s', keyword, e);
    return [];
  }
  if (res.getResponseCode() !== 200) return [];
  var body;
  try { body = JSON.parse(res.getContentText()); } catch (e) { return []; }
  if (body.errorcode !== 0) return [];
  return (body.data && body.data.oppHits) || [];
}

// ===============================  DASHBOARD DATA  ===============================

/**
 * Unified feed for the dashboard: SAM.gov contract leads (from Code.gs) + Grants.gov
 * grant leads, each tagged with a `source`. The dashboard filters/searches across both.
 */
function getUnifiedDashboardData() {
  var sam = getDashboardData(); // from Code.gs: { brand, valueCap, stats, leads:[...] }
  var contracts = (sam.leads || []).map(function (l) { l.source = 'contract'; return l; });
  var grants = readGrants_();   // [{ source:'grant', ... }]

  var all = contracts.concat(grants);
  var now = Date.now(), dayMs = 86400000;
  var stats = { total: all.length, contracts: contracts.length, grants: grants.length, new7d: 0, micro: 0 };
  all.forEach(function (l) {
    var seen = l.firstSeen ? new Date(l.firstSeen).getTime() : 0;
    if (seen && now - seen <= 7 * dayMs) stats.new7d++;
    if (l.source === 'contract' && (l.value === null || l.value <= (sam.valueCap || 15000))) stats.micro++;
  });

  return {
    brand: sam.brand,
    generatedAt: new Date().toISOString(),
    valueCap: sam.valueCap || 15000,
    stats: stats,
    leads: all,
  };
}

function readGrants_() {
  var sheet = ensureGrantSheet_();
  var last = sheet.getLastRow();
  if (last < 2) return [];
  var values = sheet.getRange(2, 1, last - 1, GRANT_HEADERS.length).getValues();
  var idx = {};
  GRANT_HEADERS.forEach(function (h, i) { idx[h] = i; });
  return values.map(function (r) {
    return {
      source: 'grant',
      firstSeen: toIso_(r[idx['First Seen']]),
      title: String(r[idx['Title']] || ''),
      agency: String(r[idx['Agency']] || ''),
      cfda: String(r[idx['CFDA']] || ''),
      number: String(r[idx['Opp Number']] || ''),
      status: String(r[idx['Status']] || ''),
      posted: String(r[idx['Open Date']] || ''),
      deadline: String(r[idx['Close Date']] || ''),
      docType: String(r[idx['Doc Type']] || ''),
      link: String(r[idx['Link']] || ''),
      noticeId: String(r[idx['Grant ID']] || ''),
      // contract-only fields as nulls so the dashboard can share one shape
      priority: null, value: null, naics: '', psc: '', type: '', setAside: '',
      pocName: '', pocEmail: '', pocPhone: '', solNum: '',
    };
  });
}

// ===============================  SHEET  ===============================

function grantSpreadsheet_() {
  var props = PropertiesService.getScriptProperties();
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) {
    var id = props.getProperty('SHEET_ID');
    if (id) { try { ss = SpreadsheetApp.openById(id); } catch (e) { ss = null; } }
    if (!ss) { ss = SpreadsheetApp.create('Uniwide Gov Tech Leads'); props.setProperty('SHEET_ID', ss.getId()); }
  }
  return ss;
}

function ensureGrantSheet_() {
  var ss = grantSpreadsheet_();
  var sheet = ss.getSheetByName(GRANTS.SHEET_NAME) || ss.insertSheet(GRANTS.SHEET_NAME);
  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, GRANT_HEADERS.length).setValues([GRANT_HEADERS])
      .setFontWeight('bold').setBackground('#0b1220').setFontColor('#ffffff');
    sheet.setFrozenRows(1);
    sheet.autoResizeColumns(1, GRANT_HEADERS.length);
  }
  return sheet;
}

function readExistingGrantIds_(sheet) {
  var ids = {};
  var last = sheet.getLastRow();
  if (last < 2) return ids;
  var col = GRANT_HEADERS.indexOf('Grant ID') + 1;
  var vals = sheet.getRange(2, col, last - 1, 1).getValues();
  vals.forEach(function (r) { if (r[0]) ids[String(r[0])] = true; });
  return ids;
}
