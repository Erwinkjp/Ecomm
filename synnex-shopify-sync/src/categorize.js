'use strict';

/**
 * UNSPSC-driven product categorization.
 *
 * The reliable signal for what a product IS is its UNSPSC commodity code (catalog
 * field[34]) — far better than the terse field[35] codes the old mapCategory used.
 * This maps UNSPSC codes (longest-prefix wins: 8-digit specifics, then 4-digit family
 * fallback) to a clean B2B taxonomy: { type, group, tags }.
 *   type  → Shopify productType (sub-collections)
 *   group → top-level category (powers the main nav / Shop-by-Category)
 *   tags  → searchable tags (+ audience tag added by caller)
 *
 * Built from the live TD SYNNEX catalog's actual code distribution. Falls back to the
 * description classifier (classify.js) when UNSPSC is absent/unknown.
 */

const { classifyProduct } = require('./classify');

// Longest-prefix UNSPSC map. Keys are 8- or 4-digit prefixes.
const UNSPSC = {
  // ── Computers & portables ──
  '43211508': { type: 'Mini PCs',       group: 'computers-portables', tags: ['desktop', 'mini-pc'] },
  '43211507': { type: 'Desktops',       group: 'computers-portables', tags: ['desktop'] },
  '43211503': { type: 'USB Hubs & Docks', group: 'computer-accessories', tags: ['hub', 'dock'] },
  '43211509': { type: 'Tablets',        group: 'computers-portables', tags: ['tablet'] },
  '43211502': { type: 'Servers',        group: 'computers-portables', tags: ['server'] },
  '43211501': { type: 'Servers',        group: 'computers-portables', tags: ['server'] },

  // ── Monitors / displays ──
  '43211902': { type: 'Monitors',       group: 'monitors-projectors', tags: ['monitor', 'display'] },
  '45111800': { type: 'AV Devices',     group: 'consumer-electronics', tags: ['av'] },
  '45111600': { type: 'Projectors',     group: 'monitors-projectors', tags: ['projector'] },

  // ── Input devices ──
  '43211706': { type: 'Keyboards & Mice', group: 'input-devices', tags: ['keyboard', 'mouse'] },
  '43211708': { type: 'Keyboards & Mice', group: 'input-devices', tags: ['mouse'] },
  '43211711': { type: 'Scanners',       group: 'input-devices', tags: ['scanner'] },

  // ── Components ──
  '43201503': { type: 'Processors',     group: 'components', tags: ['component', 'cpu'] },
  '43201404': { type: 'Network Modules', group: 'networking', tags: ['networking', 'sfp', 'module'] },
  '43201553': { type: 'Media Converters', group: 'networking', tags: ['networking', 'fiber'] },

  // ── Storage ──
  '43201830': { type: 'SSDs',           group: 'storage', tags: ['storage', 'ssd'] },
  '43201803': { type: 'Hard Drives',    group: 'storage', tags: ['storage', 'hdd'] },
  '43202005': { type: 'NAS',            group: 'storage', tags: ['storage', 'nas'] },

  // ── Memory ──
  '32101621': { type: 'RAM',            group: 'memory', tags: ['memory', 'ram'] },
  '32101602': { type: 'RAM',            group: 'memory', tags: ['memory', 'ram'] },
  '32101622': { type: 'Flash Drives',   group: 'storage', tags: ['storage', 'usb'] },

  // ── Networking ──
  '43222612': { type: 'Switches & Hubs', group: 'networking', tags: ['networking', 'switch'] },
  '43222608': { type: 'Transceivers',   group: 'networking', tags: ['networking', 'transceiver'] },
  '43222609': { type: 'Routers & Modems', group: 'networking', tags: ['networking', 'router'] },
  '43222500': { type: 'Cable Security', group: 'computer-accessories', tags: ['security', 'lock'] },
  '43221706': { type: 'Antennas',       group: 'networking', tags: ['networking', 'antenna'] },
  '43220000': { type: 'Network Cabling', group: 'networking', tags: ['networking', 'cabling'] },
  '43222000': { type: 'Networking',     group: 'networking', tags: ['networking'] },

  // ── Power / UPS ──
  '39121011': { type: 'UPS',            group: 'power', tags: ['power', 'ups'] },
  '39121000': { type: 'UPS',            group: 'power', tags: ['power', 'ups'] },
  '39121017': { type: 'Power Distribution', group: 'power', tags: ['power', 'pdu'] },
  '39121610': { type: 'Surge Protectors', group: 'power', tags: ['power', 'surge'] },
  '39121006': { type: 'Power Adapters', group: 'power', tags: ['power', 'adapter'] },
  '39121421': { type: 'Cable Accessories', group: 'computer-accessories', tags: ['cable'] },
  '26111700': { type: 'Batteries',      group: 'power', tags: ['power', 'battery'] },
  '26111704': { type: 'Chargers',       group: 'power', tags: ['power', 'charger'] },

  // ── Printers & supplies ──
  '44103103': { type: 'Printer Supplies', group: 'printers', tags: ['printer', 'toner'] },
  '44103105': { type: 'Printer Supplies', group: 'printers', tags: ['printer', 'toner'] },
  '44101700': { type: 'Label Printers', group: 'printers', tags: ['printer', 'label'] },
  '44101501': { type: 'Printers',       group: 'printers', tags: ['printer'] },

  // ── Security ──
  '46171610': { type: 'Security Cameras', group: 'security', tags: ['security', 'camera'] },
  '46171600': { type: 'Security Cameras', group: 'security', tags: ['security', 'camera'] },

  // ── Accessories / mounts / cases ──
  '41116203': { type: 'Mounts & Stands', group: 'computer-accessories', tags: ['mount', 'stand'] },
  '43212000': { type: 'Mounts & Stands', group: 'computer-accessories', tags: ['mount', 'shelf'] },
  '43212002': { type: 'Mounts & Stands', group: 'computer-accessories', tags: ['mount', 'arm'] },
  '43211604': { type: 'KVM & Splitters', group: 'computer-accessories', tags: ['kvm', 'splitter'] },
  '43211600': { type: 'Accessories',    group: 'computer-accessories', tags: ['accessory'] },
  '53121706': { type: 'Cases & Bags',   group: 'computer-accessories', tags: ['case', 'bag'] },
  '24102001': { type: 'Rack Accessories', group: 'power', tags: ['rack', 'datacenter'] },

  // ── Consumer electronics ──
  '52161514': { type: 'Headphones & Audio', group: 'consumer-electronics', tags: ['audio', 'headphone'] },
  '52161600': { type: 'Cables & Adapters', group: 'computer-accessories', tags: ['cable', 'adapter'] },

  // ── Cables (the big cable families) ──
  '26121609': { type: 'Network Cables', group: 'computer-accessories', tags: ['cable', 'ethernet'] },
  '26121607': { type: 'Fiber Cables',  group: 'computer-accessories', tags: ['cable', 'fiber'] },
  '26121620': { type: 'Cables',        group: 'computer-accessories', tags: ['cable'] },
  '26121629': { type: 'Power Cables',  group: 'computer-accessories', tags: ['cable', 'power'] },

  // ── 4-digit family fallbacks (when no 8-digit specific) ──
  '4321': { type: 'Computer Accessories', group: 'computer-accessories', tags: ['accessory'] },
  '4320': { type: 'Components',     group: 'components', tags: ['component'] },
  '4322': { type: 'Networking',     group: 'networking', tags: ['networking'] },
  '3912': { type: 'Power',          group: 'power', tags: ['power'] },
  '4617': { type: 'Security Cameras', group: 'security', tags: ['security', 'camera'] },
  '3210': { type: 'Memory',         group: 'memory', tags: ['memory'] },
  '2612': { type: 'Cables',         group: 'computer-accessories', tags: ['cable'] },
  '5216': { type: 'Consumer Electronics', group: 'consumer-electronics', tags: ['electronics'] },
  '4410': { type: 'Printer Supplies', group: 'printers', tags: ['printer'] },
  '4411': { type: 'Printers',       group: 'printers', tags: ['printer'] },
};

/**
 * Categorize a product. Prefers UNSPSC (field[34]); falls back to the description
 * classifier, then to a generic accessory bucket.
 * @param {{ unspsc?: string, description?: string, category?: string, manufacturer?: string }} p
 * @returns {{ type: string, group: string, tags: string[] }}
 */
function categorize(p = {}) {
  const code = String(p.unspsc || '').trim();
  if (code) {
    // Longest-prefix match: try 8, then 6, then 4 digits.
    for (const len of [8, 6, 4]) {
      const hit = UNSPSC[code.slice(0, len)];
      if (hit) return { type: hit.type, group: hit.group, tags: [...hit.tags] };
    }
  }
  // Fallback: description-based classifier (guarded rules).
  const byDesc = classifyProduct({ description: p.description, unspsc: code, category: p.category, manufacturer: p.manufacturer });
  if (byDesc) return byDesc;
  // Unknown: neutral "other" group so non-IT/uncategorizable items don't pollute the
  // real B2B category collections (which key on specific group tags).
  return { type: 'Other', group: 'other', tags: ['uncategorized'] };
}

module.exports = { categorize, UNSPSC };
