#!/usr/bin/env node
'use strict';
/**
 * Create / manage a B2B business account (Shopify Company + contact).
 *
 *   source .env && node scripts/create-b2b-account.js \
 *     --email buyer@acme.com --name "Jane Doe" --company "Acme Inc" \
 *     [--location "HQ"] [--city Austin] [--state TX] [--zip 78701]
 *
 *   # add a contact to an EXISTING company instead of creating one:
 *   source .env && node scripts/create-b2b-account.js \
 *     --email buyer2@acme.com --name "Sam Lee" --company-id 27472953568
 *
 * What it does: creates the company (+ location) if needed, adds the contact,
 * and assigns the Location-admin (ordering) role — i.e. a real B2B "business
 * account". Prints the account sign-in URL to share. Auth: client_credentials.
 */
const store = process.env.SHOPIFY_STORE, id = process.env.SHOPIFY_CLIENT_ID,
      secret = process.env.SHOPIFY_CLIENT_SECRET, ver = process.env.SHOPIFY_API_VERSION || '2026-01';
const ACCOUNT_URL = `https://${(process.env.STOREFRONT_DOMAIN || 'uniwidemerchandise.com')}/account`;

function parseArgs() {
  const a = {};
  const v = process.argv.slice(2);
  for (let i = 0; i < v.length; i++) if (v[i].startsWith('--')) { a[v[i].slice(2)] = v[i + 1]; i++; }
  return a;
}

let TOKEN;
async function gql(query, variables) {
  const r = await fetch(`https://${store}.myshopify.com/admin/api/${ver}/graphql.json`, {
    method: 'POST', headers: { 'X-Shopify-Access-Token': TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  return r.json();
}
const errs = (o) => o?.userErrors?.length ? JSON.stringify(o.userErrors) : null;

// Add a contact to a company. If the email already exists as a customer, assign
// that existing customer instead of failing (Shopify can't re-create the email).
async function addContact(companyGid, email, firstName, lastName) {
  const cc = await gql(`mutation($id:ID!,$c:CompanyContactInput!){companyContactCreate(companyId:$id,input:$c){companyContact{id} userErrors{field message}}}`,
    { id: companyGid, c: { email, firstName, lastName } });
  const e = errs(cc.data?.companyContactCreate);
  if (!e) return cc.data.companyContactCreate.companyContact.id;
  if (!/already been taken/i.test(e)) { console.error('contact:', e); process.exit(1); }
  // Existing customer → look it up and assign as a company contact.
  const cust = await gql(`query($q:String!){customers(first:1,query:$q){edges{node{id}}}}`, { q: `email:${email}` });
  const custId = cust.data?.customers?.edges?.[0]?.node?.id;
  if (!custId) { console.error(`contact: email ${email} is taken but no matching customer found`); process.exit(1); }
  const asg = await gql(`mutation($c:ID!,$cu:ID!){companyAssignCustomerAsContact(companyId:$c,customerId:$cu){companyContact{id} userErrors{field message}}}`,
    { c: companyGid, cu: custId });
  const ae = errs(asg.data?.companyAssignCustomerAsContact);
  if (ae) { console.error('assign:', ae); process.exit(1); }
  console.log(`  (existing customer ${email} assigned as contact)`);
  return asg.data.companyAssignCustomerAsContact.companyContact.id;
}

// Give the company a B2B catalog + price list with a percentage discount, scoped to its
// location — so contextual (B2B) pricing shows savings. Default 5%, override with --discount.
// Best-effort: a failure here warns but never fails account creation. Skip with --discount 0.
// Shared-tier model: instead of a per-company catalog (which would need ~68K products
// re-published every time), we keep ONE shared catalog per discount % — "B2B — All Products (N%)"
// — already stocked with the full in-stock catalog. New companies just get their location
// ASSIGNED to the matching tier catalog (instant). A brand-new tier % must be stocked once via
// scripts/publish-full-catalog.js. Company Standards stays a metafield page (set-company-standards.js).
async function ensureTierCatalog(companyGid, locId, companyName, pct) {
  if (!(pct > 0)) { console.log('… no B2B discount applied (--discount 0)'); return; }
  if (!locId) { console.log('⚠ no company location — B2B discount not applied'); return; }
  const title = `B2B — All Products (${pct}%)`;
  // find an existing tier catalog with this title
  const all = await gql(`{catalogs(first:50,type:COMPANY_LOCATION){edges{node{id title}}}}`);
  const found = (all.data?.catalogs?.edges || []).map(e => e.node).find(n => n.title === title);
  if (found) {
    const upd = await gql(`mutation($id:ID!,$add:CatalogContextInput){catalogContextUpdate(catalogId:$id,contextsToAdd:$add){catalog{id} userErrors{field message}}}`,
      { id: found.id, add: { companyLocationIds: [locId] } });
    if (errs(upd.data?.catalogContextUpdate)) { console.log(`⚠ assign to tier: ${errs(upd.data.catalogContextUpdate)}`); return; }
    console.log(`✓ assigned "${companyName}" to shared tier catalog "${title}" (full store @ ${pct}% off)`);
    return;
  }
  // No tier catalog yet for this % — create it (empty), then it must be stocked once.
  const cc = await gql(`mutation($in:CatalogCreateInput!){catalogCreate(input:$in){catalog{id} userErrors{field message}}}`,
    { in: { title, status: 'ACTIVE', context: { companyLocationIds: [locId] } } });
  if (errs(cc.data?.catalogCreate)) { console.log(`⚠ catalog: ${errs(cc.data.catalogCreate)} — discount not applied`); return; }
  const catalogId = cc.data.catalogCreate.catalog.id;
  const pub = await gql(`mutation($in:PublicationCreateInput!){publicationCreate(input:$in){publication{id} userErrors{field message}}}`,
    { in: { catalogId, autoPublish: true } });
  const pubId = pub.data?.publicationCreate?.publication?.id;
  await gql(`mutation($in:PriceListCreateInput!){priceListCreate(input:$in){priceList{id} userErrors{field message}}}`,
    { in: { name: `B2B All-Products ${pct}%`, currency: 'USD', catalogId, parent: { adjustment: { type: 'PERCENTAGE_DECREASE', value: pct } } } });
  console.log(`✓ created NEW tier catalog "${title}" @ ${pct}% and assigned "${companyName}".`);
  console.log(`  ⚠ It's EMPTY — stock it once with:  node scripts/publish-full-catalog.js ${pubId}`);
}

// Fire the Klaviyo "B2B Account Created" event that triggers the onboarding-email
// flow. Best-effort: a Klaviyo failure never fails account creation. Skip with --no-email.
async function fireOnboardingEmail({ email, firstName, lastName, companyName, accountUrl }) {
  if (process.argv.includes('--no-email')) { console.log('… onboarding email skipped (--no-email)'); return; }
  const key = process.env.KLAVIYO_PRIVATE_KEY;
  if (!key || !key.startsWith('pk_')) { console.log('⚠ KLAVIYO_PRIVATE_KEY not set in env — onboarding email NOT triggered.'); return; }
  try {
    const r = await fetch('https://a.klaviyo.com/api/events/', {
      method: 'POST',
      headers: { Authorization: `Klaviyo-API-Key ${key}`, revision: '2024-10-15', 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ data: { type: 'event', attributes: {
        metric: { data: { type: 'metric', attributes: { name: 'B2B Account Created' } } },
        properties: { company: companyName, sign_in_url: accountUrl },
        profile: { data: { type: 'profile', attributes: { email, first_name: firstName, last_name: lastName } } },
      } } }),
    });
    if (r.ok) console.log(`✓ onboarding email triggered (Klaviyo "B2B Account Created" event → ${email})`);
    else console.log(`⚠ Klaviyo event failed (${r.status}); account is fine but onboarding email NOT sent: ${(await r.text()).slice(0, 200)}`);
  } catch (e) { console.log(`⚠ Klaviyo event error; onboarding email NOT sent: ${e.message}`); }
}

(async () => {
  const a = parseArgs();
  if (!a.email || !a.name) { console.error('Required: --email and --name. (See header for usage.)'); process.exit(1); }
  const [firstName, ...rest] = a.name.split(' ');
  const lastName = rest.join(' ') || '-';

  TOKEN = (await (await fetch(`https://${store}.myshopify.com/admin/oauth/access_token`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: id, client_secret: secret, grant_type: 'client_credentials' }),
  })).json()).access_token;

  let companyGid, companyName;

  if (a['company-id']) {
    companyGid = a['company-id'].startsWith('gid://') ? a['company-id'] : `gid://shopify/Company/${a['company-id']}`;
    const c = await gql(`query($id:ID!){company(id:$id){name}}`, { id: companyGid });
    companyName = c.data?.company?.name;
    if (!companyName) { console.error('Company not found:', companyGid); process.exit(1); }
    var contactId = await addContact(companyGid, a.email, firstName, lastName);
    console.log(`✓ added contact ${a.email} to ${companyName}`);
  } else {
    if (!a.company) { console.error('Required for new account: --company "Name" (or use --company-id).'); process.exit(1); }
    const cr = await gql(`mutation($i:CompanyCreateInput!){companyCreate(input:$i){company{id name mainContact{id}} userErrors{field message}}}`,
      { i: { company: { name: a.company }, companyContact: { email: a.email, firstName, lastName } } });
    if (errs(cr.data?.companyCreate)) { console.error('company:', errs(cr.data.companyCreate)); process.exit(1); }
    companyGid = cr.data.companyCreate.company.id; companyName = cr.data.companyCreate.company.name;
    var contactId = cr.data.companyCreate.company.mainContact?.id;
    console.log(`✓ created company "${companyName}"`);
  }

  // Ensure a location WITH a shipping address exists (B2B checkout ships to the location's
  // address; without one, checkout fails with "You can't purchase for this location").
  // companyCreate auto-creates an *empty* default location, so we must also backfill its address.
  const addr = { address1: a.address || '123 Main St', city: a.city || 'Austin', zoneCode: a.state || 'TX',
                 countryCode: a.country || 'US', zip: a.zip || '78701', recipient: a.name, phone: a.phone || '5125550100' };
  let locId;
  const locs = await gql(`query($id:ID!){company(id:$id){locations(first:1){edges{node{id shippingAddress{address1}}}}}}`, { id: companyGid });
  const existing = locs.data?.company?.locations?.edges?.[0]?.node;
  locId = existing?.id;
  if (!locId) {
    const lc = await gql(`mutation($id:ID!,$in:CompanyLocationInput!){companyLocationCreate(companyId:$id,input:$in){companyLocation{id} userErrors{field message}}}`,
      { id: companyGid, in: { name: a.location || 'Headquarters', shippingAddress: addr, billingSameAsShipping: true } });
    if (errs(lc.data?.companyLocationCreate)) { console.error('location:', errs(lc.data.companyLocationCreate)); process.exit(1); }
    locId = lc.data.companyLocationCreate.companyLocation.id;
    console.log(`✓ created location "${a.location || 'Headquarters'}"`);
  } else if (!existing.shippingAddress) {
    const aa = await gql(`mutation($loc:ID!,$a:CompanyAddressInput!,$t:[CompanyAddressType!]!){companyLocationAssignAddress(locationId:$loc,address:$a,addressTypes:$t){userErrors{field message}}}`,
      { loc: locId, a: addr, t: ['SHIPPING', 'BILLING'] });
    if (errs(aa.data?.companyLocationAssignAddress)) { console.error('address:', errs(aa.data.companyLocationAssignAddress)); process.exit(1); }
    console.log(`✓ set shipping/billing address on location`);
  }

  // Assign the Location-admin (ordering) role to the contact
  const roles = (await gql(`query($id:ID!){company(id:$id){contactRoles(first:10){nodes{id name}}}}`, { id: companyGid })).data.company.contactRoles.nodes;
  const role = roles.find(r => /admin/i.test(r.name)) || roles[0];
  if (contactId && locId && role) {
    const ar = await gql(`mutation($loc:ID!,$a:[CompanyLocationRoleAssign!]!){companyLocationAssignRoles(companyLocationId:$loc,rolesToAssign:$a){userErrors{field message}}}`,
      { loc: locId, a: [{ companyContactId: contactId, companyContactRoleId: role.id }] });
    console.log(errs(ar.data?.companyLocationAssignRoles) ? `⚠ role: ${errs(ar.data.companyLocationAssignRoles)}` : `✓ assigned role: ${role.name}`);
  }

  const discountPct = a.discount != null ? parseFloat(a.discount) : 5;
  await ensureTierCatalog(companyGid, locId, companyName, discountPct);

  await fireOnboardingEmail({ email: a.email, firstName, lastName, companyName, accountUrl: ACCOUNT_URL });

  console.log(`\nCompany ID: ${companyGid.split('/').pop()}`);
  console.log(`Sign-in link to share: ${ACCOUNT_URL}  (they enter ${a.email} → 6-digit code)`);
  console.log(`Next: set their Company Standards →  node scripts/set-company-standards.js ${companyGid.split('/').pop()} <sku> <sku> ...`);
})().catch(e => { console.error(e); process.exit(1); });
