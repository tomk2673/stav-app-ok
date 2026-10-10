'use strict';

(function () {
  const $=id=>document.getElementById(id);
  const db=()=>window.PubGuruBackend.client;
  let ctx=null, running=false, timer=null, activeJob=null;

  function status(message) { if($('queueStatus')) $('queueStatus').textContent=message; }

  async function command(action, extra={}) {
    const response=await db().rpc('invoice_capture_command',{
      p_action:action,p_organization_id:ctx.organization.id,p_venue_id:ctx.venue.id,...extra
    });
    if(response.error)throw response.error;
    return response.data;
  }

  async function refresh() {
    const summary=await command('summary');
    const counts=summary?.counts || {};
    const pending=Number(counts.queued || 0)+Number(counts.processing || 0);
    $('queueCount').textContent=`${pending} čeká · ${counts.review || 0} ke kontrole · ${counts.failed || 0} chyb`;
    const list=$('queueJobs');
    list.replaceChildren();
    for(const job of summary?.jobs || []) {
      const row=document.createElement('div');
      row.className='queue-job';
      const text=document.createElement('div');
      const title=document.createElement('strong');
      title.textContent=job.source_file_name || 'Doklad';
      const detail=document.createElement('small');
      detail.textContent=job.status==='failed'?(job.error_message || 'Čtení selhalo.'):
        ({queued:'Čeká na čtení',processing:'Probíhá čtení',review:'Přečteno · čeká na schválení',done:'Dokončeno'}[job.status] || job.status);
      text.append(title,detail);
      row.append(text);
      if(job.status==='failed') {
        const button=document.createElement('button');
        button.type='button';button.className='btn';button.textContent='Zkusit znovu';
        button.onclick=()=>retry(job.id).catch(showError);
        row.append(button);
      } else if(job.invoice_id && ['owner','manager'].includes(ctx.role)) {
        const link=document.createElement('a');
        link.className='btn';link.href='invoice-review-v1.html';link.textContent='Zkontrolovat';
        row.append(link);
      }
      list.append(row);
    }
    if(!list.children.length)list.textContent='Zatím žádné doklady ve frontě.';
    $('queueRetry').hidden=!counts.failed;
    $('queueReview').hidden=!['owner','manager'].includes(ctx.role);
    return counts;
  }

  function showError(error) {
    console.warn('Invoice queue:',error);
    const missing=/PGRST202|42883/.test(String(error?.code || ''));
    status(missing?'Zpracování fronty ještě není dostupné. Obnov stránku po aktualizaci.':
      `Fronta čeká: ${error?.message || 'připojení není dostupné'}. Doklady jsou uložené. Zkus pokračovat znovu.`);
  }

  function schedule(delay=200) {
    clearTimeout(timer);
    timer=setTimeout(()=>run().catch(showError),delay);
  }

  async function retry(id=null) {
    await command('retry',{p_job_id:id});
    await refresh();
    schedule();
  }

  async function run() {
    if(!ctx || running || document.hidden)return;
    if(navigator.onLine===false){status('Čekám na připojení. Doklady jsou uložené.');return;}
    const capture=window.PubGuruInvoiceCapture;
    if(window.PubGuruFastCapture?.isBusy()) {schedule(1000);return;}
    if(capture.isBusy()) {schedule(1000);return;}
    if(capture.hasDraft()) {
      status('Nejdřív dokonči nebo vyčisti rozepsaný doklad. Fronta pak bude pokračovat.');
      await refresh();
      schedule(15000);
      return;
    }
    running=true;
    capture.beginQueue();
    try {
      await refresh();
      while(!document.hidden && navigator.onLine!==false && !capture.hasDraft()) {
        const job=await command('claim');
        if(!job)break;
        activeJob=job;
        status(`Čtu ${job.source_file_name || 'doklad'}… Nech tuto stránku otevřenou.`);
        const lease={p_job_id:job.id,p_token:job.claim_token};
        const heartbeat=setInterval(()=>command('heartbeat',lease).catch(showError),60000);
        try {
          await refresh();
          const download=await db().storage.from('invoice-sources').download(job.source_path);
          if(download.error)throw download.error;
          if(!download.data)throw new Error('Uložená fotografie není dostupná.');
          const file=new File([download.data],job.source_file_name || 'invoice',{
            type:job.mime_type || download.data.type
          });
          const result=await capture.readQueued(file,job);
          await command('complete',{...lease,p_result:result});
        } catch(error) {
          // Continue with the next invoice only after the failure is durably recorded.
          await command('fail',{...lease,p_error:error?.message || String(error)}).catch(async failure=>{
            // A successful complete may have lost its HTTP response. Reconcile instead of undoing it.
            const summary=await command('summary',{p_job_id:job.id});
            const saved=summary?.jobs?.find(x=>x.id===job.id && ['review','done'].includes(x.status));
            if(!saved)throw failure;
          });
        } finally {
          clearInterval(heartbeat);
          activeJob=null;
          capture.clearQueued();
        }
        await refresh();
        if(window.PubGuruFastCapture?.isBusy())break;
      }
      const counts=await refresh();
      if(counts.queued || counts.processing)status('Fronta bude pokračovat na této otevřené stránce. Přerušené čtení se obnoví automaticky.');
      else if(counts.failed)status('Čtení dokončeno. U dokladů s chybou můžeš čtení zopakovat.');
      else status('Fronta je zpracovaná. Přečtené doklady najdeš ke schválení.');
    } finally {
      capture.endQueue();
      running=false;
      schedule(15000);
    }
  }

  window.PubGuruInvoiceQueue={run,retry,isBusy:()=>running,get activeJob(){return activeJob;}};
  for(const event of ['pubguru:invoice-queued','pubguru:invoice-queue-ready','pubguru:invoice-cleared','online','focus']) {
    window.addEventListener(event,()=>schedule());
  }
  document.addEventListener('visibilitychange',()=>{if(!document.hidden)schedule();});
  document.addEventListener('DOMContentLoaded',async()=>{
    try {
      ctx=await window.PubGuruInvoiceCapture.ready;
      $('queueContinue').onclick=()=>run().catch(showError);
      $('queueRetry').onclick=()=>retry().catch(showError);
      await run();
    } catch(error) {showError(error);}
  });
})();
