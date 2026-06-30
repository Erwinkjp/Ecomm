#!/usr/bin/env node
'use strict';
/**
 * Reprice in-stock ELIGIBLE MAP items (MAP ≤ MSRP) to max(MAP, MSRP × FACTOR) — i.e. near MSRP
 * but never below MAP. Also persists map+msrp on the record so price-sync keeps it there.
 *   source .env && node scripts/reprice-map-msrp.js            # DRY RUN
 *   source .env && node scripts/reprice-map-msrp.js --execute  # apply
 */
const fs=require('fs');
const EXECUTE=process.argv.includes('--execute');
const FACTOR=0.90;
process.env.PRODUCTS_TABLE=process.env.PRODUCTS_TABLE||'synnex-shopify-sync-products';
const MAPFILE='/private/tmp/claude-502/-Users-erwin-prado-Documents-All-Code-Repos-personal-workspace-Ecomm-synnex-shopify-sync/f9bfbb3b-7364-41b5-9f45-d91c954dc55c/scratchpad/map_msrp.tsv';
const { getProductByMfrPart, saveProduct } = require('../src/catalog/products');
const { DynamoDBClient, GetItemCommand } = require('@aws-sdk/client-dynamodb');
const { marshall, unmarshall } = require('@aws-sdk/util-dynamodb');
const _ddb=new DynamoDBClient({});
async function getByPK(sku){try{const r=await _ddb.send(new GetItemCommand({TableName:process.env.PRODUCTS_TABLE,Key:marshall({synnexSku:sku})}));return r.Item?unmarshall(r.Item):null;}catch(e){return null;}}
const store=process.env.SHOPIFY_STORE,cid=process.env.SHOPIFY_CLIENT_ID,secret=process.env.SHOPIFY_CLIENT_SECRET,ver=process.env.SHOPIFY_API_VERSION||'2026-01';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function token(){
  let lastErr;
  for(let i=0;i<5;i++){
    try{return (await(await fetch(`https://${store}.myshopify.com/admin/oauth/access_token`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({client_id:cid,client_secret:secret,grant_type:'client_credentials'})})).json()).access_token;}
    catch(e){lastErr=e;await sleep(1000*(i+1));}
  }
  throw lastErr;
}
async function gql(T,q,v){
  let lastErr;
  for(let i=0;i<5;i++){
    try{return (await(await fetch(`https://${store}.myshopify.com/admin/api/${ver}/graphql.json`,{method:'POST',headers:{'X-Shopify-Access-Token':T,'Content-Type':'application/json'},body:JSON.stringify({query:q,variables:v})})).json());}
    catch(e){lastErr=e;await sleep(1000*(i+1));}
  }
  throw lastErr;
}
const SKIP_RECSET=process.argv.includes('--no-recset');
(async()=>{
  console.log(EXECUTE?'*** EXECUTE ***':'— DRY RUN —', `(MSRP × ${FACTOR}, floored at MAP)`);
  const m=new Map();
  for(const l of fs.readFileSync(MAPFILE,'utf8').split('\n')){if(!l)continue;const [k,mp,ms]=l.split('\t');m.set(k.trim(),{map:parseFloat(mp),msrp:parseFloat(ms)||0});}
  let T=await token();
  const q='{products(query:"status:active AND published_status:published AND inventory_total:>0"){edges{node{id variants{edges{node{id sku price}}}}}}}';
  await gql(T,`mutation($q:String!){bulkOperationRunQuery(query:$q){bulkOperation{id} userErrors{message}}}`,{q});
  let url;while(true){await sleep(4000);T=await token();const o=(await gql(T,`{currentBulkOperation(type:QUERY){status objectCount url}}`)).data.currentBulkOperation;process.stdout.write(`\rexport ${o.status} ${o.objectCount}    `);if(o.status==='COMPLETED'){url=o.url;break;}if(o.status==='FAILED'){console.log('FAILED');process.exit(1);}}
  console.log('');
  const txt=await(await fetch(url)).text();
  const reprice=[], setRec=[];
  let eligible=0;
  for(const line of txt.split('\n')){
    if(!line)continue;let o;try{o=JSON.parse(line);}catch(e){continue;}
    if(o.sku===undefined)continue;
    const sku=(o.sku||'').trim();const e=m.get(sku);if(!e)continue;
    if(!(e.msrp>0 && e.map<=e.msrp))continue;       // eligible only (MAP ≤ MSRP)
    const price=parseFloat(o.price);
    if(e.map>price*10)continue;                      // sanity: skip garbage MAP
    eligible++;
    const target=Math.min(e.msrp, Math.max(e.map, Math.round(e.msrp*FACTOR*100)/100));
    setRec.push({sku,map:e.map,msrp:e.msrp});
    if(price<target) reprice.push({sku,productId:o.__parentId,variantId:o.id,price,target});
  }
  reprice.sort((a,b)=>(b.target-b.price)-(a.target-a.price));
  const gain=reprice.reduce((s,r)=>s+(r.target-r.price),0);
  console.log(`Eligible in-stock MAP items: ${eligible} | to reprice (current<target): ${reprice.length}`);
  console.log(`Total price increase across repriced units: $${gain.toFixed(0)}`);
  console.log('Sample (first 12):'); reprice.slice(0,12).forEach(r=>console.log(`  ${r.sku}: $${r.price.toFixed(2)} -> $${r.target.toFixed(2)}`));
  if(!EXECUTE){console.log('\nDry run only. Re-run with --execute.');return;}
  // set map+msrp on records (durability) — skippable if already done in a prior run
  if(SKIP_RECSET){console.log('\n(skipping map+msrp record-set: --no-recset)');}
  else{
    let recSet=0;
    for(const s of setRec){let rec=await getProductByMfrPart(s.sku);if(!rec)rec=await getByPK(s.sku);if(rec){await saveProduct({...rec,map:s.map,msrp:s.msrp});recSet++;}}
    console.log(`\n✓ map+msrp set on ${recSet} records`);
  }
  // reprice in Shopify
  let done=0,i=0;
  T=await token();
  for(const r of reprice){
    if(i++%200===0)T=await token();   // refresh token periodically, not every call
    const res=await gql(T,`mutation($p:ID!,$v:[ProductVariantsBulkInput!]!){productVariantsBulkUpdate(productId:$p,variants:$v){userErrors{field message}}}`,{p:r.productId,v:[{id:r.variantId,price:String(r.target.toFixed(2))}]});
    const e=res.data?.productVariantsBulkUpdate?.userErrors;if(e&&e.length){console.log(`✗ ${r.sku}: ${JSON.stringify(e)}`);}else done++;
    if(done%500===0)process.stdout.write(`\r  repriced ${done}/${reprice.length}    `);
  }
  console.log(`\n✓ repriced ${done}/${reprice.length} items to near-MSRP`);
})().catch(e=>{console.error(e);process.exit(1);});
