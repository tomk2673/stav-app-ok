'use strict';
// Run against local files; every external request is intercepted and no real records are written.
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const http=require('node:http');
const {chromium}=require('pwmodern');
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
  for(const width of [390,820,1440]){
    const browser=await chromium.launch({headless:true,executablePath:process.env.PUB_INVOICES_CHROMIUM||undefined,args:['--no-sandbox','--no-zygote','--single-process']});
    try{
      const context=await browser.newContext({viewport:{width,height:1000}}),errors=[];
      await context.route('**/*',route=>{
        const url=new URL(route.request().url());
        if(url.hostname!=='127.0.0.1')return route.fulfill({status:200,contentType:'application/javascript',body:''});
        if(/\/(?:app-config|backend)\.js$/.test(url.pathname))return route.fulfill({status:200,contentType:'application/javascript',body:''});
        return route.continue();
      });
      await context.addInitScript(({credit})=>{
        const invoice={id:'inv',organization_id:'org',venue_id:'venue',status:'review',supplier_name:'Test supplier',invoice_number:'2026-1',
          issue_date:'2026-10-12',total_amount_gross:credit?-900:900,payment_status:'unpaid'};
        const tables={invoices:[invoice],invoice_lines:[{id:'line',invoice_id:'inv',organization_id:'org',raw_name:'Test vodka',product_id:'product',
          quantity:credit?-10:10,unit_price_net:100,unit_price_gross:100,vat_rate:0,line_total_net:credit?-900:900,line_total_gross:credit?-900:900,status:'review',original_values:{ocr_unit_gross:100,ocr_line_gross:credit?-900:900}}],
          products:[{id:'product',organization_id:'org',name:'Test vodka',volume_ml:700,unit_mode:'liquid',archived_at:null,aliases:[],current_purchase_price_gross:100}],
          purchase_price_history:[],supplier_product_mappings:[],audit_events:[]};
        window.testTables=tables;
        function from(table){
          let action='select',payload,filters=[];
          const q={select(){return this;},eq(key,value){filters.push(r=>r[key]===value);return this;},is(key,value){return this.eq(key,value);},
            in(key,values){filters.push(r=>values.includes(r[key]));return this;},order(){return this;},limit(){return this;},
            update(data){action='update';payload=data;return this;},insert(data){action='insert';payload=data;return this;},
            single(){return execute(true);},maybeSingle(){return execute(true);},then(resolve,reject){return execute().then(resolve,reject);}};
          async function execute(single=false){
            let rows=tables[table].filter(r=>filters.every(f=>f(r)));
            if(action==='update')rows.forEach(r=>Object.assign(r,payload));
            if(action==='insert'){const row={id:'new',...payload};tables[table].push(row);rows=[row];if(table==='audit_events'&&payload.event_type==='invoice.posted')invoice.status='posted';}
            return {data:single?(structuredClone(rows[0])||null):structuredClone(rows),error:null};
          }
          return q;
        }
        window.PubGuruBackend={loadContext:async()=>({organization:{id:'org'},venue:{id:'venue'},user:{id:'user'},role:'manager'}),client:{from}};
      },{credit:width===1440});
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
      const saved=await page.evaluate(()=>testTables);
      assert.equal(saved.invoices[0].status,'posted');assert.equal(saved.audit_events.length,1);
      assert.equal(saved.invoice_lines[0].unit_price_gross,width===820?1000:100);
      assert.equal(saved.invoice_lines[0].line_total_gross,width===820?1500:width===1440?-900:900);
      assert.equal(saved.purchase_price_history.length,width===1440?0:1);
      assert.deepEqual(errors,[]);
      console.log(`PASS Chromium ${width}px: prices, discounts/returns, approval, audit, layout`);
      await context.close();
    }finally{await browser.close();}
  }
}
run().catch(error=>{console.error(error);process.exitCode=1;}).finally(()=>server.close());
