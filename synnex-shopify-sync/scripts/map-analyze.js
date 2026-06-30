'use strict';
// Read-only analysis of in-stock MAP violators: classify list-at-MAP vs consider-unpublish.
const fs=require('fs');
const store=process.env.SHOPIFY_STORE,cid=process.env.SHOPIFY_CLIENT_ID,secret=process.env.SHOPIFY_CLIENT_SECRET,ver=process.env.SHOPIFY_API_VERSION||'2026-01';
const MAPFILE='/private/tmp/claude-502/-Users-erwin-prado-Documents-All-Code-Repos-personal-workspace-Ecomm-synnex-shopify-sync/f9bfbb3b-7364-41b5-9f45-d91c954dc55c/scratchpad/map_msrp.tsv';
const OUT='/private/tmp/claude-502/-Users-erwin-prado-Documents-All-Code-Repos-personal-workspace-Ecomm-synnex-shopify-sync/f9bfbb3b-7364-41b5-9f45-d91c954dc55c/scratchpad/map_instock_analysis.csv';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function token(){return (await(await fetch(`https://${store}.myshopify.com/admin/oauth/access_token`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({client_id:cid,client_secret:secret,grant_type:'client_credentials'})})).json()).access_token;}
async function gql(T,q,v){return (await(await fetch(`https://${store}.myshopify.com/admin/api/${ver}/graphql.json`,{method:'POST',headers:{'X-Shopify-Access-Token':T,'Content-Type':'application/json'},body:JSON.stringify({query:q,variables:v})})).json());}
(async()=>{
  const m=new Map();
  for(const l of fs.readFileSync(MAPFILE,'utf8').split('\n')){if(!l)continue;const [k,mp,ms]=l.split('\t');m.set(k.trim(),{map:parseFloat(mp),msrp:parseFloat(ms)||0});}
  let T=await token();
  const q='{products(query:"status:active AND published_status:published AND inventory_total:>0"){edges{node{id title variants{edges{node{sku price}}}}}}}';
  await gql(T,`mutation($q:String!){bulkOperationRunQuery(query:$q){bulkOperation{id} userErrors{message}}}`,{q});
  let url;while(true){await sleep(4000);T=await token();const o=(await gql(T,`{currentBulkOperation(type:QUERY){status url}}`)).data.currentBulkOperation;if(o.status==='COMPLETED'){url=o.url;break;}if(o.status==='FAILED'){console.log('FAILED');return;}}
  const txt=await(await fetch(url)).text();
  const titleById=new Map(); const v=[];
  for(const line of txt.split('\n')){if(!line)continue;let o;try{o=JSON.parse(line);}catch(e){continue;}
    if(o.title!==undefined&&o.sku===undefined)titleById.set(o.id,o.title);
    if(o.sku!==undefined){const sku=(o.sku||'').trim();const e=m.get(sku);if(!e)continue;const price=parseFloat(o.price);if(price<e.map && e.map<=price*10) v.push({sku,price,map:e.map,msrp:e.msrp,title:titleById.get(o.__parentId)||''});}
  }
  // classify
  let aboveList=0,nearList=0,goodDiscount=0,noMsrp=0;
  const jb={s:0,m:0,l:0,xl:0}; // jump buckets ≤10, 10-25, 25-50, >50
  for(const r of v){
    const jump=(r.map/r.price-1)*100;
    if(jump<=10)jb.s++;else if(jump<=25)jb.m++;else if(jump<=50)jb.l++;else jb.xl++;
    if(r.msrp<=0)noMsrp++;
    else if(r.map>r.msrp)aboveList++;
    else if(r.map>=r.msrp*0.92)nearList++;
    else goodDiscount++;
    r.jump=jump; r.rec = (r.msrp>0&&r.map>r.msrp)?'REVIEW: MAP>MSRP' : jump>50?'REVIEW: +'+jump.toFixed(0)+'%' : (r.msrp>0&&r.map<=r.msrp*0.92)?'LIST (good discount)':'LIST';
  }
  v.sort((a,b)=>b.jump-a.jump);
  const csv=['SKU,Title,Current,MAP,MSRP,Jump %,MAP/MSRP %,Recommendation'];
  for(const r of v) csv.push(`${r.sku},"${(r.title||'').replace(/"/g,"'").slice(0,60)}",${r.price.toFixed(2)},${r.map.toFixed(2)},${r.msrp.toFixed(2)},${r.jump.toFixed(0)}%,${r.msrp>0?(r.map/r.msrp*100).toFixed(0):'-'}%,${r.rec}`);
  fs.writeFileSync(OUT,csv.join('\n'));
  console.log(`\n=== IN-STOCK MAP VIOLATORS: ${v.length} (CSV: ${OUT}) ===`);
  console.log(`\nMAP vs MSRP (competitiveness):`);
  console.log(`  MAP > MSRP (above list — uncompetitive): ${aboveList}`);
  console.log(`  MAP 92-100% of MSRP (near list):         ${nearList}`);
  console.log(`  MAP < 92% of MSRP (real discount):       ${goodDiscount}`);
  console.log(`  no MSRP in feed (can't judge):           ${noMsrp}`);
  console.log(`\nPrice increase if listed at MAP:`);
  console.log(`  ≤10%: ${jb.s}  |  10-25%: ${jb.m}  |  25-50%: ${jb.l}  |  >50%: ${jb.xl}`);
  console.log(`\nBiggest jumps (top 12):`);
  v.slice(0,12).forEach(r=>console.log(`  ${r.sku.padEnd(14)} $${r.price.toFixed(2)} -> $${r.map.toFixed(2)} (+${r.jump.toFixed(0)}%, MSRP $${r.msrp.toFixed(2)})  ${(r.title||'').slice(0,34)}`));
})().catch(e=>{console.error(e);process.exit(1);});
