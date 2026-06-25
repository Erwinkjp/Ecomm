'use strict';

/**
 * fix-mice-cleanup.js
 *
 * Audits all Shopify products typed as "Mice" and fixes misclassified ones.
 *
 * Root cause: an old version of mapCategory() matched product descriptions
 * containing the word "mouse", which pushed desktop bundles (e.g. "Dell
 * Desktop with keyboard and mouse") and Logitech AV gear into the Mice
 * storefront collection.  The transform.js bug is fixed; this script cleans
 * up the products already in Shopify.
 *
 * Usage:
 *   source .env && node scripts/fix-mice-cleanup.js            # dry run — print report
 *   source .env && node scripts/fix-mice-cleanup.js --apply    # write changes
 *   source .env && node scripts/fix-mice-cleanup.js --apply --delete  # also delete AV gear / mic pods
 */

const STORE       = process.env.SHOPIFY_STORE;
const TOKEN       = process.env.SHOPIFY_ACCESS_TOKEN;
const API         = process.env.SHOPIFY_API_VERSION || '2026-01';
const CONCURRENCY = 5;

const DRY_RUN   = !process.argv.includes('--apply');
const DO_DELETE = process.argv.includes('--delete');

if (!STORE || !TOKEN) {
  console.error('Set SHOPIFY_STORE and SHOPIFY_ACCESS_TOKEN before running.');
  process.exit(1);
}

const GQL_URL = `https://${STORE}.myshopify.com/admin/api/${API}/graphql.json`;

// ── Rules: patterns that prove a "Mouse"-typed product is NOT a mouse ─────────
//
// Each rule: match on title → assign correct productType + group tag.
// `deletable: true` marks products that probably shouldn't exist in the catalog
// at all (AV conferencing gear, standalone mic pods) — only deleted with --delete.

const NOT_MOUSE_RULES = [
  {
    // Desktop computers and all-in-ones (e.g. "OptiPlex 7010 Desktop with Mouse")
    match: /\b(desktop|tower|optiplex|thinkcentre|ideacentre|prodesk|elitedesk|all.in.one|all in one|\bAIO\b)\b/i,
    type: 'Desktops',
    group: 'computers-portables',
    remove: ['mouse'],
    add:    ['desktop'],
  },
  {
    // Logitech Rally Bar / conferencing systems — wrong catalog, should be deleted
    match: /\b(rally\s*bar|rally\s*camera|meetup|sight\s*cam|tap\s*scheduler)\b/i,
    type: 'Video Conferencing',
    group: 'networking',
    remove: ['mouse'],
    add:    ['av', 'conferencing'],
    deletable: true,
  },
  {
    // Standalone mic pods — wrong catalog, should be deleted
    match: /\b(mic\s*pod|mic\s*hub)\b/i,
    type: 'Headphones & Microphones',
    group: 'consumer-electronics',
    remove: ['mouse'],
    add:    ['microphone'],
    deletable: true,
  },
  {
    // Standalone microphone (title doesn't say "mouse")
    match: /\bmicrophone\b/i,
    exclude: /\b(mouse|mice)\b/i,
    type: 'Headphones & Microphones',
    group: 'consumer-electronics',
    remove: ['mouse'],
    add:    ['microphone'],
  },
  {
    // Pure keyboard — title has "keyboard" but NOT "mouse" (so combos stay as Mice)
    match: /\bkeyboard\b/i,
    exclude: /\b(mouse|mice)\b/i,
    type: 'Keyboards',
    group: 'input-devices',
    remove: ['mouse'],
    add:    ['keyboard'],
  },
  {
    match: /\b(headset|headphone|earphone|earbud)\b/i,
    type: 'Headphones & Microphones',
    group: 'consumer-electronics',
    remove: ['mouse'],
    add:    ['headphone'],
  },
  {
    match: /\b(webcam|web\s*cam|pc\s*camera)\b/i,
    type: 'Webcams & Cameras',
    group: 'input-devices',
    remove: ['mouse'],
    add:    ['camera', 'webcam'],
  },
];

function classifyProduct(product) {
  const title = product.title || '';
  for (const rule of NOT_MOUSE_RULES) {
    if (!rule.match.test(title)) continue;
    if (rule.exclude && rule.exclude.test(title)) continue;
    return rule;
  }
  return null; // Looks like a real mouse — leave it alone
}

function buildNewTags(existingTags, rule) {
  const removeSet = new Set(rule.remove.map(t => t.toLowerCase()));
  const filtered  = existingTags.filter(t => !removeSet.has(t.toLowerCase()));
  return [...new Set([...filtered, rule.group, ...rule.add])];
}

// ── GraphQL helpers ───────────────────────────────────────────────────────────

async function gql(query, variables = {}, retries = 3) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await fetch(GQL_URL, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': TOKEN },
        body:    JSON.stringify({ query, variables }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.json();
      if (body.errors?.length) {
        const msg = body.errors[0].message;
        if (msg.toLowerCase().includes('throttled') && attempt < retries) {
          await new Promise(r => setTimeout(r, 2000 * attempt));
          continue;
        }
        throw new Error(msg);
      }
      return body.data;
    } catch (e) {
      if (attempt < retries && (e.code === 'ETIMEDOUT' || e.code === 'ECONNRESET' || e.message?.includes('fetch failed'))) {
        await new Promise(r => setTimeout(r, 3000 * attempt));
        continue;
      }
      throw e;
    }
  }
}

const GET_MOUSE_PRODUCTS = `
  query getMouseProducts($cursor: String) {
    products(first: 250, after: $cursor, query: "product_type:Mouse") {
      pageInfo { hasNextPage endCursor }
      nodes {
        id
        title
        vendor
        productType
        tags
      }
    }
  }
`;

const UPDATE_PRODUCT = `
  mutation productUpdate($input: ProductInput!) {
    productUpdate(input: $input) {
      product { id productType tags }
      userErrors { field message }
    }
  }
`;

const DELETE_PRODUCT = `
  mutation productDelete($input: ProductDeleteInput!) {
    productDelete(input: $input) {
      deletedProductId
      userErrors { field message }
    }
  }
`;

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\nQuerying productType:Mouse from ${STORE}.myshopify.com …\n`);

  const products = [];
  let cursor = null;
  do {
    const data = await gql(GET_MOUSE_PRODUCTS, cursor ? { cursor } : {});
    const page  = data.products;
    products.push(...page.nodes);
    cursor = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
    process.stdout.write(`\r  Loaded ${products.length} products…`);
  } while (cursor);
  console.log(`\n  Total Mouse-typed: ${products.length}\n`);

  // Classify into: real mice / retype / delete
  const realMice = [];
  const toRetype = [];
  const toDelete = [];

  for (const p of products) {
    const rule = classifyProduct(p);
    if (!rule) {
      realMice.push(p);
    } else if (rule.deletable && DO_DELETE) {
      toDelete.push({ product: p, rule });
    } else {
      toRetype.push({ product: p, rule });
    }
  }

  // ── Report ────────────────────────────────────────────────────────────────
  console.log(`  Real mice (no change):  ${realMice.length}`);
  console.log(`  Misclassified → retype: ${toRetype.length}`);
  console.log(`  Deletable (AV / mics):  ${toDelete.length + toRetype.filter(x => x.rule.deletable).length}`);
  if (!DO_DELETE) console.log(`  (pass --delete to remove AV gear / mic pods instead of retyping them)`);
  console.log('');

  if (toRetype.length > 0) {
    console.log('── Retype plan ─────────────────────────────────────────────────────────────');
    for (const { product, rule } of toRetype) {
      const newTags = buildNewTags(product.tags, rule);
      console.log(`  "${product.title}"`);
      console.log(`    type:  ${product.productType} → ${rule.type}`);
      console.log(`    tags:  [${newTags.join(', ')}]`);
    }
    console.log('');
  }

  if (toDelete.length > 0) {
    console.log('── Delete plan ─────────────────────────────────────────────────────────────');
    for (const { product } of toDelete) {
      console.log(`  "${product.title}"  (${product.id})`);
    }
    console.log('');
  }

  if (DRY_RUN) {
    console.log('DRY RUN — no changes written. Re-run with --apply to apply.\n');
    return;
  }

  // ── Apply retypes ─────────────────────────────────────────────────────────
  if (toRetype.length > 0) {
    console.log(`Applying ${toRetype.length} retypes…`);
    let done = 0, errors = 0;

    async function retypeOne({ product, rule }) {
      try {
        const newTags = buildNewTags(product.tags, rule);
        const data    = await gql(UPDATE_PRODUCT, { input: { id: product.id, productType: rule.type, tags: newTags } });
        const errs    = data.productUpdate?.userErrors || [];
        if (errs.length) throw new Error(errs.map(e => e.message).join('; '));
        done++;
      } catch (e) {
        errors++;
        if (errors <= 5) console.error(`\n  ✗ "${product.title}": ${e.message}`);
      }
      if ((done + errors) % 10 === 0 || done + errors === toRetype.length) {
        process.stdout.write(`\r  Retyped ${done}/${toRetype.length}  errors: ${errors}`);
      }
    }

    for (let i = 0; i < toRetype.length; i += CONCURRENCY) {
      await Promise.all(toRetype.slice(i, i + CONCURRENCY).map(retypeOne));
    }
    console.log('\n');
  }

  // ── Apply deletes ─────────────────────────────────────────────────────────
  if (toDelete.length > 0) {
    console.log(`Deleting ${toDelete.length} products…`);
    let done = 0, errors = 0;

    async function deleteOne({ product }) {
      try {
        const data = await gql(DELETE_PRODUCT, { input: { id: product.id } });
        const errs = data.productDelete?.userErrors || [];
        if (errs.length) throw new Error(errs.map(e => e.message).join('; '));
        done++;
      } catch (e) {
        errors++;
        if (errors <= 5) console.error(`\n  ✗ "${product.title}": ${e.message}`);
      }
      process.stdout.write(`\r  Deleted ${done}/${toDelete.length}  errors: ${errors}`);
    }

    for (let i = 0; i < toDelete.length; i += CONCURRENCY) {
      await Promise.all(toDelete.slice(i, i + CONCURRENCY).map(deleteOne));
    }
    console.log('\n');
  }

  console.log('Done.\n');
}

main().catch(e => { console.error(e); process.exit(1); });
