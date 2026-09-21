const fs = require('node:fs');
const root = '/Users/Netas/Projects/solidgate_funnel_pwa_boilerplate_2026_08_02';
const ts = require(root + '/node_modules/typescript');
const assert = require('node:assert/strict');
const source = fs.readFileSync(root + '/apps/funnel/src/app/admin/_queries/revenue.ts', 'utf8')
  .replace(/^import .*;\n/gm, '');
const emitted = ts.transpileModule(source, {compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022}}).outputText;
let tables = {};
let calls = [];
function getSupabaseAdminClient() {
  return {from(table) {
    calls.push(table);
    let rows = [...(tables[table] || [])];
    const q = {
      select() {return q;},
      eq(k,v) {rows=rows.filter(r=>r[k]===v);return q;},
      in(k,v) {rows=rows.filter(r=>v.includes(r[k]));return q;},
      gt(k,v) {rows=rows.filter(r=>r[k]>v);return q;},
      gte(k,v) {rows=rows.filter(r=>r[k]>=v);return q;},
      lt(k,v) {rows=rows.filter(r=>r[k]<v);return q;},
      then(resolve,reject) {return Promise.resolve({data:rows.slice(0,1000),error:null}).then(resolve,reject);},
    }; return q;
  }};
}
const exported = {};
new Function('getSupabaseAdminClient','convertToEur','exports','module',emitted)(getSupabaseAdminClient, amount=>amount, exported, {exports:exported});
const range = {from:'2026-09-01T00:00:00Z', to:'2026-10-01T00:00:00Z'};
const base = {payment_environment:'production',currency:'eur',created_at:'2026-09-02T00:00:00Z',status:'active'};
(async()=>{
const findings=[];
tables={orders:Array.from({length:1100},()=>({...base,amount_cents:100}))};
const capped=await exported.grossRevenueInEurInRange(range);
assert.equal(capped,100000);
findings.push({case:'1100 paid orders at100 cents each, configured API max_rows1000',actual:capped,expected:110000});
tables={orders:[],renewal_events:[{...base,amount_cents:5900}]}; calls=[];
const kpi=await exported.grossRevenueInEurInRange(range);
const kpiTables=[...calls];
const renew=await exported.renewalRevenueInEur(range);
assert.equal(kpi,0); assert.equal(renew,5900);
findings.push({case:'renewal-only period',kpiAmount:kpi,renewalAmount:renew,kpiTables});
tables={orders:[],renewal_events:[{...base,amount_cents:5900,event_created_at:'2026-09-10T00:00:00Z',invoice_created_at:base.created_at}]};
const dated=await exported.revenueTimeSeriesInEur(range);
assert.deepEqual(dated,[{date:'2026-09-02',value:5900}]);
findings.push({case:'invoice created Sep2, succeeded Sep10',actual:dated,expectedPaidDate:'2026-09-10'});
tables={orders:[{...base,amount_cents:5900}],renewal_events:[]};
const before=await exported.revenueTimeSeriesInEur(range);
tables.orders[0]={...tables.orders[0],amount_cents:4700,solidgate_refunded_amount_cents:1200,updated_at:'2026-09-14T00:00:00Z'};
const after=await exported.revenueTimeSeriesInEur(range);
assert.equal(before[0].value,5900); assert.equal(after[0].value,4700);
findings.push({case:'Sep14 refund1200 rewrites Sep2 balance',before,after,expectedMovementDate:'2026-09-14'});
tables={orders:[{...base,status:'disputed',amount_cents:1267}],renewal_events:[{...base,status:'disputed',amount_cents:1267}]};
const initialDisputed=await exported.grossRevenueInEurInRange(range);
const renewalDisputed=await exported.renewalRevenueInEur(range);
assert.equal(initialDisputed,0);assert.equal(renewalDisputed,1267);
findings.push({case:'equivalent partial chargeback leaves1267',initialCounted:initialDisputed,renewalCounted:renewalDisputed});
console.log(JSON.stringify(findings,null,2));
})().catch(e=>{console.error(e);process.exitCode=1});
