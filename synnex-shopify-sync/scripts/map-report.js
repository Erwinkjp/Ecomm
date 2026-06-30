#!/usr/bin/env node
'use strict';
// Report on the MAP-repriced products: SKU, title, old price (reconstructed = cost×1.15),
// new price (MAP), and the increase. Writes a CSV and prints a table.
const fs = require('fs');
const store=process.env.SHOPIFY_STORE,cid=process.env.SHOPIFY_CLIENT_ID,secret=process.env.SHOPIFY_CLIENT_SECRET,ver=process.env.SHOPIFY_API_VERSION||'2026-01';
const cust=process.env.SYNNEX_XML_CUSTOMER_NO,user=process.env.SYNNEX_XML_USERNAME,pass=process.env.SYNNEX_XML_PASSWORD;
const MARKUP=parseFloat(process.env.PRICE_MARKUP_PERCENT||'15');
const MAPFILE='/private/tmp/claude-502/-Users-erwin-prado-Documents-All-Code-Repos-personal-workspace-Ecomm-synnex-shopify-sync/f9bfbb3b-7364-41b5-9f45-d91c954dc55c/scratchpad/map_pns.tsv';
const OUT='/private/tmp/claude-502/-Users-erwin-prado-Documents-All-Code-Repos-personal-workspace-Ecomm-synnex-shopify-sync/f9bfbb3b-7364-41b5-9f45-d91c954dc55c/scratchpad/map_report.csv';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const esc=s=>String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
async function token(){return (await(await fetch(`https://${store}.myshopify.com/admin/oauth/access_token`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({client_id:cid,client_secret:secret,grant_type:'client_credentials'})})).json()).access_token;}
async function gql(T,q,v){return (await(await fetch(`https://${store}.myshopify.com/admin/api/${ver}/graphql.json`,{method:'POST',headers:{'X-Shopify-Access-Token':T,'Content-Type':'application/json'},body:JSON.stringify({query:q,variables:v})})).json());}

// TD Synnex P&A raw call, keyed by mfgPN → { cost, packQty }
async function costByMfgPN(pns){
  const out=new Map();
  for(let i=0;i<pns.length;i+=40){
    const batch=pns.slice(i,i+40);
    const sku=batch.map((p,j)=>`<skuList><mfgPN>${esc(p)}</mfgPN><lineNumber>${j+1}</lineNumber></skuList>`).join('');
    const xml=`<?xml version="1.0" encoding="UTF-8"?><priceRequest><customerNo>${esc(cust)}</customerNo><userName>${esc(user)}</userName><password>${esc(pass)}</password>${sku}<jsonVersion>false</jsonVersion></priceRequest>`;
    const t=await(await fetch('https://ec.us.tdsynnex.com/SynnexXML/PriceAvailability',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:'xmldata='+encodeURIComponent(xml)})).text();
    for(const blk of t.match(/<PriceAvailabilityList>[\s\S]*?<\/PriceAvailabilityList>/g)||[]){
      const pn=(blk.match(/<mfgPN>([^<]*)<\/mfgPN>/)||[])[1];
      const price=parseFloat((blk.match(/<price>([^<]*)<\/price>/)||[])[1]||'0');
      if(pn) out.set(pn.trim(),{cost:price});
    }
  }
  return out;
}

(async()=>{
  const mapByPN=new Map();
  for(const l of fs.readFileSync(MAPFILE,'utf8').split('\n')){if(!l)continue;const [pn,m]=l.split('\t');mapByPN.set(pn.trim(),parseFloat(m));}

  // export listed variants + titles
  let T=await token();
  const q=`{products(query:\"status:active AND published_status:published AND inventory_total:>0\"){edges{node{id title variants{edges{node{sku price}}}}}}}`;
  await gql(T,`mutation($q:String!){bulkOperationRunQuery(query:$q){bulkOperation{id} userErrors{message}}}`,{q});
  let url; while(true){await sleep(4000);T=await token();const o=(await gql(T,`{currentBulkOperation(type:QUERY){status url}}`)).data.currentBulkOperation;if(o.status==='COMPLETED'){url=o.url;break;}if(o.status==='FAILED'){console.log('FAILED');process.exit(1);}}
  const txt=await(await fetch(url)).text();
  const titleById=new Map(); const rows=[];
  for(const line of txt.split('\n')){if(!line)continue;let o;try{o=JSON.parse(line);}catch(e){continue;}
    if(o.title!==undefined && o.sku===undefined) titleById.set(o.id,o.title);
    if(o.sku!==undefined){const sku=(o.sku||'').trim(); if(mapByPN.has(sku)) rows.push({sku,mapv:mapByPN.get(sku),cur:parseFloat(o.price),title:titleById.get(o.__parentId)||''});}
  }
  // reconstruct old price = cost×markup
  const costs=await costByMfgPN(rows.map(r=>r.sku));
  const report=[];
  for(const r of rows){
    const c=costs.get(r.sku);
    const old=c?Math.round(c.cost*(1+MARKUP/100)*100)/100:null;
    if(old!=null && old < r.mapv){
      report.push({sku:r.sku,title:r.title,old,mapv:r.mapv,inc:r.mapv-old,pct:((r.mapv-old)/old*100)});
    }
  }
  report.sort((a,b)=>b.pct-a.pct);
  // CSV
  const csv=['SKU,Title,Old Price (cost+15%),New Price (MAP),Increase $,Increase %'];
  for(const r of report) csv.push(`${r.sku},"${(r.title||'').replace(/"/g,"'")}",${r.old.toFixed(2)},${r.mapv.toFixed(2)},${r.inc.toFixed(2)},${r.pct.toFixed(1)}%`);
  fs.writeFileSync(OUT,csv.join('\n'));
  // print
  console.log(`\nMAP repricing report — ${report.length} products (CSV: ${OUT})\n`);
  console.log('SKU'.padEnd(16)+'OLD'.padStart(10)+'MAP'.padStart(10)+'  +$'.padStart(8)+'  +%'.padStart(7)+'  TITLE');
  for(const r of report) console.log(r.sku.padEnd(16)+('$'+r.old.toFixed(2)).padStart(10)+('$'+r.mapv.toFixed(2)).padStart(10)+('+'+r.inc.toFixed(2)).padStart(8)+(r.pct.toFixed(0)+'%').padStart(7)+'  '+(r.title||'').slice(0,42));
})().catch(e=>{console.error(e);process.exit(1);});
