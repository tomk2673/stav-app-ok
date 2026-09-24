alter table public.invoice_lines
  add column if not exists vat_rate numeric,
  add column if not exists unit_price_net numeric,
  add column if not exists line_total_net numeric,
  add column if not exists line_total_gross numeric;

alter table public.invoice_lines
  drop constraint if exists invoice_lines_vat_rate_check;
alter table public.invoice_lines
  add constraint invoice_lines_vat_rate_check
  check (vat_rate is null or (vat_rate >= 0 and vat_rate <= 100));
