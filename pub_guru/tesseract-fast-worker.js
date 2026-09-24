'use strict';

(function () {
  if (!window.Tesseract || typeof window.Tesseract.createWorker !== 'function') return;

  const tesseract = window.Tesseract;
  let workerPromise = null;
  let activeLogger = null;
  let queue = Promise.resolve();

  async function getWorker() {
    if (!workerPromise) {
      workerPromise = tesseract.createWorker('ces+eng', 1, {
        logger: message => activeLogger?.(message)
      }).then(async worker => {
        await worker.setParameters({
          tessedit_pageseg_mode: '6',
          preserve_interword_spaces: '1'
        });
        return worker;
      }).catch(error => {
        workerPromise = null;
        throw error;
      });
    }
    return workerPromise;
  }

  async function recognizeWithWorker(input, _language, options = {}) {
    const run = async () => {
      activeLogger = typeof options.logger === 'function' ? options.logger : null;
      try {
        const worker = await getWorker();
        if (options.tessedit_pageseg_mode || options.preserve_interword_spaces) {
          await worker.setParameters({
            tessedit_pageseg_mode: String(options.tessedit_pageseg_mode || '6'),
            preserve_interword_spaces: String(options.preserve_interword_spaces || '1')
          });
        }
        return await worker.recognize(input);
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
