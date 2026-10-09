'use strict';

(function () {
  const pending = new Map();
  let seq = 0;
  let browserRecognize = null;

  function nativeHandler() {
    return window.webkit?.messageHandlers?.pubGuruVision || null;
  }

  function available() {
    return typeof nativeHandler()?.postMessage === 'function';
  }

  function report(logger, message) {
    try { if (typeof logger === 'function') logger(message); } catch (_) { /* UI progress must not break OCR. */ }
  }

  function callNative(canvas, logger) {
    return new Promise((resolve, reject) => {
      const requestId = `vision_${Date.now()}_${++seq}`;
      const timer = setTimeout(() => {
        pending.delete(requestId);
        reject(new Error('Apple Vision OCR timeout'));
      }, 45000);

      pending.set(requestId, {
        resolve: payload => {
          clearTimeout(timer);
          pending.delete(requestId);
          if (typeof payload.text !== 'string' || !payload.text.trim()) {
            reject(new Error('Apple Vision nevrátilo žádný čitelný text.'));
            return;
          }
          report(logger, { status: 'Apple Vision OCR dokončeno', progress: 1 });
          const confidence = Number(payload.confidence);
          resolve({ data: { text: payload.text, confidence: Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) * 100 : 0,
            lines: Array.isArray(payload.lines) ? payload.lines : [], native: true } });
        },
        reject: error => {
          clearTimeout(timer);
          pending.delete(requestId);
          reject(error);
        }
      });

      report(logger, { status: 'Apple Vision OCR', progress: 0.08 });
      try {
        nativeHandler().postMessage({
          requestId,
          imageDataUrl: canvas.toDataURL('image/jpeg', 0.94)
        });
      } catch (error) {
        clearTimeout(timer);
        pending.delete(requestId);
        reject(error);
      }
    });
  }

  window.PubGuruNativeOCR = window.PubGuruNativeOCR || {};
  window.PubGuruNativeOCR.available = available;
  window.PubGuruNativeOCR.resolve = payload => {
    const waiter = pending.get(payload?.requestId);
    if (!waiter) return;
    if (payload.error) waiter.reject(new Error(payload.error));
    else waiter.resolve(payload);
  };

  async function recognize(input, language = 'ces+eng', options = {}) {
    let result;
    if (available() && input instanceof HTMLCanvasElement) {
      try {
        result = await callNative(input, options.logger);
      } catch (error) {
        console.warn('Apple Vision OCR selhalo, používám Tesseract fallback.', error);
      }
    }
    if (!result) {
      const fallback = browserRecognize || window.Tesseract?.recognize?.bind(window.Tesseract);
      if (!fallback) throw new Error('Místní OCR není dostupné. Zkus doklad načíst znovu po připojení k internetu.');
      result = await fallback(input, language, options);
    }
    if (typeof result?.data?.text === 'string' && window.PubGuruNormalizeOcrText) {
      result.data.text = window.PubGuruNormalizeOcrText(result.data.text);
    }
    return result;
  }
  // Native OCR is usable even if the Tesseract CDN is unavailable.
  window.PubGuruNativeOCR.recognize = recognize;

  function install() {
    if (!window.Tesseract?.recognize || window.Tesseract.__pubGuruVisionWrapped) return false;
    browserRecognize = window.Tesseract.recognize.bind(window.Tesseract);
    window.Tesseract.recognize = recognize;
    window.Tesseract.__pubGuruVisionWrapped = true;
    return true;
  }

  if (!install()) {
    let tries = 0;
    const timer = setInterval(() => {
      tries += 1;
      if (install() || tries > 50) clearInterval(timer);
    }, 100);
  }
})();
