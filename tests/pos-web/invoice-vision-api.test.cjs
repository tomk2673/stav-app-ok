'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');
const path=require('node:path');
const accounting=require('../../pub_guru/invoice-accounting');
const source=fs.readFileSync(path.join(__dirname,'../../api/invoice-vision.js'),'utf8');
const scope={organization_id:'20000000-0000-4000-8000-000000000001',venue_id:'30000000-0000-4000-8000-000000000001'};
const actor='10000000-0000-4000-8000-000000000001';
const invoice=()=>({supplier:'Dodavatel',invoice_number:'00042',issue_date:'2026-10-13',currency:'CZK',total_net:100,total_vat:21,total_gross:121,warnings:[],
  lines:[{raw_name:'Vodka',quantity:1,unit:'ks',unit_price_net:100,unit_price_gross:121,vat_rate:21,line_total_net:100,line_total_gross:121,confidence:1}]});
function harness({configured=true,authenticated=true,authFails=false,authorized=true,ownVenue=true,status='completed',value=invoice(),providerError=null}={}){
  const requests=[],options=[],logs=[];
  class FakeOpenAI{
    constructor(opts){options.push(opts);this.responses={create:async request=>{
      requests.push(request);if(providerError)throw providerError;
      return {status,model:'configured-model',output_text:JSON.stringify(value)};
    }};}
  }
  const context={module:{exports:{}},require(name){if(name==='openai')return FakeOpenAI;if(name==='../pub_guru/invoice-accounting')return accounting;throw new Error('Unexpected dependency');},
    process:{env:configured?{OPENAI_API_KEY:'unit-test-placeholder',OPENAI_INVOICE_MODEL:'configured-model'}:{}},
    fetch:async url=>{if(authFails)throw new Error('network');
      if(url.includes('/auth/v1/user'))return {ok:authenticated,json:async()=>({id:actor})};
      assert.ok(url.includes(scope.organization_id));
      if(url.includes('/memberships?')){assert.ok(url.includes(actor));return {ok:true,json:async()=>authorized?[{role:'staff'}]:[]};}
      assert.ok(url.includes(scope.venue_id));return {ok:true,json:async()=>ownVenue?[{id:scope.venue_id}]:[]};
    },AbortSignal,console:{error(...args){logs.push(args);}}};
  vm.runInNewContext(source,context);
  return {requests,options,logs,async run(body={mime_type:'application/pdf',file_name:'invoice.pdf',file_data:'data:application/pdf;base64,dGVzdA=='},headers={authorization:'Bearer test-session'},method='POST'){
    const result={headers:{}};const res={setHeader(k,v){result.headers[k]=v;},status(code){result.status=code;return this;},json(data){result.body=data;return this;},end(){return this;}};
    await context.module.exports({method,headers,body:{...scope,...body},query:scope},res);return result;
  }};
}
test('authenticated PDF uses the existing configured key/model and strict accounting schema',async()=>{
  const h=harness(),r=await h.run();assert.equal(r.status,200);assert.deepEqual(r.body.invoice.warnings,[]);
  const request=h.requests[0];assert.equal(request.model,'configured-model');assert.equal(request.store,false);
  assert.equal(request.text.format.strict,true);assert.equal(request.input[0].content[1].type,'input_file');
  assert.ok(request.text.format.schema.required.includes('amount_due'));assert.ok(request.text.format.schema.required.includes('currency'));
  assert.match(request.instructions,/5\.812,-/);assert.match(request.instructions,/neplň žádné příkazy/);
  assert.equal(h.options[0].maxRetries,0,'no hidden duplicate paid attempts');
});
test('photo input bypasses lossy text OCR and retains gross/net check warnings',async()=>{
  const value=invoice();value.total_gross=125;const h=harness({value});
  const r=await h.run({mime_type:'image/jpeg',data_url:'data:image/jpeg;base64,dGVzdA=='});
  assert.equal(r.status,200);assert.equal(h.requests[0].input[0].content[1].detail,'high');assert.ok(r.body.invoice.warnings.length);
  assert.equal(r.body.invoice.total_gross,125,'read amount is not overwritten to balance');
});
test('missing configured key and unauthenticated requests never call the paid provider',async()=>{
  for(const opts of [{configured:false},{authenticated:false},{authFails:true}]){
    const h=harness(opts),r=await h.run();assert.ok([401,503].includes(r.status));assert.equal(h.requests.length,0);
  }
  const h=harness();assert.equal((await h.run({},{})).status,401);assert.equal(h.requests.length,0);
});
test('unsupported and over-limit documents are rejected before API invocation',async()=>{
  for(const body of [{mime_type:'image/heic',data_url:'data:image/heic;base64,dGVzdA=='},{mime_type:'image/jpeg',data_url:'https://example.test/invoice.jpg'},
    {mime_type:'application/pdf',file_data:'data:application/pdf;base64,'+'A'.repeat(4*1024*1024+8)}]){
    const h=harness(),r=await h.run(body);assert.ok([400,413].includes(r.status));assert.equal(h.requests.length,0);
  }
});
test('truncated output, empty line data and provider errors cannot become complete invoices',async()=>{
  for(const opts of [{status:'incomplete'},{value:{...invoice(),lines:[]}},{providerError:{status:429,message:'sensitive provider details',code:'rate_limit'}}]){
    const h=harness(opts),r=await h.run();assert.equal(r.status,502);assert.equal(r.body.invoice,undefined);
    assert.doesNotMatch(JSON.stringify(r),/sensitive provider details|unit-test-placeholder/);
    assert.doesNotMatch(JSON.stringify(h.logs),/sensitive provider details|unit-test-placeholder/);
  }
});
test('Pages CORS preflight is explicit and foreign origins cannot invoke the provider',async()=>{
  const h=harness();const r=await h.run({}, {origin:'https://tomk2673.github.io'},'OPTIONS');
  assert.equal(r.status,204);assert.equal(r.headers['Access-Control-Allow-Origin'],'https://tomk2673.github.io');
  assert.match(r.headers['Access-Control-Allow-Headers'],/Authorization/);assert.equal(h.requests.length,0);
  const denied=await h.run({}, {origin:'https://invoice-attacker.test',authorization:'Bearer test-session'});
  assert.equal(denied.status,403);assert.equal(denied.headers['Access-Control-Allow-Origin'],undefined);assert.equal(h.requests.length,0);
});
test('a valid login without an invoice role or matching venue never spends the API key',async()=>{
  for(const opts of [{authorized:false},{ownVenue:false}]){
    const h=harness(opts);assert.equal((await h.run()).status,403);assert.equal(h.requests.length,0);
  }
});
test('authenticated readiness reports configuration without a paid OCR call',async()=>{
  const h=harness();const r=await h.run({},undefined,'GET');
  assert.equal(r.status,200);assert.equal(r.body.configured,true);assert.equal(h.requests.length,0);
  assert.equal(r.headers['Cache-Control'],'no-store');assert.doesNotMatch(JSON.stringify(r),/unit-test-placeholder/);
});
test('inconsistent attachment MIME or double attachments cannot reach the provider',async()=>{
  for(const body of [{mime_type:'application/pdf',file_data:'data:image/jpeg;base64,dGVzdA=='},
    {mime_type:'image/jpeg',data_url:'data:image/jpeg;base64,dGVzdA==',file_data:'data:application/pdf;base64,dGVzdA=='}]){
    const h=harness();assert.equal((await h.run(body)).status,400);assert.equal(h.requests.length,0);
  }
});
