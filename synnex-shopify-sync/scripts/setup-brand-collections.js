'use strict';
/**
 * setup-brand-collections — create one smart collection per well-known brand
 * (rule: VENDOR contains <term>, capturing the messy vendor variants), publish
 * each to the Online Store, and report product counts. These are surfaced ONLY
 * on the /pages/brands page (not in the category nav). Upload each brand's logo
 * as that collection's image in Admin → Collections.
 *
 *   source .env && node scripts/setup-brand-collections.js          # create + publish + counts
 *   source .env && node scripts/setup-brand-collections.js --counts # just report counts
 */
const STORE=process.env.SHOPIFY_STORE,TOKEN=process.env.SHOPIFY_ACCESS_TOKEN,VER=process.env.SHOPIFY_API_VERSION||'2026-01';
const GQL=`https://${STORE}.myshopify.com/admin/api/${VER}/graphql.json`;
const REST=`https://${STORE}.myshopify.com/admin/api/${VER}`;
const H={'X-Shopify-Access-Token':TOKEN,'Content-Type':'application/json'};
const COUNTS_ONLY=process.argv.includes('--counts');

// title → vendor CONTAINS term (chosen to capture variants without over-matching)
const BRANDS=[
  ['HP','Hp Inc'],['Dell','Dell'],['Lenovo','Lenovo'],['Microsoft','Microsoft'],['Apple','Apple'],
  ['ASUS','ASUS'],['Acer','Acer'],['Samsung','Samsung'],['LG','LG Electron'],['Logitech','Logitech'],
  ['Cisco','Cisco'],['Intel','Intel Corp'],['NVIDIA','NVIDIA'],['Seagate','Seagate'],['Western Digital','Western Digital'],
  ['Kingston','Kingston'],['Epson','Epson'],['Brother','Brother'],['Canon','Canon'],['Netgear','Netgear'],
  ['TP-Link','TP-Link'],['Razer','Razer'],['Corsair','Corsair'],['Sony','Sony'],['Belkin','Belkin'],
  ['Targus','Targus'],['ViewSonic','ViewSonic'],['MSI','MSI'],['HPE','Hewlett Packard Enterprise'],['Eaton','Eaton'],
];
const handleOf=t=>'brand-'+t.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,'');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function gql(q,v){const r=await fetch(GQL,{method:'POST',headers:H,body:JSON.stringify({query:q,variables:v})});return r.json();}

async function ensure(title,term){
  const handle=handleOf(title);
  let c=(await gql(`query($h:String!){collectionByHandle(handle:$h){id productsCount{count}}}`,{h:handle})).data.collectionByHandle;
  if(!c && !COUNTS_ONLY){
    const d=await gql(`mutation($i:CollectionInput!){collectionCreate(input:$i){collection{id productsCount{count}} userErrors{message}}}`,
      {i:{title,handle,ruleSet:{appliedDisjunctively:false,rules:[{column:'VENDOR',relation:'CONTAINS',condition:term}]}}});
    const e=d.data.collectionCreate.userErrors;
    if(e&&e.length){console.log(`  ✗ ${title}: ${e.map(x=>x.message).join(';')}`);return null;}
    c=d.data.collectionCreate.collection;
  }
  if(!c) return {title,handle,count:'-'};
  // publish to Online Store (REST legacy flag; needs write_products)
  if(!COUNTS_ONLY){
    const found=await(await fetch(`${REST}/smart_collections.json?handle=${handle}`,{headers:H})).json();
    const sc=found.smart_collections&&found.smart_collections[0];
    if(sc&&!sc.published_at){await fetch(`${REST}/smart_collections/${sc.id}.json`,{method:'PUT',headers:H,body:JSON.stringify({smart_collection:{id:sc.id,published:true}})});}
  }
  // re-read count (smart collection counts settle async)
  const cnt=(await gql(`query($h:String!){collectionByHandle(handle:$h){productsCount{count}}}`,{h:handle})).data.collectionByHandle.productsCount.count;
  return {title,handle,count:cnt};
}

(async()=>{
  if(!STORE||!TOKEN)throw new Error('source .env first');
  const rows=[];
  for(const [title,term] of BRANDS){ rows.push(await ensure(title,term)); await sleep(250); }
  rows.sort((a,b)=>(b.count||0)-(a.count||0));
  console.log('\n=== brand collections (by product count) ===');
  rows.forEach(r=>console.log(`  ${String(r.count).padStart(6)}  ${r.title.padEnd(18)} /collections/${r.handle}`));
  const populated=rows.filter(r=>typeof r.count==='number'&&r.count>0);
  console.log(`\npopulated (>0): ${populated.length} → handles for the Brands page:`);
  console.log('  '+populated.map(r=>r.handle).join(','));
})().catch(e=>{console.error('ERROR:',e.message);process.exit(1);});
