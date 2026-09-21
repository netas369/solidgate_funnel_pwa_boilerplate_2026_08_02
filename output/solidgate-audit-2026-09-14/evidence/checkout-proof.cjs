const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const ts = require('/Users/Netas/Projects/solidgate_funnel_pwa_boilerplate_2026_08_02/node_modules/typescript');
const root = '/Users/Netas/Projects/solidgate_funnel_pwa_boilerplate_2026_08_02';
function load(relative, modules) {
  const source = fs.readFileSync(`${root}/${relative}`, 'utf8');
  const output = ts.transpileModule(source, {compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true}}).outputText;
  const module = {exports:{}};
  vm.runInNewContext(output, {module, exports: module.exports, require(id) { if (!(id in modules)) throw Error(`Unexpected dependency: ${id}`); return modules[id]; }, console, Date, URL, Request, Response, Set, Map, process:{env:{VERCEL_ENV:'preview'}}, crypto:require('node:crypto').webcrypto, setTimeout,clearTimeout}, {filename: relative});
  return module.exports;
}
function chain(row, calls) {
  const value = {data:row,error:null};
  const obj = {
    select(...args){calls.push(['select',...args]);return obj},
    update(...args){calls.push(['update',...args]);return obj},
    eq(...args){calls.push(['eq',...args]);return obj},
    is(...args){calls.push(['is',...args]);return obj},
    maybeSingle:async()=>value,
    then(resolve,reject){return Promise.resolve(value).then(resolve,reject)}
  };return obj;
}
(async()=>{
  const authCalls=[];
  const victim={id:'11111111-1111-4111-8111-111111111111',email:'victim@example.test'};
  const admin={auth:{admin:{
    createUser:async params=>{authCalls.push(['createUser',params]); return {data:null,error:{code:'email_exists',status:422,message:'Email exists'}}},
    generateLink:async params=>{authCalls.push(['generateLink',params]);return {data:{properties:{hashed_token:'server-created-token-never-sent-to-inbox'},user:victim},error:null}}
  }},from: table=>chain(null,authCalls)};
  const {linkAuthUser}=load('apps/funnel/src/lib/payment/provision-account.ts',{
    '@repo/shared/supabase/admin':{getSupabaseAdminClient:()=>admin},
    '@repo/shared/supabase/server':{createClient:async()=>({auth:{verifyOtp:async params=>{authCalls.push(['verifyOtp',params]);return {error:null}}}})},
    '@repo/shared/entitlements':{},
    '@repo/shared/payment-environment':{currentPaymentEnvironment:()=> 'sandbox'},
    '@repo/i18n/routing':{routing:{locales:['en','lt']}}
  });
  const result=await linkAuthUser({email:victim.email,sessionId:'attacker-session',userId:null,orderMatch:{column:'solidgate_order_id',value:'attacker-paid-order'},supabaseAdmin:admin,logPrefix:'local-audit'});
  assert.equal(result.linked,true);
  assert.equal(result.userId,victim.id);
  assert.equal(authCalls.find(c=>c[0]==='verifyOtp')[1].token_hash,'server-created-token-never-sent-to-inbox');
  console.log(JSON.stringify({proof:'existing-account checkout email autologin',result,authCalls:authCalls.filter(c=>['createUser','generateLink','verifyOtp'].includes(c[0]))}));
  for(const fixture of [{status:'active',expires_at:'2025-01-01T00:00:00Z',revoked_at:null},{status:'past_due',expires_at:'2025-01-01T00:00:00Z',revoked_at:null}]) {
    const calls=[];
    const admin={rpc:async name=>{calls.push(['rpc',name]);return {data:[],error:null}},from:table=>chain(table==='user_prefs'?{locale:'lt'}:table==='entitlements'?{id:'expired-addon',...fixture}:null,calls)};
    const {POST}=load('apps/pwa/src/app/api/solidgate/purchase/route.ts',{
      'next/server':{NextResponse:{json:(body,init)=>Response.json(body,init)}},
      '@repo/shared/supabase/server':{createClient:async()=>({auth:{getUser:async()=>({data:{user:victim},error:null})}})},
      '@repo/shared/supabase/admin':{getSupabaseAdminClient:()=>admin},
      '@repo/shared/price-map':{resolveProductPrice:()=>({amountCents:1900}),LOCALE_CURRENCY_MAP:{lt:'eur'}},
      '@repo/shared/solidgate':{paymentEnvironmentForVercel:()=> 'sandbox'},
      '@repo/shared/solidgate/account-vault':{},
      '@repo/shared/solidgate/catalog':{PRODUCT_ID_TO_CODE:{oto2_addon_weekly:'BRANDADDON_000000_SUB'},SOLIDGATE_PRODUCT_CODES:{main:'BRAND_000000_SUB'}},
      '@repo/shared/locale-prefixes':{},
      '@repo/shared/solidgate/catalog-ids.json':{addon_direct:{product_id:'seeded-product',prices:{eur:'seeded-price'}}},
      '@repo/i18n/routing':{routing:{locales:['lt','en'],defaultLocale:'en'}},
      '@repo/shared/boilerplate-brand':{},
      '@/lib/analytics/acquisition':{},
      '@/lib/pwa-products':{PWA_SLUGS:new Set(['oto2_addon_weekly']),PWA_SUBSCRIPTION_CATALOG_KEY:'addon_direct',PWA_SUBSCRIPTION_PRODUCT:'oto2_addon_weekly'}
    });
    const response=await POST(new Request('https://app.example.test/api/solidgate/purchase',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({slug:'oto2_addon_weekly'})}));
    const body=await response.json();
    assert.equal(body.alreadyOwned,true);
    assert.equal(calls.some(c=>c[0]==='rpc'&&c[1]==='open_solidgate_pwa_purchase_v2'),false);
    console.log(JSON.stringify({proof:'inactive-addon recovery purchase suppressed',fixture,response:{status:response.status,body},filters:calls.filter(c=>['eq','is'].includes(c[0]))}));
  }
})();
