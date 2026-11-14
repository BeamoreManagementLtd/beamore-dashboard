-- New clerk questionnaire: a private link (no login) the clerk fills in; answers go straight into their record.
alter table clerk_compliance add column join_token text unique;
alter table clerk_compliance add column join_submitted_at timestamptz;
alter table clerk_compliance add column ppe_have text[] not null default '{}';  -- what they already own
alter table clerk_compliance add column documents_folder_id text;                -- their folder under Personnel in Drive
