'use strict';

const { config } = require('../config');

// ── Cheap-junk classifier ─────────────────────────────────────────────────────
// TD Synnex's catalog is full of sub-$5 clutter — patch cables, adapters, keystone
// jacks, wallplates, surface boxes, cable ties, stylus tips, consumables — that no
// B2B buyer searches for and that drags down browse/sort. This keeps that clutter
// off the storefront while RETAINING genuinely cheap hardware (flash drives, SD
// cards, batteries, mice/keyboards, drive enclosures, etc.).
//
// Matched against the TD Synnex product description (which is the listing title).

// Real-hardware signals — these stay listed even when cheap.
const REAL = /flash ?drive|thumb ?drive|usb (?:drive|stick|flash)|jump ?drive|\bSD ?card\b|micro ?sd|\bSDHC\b|\bSDXC\b|memory card|\bmouse\b|\bmice\b|\bkeyboard\b|\bkeypad\b|web ?cam|head(?:set|phone)s?|ear ?buds?|\bspeakers?\b|\bSSD\b|\bNVMe\b|hard ?drive|\bHDD\b|\bbatter(?:y|ies)\b|power ?bank|access point|network switch|\bNIC\b|wireless (?:adapter|card|nic)|wi-?fi (?:adapter|card|usb|dongle)|\bRAM\b|\bDIMM\b|\bSO-?DIMM\b|memory module|flash memory|\bUPS\b/i;

// Junk-override — if the title says cable/cord/connector/pad/etc. it's clutter even
// when it name-drops a real device (e.g. "USB cable for hard drive", "speaker wire").
const JUNK = /\bcable\b|\bcord\b|\bwire\b|\bcoupler\b|\bconnector\b|\bextension\b|mouse ?pad|\bpad\b|\bpatch\b|keystone|wall ?plate|face ?plate|privacy (?:cover|screen|filter)|cable tie|ferrule|gender changer|\bbnc\b|\brj-?45\b|\brj-?11\b|\breceiver\b|\bdongle\b|stylus|\bribbon\b|\bsplitter\b|surface mount|filler|blank panel/i;

/** True when the title clearly describes genuine hardware worth listing. */
function isRealHardware(text = '') {
  return REAL.test(text) && !JUNK.test(text);
}

/**
 * True when a product is cheap accessory/cable clutter that should be kept off the
 * storefront (drafted) instead of listed. Only applies below the price floor; any
 * title that reads as real hardware is always retained.
 *
 * @param {string} text       product description / title
 * @param {number} sellPrice  marked-up sell price
 */
function isCheapJunk(text = '', sellPrice) {
  const max = config.sync.junkMaxPrice;
  if (!Number.isFinite(max) || max <= 0) return false; // disabled when floor is 0
  if (!(sellPrice < max)) return false;                 // only sub-floor items
  return !isRealHardware(text);                         // keep real hw, hide the rest
}

module.exports = { isCheapJunk, isRealHardware };
