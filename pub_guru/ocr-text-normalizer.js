'use strict';

(function () {
  function normalize(text) {
    return String(text || '')
      .replace(/Brutto\s+celkem/gi, 'Brutto součet')
      .replace(/\b((?:0|12|21)\s*%)\s*[|Il]\s*(KS\b)/gi, '$1 1 $2');
  }

  function install() {
    if (!window.Tesseract?.recognize || window.Tesseract.__pubGuruTextNormalized) return false;
    const original = window.Tesseract.recognize.bind(window.Tesseract);
    window.Tesseract.recognize = async function (...args) {
      const result = await original(...args);
      if (result?.data && typeof result.data.text === 'string') {
        result.data.text = normalize(result.data.text);
      }
      return result;
    };
    window.Tesseract.__pubGuruTextNormalized = true;
    return true;
  }

  if (!install()) {
    let tries = 0;
    const timer = setInterval(() => {
      tries += 1;
      if (install() || tries > 50) clearInterval(timer);
    }, 100);
  }

  window.PubGuruNormalizeOcrText = normalize;
})();
