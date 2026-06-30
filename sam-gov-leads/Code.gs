/**
 * Uniwide Merchandise — Government Micro-Lead Generator
 * ----------------------------------------------------
 * Pulls federal contract opportunities from the SAM.gov public Opportunities API
 * (https://api.sam.gov/opportunities/v2/search), filters them to the product
 * categories we sell (IT hardware/software + office supplies via NAICS/PSC),
 * harvests the contracting Point-of-Contact (name/email/phone) from each notice,
 * de-duplicates, and writes them as leads into a Google Sheet. Runs daily.
 *
 * WHY POC-centric: true micro-purchases (<$10k) aren't posted on SAM.gov, but the
 * buyers who make them are reachable via the POCs on the larger notices they post.
 * Those POCs can buy off our store on a Government Purchase Card. Lead = the buyer.
 *
 * SETUP (one time):
 *   1. Get a free SAM.gov API key: sam.gov → sign in → Account Details → API Key.
 *   2. In Apps Script: Project Settings → Script Properties → add SAM_API_KEY = <key>.
 *      (or run setApiKey('yourkey') once from the editor, then delete the call)
 *   3. Run setup() once (grant permissions). It creates the sheet + a daily trigger.
 *   4. Optional: set DIGEST_EMAIL below to get a daily email of new leads.
 *
 * Run testRun() any time for a one-off pull without waiting for the trigger.
 */

// ─────────────────────────────  CONFIG  ─────────────────────────────
var CONFIG = {
  // Product categories we sell. We query SAM.gov server-side by NAICS, then
  // additionally keep anything whose PSC (classification code) is in PSC_KEEP.
  NAICS: [
    '423430', // Computer & peripheral equipment & software merchant wholesalers (our core reseller code)
    '334111', // Electronic computer manufacturing
    '334118', // Computer terminal & other peripheral equipment
    '511210', // Software publishers
    '541519', // Other computer-related services (VAR / IT)
    '424120', // Stationery & office-supplies merchant wholesalers
    '453210'  // Office supplies & stationery stores
  ],
  // Product Service Codes worth keeping even if NAICS is broad (70xx = IT, 75xx = office).
  PSC_KEEP_PREFIX: ['70', '7010', '7021', '7025', '7030', '7035', '7045', '7050',
                    '5805', '5810', '7490', '7510', '7520', '6010'],
  // Procurement (notice) types to keep — the buy-side, early-signal ones.
  //   k = Combined Synopsis/Solicitation, o = Solicitation, p = Presolicitation,
  //   r = Sources Sought, s = Special Notice, i = Intent to Bundle.
  PTYPES_KEEP: ['k', 'o', 'p', 'r', 's', 'i'],
  // How many days back to pull on each run (daily trigger → 2 gives a safety overlap).
  LOOKBACK_DAYS: 2,
  // Only keep notices that still have a POC email (the whole point is direct outreach).
  REQUIRE_EMAIL: true,
  // Sheet + email
  SHEET_NAME: 'Gov Leads',
  DIGEST_EMAIL: '', // e.g. 'erwin@uniwidemerchandise.com' — leave '' to disable email digest
  // Restrict to certain states' place-of-performance (e.g. ['TX','OK']). Empty = nationwide.
  STATES: [],
  // API
  API_BASE: 'https://api.sam.gov/opportunities/v2/search',
  PAGE_SIZE: 1000,      // max 1000
  MAX_PAGES_PER_NAICS: 5 // safety cap on pagination per NAICS per run
};

var HEADERS = ['Posted', 'Priority', 'Title', 'Agency / Office', 'NAICS', 'PSC',
  'Notice Type', 'Set-Aside', 'Response Deadline', 'POC Name', 'POC Email',
  'POC Phone', 'Solicitation #', 'Link', 'Notice ID', 'Status'];

// ─────────────────────────────  ENTRY POINTS  ─────────────────────────────

/** One-time setup: validates key, builds the sheet, installs the daily trigger. */
function setup() {
  if (!getApiKey_()) throw new Error('Set SAM_API_KEY in Script Properties first (see header).');
  ensureSheet_();
  createDailyTrigger_();
  Logger.log('Setup complete. Sheet "%s" ready and daily trigger installed.', CONFIG.SHEET_NAME);
  runLeadSync(); // do an initial pull right away
}

/** Manual one-off pull (safe to run anytime). */
function testRun() { runLeadSync(); }

/** Helper to store the API key from the editor: setApiKey('xxxx') then delete the call. */
function setApiKey(key) {
  PropertiesService.getScriptProperties().setProperty('SAM_API_KEY', String(key).trim());
  Logger.log('SAM_API_KEY saved.');
}

// ─────────────────────────────  MAIN  ─────────────────────────────

function runLeadSync() {
  var apiKey = getApiKey_();
  if (!apiKey) throw new Error('Missing SAM_API_KEY (Project Settings → Script Properties).');

  var sheet = ensureSheet_();
  var existingIds = readExistingNoticeIds_(sheet);

  var tz = Session.getScriptTimeZone();
  var now = new Date();
  var from = new Date(now.getTime() - CONFIG.LOOKBACK_DAYS * 86400000);
  var postedFrom = Utilities.formatDate(from, tz, 'MM/dd/yyyy');
  var postedTo = Utilities.formatDate(now, tz, 'MM/dd/yyyy');

  var seen = {};        // de-dup within this run
  var newLeads = [];

  CONFIG.NAICS.forEach(function (naics) {
    var page = 0, offset = 0, total = Infinity;
    while (offset < total && page < CONFIG.MAX_PAGES_PER_NAICS) {
      var resp = fetchOpportunities_(apiKey, {
        postedFrom: postedFrom, postedTo: postedTo,
        ncode: naics, limit: CONFIG.PAGE_SIZE, offset: offset
      });
      if (!resp) break;
      total = resp.totalRecords || 0;
      var data = resp.opportunitiesData || [];
      data.forEach(function (opp) {
        var lead = toLead_(opp);
        if (!lead) return;
        if (existingIds[lead.noticeId] || seen[lead.noticeId]) return;
        seen[lead.noticeId] = true;
        newLeads.push(lead);
      });
      offset += CONFIG.PAGE_SIZE;
      page++;
      Utilities.sleep(400); // be polite to the API / stay under rate limits
    }
  });

  // Highest-priority leads first.
  newLeads.sort(function (a, b) { return b.priority - a.priority; });

  if (newLeads.length) {
    var rows = newLeads.map(function (l) {
      return [l.posted, l.priority, l.title, l.agency, l.naics, l.psc, l.type,
        l.setAside, l.deadline, l.pocName, l.pocEmail, l.pocPhone, l.solNum,
        l.link, l.noticeId, 'New'];
    });
    sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, HEADERS.length).setValues(rows);
    if (CONFIG.DIGEST_EMAIL) sendDigest_(newLeads);
  }
  Logger.log('Run complete: %s new lead(s) added.', newLeads.length);
}

// ─────────────────────────────  SAM.gov API  ─────────────────────────────

function fetchOpportunities_(apiKey, params) {
  var url = CONFIG.API_BASE + '?api_key=' + encodeURIComponent(apiKey);
  Object.keys(params).forEach(function (k) {
    url += '&' + k + '=' + encodeURIComponent(params[k]);
  });
  if (CONFIG.STATES.length === 1) url += '&state=' + encodeURIComponent(CONFIG.STATES[0]);

  var res = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
  var code = res.getResponseCode();
  if (code === 200) {
    try { return JSON.parse(res.getContentText()); }
    catch (e) { Logger.log('Parse error: %s', e); return null; }
  }
  if (code === 429) { Logger.log('Rate limited (429). Backing off.'); Utilities.sleep(5000); return null; }
  Logger.log('SAM.gov API %s: %s', code, res.getContentText().slice(0, 300));
  return null;
}

// ─────────────────────────────  TRANSFORM / FILTER  ─────────────────────────────

/** Convert a raw opportunity into a lead row, or null if it should be skipped. */
function toLead_(opp) {
  var ptype = (opp.type || '').toLowerCase();
  var ptypeCode = noticeTypeCode_(ptype);
  if (CONFIG.PTYPES_KEEP.indexOf(ptypeCode) === -1) return null;

  // PSC relevance (extra filter on top of the NAICS server query).
  var psc = String(opp.classificationCode || '');
  if (psc && CONFIG.PSC_KEEP_PREFIX.length) {
    var pscOk = CONFIG.PSC_KEEP_PREFIX.some(function (p) { return psc.indexOf(p) === 0; });
    // Keep it if PSC matches OR PSC is blank (some notices omit it) — don't over-filter.
    if (psc && !pscOk && !isProductNaics_(opp.naicsCode)) return null;
  }

  // Place-of-performance state filter (when more than one state configured).
  if (CONFIG.STATES.length > 1) {
    var st = (opp.placeOfPerformance && opp.placeOfPerformance.state && opp.placeOfPerformance.state.code) || '';
    if (CONFIG.STATES.indexOf(st) === -1) return null;
  }

  var poc = bestPoc_(opp.pointOfContact);
  if (CONFIG.REQUIRE_EMAIL && !poc.email) return null;

  return {
    noticeId: opp.noticeId,
    posted: opp.postedDate || '',
    title: opp.title || '',
    agency: opp.fullParentPathName || '',
    naics: opp.naicsCode || '',
    psc: psc,
    type: opp.type || '',
    setAside: opp.typeOfSetAsideDescription || opp.typeOfSetAside || '',
    deadline: opp.responseDeadLine || '',
    pocName: poc.fullName,
    pocEmail: poc.email,
    pocPhone: poc.phone,
    solNum: opp.solicitationNumber || '',
    link: opp.uiLink || '',
    priority: scoreLead_(opp, ptypeCode, poc)
  };
}

/** Heuristic 0–100 priority: early-signal + small-biz + reachable scores higher. */
function scoreLead_(opp, ptypeCode, poc) {
  var s = 40;
  if (ptypeCode === 'r') s += 25;            // Sources Sought = earliest, shape the buy
  if (ptypeCode === 'k') s += 20;            // Combined Synopsis/Solicitation = ready to buy
  if (ptypeCode === 'p') s += 12;            // Presolicitation
  if (ptypeCode === 'o') s += 10;            // Solicitation
  var sa = (opp.typeOfSetAsideDescription || '').toLowerCase();
  if (/small business|8\(a\)|wosb|sdvosb|hubzone|veteran/.test(sa)) s += 15; // friendly to a small reseller
  if (poc.email) s += 8;
  if (isProductNaics_(opp.naicsCode)) s += 5;
  if (opp.active === 'Yes') s += 3;
  return Math.min(100, s);
}

function bestPoc_(list) {
  var empty = { fullName: '', email: '', phone: '' };
  if (!list || !list.length) return empty;
  var primary = list.filter(function (p) { return (p.type || '').toLowerCase() === 'primary'; })[0];
  var p = primary || list[0];
  return { fullName: p.fullName || '', email: p.email || '', phone: p.phone || '' };
}

function isProductNaics_(n) {
  n = String(n || '');
  return CONFIG.NAICS.indexOf(n) !== -1;
}

/** Map SAM.gov verbose type text → single-letter ptype code. */
function noticeTypeCode_(t) {
  if (t.indexOf('combined') === 0 || t.indexOf('combined synopsis') !== -1) return 'k';
  if (t.indexOf('sources sought') !== -1) return 'r';
  if (t.indexOf('presolicitation') !== -1) return 'p';
  if (t.indexOf('special notice') !== -1) return 's';
  if (t.indexOf('intent to bundle') !== -1) return 'i';
  if (t.indexOf('award') !== -1) return 'a';
  if (t.indexOf('justification') !== -1) return 'u';
  if (t.indexOf('solicitation') !== -1) return 'o';
  return t.slice(0, 1);
}

// ─────────────────────────────  SHEET  ─────────────────────────────

function ensureSheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet() || SpreadsheetApp.create('Uniwide Gov Leads');
  var sheet = ss.getSheetByName(CONFIG.SHEET_NAME) || ss.insertSheet(CONFIG.SHEET_NAME);
  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS])
      .setFontWeight('bold').setBackground('#0b1220').setFontColor('#ffffff');
    sheet.setFrozenRows(1);
    sheet.autoResizeColumns(1, HEADERS.length);
  }
  return sheet;
}

function readExistingNoticeIds_(sheet) {
  var ids = {};
  var last = sheet.getLastRow();
  if (last < 2) return ids;
  var col = HEADERS.indexOf('Notice ID') + 1;
  var vals = sheet.getRange(2, col, last - 1, 1).getValues();
  vals.forEach(function (r) { if (r[0]) ids[r[0]] = true; });
  return ids;
}

// ─────────────────────────────  TRIGGER + EMAIL  ─────────────────────────────

function createDailyTrigger_() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'runLeadSync') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('runLeadSync').timeBased().everyDays(1).atHour(6).create();
}

function sendDigest_(leads) {
  var top = leads.slice(0, 25);
  var rows = top.map(function (l) {
    return '<tr><td>' + l.priority + '</td><td>' + esc_(l.title) + '</td><td>' + esc_(l.agency) +
      '</td><td>' + esc_(l.setAside) + '</td><td>' + esc_(l.pocName) + '<br>' + esc_(l.pocEmail) +
      '</td><td><a href="' + l.link + '">View</a></td></tr>';
  }).join('');
  var html = '<h2>' + leads.length + ' new government leads</h2>' +
    '<table border="1" cellpadding="6" cellspacing="0" style="border-collapse:collapse;font-family:Arial;font-size:13px">' +
    '<tr style="background:#0b1220;color:#fff"><th>Pri</th><th>Title</th><th>Agency</th><th>Set-Aside</th><th>Contact</th><th></th></tr>' +
    rows + '</table>' +
    (leads.length > 25 ? '<p>+ ' + (leads.length - 25) + ' more in the sheet.</p>' : '');
  MailApp.sendEmail({ to: CONFIG.DIGEST_EMAIL, subject: '🏛️ ' + leads.length + ' new gov leads — Uniwide', htmlBody: html });
}

function esc_(s) { return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

function getApiKey_() { return PropertiesService.getScriptProperties().getProperty('SAM_API_KEY'); }
