/**
 * Uniwide Merchandise - Government TECH Micro-Lead Dashboard
 * ---------------------------------------------------------
 * Pulls federal contract opportunities from the SAM.gov public Opportunities API
 * (https://api.sam.gov/opportunities/v2/search), filters them to the TECHNOLOGY
 * categories we sell (IT hardware/software/peripherals/services via NAICS + PSC),
 * harvests each notice's contracting Point-of-Contact (name/email/phone),
 * de-duplicates, scores them, and writes them as leads into a backing Google Sheet.
 *
 * It ALSO serves a live HTML dashboard (deploy as a Web App) you can share by link -
 * real-time-ish counts, alerts for brand-new leads, a "<= $15k / micro-buy" filter,
 * and one-click email-the-POC links. No Google login required for viewers.
 *
 * WHY POC-centric for sub-$15k buys: true micro-purchases (< the federal micro-purchase
 * threshold) are NOT posted on SAM.gov - agencies put them on a Government Purchase
 * Card (GPC). So we surface the TECH buying offices + their POCs actively procuring our
 * categories; they can buy straight off our store on a card. The lead is the buyer.
 *
 * SETUP (one time):
 *   1. Free SAM.gov API key: sam.gov -> sign in -> Account Details -> API Key.
 *   2. Apps Script: Project Settings -> Script Properties ->
 *        Property = SAM_API_KEY   (this exact name)
 *        Value    = <your key>
 *   3. Run setup() once (grant permissions). Builds the sheet + hourly trigger + first pull.
 *   4. Deploy -> New deployment -> type "Web app" ->
 *        Execute as: Me     Who has access: Anyone   ->  Deploy.
 *      Copy the Web app URL and send it to your dad. That's the dashboard.
 *   5. (Optional) set DIGEST_EMAIL below for an email alert of new leads.
 *
 * Run testRun() any time for a one-off pull.
 */

// ===============================  CONFIG  ===============================
var CONFIG = {
  // TECHNOLOGY categories we sell, queried server-side by NAICS.
  // Hardware/equipment NAICS only. Dropped software publishers (511210) and IT-services
  // (541512/541519) so we stop pulling cloud / software / services buys.
  NAICS: [
    '423430', // Computer & peripheral equipment & software merchant wholesalers (core reseller)
    '334111', // Electronic computer manufacturing
    '334112', // Computer storage device manufacturing
    '334118', // Computer terminal & other peripheral equipment
  ],
  // Equipment PSCs only. 70 = general-purpose IT equipment, 58 = comms/electronics equipment.
  // (Dropped D3 = IT & Telecom SERVICES.) Software PSCs removed via PSC_EXCLUDE_PREFIX.
  PSC_KEEP_PREFIX: ['70', '58'],
  PSC_EXCLUDE_PREFIX: ['7030'], // 7030 = ADP software
  // Skip notices whose TITLE reads as a service/cloud/software buy (equipment focus). Tunable.
  SERVICE_TERMS: ['cloud', 'saas', 'as a service', 'subscription', 'software license',
    'software maintenance', 'license renewal', 'managed service', 'hosting', 'hosted',
    'technical support', 'help desk', 'training', 'consulting', 'staffing', 'curriculum',
    'maintenance agreement', 'support services', 'installation services'],
  // Notice types to keep - buy-side, early-signal ones.
  //   k = Combined Synopsis/Solicitation, o = Solicitation, p = Presolicitation,
  //   r = Sources Sought, s = Special Notice, i = Intent to Bundle.
  PTYPES_KEEP: ['k', 'o', 'p', 'r', 's', 'i'],
  // Dollar ceiling for the "micro-buy" flag and the dashboard's default filter.
  VALUE_CAP: 15000,
  // How many days back to pull on each run (hourly trigger -> small lookback w/ overlap).
  LOOKBACK_DAYS: 3,
  // Only keep notices that still have a POC email (the whole point is direct outreach).
  REQUIRE_EMAIL: true,
  // Sheet + email
  SHEET_NAME: 'Gov Tech Leads',
  DIGEST_EMAIL: '', // e.g. 'erwin@uniwidemerchandise.com' - leave '' to disable email alerts
  // Restrict to certain states' place-of-performance (e.g. ['TX','OK']). Empty = nationwide.
  STATES: [],
  // Branding shown on the dashboard
  BRAND: 'Uniwide Merchandise',
  // API
  API_BASE: 'https://api.sam.gov/opportunities/v2/search',
  PAGE_SIZE: 1000,       // max 1000
  MAX_PAGES_PER_NAICS: 5 // safety cap on pagination per NAICS per run
};

var HEADERS = ['First Seen', 'Posted', 'Priority', 'Title', 'Agency / Office', 'NAICS', 'PSC',
  'Notice Type', 'Set-Aside', 'Est. Value', 'Response Deadline', 'POC Name', 'POC Email',
  'POC Phone', 'Solicitation #', 'Link', 'Notice ID', 'Status'];

// ===============================  WEB APP (dashboard)  ===============================

/** Serves the shareable dashboard. Deploy this project as a Web App (access: Anyone). */
function doGet() {
  return HtmlService.createHtmlOutputFromFile('Dashboard')
    .setTitle('Gov Tech Leads - ' + CONFIG.BRAND)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

/** Called by the dashboard (google.script.run) to load current leads + stats. */
function getDashboardData() {
  var sheet = ensureSheet_();
  var last = sheet.getLastRow();
  var leads = [];
  if (last >= 2) {
    var values = sheet.getRange(2, 1, last - 1, HEADERS.length).getValues();
    var idx = {};
    HEADERS.forEach(function (h, i) { idx[h] = i; });
    leads = values.map(function (r) {
      var v = r[idx['Est. Value']];
      return {
        firstSeen: toIso_(r[idx['First Seen']]),
        posted: String(r[idx['Posted']] || ''),
        priority: Number(r[idx['Priority']]) || 0,
        title: String(r[idx['Title']] || ''),
        agency: String(r[idx['Agency / Office']] || ''),
        naics: String(r[idx['NAICS']] || ''),
        psc: String(r[idx['PSC']] || ''),
        type: String(r[idx['Notice Type']] || ''),
        setAside: String(r[idx['Set-Aside']] || ''),
        value: (v === '' || v === null) ? null : Number(v),
        deadline: String(r[idx['Response Deadline']] || ''),
        pocName: String(r[idx['POC Name']] || ''),
        pocEmail: String(r[idx['POC Email']] || ''),
        pocPhone: String(r[idx['POC Phone']] || ''),
        solNum: String(r[idx['Solicitation #']] || ''),
        link: String(r[idx['Link']] || ''),
        noticeId: String(r[idx['Notice ID']] || ''),
        status: String(r[idx['Status']] || '')
      };
    });
  }

  var now = Date.now();
  var dayMs = 86400000;
  var stats = {
    total: leads.length,
    new24h: 0,
    new7d: 0,
    highPriority: 0,
    micro: 0
  };
  leads.forEach(function (l) {
    var seen = l.firstSeen ? new Date(l.firstSeen).getTime() : 0;
    if (seen && now - seen <= dayMs) stats.new24h++;
    if (seen && now - seen <= 7 * dayMs) stats.new7d++;
    if (l.priority >= 75) stats.highPriority++;
    if (l.value === null || l.value <= CONFIG.VALUE_CAP) stats.micro++;
  });

  return {
    brand: CONFIG.BRAND,
    generatedAt: new Date().toISOString(),
    valueCap: CONFIG.VALUE_CAP,
    stats: stats,
    leads: leads
  };
}

/** Optional: dashboard "Sync now" button -> live pull. Returns count added. */
function syncNow() {
  try { return { ok: true, added: runLeadSync() }; }
  catch (e) { return { ok: false, error: String(e) }; }
}

// ===============================  ENTRY POINTS  ===============================

/** One-time setup: validates key, builds the sheet, installs the hourly trigger. */
function setup() {
  if (!getApiKey_()) throw new Error('Set SAM_API_KEY in Script Properties first (see header).');
  ensureSheet_();
  createSyncTrigger_();
  Logger.log('Setup complete. Sheet "%s" ready and hourly trigger installed.', CONFIG.SHEET_NAME);
  runLeadSync(); // initial pull
}

/** Manual one-off pull (safe to run anytime). Returns count added. */
function testRun() { return runLeadSync(); }

/** Helper to store the API key from the editor: setApiKey('xxxx') then delete the call. */
function setApiKey(key) {
  PropertiesService.getScriptProperties().setProperty('SAM_API_KEY', String(key).trim());
  Logger.log('SAM_API_KEY saved.');
}

// ===============================  MAIN  ===============================

function runLeadSync() {
  var apiKey = getApiKey_();
  if (!apiKey) throw new Error('Missing SAM_API_KEY (Project Settings -> Script Properties).');

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
    var stamp = new Date().toISOString();
    var rows = newLeads.map(function (l) {
      return [stamp, l.posted, l.priority, l.title, l.agency, l.naics, l.psc, l.type,
        l.setAside, (l.value === null ? '' : l.value), l.deadline, l.pocName, l.pocEmail,
        l.pocPhone, l.solNum, l.link, l.noticeId, 'New'];
    });
    sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, HEADERS.length).setValues(rows);
    if (CONFIG.DIGEST_EMAIL) sendDigest_(newLeads);
  }
  Logger.log('Run complete: %s new lead(s) added.', newLeads.length);
  return newLeads.length;
}

// ===============================  SAM.gov API  ===============================

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

// ===============================  TRANSFORM / FILTER  ===============================

/** Convert a raw opportunity into a lead row, or null if it should be skipped. */
function toLead_(opp) {
  var ptype = (opp.type || '').toLowerCase();
  var ptypeCode = noticeTypeCode_(ptype);
  if (CONFIG.PTYPES_KEEP.indexOf(ptypeCode) === -1) return null;

  // PSC relevance (extra filter on top of the NAICS server query).
  var psc = String(opp.classificationCode || '');
  // Exclude software/service PSCs (e.g. 7030 ADP software) even within a kept prefix.
  if (psc && CONFIG.PSC_EXCLUDE_PREFIX && CONFIG.PSC_EXCLUDE_PREFIX.some(function (p) { return psc.indexOf(p) === 0; })) return null;
  if (psc && CONFIG.PSC_KEEP_PREFIX.length) {
    var pscOk = CONFIG.PSC_KEEP_PREFIX.some(function (p) { return psc.indexOf(p) === 0; });
    // Keep if PSC matches OR PSC blank (some notices omit it) OR NAICS is one of ours - don't over-filter.
    if (psc && !pscOk && !isProductNaics_(opp.naicsCode)) return null;
  }

  // Equipment focus: skip service/cloud/software buys detected in the title.
  var titleLc = (opp.title || '').toLowerCase();
  if (CONFIG.SERVICE_TERMS.some(function (t) { return titleLc.indexOf(t) !== -1; })) return null;

  // Place-of-performance state filter (when more than one state configured).
  if (CONFIG.STATES.length > 1) {
    var st = (opp.placeOfPerformance && opp.placeOfPerformance.state && opp.placeOfPerformance.state.code) || '';
    if (CONFIG.STATES.indexOf(st) === -1) return null;
  }

  var poc = bestPoc_(opp.pointOfContact);
  if (CONFIG.REQUIRE_EMAIL && !poc.email) return null;

  var value = estValue_(opp);

  return {
    noticeId: opp.noticeId,
    posted: opp.postedDate || '',
    title: opp.title || '',
    agency: opp.fullParentPathName || '',
    naics: opp.naicsCode || '',
    psc: psc,
    type: opp.type || '',
    setAside: opp.typeOfSetAsideDescription || opp.typeOfSetAside || '',
    value: value,
    deadline: opp.responseDeadLine || '',
    pocName: poc.fullName,
    pocEmail: poc.email,
    pocPhone: poc.phone,
    solNum: opp.solicitationNumber || '',
    link: opp.uiLink || '',
    priority: scoreLead_(opp, ptypeCode, poc, value)
  };
}

/** Pull a published dollar value if present (award amount). null when unposted. */
function estValue_(opp) {
  var amt = opp.award && (opp.award.amount != null ? opp.award.amount : null);
  if (amt == null || amt === '') return null;
  var n = Number(String(amt).replace(/[^0-9.\-]/g, ''));
  return isNaN(n) ? null : n;
}

/** Heuristic 0-100 priority: early-signal + small-biz + reachable + micro-sized scores higher. */
function scoreLead_(opp, ptypeCode, poc, value) {
  var s = 40;
  if (ptypeCode === 'r') s += 25;            // Sources Sought = earliest, shape the buy
  if (ptypeCode === 'k') s += 20;            // Combined Synopsis/Solicitation = ready to buy
  if (ptypeCode === 'p') s += 12;            // Presolicitation
  if (ptypeCode === 'o') s += 10;            // Solicitation
  var sa = (opp.typeOfSetAsideDescription || '').toLowerCase();
  if (/small business|8\(a\)|wosb|sdvosb|hubzone|veteran/.test(sa)) s += 15; // friendly to a small reseller
  if (poc.email) s += 8;
  if (isProductNaics_(opp.naicsCode)) s += 5;
  if (value !== null && value <= CONFIG.VALUE_CAP) s += 10; // confirmed micro-buy sized
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

/** Map SAM.gov verbose type text -> single-letter ptype code. */
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

// ===============================  SHEET  ===============================

function ensureSheet_() {
  // Standalone scripts have no "active" spreadsheet, and create() makes a NEW file every run.
  // So we create the spreadsheet once and remember its ID in Script Properties, then reuse it
  // for every execution (setup, hourly trigger, and the web-app dashboard) -> one shared sheet.
  var props = PropertiesService.getScriptProperties();
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) {
    var id = props.getProperty('SHEET_ID');
    if (id) { try { ss = SpreadsheetApp.openById(id); } catch (e) { ss = null; } }
    if (!ss) {
      ss = SpreadsheetApp.create('Uniwide Gov Tech Leads');
      props.setProperty('SHEET_ID', ss.getId());
    }
  }
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

// ===============================  TRIGGER + EMAIL  ===============================

function createSyncTrigger_() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'runLeadSync') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('runLeadSync').timeBased().everyHours(1).create();
}

function sendDigest_(leads) {
  var top = leads.slice(0, 25);
  var rows = top.map(function (l) {
    return '<tr><td>' + l.priority + '</td><td>' + esc_(l.title) + '</td><td>' + esc_(l.agency) +
      '</td><td>' + esc_(l.setAside) + '</td><td>' + (l.value === null ? 'TBD' : '$' + l.value.toLocaleString()) +
      '</td><td>' + esc_(l.pocName) + '<br>' + esc_(l.pocEmail) +
      '</td><td><a href="' + l.link + '">View</a></td></tr>';
  }).join('');
  var html = '<h2>' + leads.length + ' new government tech leads</h2>' +
    '<table border="1" cellpadding="6" cellspacing="0" style="border-collapse:collapse;font-family:Arial;font-size:13px">' +
    '<tr style="background:#0b1220;color:#fff"><th>Pri</th><th>Title</th><th>Agency</th><th>Set-Aside</th><th>Est. Value</th><th>Contact</th><th></th></tr>' +
    rows + '</table>' +
    (leads.length > 25 ? '<p>+ ' + (leads.length - 25) + ' more on the dashboard.</p>' : '');
  MailApp.sendEmail({ to: CONFIG.DIGEST_EMAIL, subject: leads.length + ' new gov tech leads - ' + CONFIG.BRAND, htmlBody: html });
}

function esc_(s) { return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

function toIso_(v) {
  if (!v) return '';
  if (v instanceof Date) return v.toISOString();
  return String(v);
}

function getApiKey_() { return PropertiesService.getScriptProperties().getProperty('SAM_API_KEY'); }
