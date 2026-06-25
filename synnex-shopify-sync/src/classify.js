'use strict';

/**
 * Description-based product classifier.
 *
 * Goal (per 2026-06-17 reframe): identify PHYSICAL SELLABLE products and bucket them
 * into clean categories so everything is searchable. Non-physical items (software,
 * services, warranties) are flagged for hiding; anything unrecognizable returns null
 * (→ caller buckets as "other" / hide).
 *
 * First-match-wins. Service/software guards run FIRST so warranty/license listings (which
 * wear product nouns) are caught before the physical rules. Physical rules use positive
 * description regexes with negative accessory guards to avoid mis-filing parts as products.
 */

// Accessory/parts noise — never classify these AS the core product.
const ACCESSORY_GUARD = /\b(bag|sleeve|backpack|carrying case|lock|wire kit|tool kit|repair kit|mounting screw|wall plate|warranty|warr\b|replacement part|spare part|cleaning|screen protector)\b/i;

// Non-physical: services / warranties / coverage — hide these.
const SERVICE_GUARD = /\b(warranty|warr\b|\d+\s?yr\b|\d+\s?year|next business day|\bnbd\b|onsite|on-site|carepack|care pack|maintenance|coverage|\bsvc\b|support contract|tech support|installation service|prof(essional)? services|training|certification|subscription renewal|extended service)\b/i;
const SOFTWARE_GUARD = /\b(license|licen[cs]e|lic\/sa|sa pack|\bolv\b|\bolp\b|\bcal\b|software|saas|\bvirtual\b.*\b(license|subscription)|antivirus|microsoft 365|office 365|win(dows)? (svr|server) (std|dc|cal)|e-?ltu|user license|device license|cloud (license|subscription))\b/i;

const RULES = [
  // ── Non-physical (hidden by caller via group) ──
  { type: 'Services', group: 'services', tags: ['service'], desc: SERVICE_GUARD },
  { type: 'Software', group: 'software', tags: ['software'], desc: SOFTWARE_GUARD },

  // ── Computers ──
  { type: 'Servers', group: 'computers-portables', tags: ['server'], desc: /\b(poweredge|proliant|\bserver\b|blade server|rack server|nx server)\b/i, notDesc: ACCESSORY_GUARD },
  { type: 'Notebooks', group: 'computers-portables', tags: ['laptop','notebook'], desc: /\b(thinkpad|latitude|elitebook|probook|macbook|chromebook|ideapad|zenbook|vivobook|lifebook|travelmate|inspiron|aspire|pavilion laptop|gram|legion|victus|notebook|laptop)\b/i, notDesc: ACCESSORY_GUARD },
  { type: 'Workstations', group: 'computers-portables', tags: ['workstation'], desc: /\b(workstation|thinkstation|precision tower|zbook|mac pro|mac studio|z2 |z4 |z6 |z8 )\b/i, notDesc: ACCESSORY_GUARD },
  { type: 'Mini PCs', group: 'computers-portables', tags: ['mini-pc'], desc: /\b(nuc|mini ?pc|tiny|micro form|stick pc|compute stick|thinkcentre tiny)\b/i, notDesc: ACCESSORY_GUARD },
  { type: 'Desktops', group: 'computers-portables', tags: ['desktop'], desc: /\b(optiplex|thinkcentre|prodesk|elitedesk|\bimac\b|all.?in.?one|desktop pc|tower pc|small form factor|\bsff\b)\b/i, notDesc: ACCESSORY_GUARD },
  { type: 'Tablets', group: 'computers-portables', tags: ['tablet'], desc: /\b(ipad|galaxy tab|surface pro|surface go|tablet)\b/i, notDesc: ACCESSORY_GUARD },
  { type: 'Phones', group: 'cell-phones', tags: ['phone'], desc: /\b(iphone|galaxy s\d|galaxy note|pixel \d|smartphone|cell ?phone|mobile phone)\b/i, notDesc: ACCESSORY_GUARD },

  // ── Displays ──
  { type: 'Televisions', group: 'monitors-projectors', tags: ['tv','display'], desc: /\b(smart (led|tv)|\bled tv\b|\boled\b|\bqled\b|\btelevision\b|\b\d{2}" .*tv\b|class v-series|smartcast)\b/i, notDesc: ACCESSORY_GUARD },
  { type: 'Monitors', group: 'monitors-projectors', tags: ['monitor','display'], desc: /\b(monitor|lcd display|led monitor|\bips\b.*(monitor|display)|curved display|gaming monitor)\b/i, notDesc: ACCESSORY_GUARD },
  { type: 'Projectors', group: 'monitors-projectors', tags: ['projector'], desc: /\b(projector|projection)\b/i, notDesc: ACCESSORY_GUARD },

  // ── Networking ──
  { type: 'Switches & Hubs', group: 'networking', tags: ['networking','switch'], desc: /\b(\d+[ -]?port.*(switch|gigabit)|network switch|poe switch|managed switch|catalyst)\b/i, notDesc: ACCESSORY_GUARD },
  { type: 'Routers & Firewalls', group: 'networking', tags: ['networking','router'], desc: /\b(router|firewall|access point|wireless ap|\bgateway\b.*(router|wifi)|mesh wifi)\b/i, notDesc: ACCESSORY_GUARD },
  { type: 'Networking', group: 'networking', tags: ['networking'], desc: /\b(transceiver|sfp\b|ethernet adapter|fiber module|media converter|modem|network card|nic\b)\b/i, notDesc: ACCESSORY_GUARD },

  // ── Storage ──
  { type: 'SSDs', group: 'storage', tags: ['storage','ssd'], desc: /\b(ssd|solid state|nvme|m\.2 drive)\b/i, notDesc: ACCESSORY_GUARD },
  { type: 'NAS', group: 'storage', tags: ['storage','nas'], desc: /\b(nas\b|network attached storage|synology|qnap)\b/i, notDesc: ACCESSORY_GUARD },
  { type: 'Hard Drives', group: 'storage', tags: ['storage','hdd'], desc: /\b(hard drive|\bhdd\b|\d+\s?tb.*(sata|sas|drive)|7200\s?rpm|external drive)\b/i, notDesc: ACCESSORY_GUARD },
  { type: 'Optical Drives', group: 'storage', tags: ['storage','optical'], desc: /\b(dvd-?writer|dvd-?rw|blu-?ray drive|optical drive|cd-?rom drive)\b/i, notDesc: ACCESSORY_GUARD },
  { type: 'Flash Drives', group: 'storage', tags: ['storage','usb'], desc: /\b(flash drive|usb drive|thumb drive|memory card|sd card|compactflash|microsd)\b/i, notDesc: ACCESSORY_GUARD },

  // ── Memory ──
  { type: 'RAM', group: 'memory', tags: ['memory','ram'], desc: /\b(ddr[2345]|dimm|sodimm|so-dimm|\d+\s?gb.*(memory|module|ecc|registered)|ram module)\b/i, notDesc: ACCESSORY_GUARD },

  // ── Gaming / PC components ──
  { type: 'Graphics Cards', group: 'components', tags: ['component','gpu'], desc: /\b(geforce (rtx|gtx)|radeon (rx|pro)|quadro|graphics card|video card|\bgpu\b)\b/i, notDesc: ACCESSORY_GUARD },
  { type: 'Processors', group: 'components', tags: ['component','cpu'], desc: /\b(core i[3579]|ryzen [3579]|threadripper|\bxeon\b|\bepyc\b|pentium|celeron)\b.*\b(processor|cpu|box|tray|ghz)\b|\bprocessor\b.*\b(lga|socket|am[45]|box|tray)\b/i, notDesc: ACCESSORY_GUARD },
  { type: 'Motherboards', group: 'components', tags: ['component','motherboard'], desc: /\b(motherboard|mainboard|\b(atx|matx|mini-itx) board\b)\b/i, notDesc: ACCESSORY_GUARD },
  { type: 'PC Cases', group: 'components', tags: ['component','case'], desc: /\b(mid tower|full tower|atx case|computer chassis|pc case|gaming case|pc gaming cabinet)\b/i, notDesc: ACCESSORY_GUARD },
  { type: 'Power Supplies', group: 'components', tags: ['component','psu'], desc: /\b(\d{3,4}\s?w(att)?.*(power supply|psu|80\s?plus)|atx power supply|modular psu)\b/i, notDesc: ACCESSORY_GUARD },
  { type: 'CPU Coolers', group: 'components', tags: ['component','cooler'], desc: /\b(cpu cooler|liquid cooler|aio cooler|heatsink|water cooling)\b/i, notDesc: ACCESSORY_GUARD },
  { type: 'Game Controllers', group: 'gaming', tags: ['gaming','controller'], desc: /\b(racing wheel|game ?pad|joystick|game controller|flight stick|xbox controller|dualsense|dualshock)\b/i, notDesc: ACCESSORY_GUARD },
  { type: 'Gaming Consoles', group: 'gaming', tags: ['gaming','console'], desc: /\b(playstation \d|\bps[45]\b|xbox series|nintendo switch console)\b/i, notDesc: ACCESSORY_GUARD },

  // ── Power ──
  { type: 'UPS', group: 'power', tags: ['power','ups'], desc: /\b(\bups\b|uninterruptible|battery backup|smart-?ups|back-?ups)\b/i, notDesc: ACCESSORY_GUARD },
  { type: 'Power Distribution', group: 'power', tags: ['power','pdu'], desc: /\b(\bpdu\b|power distribution|rack power)\b/i, notDesc: ACCESSORY_GUARD },
  { type: 'Surge Protectors', group: 'power', tags: ['power','surge'], desc: /\b(surge protector|surge suppress|power strip|isobar)\b/i, notDesc: ACCESSORY_GUARD },
  { type: 'Power Supplies & Adapters', group: 'power', tags: ['power','adapter'], desc: /\b(power adapter|ac adapter|power supply|power bank|charger\b)\b/i, notDesc: ACCESSORY_GUARD },
  { type: 'Batteries', group: 'power', tags: ['power','battery'], desc: /\b(\bbattery\b|battery cartridge|li-ion battery|replacement battery)\b/i, notDesc: ACCESSORY_GUARD },

  // ── Printers / imaging ──
  { type: 'Printers', group: 'printers', tags: ['printer'], desc: /\b(printer|laserjet|inkjet|officejet|multifunction printer|label printer|\bmfp\b)\b/i, notDesc: /\b(cable|stand|tray\b|warranty|service)\b/i },
  { type: 'Printer Supplies', group: 'printers', tags: ['printer','supplies'], desc: /\b(toner|ink cartridge|print cartridge|drum unit|imaging unit|ribbon cartridge)\b/i },
  { type: 'Scanners', group: 'input-devices', tags: ['scanner'], desc: /\b(scanner|barcode reader|document scanner|sheetfed scanner)\b/i, notDesc: ACCESSORY_GUARD },

  // ── Peripherals / input ──
  { type: 'Keyboards', group: 'input-devices', tags: ['keyboard'], desc: /\b(keyboard|keypad|numeric keypad)\b/i, notDesc: ACCESSORY_GUARD },
  { type: 'Mice', group: 'input-devices', tags: ['mouse'], desc: /\b(mouse|trackball|pointing device)\b/i, notDesc: ACCESSORY_GUARD },
  { type: 'Webcams & Cameras', group: 'input-devices', tags: ['camera','webcam'], desc: /\b(webcam|web camera|conference camera|document camera)\b/i, notDesc: ACCESSORY_GUARD },
  { type: 'Security Cameras', group: 'security', tags: ['security','camera'], desc: /\b(security camera|surveillance|ip camera|network camera|nvr\b|cctv|wisenet|dome camera)\b/i, notDesc: ACCESSORY_GUARD },
  { type: 'Headphones & Audio', group: 'consumer-electronics', tags: ['audio'], desc: /\b(headphone|headset|earbud|earphone|speaker|soundbar|microphone)\b/i, notDesc: ACCESSORY_GUARD },
  { type: 'Cameras', group: 'consumer-electronics', tags: ['camera'], desc: /\b(digital camera|dslr|mirrorless camera|camcorder|action cam|gopro)\b/i, notDesc: ACCESSORY_GUARD },
  { type: 'Wearables', group: 'consumer-electronics', tags: ['wearable'], desc: /\b(smartwatch|smart watch|fitness tracker|smart band)\b/i, notDesc: ACCESSORY_GUARD },
  { type: 'Drones', group: 'consumer-electronics', tags: ['drone'], desc: /\b(drone|quadcopter|\buav\b)\b/i, notDesc: ACCESSORY_GUARD },

  // ── Docks / mounts / accessories ──
  { type: 'Docks & Hubs', group: 'computer-accessories', tags: ['dock','hub'], desc: /\b(docking station|usb hub|usb-?c hub|thunderbolt dock|port replicator)\b/i, notDesc: ACCESSORY_GUARD },
  { type: 'KVM & Splitters', group: 'computer-accessories', tags: ['kvm','splitter'], desc: /\b(kvm|video splitter|hdmi splitter|matrix switch)\b/i, notDesc: ACCESSORY_GUARD },
  { type: 'Mounts & Stands', group: 'computer-accessories', tags: ['mount','stand'], desc: /\b(monitor arm|monitor stand|wall mount|tv mount|mounting bracket|laptop stand|rack shelf)\b/i },
  { type: 'Cases & Bags', group: 'computer-accessories', tags: ['case','bag'], desc: /\b(laptop bag|carrying case|backpack|notebook case|messenger bag|laptop sleeve)\b/i },

  // ── Cables & adapters (catch the big cable volume) ──
  { type: 'Cables & Adapters', group: 'computer-accessories', tags: ['cable'], desc: /\b(hdmi|displayport|\bvga\b|\busb\b|cat\s?[5-8]|ethernet cable|patch cable|fiber cable|power cord|adapter cable|serial cable|kvm cable|\bcable\b|\bcord\b|coupler)\b/i },
];

function classifyProduct(p = {}) {
  const desc = p.description || '';
  const unspsc = (p.unspsc || '').trim();
  for (const rule of RULES) {
    if (rule.unspsc && !rule.unspsc.some(prefix => unspsc.startsWith(prefix))) continue;
    if (rule.desc && !rule.desc.test(desc)) continue;
    if (rule.notDesc && rule.notDesc.test(desc)) continue;
    if (!rule.desc && !rule.unspsc) continue;
    return { type: rule.type, group: rule.group, tags: [...rule.tags] };
  }
  return null;
}

module.exports = { classifyProduct, RULES, ACCESSORY_GUARD };
