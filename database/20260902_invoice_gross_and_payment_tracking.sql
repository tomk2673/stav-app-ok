alter table public.invoice_lines
  add column if not exists unit_price_gross numeric;

alter table public.purchase_price_history
  add column if not exists unit_price_net numeric,
  add column if not exists unit_price_gross numeric,
  add column if not exists vat_rate numeric;

alter table public.products
  add column if not exists current_purchase_price_gross numeric;

alter table public.invoices
  add column if not exists payment_status text not null default 'unknown',
  add column if not exists payment_method text,
  add column if not exists paid_at timestamptz,
  add column if not exists total_amount_gross numeric;

alter table public.invoices
  drop constraint if exists invoices_payment_status_check;
alter table public.invoices
  add constraint invoices_payment_status_check
  check (payment_status in ('unknown','unpaid','paid'));

create index if not exists invoices_org_issue_date_idx
  on public.invoices (organization_id, issue_date desc);
create index if not exists invoices_org_paid_at_idx
  on public.invoices (organization_id, paid_at desc)
  where paid_at is not null;

update public.invoice_lines
set unit_price_gross = case
  when unit_price_gross is not null then unit_price_gross
  when quantity is not null and quantity <> 0 and line_total_gross is not null then abs(line_total_gross / quantity)
  when unit_price_net is not null and vat_rate is not null then unit_price_net * (1 + vat_rate / 100.0)
  else null
end
where unit_price_gross is null;

update public.purchase_price_history
set unit_price_net = coalesce(unit_price_net, unit_price)
where unit_price_net is null;

update public.invoices
set total_amount_gross = total_amount
where total_amount_gross is null and total_amount is not null;

update public.invoices
set payment_status = 'paid',
    payment_method = coalesce(payment_method, 'cash'),
    paid_at = coalesce(paid_at, issue_date::timestamptz)
where payment_status = 'unknown'
  and raw_extraction->>'raw_text' ~* '(hotov[eě]|zp[uů]sob[[:space:]]+[uú]hrady:[[:space:]]*hotov)';