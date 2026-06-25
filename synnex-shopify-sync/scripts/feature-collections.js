'use strict';

/**
 * feature-collections — float the enriched (`featured`-tagged) products to the top of
 * each B2B category + Solutions collection, so browsing leads with products that have
 * a clean title, image, description and spec sheet (the "nice experience" pass).
 *
 * Mechanism: smart collections support MANUAL sort order. We set each target collection
 * to MANUAL, then use collectionReorderProducts to move its `featured` members to the
 * front. Membership is derived from each collection's OWN rules (TAG/TYPE) matched
 * against the (bounded) set of `featured` products — so we never paginate the full
 * 20k-60k product collections. Idempotent — re-run as more products get enriched.
 *
 *   source .env && node scripts/feature-collections.js            # dry-run (report only)
 *   source .env && node scripts/feature-collections.js --apply    # set MANUAL + reorder
 *   source .env && node scripts/feature-collections.js --apply --handle networking
 */

const STORE = process.env.SHOPIFY_STORE, TOKEN = process.env.SHOPIFY_ACCESS_TOKEN, VER = process.env.SHOPIFY_API_VERSION || '2026-01';
const APPLY = process.argv.includes('--apply');
const ONLY = (() => { const i = process.argv.indexOf('--handle'); return i > -1 ? process.argv[i + 1] : null; })();
// --handles a,b,c → operate on an explicit comma-separated list instead of the default set.
const HANDLES = (() => { const i = process.argv.indexOf('--handles'); return i > -1 ? process.argv[i + 1].split(',').map(s => s.trim()).filter(Boolean) : null; })();
const GQL = `https://${STORE}.myshopify.com/admin/api/${VER}/graphql.json`;

const COLLECTIONS = [
  'laptops-desktops-servers', 'monitors-displays', 'networking', 'storage-nas', 'power-ups',
  'security-surveillance', 'printers-supplies', 'memory', 'components', 'keyboards-mice',
  'accessories-cables', 'audio-electronics',
  'education-solutions', 'government-solutions', 'healthcare-solutions', 'finance-solutions', 'business-solutions',
];

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function gql(query, variables = {}) {
  for (let attempt = 0; attempt < 6; attempt++) {
    const r = await fetch(GQL, { method: 'POST', headers: { 'X-Shopify-Access-Token': TOKEN, 'Content-Type': 'application/json' }, body: JSON.stringify({ query, variables }) });
    const j = await r.json();
    if (j.errors?.some(e => /throttl/i.test(e.message))) { await sleep(2500); continue; }
    if (j.errors?.length) throw new Error(j.errors.map(e => e.message).join('; '));
    return j.data;
  }
  throw new Error('throttled repeatedly');
}

// Load every `featured` product once (bounded set), with the fields needed to test
// collection membership: tags + productType.
async function loadFeaturedProducts() {
  const out = [];
  let cursor = null;
  do {
    const d = await gql(`query($c:String){
      products(first:250, after:$c, query:"tag:featured status:active"){
        pageInfo{hasNextPage endCursor}
        nodes{ id productType tags }
      }
    }`, { c: cursor });
    out.push(...d.products.nodes);
    cursor = d.products.pageInfo.hasNextPage ? d.products.pageInfo.endCursor : null;
  } while (cursor);
  return out;
}

// Does a product satisfy a smart collection's ruleSet (TAG/TYPE rules; AND/OR)?
function matchesRules(product, ruleSet) {
  if (!ruleSet?.rules?.length) return false;
  const test = r => {
    if (r.column === 'TAG') return product.tags.includes(r.condition);
    if (r.column === 'TYPE') return (product.productType || '') === r.condition;
    return false; // other columns (VARIANT_PRICE etc.) not used for our category rules
  };
  return ruleSet.appliedDisjunctively ? ruleSet.rules.some(test) : ruleSet.rules.every(test);
}

async function run() {
  if (!STORE || !TOKEN) throw new Error('source .env first');
  const handles = ONLY ? [ONLY] : (HANDLES || COLLECTIONS);
  console.log(`${APPLY ? 'APPLYING' : 'DRY-RUN'} — ${handles.length} collection(s)`);
  const featured = await loadFeaturedProducts();
  console.log(`featured products in catalog: ${featured.length}\n`);

  for (const handle of handles) {
    const d = await gql(`query($h:String!){ collectionByHandle(handle:$h){ id title sortOrder productsCount{count} ruleSet{ appliedDisjunctively rules{ column relation condition } } } }`, { h: handle });
    const c = d.collectionByHandle;
    if (!c) { console.log(`  ✗ missing: ${handle}`); continue; }

    const members = featured.filter(p => matchesRules(p, c.ruleSet)).map(p => p.id);
    console.log(`  ${handle.padEnd(26)} total:${String(c.productsCount.count).padStart(6)}  featured:${String(members.length).padStart(5)}  sort:${c.sortOrder}`);
    if (!APPLY || members.length === 0) continue;

    if (c.sortOrder !== 'MANUAL') {
      await gql(`mutation($id:ID!){ collectionUpdate(input:{id:$id,sortOrder:MANUAL}){ userErrors{message} } }`, { id: c.id });
    }
    const BATCH = 200;
    for (let i = 0; i < members.length; i += BATCH) {
      const moves = members.slice(i, i + BATCH).map((id, k) => ({ id, newPosition: String(i + k) }));
      const mv = await gql(`mutation($id:ID!,$moves:[MoveInput!]!){ collectionReorderProducts(id:$id,moves:$moves){ job{id} userErrors{message} } }`, { id: c.id, moves });
      const errs = mv.collectionReorderProducts.userErrors || [];
      if (errs.length) console.log(`     ! ${handle}: ${errs.map(e => e.message).join('; ')}`);
      await sleep(500);
    }
    console.log(`     → floated ${members.length} featured to top`);
  }
  console.log('\nDone.');
}

run().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
