'use strict';

(function () {
  const pending = new Map();
  let seq = 0;

  function nativeHandler() {
    return window.webkit?.messageHandlers?.pubGuruVision || null;
  }

  function available() {
    return !!nativeHandler();
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
          logger?.({ status: 'Apple Vision OCR dokončeno', progress: 1 });
          resolve({ data: { text: payload.text || '', confidence: payload.confidence || 0, native: true } });
        },
        reject: error => {
          clearTimeout(timer);
          pending.delete(requestId);
          reject(error);
        }
      });

      logger?.({ status: 'Apple Vision OCR', progress: 0.08 });
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

  function install() {
    if (!window.Tesseract?.recognize || window.Tesseract.__pubGuruVisionWrapped) return false;
    const original = window.Tesseract.recognize.bind(window.Tesseract);
    window.Tesseract.recognize = function (input, language, options = {}) {
      if (available() && input instanceof HTMLCanvasElement) {
        return callNative(input, options.logger).catch(error => {
          console.warn('Apple Vision OCR selhalo, používám Tesseract fallback.', error);
          return original(input, language, options);
        });
      }
      return original(input, language, options);
    };
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
