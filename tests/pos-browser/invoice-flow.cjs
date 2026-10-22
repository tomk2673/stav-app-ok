'use strict';
// Local files and isolated PostgreSQL with real migrations/RLS/triggers only.
// Every external request is intercepted; no production transaction is written.
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const http=require('node:http');
const browsers=require('pwmodern');
const {setup,clientFor,ids}=require('../pos-web/helpers/invoice-postgres.cjs');
const root=path.resolve(__dirname,'../..');
const server=http.createServer((req,res)=>{
  const name=decodeURIComponent(req.url.split('?')[0]),file=path.resolve(root,'.'+name);
  if(!file.startsWith(root+path.sep)){res.writeHead(403);return res.end();}
  try{
    res.setHeader('Content-Type',name.endsWith('.js')?'application/javascript':name.endsWith('.css')?'text/css':'text/html');
    res.end(fs.readFileSync(file));
  }catch{res.writeHead(404);res.end();}
});

async function run(){
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  for(const engine of (process.env.PUB_INVOICES_BROWSERS||'chromium,webkit').split(','))for(const width of [390,820,1440]){
    const browser=await browsers[engine].launch({headless:true,...(engine==='chromium'?{
      executablePath:process.env.PUB_INVOICES_CHROMIUM||undefined,args:['--no-sandbox','--no-zygote','--single-process']}: {})});
    let db;
    try{
      ({db}=await setup({total:width===1440?-900:900,lines:[{quantity:width===1440?-10:10,
        unit_price_net:100,unit_price_gross:100,vat_rate:0,line_total_net:width===1440?-900:900,line_total_gross:width===1440?-900:900}]}));
      const client=clientFor(db);
      const context=await browser.newContext({viewport:{width,height:1000}}),errors=[];
      await context.route('**/*',route=>{
        const url=new URL(route.request().url());
        if(url.hostname!=='127.0.0.1')return route.fulfill({status:200,contentType:'application/javascript',body:''});
        if(/\/(?:app-config|backend)\.js$/.test(url.pathname))return route.fulfill({status:200,contentType:'application/javascript',body:''});
        return route.continue();
      });
      await context.exposeFunction('invoiceTestQuery',async({table,steps})=>{
        let query=client.from(table);
        for(const [method,args] of steps){
          assert.ok(['select','eq','is','in','order','limit','update','insert','single','maybeSingle'].includes(method));
          query=query[method](...args);
        }
        const result=await query;
        return {data:result.data,error:result.error?{message:result.error.message,code:result.error.code}:null};
      });
      await context.addInitScript(({ids})=>{
        function from(table){
          const steps=[],q={then(resolve,reject){return window.invoiceTestQuery({table,steps}).then(resolve,reject);}};
          for(const method of ['select','eq','is','in','order','limit','update','insert','single','maybeSingle']){
            q[method]=(...args)=>{steps.push([method,args]);return q;};
          }
          return q;
        }
        window.PubGuruBackend={loadContext:async()=>({organization:{id:ids.org},venue:{id:ids.venue},user:{id:ids.user},role:'manager'}),client:{from}};
      },{ids});
      const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
      await page.goto(`http://127.0.0.1:${server.address().port}/pub_guru/invoice-review-v1.html`);
      await page.locator('.queue-item').click();await page.locator('.linegross').waitFor();
      assert.equal(await page.locator('.gross').inputValue(),'100');
      assert.equal(await page.locator('.linegross').inputValue(),width===1440?'-900':'900');
      const layout=await page.evaluate(()=>({screen:innerWidth,body:document.documentElement.scrollWidth}));
      assert.ok(layout.body<=layout.screen,`horizontal overflow at ${width}: ${JSON.stringify(layout)}`);
      if(width===820){
        await page.locator('.qty').fill('1,5');await page.locator('.gross').fill('1.000,-');
        assert.equal(await page.locator('.linegross').inputValue(),'900','unit edits preserve printed result');
        await page.locator('.recalculate').click();await page.locator('#totalGross').fill('1 500,00');
      }
      assert.deepEqual(await page.evaluate(()=>PubGuruInvoiceReview.check().issues),[]);
      await page.locator('#postBtn').click();await page.locator('#editor').waitFor({state:'hidden'});
      assert.equal(await page.locator('#queueCount').textContent(),'0');
      assert.equal(await page.locator('.queue-item').count(),0);
      const invoice=(await db.query('select status,total_amount_gross from invoices')).rows[0];
      const line=(await db.query('select unit_price_gross,line_total_gross from invoice_lines')).rows[0];
      const total=width===820?1500:width===1440?-900:900;
      assert.equal(invoice.status,'posted');assert.equal(Number(invoice.total_amount_gross),total);
      assert.equal(Number(line.unit_price_gross),width===820?1000:100);assert.equal(Number(line.line_total_gross),total);
      const summary=(await db.query("select public.invoice_capture_command('summary',$1,$2) as result",[ids.org,ids.venue])).rows[0].result;
      assert.equal(summary.counts.review,undefined);assert.equal(summary.counts.done,1);
      const stock=(await db.query('select movement_type,quantity_ml from stock_movements')).rows;
      assert.equal(stock.length,1);assert.equal(stock[0].movement_type,width===1440?'return':'receipt');
      assert.equal(Number(stock[0].quantity_ml),width===820?1050:width===1440?-7000:7000);
      const audits=(await db.query('select event_type,after_data from audit_events')).rows;
      assert.equal(audits.length,2);assert.equal(audits.find(a=>a.event_type==='invoice.posted').after_data.total_gross,total);
      assert.ok(audits.some(a=>a.event_type==='invoice.capture_queue_completed'));
      assert.equal((await db.query('select count(*)::int as n from purchase_price_history')).rows[0].n,width===1440?0:1);
      assert.deepEqual(errors,[]);
      console.log(`PASS ${engine} ${width}px: real PostgreSQL approval, preserved money, queue empty, one stock movement, audits, layout`);
      await context.close();
    }finally{if(db)await db.close();await browser.close();}
  }
}
run().catch(error=>{console.error(error);process.exitCode=1;}).finally(()=>server.close());
