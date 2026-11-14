-- Fees by project: every sales invoice in the financial year (paid ones too), summed by project.
alter table invoices add column subtotal numeric;          -- ex VAT
alter table invoices add column amount_paid numeric;
alter table invoices add column amount_credited numeric;
create index on invoices (project_id, issued);

-- Director only: the money per project per month (security invoker, and invoices are staff-readable,
-- so the view is wrapped in a director check)
create view project_fees with (security_invoker = true) as
select
  project_id,
  date_trunc('month', issued)::date as month,
  count(*) as invoices,
  sum(subtotal) as invoiced_net,
  sum(total) as invoiced_gross,
  sum(coalesce(amount_paid, 0)) as paid,
  sum(case when status = 'AUTHORISED' then amount_due else 0 end) as outstanding,
  sum(coalesce(amount_credited, 0)) as credited
from invoices
where status in ('AUTHORISED', 'PAID') and issued >= '2025-12-01' and public.is_director()
group by 1, 2;
