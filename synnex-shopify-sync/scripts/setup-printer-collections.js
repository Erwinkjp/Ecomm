#!/usr/bin/env node
'use strict';
/**
 * Build the storefront "Printers & Print Supplies" subcategory collections to mirror
 * TD SYNNEX's mega-menu. Updates undercounting type-based collections to broader
 * title-based + in-stock rules, and creates the missing subcats (cables/thermal/label),
 * publishing new ones to the Online Store.
 *   source .env && node scripts/setup-printer-collections.js            # DRY RUN
 *   source .env && node scripts/setup-printer-collections.js --execute  # apply
 */
const EXECUTE=process.argv.includes('--execute');
const store=process.env.SHOPIFY_STORE,cid=process.env.SHOPIFY_CLIENT_ID,secret=process.env.SHOPIFY_CLIENT_SECRET,ver=process.env.SHOPIFY_API_VERSION||'2026-01';
const ONLINE_STORE_PUB='gid://shopify/Publication/43075764359';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function token(){return (await(await fetch(`https://${store}.myshopify.com/admin/oauth/access_token`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({client_id:cid,client_secret:secret,grant_type:'client_credentials'})})).json()).access_token;}
async function gql(T,q,v){return (await(await fetch(`https://${store}.myshopify.com/admin/api/${ver}/graphql.json`,{method:'POST',headers:{'X-Shopify-Access-Token':T,'Content-Type':'application/json'},body:JSON.stringify({query:q,variables:v})})).json());}
const inv={column:'VARIANT_INVENTORY',relation:'GREATER_THAN',condition:'0'};
const title=s=>({column:'TITLE',relation:'CONTAINS',condition:s});

// Existing collections to broaden (id -> new title-rule). All ALL+in-stock.
const UPDATES=[
  {id:'gid://shopify/Collection/488125399264', handle:'laser-printers',         rule:title('Laser Printer')},
  {id:'gid://shopify/Collection/488125432032', handle:'inkjet-printers',        rule:title('Inkjet Printer')},
  {id:'gid://shopify/Collection/488125464800', handle:'multifunction-printers', rule:title('Multifunction')},
];
// New collections to create + publish.
const CREATES=[
  {title:'Printer Cables',  handle:'printer-cables',   rule:title('Printer Cable')},
  {title:'Thermal Printers',handle:'thermal-printers', rule:title('Thermal Printer')},
  {title:'Label Printers',  handle:'label-printers',   rule:title('Label Printer')},
];

(async()=>{
  console.log(EXECUTE?'*** EXECUTE ***':'— DRY RUN —');
  let T=await token();
  // UPDATES
  for(const u of UPDATES){
    console.log(`\nUPDATE ${u.handle}: rules -> [TITLE CONTAINS '${u.rule.condition}', inv>0]`);
    if(!EXECUTE)continue;
    const r=await gql(T,`mutation($id:ID!,$rs:CollectionRuleSetInput!){collectionUpdate(input:{id:$id,ruleSet:$rs}){collection{handle productsCount{count}} userErrors{field message}}}`,
      {id:u.id, rs:{appliedDisjunctively:false, rules:[u.rule, inv]}});
    const e=r.data?.collectionUpdate?.userErrors;
    if(e&&e.length)console.log('  ✗',JSON.stringify(e)); else console.log(`  ✓ now count=${r.data.collectionUpdate.collection.productsCount.count}`);
    await sleep(800);
  }
  // CREATES
  for(const c of CREATES){
    console.log(`\nCREATE ${c.handle} ("${c.title}"): rules [TITLE CONTAINS '${c.rule.condition}', inv>0] + publish Online Store`);
    if(!EXECUTE)continue;
    const r=await gql(T,`mutation($in:CollectionInput!){collectionCreate(input:$in){collection{id handle productsCount{count}} userErrors{field message}}}`,
      {in:{title:c.title, handle:c.handle, ruleSet:{appliedDisjunctively:false, rules:[c.rule, inv]}}});
    const e=r.data?.collectionCreate?.userErrors;
    if(e&&e.length){console.log('  ✗',JSON.stringify(e));continue;}
    const col=r.data.collectionCreate.collection;
    console.log(`  ✓ created ${col.id} count=${col.productsCount.count}`);
    const p=await gql(T,`mutation($id:ID!,$pid:ID!){publishablePublish(id:$id,input:{publicationId:$pid}){userErrors{field message}}}`,{id:col.id,pid:ONLINE_STORE_PUB});
    const pe=p.data?.publishablePublish?.userErrors;
    console.log(pe&&pe.length?'  ✗ publish: '+JSON.stringify(pe):'  ✓ published to Online Store');
    await sleep(800);
  }
  console.log(EXECUTE?'\nDone.':'\nDry run only. Re-run with --execute.');
})().catch(e=>{console.error(e);process.exit(1);});
