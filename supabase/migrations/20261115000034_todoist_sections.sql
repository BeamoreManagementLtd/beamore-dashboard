-- Todoist columns remembered between syncs (an incremental sync only lists the ones that changed)
alter table todoist_state add column sections jsonb not null default '{}';
