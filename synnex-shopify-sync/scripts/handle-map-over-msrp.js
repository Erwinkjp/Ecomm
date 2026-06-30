#!/usr/bin/env node
'use strict';
/**
 * Handle the in-stock published items where MAP > MSRP (the segment the MSRP×0.90 reprice
 * deliberately skipped). Per merchant decision:
 *   - DRAFT the C2G cable/connector junk (reversible; we don't push cables — shipping losses).
 *   - Reprice everything else to MSRP × 0.90 (competitive), and persist a capped MAP
 *     (= round(MSRP×0.90)) + MSRP on the record so price-sync keeps it at MSRP×0.90
 *     (price-sync's near-MSRP branch fires when stored map ≤ msrp).
 *
 *   source .env && node scripts/handle-map-over-msrp.js            # DRY RUN
 *   source .env && node scripts/handle-map-over-msrp.js --execute  # apply
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
async function token(){let e;for(let i=0;i<5;i++){try{return (await(await fetch(`https://${store}.myshopify.com/admin/oauth/access_token`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({client_id:cid,client_secret:secret,grant_type:'client_credentials'})})).json()).access_token;}catch(x){e=x;await sleep(1000*(i+1));}}throw e;}
async function gql(T,q,v){let e;for(let i=0;i<5;i++){try{return (await(await fetch(`https://${store}.myshopify.com/admin/api/${ver}/graphql.json`,{method:'POST',headers:{'X-Shopify-Access-Token':T,'Content-Type':'application/json'},body:JSON.stringify({query:q,variables:v})})).json());}catch(x){e=x;await sleep(1000*(i+1));}}throw e;}
const isC2G=v=>/c2g|cables to go/i.test(v||'');
(async()=>{
  console.log(EXECUTE?'*** EXECUTE ***':'— DRY RUN —');
  const m=new Map();
  for(const l of fs.readFileSync(MAPFILE,'utf8').split('\n')){if(!l)continue;const [k,mp,ms]=l.split('\t');m.set(k.trim(),{map:parseFloat(mp),msrp:parseFloat(ms)||0});}
  let T=await token();
  const q='{products(query:"status:active AND published_status:published AND inventory_total:>0"){edges{node{id vendor variants{edges{node{id sku price}}}}}}}';
  await gql(T,`mutation($q:String!){bulkOperationRunQuery(query:$q){bulkOperation{id} userErrors{message}}}`,{q});
  let url;while(true){await sleep(4000);T=await token();const o=(await gql(T,`{currentBulkOperation(type:QUERY){status objectCount url}}`)).data.currentBulkOperation;process.stdout.write(`\rexport ${o.status} ${o.objectCount}    `);if(o.status==='COMPLETED'){url=o.url;break;}if(o.status==='FAILED'){console.log('FAILED');process.exit(1);}}
  console.log('');
  const txt=await(await fetch(url)).text();
  const vendorById=new Map(); const draft=[], reprice=[];
  for(const line of txt.split('\n')){if(!line)continue;let o;try{o=JSON.parse(line);}catch(e){continue;}
    if(o.vendor!==undefined&&o.sku===undefined)vendorById.set(o.id,o.vendor);
    if(o.sku!==undefined){const sku=(o.sku||'').trim();const e=m.get(sku);if(!e)continue;
      if(!(e.msrp>0 && e.map>e.msrp))continue;                    // only MAP > MSRP segment
      const vendor=vendorById.get(o.__parentId)||'';
      if(isC2G(vendor)) draft.push({sku,productId:o.__parentId,vendor});
      else{const target=Math.round(e.msrp*FACTOR*100)/100; reprice.push({sku,productId:o.__parentId,variantId:o.id,price:parseFloat(o.price),target,msrp:e.msrp});}
    }
  }
  console.log(`MAP>MSRP segment — to DRAFT (C2G junk): ${draft.length} | to reprice @MSRP×${FACTOR} (rest): ${reprice.length}`);
  console.log('  draft sample:'); draft.slice(0,5).forEach(d=>console.log(`    ${d.sku} (${d.vendor})`));
  console.log('  reprice sample:'); reprice.slice(0,8).forEach(r=>console.log(`    ${r.sku}: $${r.price.toFixed(2)} -> $${r.target.toFixed(2)} (MSRP $${r.msrp.toFixed(2)})`));
  if(!EXECUTE){console.log('\nDry run only. Re-run with --execute.');return;}
  // 1) DRAFT C2G junk + flag autoHiddenJunk for durability
  let drafted=0;T=await token();let i=0;
  for(const d of draft){
    if(i++%200===0)T=await token();
    const r=await gql(T,`mutation($id:ID!){productUpdate(input:{id:$id,status:DRAFT}){userErrors{message}}}`,{id:d.productId});
    const e=r.data?.productUpdate?.userErrors; if(e&&e.length){console.log('✗ draft',d.sku,JSON.stringify(e));continue;}
    let rec=await getProductByMfrPart(d.sku);if(!rec)rec=await getByPK(d.sku);if(rec)await saveProduct({...rec,autoHiddenJunk:true});
    drafted++; if(drafted%100===0)process.stdout.write(`\r  drafted ${drafted}/${draft.length}   `);
  }
  console.log(`\n✓ drafted ${drafted}/${draft.length} C2G items`);
  // 2) reprice the rest @ MSRP×0.90 + persist capped map(=target)+msrp so price-sync holds it
  let done=0;i=0;T=await token();
  for(const r of reprice){
    if(i++%200===0)T=await token();
    const res=await gql(T,`mutation($p:ID!,$v:[ProductVariantsBulkInput!]!){productVariantsBulkUpdate(productId:$p,variants:$v){userErrors{message}}}`,{p:r.productId,v:[{id:r.variantId,price:String(r.target.toFixed(2))}]});
    const e=res.data?.productVariantsBulkUpdate?.userErrors; if(e&&e.length){console.log('✗ reprice',r.sku,JSON.stringify(e));continue;}
    let rec=await getProductByMfrPart(r.sku);if(!rec)rec=await getByPK(r.sku);if(rec)await saveProduct({...rec,map:r.target,msrp:r.msrp});
    done++; if(done%50===0)process.stdout.write(`\r  repriced ${done}/${reprice.length}   `);
  }
  console.log(`\n✓ repriced ${done}/${reprice.length} items to MSRP×${FACTOR}`);
})().catch(e=>{console.error(e);process.exit(1);});
