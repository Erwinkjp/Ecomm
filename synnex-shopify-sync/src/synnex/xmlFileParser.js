/**
 * Parse TD Synnex XML file (downloaded from portal or bulk export).
 * Extracts items with part number, quantity, price. Tag names are configurable via env
 * or common variants (synnexSKU, partNumber, qtyAvailable, unitPrice, etc.).
 */
function getText(blob, tagNames) {
  if (!blob || !tagNames.length) return '';
  for (const name of tagNames) {
    const m = new RegExp(`<${name}[^>]*>([^<]*)</${name}>`, 'i').exec(blob);
    if (m) return m[1].trim();
  }
  return '';
}

function parseSynnexXmlFile(content, options = {}) {
  const allowlist = options.allowlist || null;
  const results = [];
  const partTags = (process.env.SYNNEX_XML_PART_TAG || 'synnexSKU,partNumber,sku,PARTNUM').split(',').map((s) => s.trim());
  const qtyTags = (process.env.SYNNEX_XML_QTY_TAG || 'qtyAvailable,quantityAvailable,qty,QTY').split(',').map((s) => s.trim());
  const priceTags = (process.env.SYNNEX_XML_PRICE_TAG || 'unitPrice,price,sellPrice').split(',').map((s) => s.trim());
  const descTags = (process.env.SYNNEX_XML_DESC_TAG || 'description,desc').split(',').map((s) => s.trim());
  const manufacturerTags = (process.env.SYNNEX_XML_MANUFACTURER_TAG || 'manufacturer,brand,vendor,Mfr').split(',').map((s) => s.trim());
  const categoryTags = (process.env.SYNNEX_XML_CATEGORY_TAG || 'category,cat,productCategory').split(',').map((s) => s.trim());

  const itemRegex = /<item[^>]*>([\s\S]*?)<\/item>|<\w+Item[^>]*>([\s\S]*?)<\/\w+Item>/gi;
  let m;
  while ((m = itemRegex.exec(content)) !== null) {
    const block = m[1] || m[2] || '';
    const partNumber = getText(block, partTags);
    if (!partNumber) continue;
    if (allowlist && !allowlist.has(partNumber)) continue;
    const qty = getText(block, qtyTags);
    const price = getText(block, priceTags);
    const description = getText(block, descTags);
    const manufacturer = getText(block, manufacturerTags) || undefined;
    const category = getText(block, categoryTags) || undefined;
    results.push({
      partNumber,
      description: description || undefined,
      quantityAvailable: parseInt(qty, 10) || 0,
      price: price ? parseFloat(price) : undefined,
      currency: 'USD',
      manufacturer,
      category,
    });
  }

  if (results.length === 0) {
    const altItemRegex = /<product[^>]*>([\s\S]*?)<\/product>|<\w+Record[^>]*>([\s\S]*?)<\/\w+Record>/gi;
    while ((m = altItemRegex.exec(content)) !== null) {
      const block = m[1] || m[2] || '';
      const partNumber = getText(block, partTags);
      if (!partNumber) continue;
      if (allowlist && !allowlist.has(partNumber)) continue;
      const qty = getText(block, qtyTags);
      const price = getText(block, priceTags);
      const description = getText(block, descTags);
      const manufacturer = getText(block, manufacturerTags) || undefined;
      const category = getText(block, categoryTags) || undefined;
      results.push({
        partNumber,
        description: description || undefined,
        quantityAvailable: parseInt(qty, 10) || 0,
        price: price ? parseFloat(price) : undefined,
        currency: 'USD',
        manufacturer,
        category,
      });
    }
  }

  return results;
}

module.exports = { parseSynnexXmlFile };
