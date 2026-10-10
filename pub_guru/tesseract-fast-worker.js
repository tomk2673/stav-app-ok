'use strict';

(function () {
  if (!window.Tesseract || typeof window.Tesseract.createWorker !== 'function') return;

  const tesseract = window.Tesseract;
  let workerPromise = null;
  let activeLogger = null;
  let queue = Promise.resolve();

  function deadline(task, ms, message, cancel) {
    let timer;
    const timeout=new Promise((_,reject)=>{timer=setTimeout(()=>{
      try { cancel(); } catch (error) { console.warn('OCR cleanup failed',error); }
      reject(new Error(message));
    },ms);});
    return Promise.race([task,timeout]).finally(()=>clearTimeout(timer));
  }

  async function getWorker() {
    if (!workerPromise) {
      const pending = tesseract.createWorker('ces+eng', 1, {
        logger: message => activeLogger?.(message)
      }).then(async worker => {
        await worker.setParameters({
          tessedit_pageseg_mode: '6',
          preserve_interword_spaces: '1'
        });
        return worker;
      });
      const current = deadline(pending,60000,'OCR se nepodařilo načíst. Zkontroluj připojení a zkus čtení znovu.',()=>{
        workerPromise=null;
        pending.then(worker=>worker.terminate()).catch(()=>{});
      }).catch(error => {
        if(workerPromise===current)workerPromise = null;
        throw error;
      });
      workerPromise=current;
    }
    return workerPromise;
  }

  async function recognizeWithWorker(input, _language, options = {}) {
    const run = async () => {
      activeLogger = typeof options.logger === 'function' ? options.logger : null;
      try {
        const worker = await getWorker();
        if (options.tessedit_pageseg_mode || options.preserve_interword_spaces) {
          await deadline(worker.setParameters({
            tessedit_pageseg_mode: String(options.tessedit_pageseg_mode || '6'),
            preserve_interword_spaces: String(options.preserve_interword_spaces || '1')
          }),30000,'OCR nereaguje. Zkus čtení spustit znovu.',()=>{
            workerPromise=null;
            Promise.resolve(worker.terminate()).catch(()=>{});
          });
        }
        return await deadline(worker.recognize(input),90000,'Čtení dokladu překročilo časový limit. Zkus ostřejší fotku nebo opakovat čtení.',()=>{
          workerPromise=null;
          Promise.resolve(worker.terminate()).catch(()=>{});
        });
      } finally {
        activeLogger = null;
      }
    };

    const next = queue.then(run, run);
    queue = next.catch(() => {});
    return next;
  }

  tesseract.recognize = recognizeWithWorker;
  tesseract.__pubGuruPersistentWorker = true;

  window.PubGuruFastOCR = {
    warmup: () => getWorker().then(() => true).catch(error => {
      console.warn('PUB GURU OCR warmup failed', error);
      return false;
    })
  };

  const warm = () => {
    if (window.PubGuruNativeOCR?.available?.()) return;
    window.PubGuruFastOCR.warmup();
  };

  if ('requestIdleCallback' in window) requestIdleCallback(warm, { timeout: 2500 });
  else setTimeout(warm, 600);
})();
