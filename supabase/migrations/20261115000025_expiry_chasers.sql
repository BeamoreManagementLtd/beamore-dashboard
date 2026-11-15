-- Which expiry dates a renewal-request draft has already been saved for (field → expiry date), so each is drafted once.
alter table clerk_compliance add column expiry_chased jsonb not null default '{}';
