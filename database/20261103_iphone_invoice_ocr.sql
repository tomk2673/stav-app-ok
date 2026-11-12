-- Apple OCR is stored alongside the original image, never trusted as approved accounting data.
alter table public.invoice_capture_jobs
  add column if not exists apple_ocr_text text;
