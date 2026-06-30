#!/usr/bin/env node
'use strict';
/**
 * Stock a B2B tier catalog with the full in-stock storefront set (one-time, per discount tier).
 *
 *   source .env && node scripts/publish-full-catalog.js <publicationId>
 *
 * <publicationId> is the catalog's publication GID (or numeric id). create-b2b-account.js prints
 * it when it creates a new tier catalog. Publishes every active + published + in-stock product
 * into that publication via a Shopify bulk mutation (scalable to hundreds of thousands).
 * The publication's autoPublish keeps new synced products flowing in afterwards.
 */
const store=process.env.SHOPIFY_STORE,cid=process.env.SHOPIFY_CLIENT_ID,secret=process.env.SHOPIFY_CLIENT_SECRET,ver=process.env.SHOPIFY_API_VERSION||'2026-01';
const raw=process.argv[2];
if(!raw){console.error('Usage: node scripts/publish-full-catalog.js <publicationId>');process.exit(1);}
const PUB=raw.startsWith('gid://')?raw:`gid://shopify/Publication/${raw}`;
const FILTER='status:active AND published_status:published AND inventory_total:>0';
const log=(...a)=>console.log(new Date().toISOString(),...a);

async function token(){return (await(await fetch(`https://${store}.myshopify.com/admin/oauth/access_token`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({client_id:cid,client_secret:secret,grant_type:'client_credentials'})})).json()).access_token;}
async function gql(T,q,v){return (await(await fetch(`https://${store}.myshopify.com/admin/api/${ver}/graphql.json`,{method:'POST',headers:{'X-Shopify-Access-Token':T,'Content-Type':'application/json'},body:JSON.stringify({query:q,variables:v})})).json());}
const sleep=ms=>new Promise(r=>setTimeout(r,ms));

(async()=>{
  let T=await token();
  // 1) export the in-stock product IDs via a bulk query
  log('Starting product-ID export...');
  await gql(T,`mutation($q:String!){bulkOperationRunQuery(query:$q){bulkOperation{id} userErrors{field message}}}`,{q:`{products(query:\"${FILTER}\"){edges{node{id}}}}`});
  let url;
  while(true){ await sleep(3000); T=await token();
    const o=(await gql(T,`{currentBulkOperation(type:QUERY){status objectCount url}}`)).data.currentBulkOperation;
    log(`export ${o.status} count=${o.objectCount}`);
    if(o.status==='COMPLETED'){url=o.url;break;}
    if(o.status==='FAILED'){log('export FAILED');process.exit(1);}
  }
  const txt=await (await fetch(url)).text();
  const ids=txt.split('\n').filter(Boolean).map(l=>{try{return JSON.parse(l).id;}catch(_){return null;}}).filter(Boolean);
  log(`Exported ${ids.length} product IDs.`);

  // 2) staged upload of the mutation-variables JSONL
  const jsonl=ids.map(id=>JSON.stringify({id,input:[{publicationId:PUB}]})).join('\n')+'\n';
  const su=await gql(T,`mutation{stagedUploadsCreate(input:[{resource:BULK_MUTATION_VARIABLES,filename:"pub.jsonl",mimeType:"text/jsonl",httpMethod:POST}]){stagedTargets{url parameters{name value}} userErrors{field message}}}`);
  const tgt=su.data?.stagedUploadsCreate?.stagedTargets?.[0];
  if(!tgt){log('stagedUploadsCreate failed',JSON.stringify(su));process.exit(1);}
  const key=tgt.parameters.find(p=>p.name==='key').value;
  const fd=new FormData();
  for(const p of tgt.parameters) fd.append(p.name,p.value);
  fd.append('file',new Blob([jsonl],{type:'text/jsonl'}),'pub.jsonl');
  const up=await fetch(tgt.url,{method:'POST',body:fd});
  if(up.status>=300){log('upload failed',await up.text());process.exit(1);}
  log('uploaded variables, status',up.status);

  // 3) run the bulk publish mutation
  const MUT='mutation call($id:ID!,$input:[PublicationInput!]!){publishablePublish(id:$id,input:$input){userErrors{message}}}';
  const run=await gql(T,`mutation($m:String!,$p:String!){bulkOperationRunMutation(mutation:$m,stagedUploadPath:$p){bulkOperation{id status} userErrors{field message}}}`,{m:MUT,p:key});
  if(run.data?.bulkOperationRunMutation?.userErrors?.length){log('runMutation errors',JSON.stringify(run.data.bulkOperationRunMutation.userErrors));process.exit(1);}
  log('bulk publish started:',JSON.stringify(run.data?.bulkOperationRunMutation?.bulkOperation));

  // 4) poll to completion
  while(true){ await sleep(10000); T=await token();
    const o=(await gql(T,`{currentBulkOperation(type:MUTATION){status objectCount errorCode}}`)).data.currentBulkOperation;
    log(`publish ${o.status} processed=${o.objectCount} err=${o.errorCode||'-'}`);
    if(o.status==='COMPLETED'){log(`✓ DONE — published ${o.objectCount} products into ${PUB}`);break;}
    if(o.status==='FAILED'||o.status==='CANCELED'){log('✗ publish',o.status,o.errorCode);process.exit(1);}
  }
})().catch(e=>{log('ERROR',e.message);process.exit(1);});
