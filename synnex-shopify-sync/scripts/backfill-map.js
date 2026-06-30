#!/usr/bin/env node
'use strict';
/**
 * One-time MAP backfill:
 *   1) Sets `map` on each MAP-protected product's DynamoDB record (durability — so the
 *      now-deployed price-sync MAP floor keeps working on future runs).
 *   2) Reprices any listed variant currently advertised BELOW its MAP up to MAP.
 *
 *   source .env && node scripts/backfill-map.js            # DRY RUN (no writes)
 *   source .env && node scripts/backfill-map.js --execute  # apply changes
 */
const fs = require('fs');
const EXECUTE = process.argv.includes('--execute');
process.env.PRODUCTS_TABLE = process.env.PRODUCTS_TABLE || 'synnex-shopify-sync-products';
const MAPFILE = '/private/tmp/claude-502/-Users-erwin-prado-Documents-All-Code-Repos-personal-workspace-Ecomm-synnex-shopify-sync/f9bfbb3b-7364-41b5-9f45-d91c954dc55c/scratchpad/map_both.tsv';
const { getProductByMfrPart, saveProduct } = require('../src/catalog/products');
const { DynamoDBClient, GetItemCommand } = require('@aws-sdk/client-dynamodb');
const { marshall, unmarshall } = require('@aws-sdk/util-dynamodb');
const _ddb = new DynamoDBClient({});
// Records are keyed by PK = synnexSku. Synnex-SKU-listed products (e.g. the LG monitor,
// sku 6475408) aren't found by the mfrPartNumber index — fall back to a PK GetItem.
async function getByPK(sku){ try{const r=await _ddb.send(new GetItemCommand({TableName:process.env.PRODUCTS_TABLE,Key:marshall({synnexSku:sku})}));return r.Item?unmarshall(r.Item):null;}catch(e){return null;} }

const store=process.env.SHOPIFY_STORE,cid=process.env.SHOPIFY_CLIENT_ID,secret=process.env.SHOPIFY_CLIENT_SECRET,ver=process.env.SHOPIFY_API_VERSION||'2026-01';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function token(){return (await(await fetch(`https://${store}.myshopify.com/admin/oauth/access_token`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({client_id:cid,client_secret:secret,grant_type:'client_credentials'})})).json()).access_token;}
async function gql(T,q,v){return (await(await fetch(`https://${store}.myshopify.com/admin/api/${ver}/graphql.json`,{method:'POST',headers:{'X-Shopify-Access-Token':T,'Content-Type':'application/json'},body:JSON.stringify({query:q,variables:v})})).json());}

(async()=>{
  console.log(EXECUTE ? '*** EXECUTE MODE — writing changes ***' : '— DRY RUN (no writes) —');
  const mapByPN=new Map();
  for(const l of fs.readFileSync(MAPFILE,'utf8').split('\n')){if(!l)continue;const [pn,m]=l.split('\t');mapByPN.set(pn.trim(),parseFloat(m));}
  console.log('MAP set:',mapByPN.size);

  let T=await token();
  // export listed variants with ids + price
  // MAP applies to anything ADVERTISED (published), in stock or not — so do NOT filter by inventory.
  const q=`{products(query:\"status:active AND publication_id:43075764359\"){edges{node{id variants{edges{node{id sku price}}}}}}}`;
  await gql(T,`mutation($q:String!){bulkOperationRunQuery(query:$q){bulkOperation{id} userErrors{message}}}`,{q});
  let url;
  while(true){await sleep(4000);T=await token();const o=(await gql(T,`{currentBulkOperation(type:QUERY){status objectCount url}}`)).data.currentBulkOperation;process.stdout.write(`\rexport ${o.status} ${o.objectCount}    `);if(o.status==='COMPLETED'){url=o.url;break;}if(o.status==='FAILED'){console.log('export FAILED');process.exit(1);}}
  console.log('');
  const txt=await(await fetch(url)).text();

  const matches=[], reprice=[], anomalies=[];
  for(const line of txt.split('\n')){
    if(!line)continue;let o;try{o=JSON.parse(line);}catch(e){continue;}
    if(o.sku===undefined)continue;
    const sku=(o.sku||'').trim();
    if(!mapByPN.has(sku))continue;
    const mapv=mapByPN.get(sku), price=parseFloat(o.price);
    matches.push({sku,mapv,price,variantId:o.id,productId:o.__parentId});
    if(price<mapv){
      if(mapv>price*10){anomalies.push({sku,price,mapv});continue;} // sanity: skip absurd MAP
      reprice.push({sku,mapv,price,variantId:o.id,productId:o.__parentId});
    }
  }
  console.log(`MAP-protected listed: ${matches.length} | below MAP (to reprice): ${reprice.length} | sanity-skipped: ${anomalies.length}`);
  if(anomalies.length){console.log('  anomalies (MAP > 10x price, NOT repriced — review):'); anomalies.slice(0,10).forEach(a=>console.log(`    ${a.sku}: $${a.price} vs MAP $${a.mapv}`));}
  console.log('\nReprice plan (first 15):');
  reprice.slice(0,15).forEach(r=>console.log(`  ${r.sku}: $${r.price} -> $${r.mapv}`));

  if(!EXECUTE){console.log('\nDry run only. Re-run with --execute to apply.');return;}

  // 1) set map on DynamoDB records (all sane matches, for durability) — skip garbage-MAP anomalies
  const badSkus = new Set(anomalies.map(a=>a.sku));
  let mapSet=0;
  for(const m of matches){
    if(badSkus.has(m.sku)) continue;
    let rec=await getProductByMfrPart(m.sku);
    if(!rec) rec=await getByPK(m.sku);
    if(rec){await saveProduct({...rec, map:m.mapv}); mapSet++;}
  }
  console.log(`\n✓ map set on ${mapSet} product records`);

  // 2) reprice violators in Shopify
  let done=0;
  for(const r of reprice){
    T=await token();
    const res=await gql(T,`mutation($p:ID!,$v:[ProductVariantsBulkInput!]!){productVariantsBulkUpdate(productId:$p,variants:$v){userErrors{field message}}}`,{p:r.productId,v:[{id:r.variantId,price:String(r.mapv.toFixed(2))}]});
    const e=res.data?.productVariantsBulkUpdate?.userErrors;
    if(e&&e.length){console.log(`  ✗ ${r.sku}: ${JSON.stringify(e)}`);}else{done++;}
  }
  console.log(`✓ repriced ${done}/${reprice.length} violators to MAP`);
})().catch(e=>{console.error(e);process.exit(1);});
