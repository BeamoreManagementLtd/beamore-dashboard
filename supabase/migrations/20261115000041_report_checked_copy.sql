-- The fixes go into a copy, never the clerk's own file (Ronan, 15 Nov 2026: "if you mess something up, the original is
-- there"). The copy lives in a "Checked (dashboard)" folder next to it; once the PDF has gone to the client, the
-- clerk's original goes to Drive's bin (restorable for 30 days) and the checked copy takes its place.
alter table reports add column checked_file_id text;          -- the fixed copy
alter table reports add column checked_folder_id text;        -- the "Checked (dashboard)" folder it's in
alter table reports add column checked_name text;             -- its name (the folder's naming pattern)
alter table reports add column original_trashed_at timestamptz;
