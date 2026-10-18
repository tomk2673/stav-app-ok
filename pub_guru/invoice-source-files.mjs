let converterPromise;

async function nativeImageWorks(file) {
  const image = new Image(); const url = URL.createObjectURL(file);
  let timer;
  try {
    image.src = url;
    await Promise.race([image.decode(), new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('Image decode timeout')), 15000);
    })]);
    return true;
  } catch { return false; }
  finally { clearTimeout(timer); URL.revokeObjectURL(url); }
}

async function converter() {
  if (window.heic2any) return window.heic2any;
  if (!converterPromise) converterPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    const timer = setTimeout(() => { script.remove(); reject(new Error('HEIC převodník neodpověděl. Zkus čtení znovu po obnovení připojení.')); }, 20000);
    script.src = new URL('./vendor/heic2any-0.0.4.min.js', import.meta.url).href;
    script.onload = () => { clearTimeout(timer); window.heic2any ? resolve(window.heic2any) : reject(new Error('HEIC převodník není dostupný.')); };
    script.onerror = () => { clearTimeout(timer); script.remove(); reject(new Error('HEIC převodník se nenačetl. Zkus čtení znovu po obnovení připojení.')); };
    document.head.appendChild(script);
  }).catch(error => { converterPromise = null; throw error; });
  return converterPromise;
}

export async function forReading(file) {
  if (!/image\/hei[cf]/i.test(file.type) && !/\.hei[cf]$/i.test(file.name)) return file;
  // Safari versions with native HEIC support avoid converting the OCR copy.
  if (await nativeImageWorks(file)) return file;
  const convert = await converter(); let timer;
  try {
    const result = await Promise.race([
      convert({blob: file, toType: 'image/jpeg', quality: 1}),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('HEIC převod se přerušil. Zkus čtení znovu.')), 60000); })
    ]);
    if (Array.isArray(result)) throw new Error('HEIC obsahuje více snímků. Vyber jednotlivé fotografie.');
    if (!(result instanceof Blob) || !result.size) throw new Error('HEIC se nepodařilo přečíst.');
    // The job still supplies the original SHA-256 and source_path to the existing reader.
    return new File([result], file.name, {type: 'image/jpeg'});
  } finally { clearTimeout(timer); }
}
