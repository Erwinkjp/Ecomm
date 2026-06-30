'use strict';
// Read-only: how many MAP violators are IN-STOCK (searchable) vs all published.
const fs=require('fs');
const store=process.env.SHOPIFY_STORE,cid=process.env.SHOPIFY_CLIENT_ID,secret=process.env.SHOPIFY_CLIENT_SECRET,ver=process.env.SHOPIFY_API_VERSION||'2026-01';
const MAPFILE='/private/tmp/claude-502/-Users-erwin-prado-Documents-All-Code-Repos-personal-workspace-Ecomm-synnex-shopify-sync/f9bfbb3b-7364-41b5-9f45-d91c954dc55c/scratchpad/map_both.tsv';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function token(){return (await(await fetch(`https://${store}.myshopify.com/admin/oauth/access_token`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({client_id:cid,client_secret:secret,grant_type:'client_credentials'})})).json()).access_token;}
async function gql(T,q,v){return (await(await fetch(`https://${store}.myshopify.com/admin/api/${ver}/graphql.json`,{method:'POST',headers:{'X-Shopify-Access-Token':T,'Content-Type':'application/json'},body:JSON.stringify({query:q,variables:v})})).json());}
(async()=>{
  const map=new Map();
  for(const l of fs.readFileSync(MAPFILE,'utf8').split('\n')){if(!l)continue;const [pn,m]=l.split('\t');map.set(pn.trim(),parseFloat(m));}
  let T=await token();
  const q='{products(query:"status:active AND published_status:published AND inventory_total:>0"){edges{node{id variants{edges{node{sku price}}}}}}}';
  await gql(T,`mutation($q:String!){bulkOperationRunQuery(query:$q){bulkOperation{id} userErrors{message}}}`,{q});
  let url;while(true){await sleep(4000);T=await token();const o=(await gql(T,`{currentBulkOperation(type:QUERY){status objectCount url}}`)).data.currentBulkOperation;process.stdout.write(`\rexport ${o.status} ${o.objectCount}    `);if(o.status==='COMPLETED'){url=o.url;break;}if(o.status==='FAILED'){console.log('FAILED');return;}}
  console.log('');
  const txt=await(await fetch(url)).text();
  let total=0,mapc=0,below=0,anom=0;
  for(const line of txt.split('\n')){if(!line)continue;let o;try{o=JSON.parse(line);}catch(e){continue;}if(o.sku===undefined)continue;total++;const sku=(o.sku||'').trim();if(!map.has(sku))continue;mapc++;const mv=map.get(sku),p=parseFloat(o.price);if(p<mv){if(mv>p*10)anom++;else below++;}}
  console.log(`\nIN-STOCK / searchable variants: ${total}`);
  console.log(`  MAP-protected (in-stock): ${mapc}`);
  console.log(`  below MAP (in-stock violators): ${below}  | sanity-skipped: ${anom}`);
})().catch(e=>{console.error(e);process.exit(1);});
