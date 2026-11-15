-- Report checking, the rest of the list (Ronan, 15 Nov 2026): photos reused from earlier reports, what was changed in
-- each report (for the note to the clerk), a quality score, and the original file name when it's made standard.
alter table reports add column photo_hashes text[];          -- a fingerprint of each photo, to spot ones reused later
alter table reports add column photo_count int;
alter table reports add column fixes jsonb;                  -- {spelling: [{find, replace}], filled: [{label, value}], rotated, shrunk}
alter table reports add column clerk_points text[];          -- what the clerk could do better next time (for the note)
alter table reports add column score int;                    -- 0-100 quality score
alter table reports add column renamed_from text;            -- the clerk's file name before it was made standard
