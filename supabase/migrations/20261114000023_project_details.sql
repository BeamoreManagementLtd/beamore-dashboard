-- Project details read from the diary (Report emails and Invoice POs tabs) and the CoW diaries' front pages.
alter table projects add column report_to text;
alter table projects add column report_cc text;
alter table projects add column inspection_frequency text;
alter table projects add column reporting_frequency text;
alter table projects add column dfe_project_number text;     -- SRP1383
alter table projects add column details jsonb not null default '{}';  -- from the CoW diary front page: DfE PD, PM, TA, contractor…
