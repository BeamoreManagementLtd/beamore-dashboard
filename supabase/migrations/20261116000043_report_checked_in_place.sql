-- Reports are checked in the clerk's own file (Ronan, 16 Nov 2026). The version the clerk uploaded is kept in Drive's
-- version history; this is its id, so "Check again" can start from it.
alter table reports add column if not exists original_revision_id text;
