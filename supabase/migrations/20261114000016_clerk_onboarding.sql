-- New clerk onboarding workflow (docs/workflows.html, workflow 4): the record and document dates it checks.
-- Documents themselves aren't stored here; only that they were received and when they expire.
alter table clerk_compliance add column address text;
alter table clerk_compliance add column emergency_contact text;
alter table clerk_compliance add column business_type text check (business_type in ('limited', 'sole_trader', 'umbrella'));
alter table clerk_compliance add column company_name text;
alter table clerk_compliance add column bank_details_received date;     -- the details themselves go in Xero, not here
alter table clerk_compliance add column pi_insurance_expiry date;
alter table clerk_compliance add column pl_insurance_expiry date;
alter table clerk_compliance add column cscs_number text;
alter table clerk_compliance add column cscs_expiry date;
alter table clerk_compliance add column right_to_work_checked date;
alter table clerk_compliance add column terms_signed date;
alter table clerk_compliance add column onboarding_started date;       -- set when a new clerk's onboarding begins
alter table clerk_compliance add column onboarding_project_id uuid references projects (id);  -- the job they were appointed for
