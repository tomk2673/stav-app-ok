'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {JSDOM}=require('jsdom');
const root=path.resolve(__dirname,'../../pub_guru');

async function until(predicate,label){
  for(let i=0;i<200;i++){
    if(predicate())return;
    await new Promise(resolve=>setTimeout(resolve,5));
  }
  throw new Error('Timed out: '+label);
}

async function harness({jobs=[{id:'old-1'},{id:'old-2'}],draft=false,failRead=false,lostResponse=false}={}){
  const dom=new JSDOM(fs.readFileSync(path.join(root,'invoice-capture.html'),'utf8'),{
    url:'https://invoices.test/pub_guru/invoice-capture.html',runScripts:'outside-only',pretendToBeVisual:true
  });
  const w=dom.window,calls=[],saved=[];
  w.console={warn(){},error:assert.fail};
  const ctx={organization:{id:'org'},venue:{id:'venue'},user:{id:'user'},role:'owner'};
  let locked=false,queueDraft=false;
  jobs=jobs.map(job=>({status:'queued',source_file_name:'invoice.pdf',mime_type:'application/pdf',source_path:job.id+'.pdf',...job}));
  w.PubGuruInvoiceCapture={ready:Promise.resolve(ctx),isBusy:()=>locked,hasDraft:()=>draft || queueDraft,
    beginQueue(){assert.equal(draft,false);locked=true;},endQueue(){locked=false;},
    clearQueued(){queueDraft=false;},
    async readQueued(file,job){
      assert.equal(locked,true,'manual editor must be reserved before reading');
      calls.push('read:'+job.id);
      if(failRead && job.id==='old-1')throw new Error('OCR timeout');
      await new Promise(resolve=>setTimeout(resolve,5));
      queueDraft=true;
      return {raw_text:'Test invoice',lines:[{rawName:'Test'}],provider:'tesseract-browser-v3'};
    }
  };
  w.PubGuruFastCapture={isBusy:()=>false};
  w.PubGuruBackend={client:{
    storage:{from(bucket){assert.equal(bucket,'invoice-sources');return {
      download:async source=>{calls.push('download:'+source);return {data:new w.Blob(['test'],{type:'application/pdf'}),error:null};}
    };}},
    rpc:async(name,args)=>{
      assert.equal(name,'invoice_capture_command');assert.equal(args.p_organization_id,'org');assert.equal(args.p_venue_id,'venue');
      calls.push(args.p_action);
      const job=jobs.find(x=>x.id===args.p_job_id);
      if(args.p_action==='summary'){
        const counts={};for(const job of jobs)counts[job.status]=(counts[job.status] || 0)+1;
        return {data:{counts,jobs},error:null};
      }
      if(args.p_action==='claim'){
        const next=jobs.find(x=>x.status==='queued');
        if(next){next.status='processing';next.claim_token='lease-'+next.id;}
        return {data:next || null,error:null};
      }
      if(args.p_action==='complete'){
        assert.equal(locked,true,'editor must remain reserved through persistence');
        assert.equal(args.p_token,job.claim_token);
        assert.equal(job.status,'processing');
        saved.push(args.p_result);job.status='review';job.invoice_id='invoice-'+job.id;
        if(lostResponse && job.id==='old-1')throw new Error('Response was lost');
        return {data:{invoice_id:job.invoice_id,status:'review'},error:null};
      }
      if(args.p_action==='fail'){
        if(job.status==='review')return {data:null,error:new Error('lease lost')};
        job.status='failed';job.error_message=args.p_error;
        return {data:{status:'failed'},error:null};
      }
      if(args.p_action==='retry'){
        for(const job of jobs)if(job.status==='failed' && (!args.p_job_id || args.p_job_id===job.id))job.status='queued';
        failRead=false;return {data:{status:'queued'},error:null};
      }
      assert.fail('Unexpected action: '+args.p_action);
    }
  }};
  w.eval(fs.readFileSync(path.join(root,'invoice-queue.js'),'utf8'));
  await until(()=>w.document.getElementById('queueContinue').onclick,'initialized');
  return {dom,w,jobs,calls,saved,clearDraft(){draft=false;w.dispatchEvent(new w.Event('pubguru:invoice-cleared'));}};
}

test('opening capture automatically drains existing jobs exactly once into review',async()=>{
  const h=await harness();
  try{
    await until(()=>h.jobs.every(x=>x.status==='review') && !h.w.PubGuruInvoiceQueue.isBusy(),'queue drained');
    assert.equal(h.saved.length,2);assert.deepEqual(h.calls.filter(x=>x.startsWith('read:')),['read:old-1','read:old-2']);
    assert.match(h.w.document.getElementById('queueCount').textContent,/0 čeká · 2 ke kontrole/);
    await Promise.all([h.w.PubGuruInvoiceQueue.run(),h.w.PubGuruInvoiceQueue.run()]);
    assert.equal(h.saved.length,2);
  }finally{h.dom.window.close();}
});

test('a failed OCR does not block the next invoice; retry processes the retained job',async()=>{
  const h=await harness({failRead:true});
  try{
    await until(()=>h.jobs[0].status==='failed' && h.jobs[1].status==='review' && !h.w.PubGuruInvoiceQueue.isBusy(),'partial failure');
    assert.equal(h.jobs[0].error_message,'OCR timeout');assert.equal(h.saved.length,1);
    assert.equal(h.w.document.getElementById('queueRetry').hidden,false);
    await h.w.PubGuruInvoiceQueue.retry('old-1');
    await until(()=>h.jobs[0].status==='review' && !h.w.PubGuruInvoiceQueue.isBusy(),'retry completed');
    assert.equal(h.saved.length,2);
  }finally{h.dom.window.close();}
});

test('manual drafts remain untouched until cleared; new uploads wake the queue',async()=>{
  const h=await harness({draft:true});
  try{
    await until(()=>h.w.document.getElementById('queueStatus').textContent.includes('rozepsaný'),'draft respected');
    assert.equal(h.calls.includes('claim'),false);assert.equal(h.saved.length,0);
    h.clearDraft();
    await until(()=>h.jobs.every(x=>x.status==='review') && !h.w.PubGuruInvoiceQueue.isBusy(),'resumed');
    h.jobs.push({id:'new',status:'queued',source_path:'new.pdf',mime_type:'application/pdf'});
    h.w.dispatchEvent(new h.w.CustomEvent('pubguru:invoice-queued',{detail:{jobId:'new'}}));
    await until(()=>h.jobs.at(-1).status==='review' && !h.w.PubGuruInvoiceQueue.isBusy(),'new upload read');
    assert.equal(h.saved.length,3);
  }finally{h.dom.window.close();}
});

test('lost complete response reconciles saved invoice and continues the remaining jobs',async()=>{
  const h=await harness({lostResponse:true});
  try{
    await until(()=>h.jobs.every(x=>x.status==='review') && !h.w.PubGuruInvoiceQueue.isBusy(),'response reconciled');
    assert.equal(h.saved.length,2);assert.equal(h.jobs[0].error_message,undefined);
  }finally{h.dom.window.close();}
});

test('queue filenames and error messages are displayed as text',async()=>{
  const h=await harness({jobs:[{id:'bad',status:'failed',source_file_name:'<img src=x onerror=alert(1)>',error_message:'<script>attack()</script>'}]});
  try{
    await until(()=>h.w.document.querySelector('#queueJobs strong'),'queue displayed');
    const list=h.w.document.getElementById('queueJobs');
    assert.equal(list.querySelector('img,script'),null);
    assert.match(list.textContent,/<img src=x/);assert.match(list.textContent,/<script>/);
  }finally{h.dom.window.close();}
});
