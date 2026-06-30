'use strict';
/**
 * hide-zero-price — draft (hide) active products whose price is at/under a threshold.
 * These are SKUs where TD Synnex returned no cost, so price-sync set them to ~$0 —
 * unsellable, look broken on the storefront. Drafting is fully reversible.
 *
 *   source .env && node scripts/hide-zero-price.js            # dry run (count + sample)
 *   source .env && node scripts/hide-zero-price.js --apply    # draft them
 *   source .env && node scripts/hide-zero-price.js --apply --max 0.01   # custom threshold ($)
 */
const STORE=process.env.SHOPIFY_STORE,TOKEN=process.env.SHOPIFY_ACCESS_TOKEN,VER=process.env.SHOPIFY_API_VERSION||'2026-01';
const GQL=`https://${STORE}.myshopify.com/admin/api/${VER}/graphql.json`;
const APPLY=process.argv.includes('--apply');
const MAX=(()=>{const i=process.argv.indexOf('--max');return i>-1?process.argv[i+1]:'0.01';})();
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function gql(q,v){
  for(let a=0;a<6;a++){
    const r=await fetch(GQL,{method:'POST',headers:{'X-Shopify-Access-Token':TOKEN,'Content-Type':'application/json'},body:JSON.stringify({query:q,variables:v})});
    const j=await r.json();
    if(j.errors&&j.errors.some(e=>/throttl/i.test(e.message))){await sleep(2500);continue;}
    if(j.errors)throw new Error(JSON.stringify(j.errors).slice(0,300));
    return j.data;
  }
  throw new Error('throttled');
}
(async()=>{
  if(!STORE||!TOKEN)throw new Error('source .env first');
  const query=`status:active price:<=${MAX}`;
  console.log(`${APPLY?'APPLYING':'DRY-RUN'} — hiding active products with price <= $${MAX}\n`);
  const ids=[]; let cursor=null, sampled=0;
  do{
    const d=await gql(`query($c:String){products(first:200,after:$c,query:"${query}"){pageInfo{hasNextPage endCursor} nodes{id title variants(first:1){nodes{price}}}}}`,{c:cursor});
    for(const p of d.products.nodes){ ids.push(p.id); if(sampled<8){console.log(`  $${p.variants.nodes[0].price}  ${p.title.slice(0,60)}`);sampled++;} }
    cursor=d.products.pageInfo.hasNextPage?d.products.pageInfo.endCursor:null;
  }while(cursor);
  console.log(`\n${ids.length} active products at <= $${MAX}.`);
  if(!APPLY){console.log('Dry run — re-run with --apply to draft them.');return;}
  let done=0,err=0;
  for(const id of ids){
    const d=await gql(`mutation($id:ID!){productUpdate(input:{id:$id,status:DRAFT}){product{id} userErrors{message}}}`,{id});
    if(d.productUpdate.userErrors.length){err++;}else{done++;}
    if(done%50===0)process.stdout.write(`\r  drafted ${done}/${ids.length}...`);
    await sleep(120);
  }
  console.log(`\n✓ drafted ${done} | errors ${err}. (Reversible: set status back to Active to restore.)`);
})().catch(e=>{console.error('ERROR:',e.message);process.exit(1);});
