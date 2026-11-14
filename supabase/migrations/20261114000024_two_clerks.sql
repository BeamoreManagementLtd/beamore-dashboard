-- Most jobs have a building clerk of works and an M&E clerk of works. clerk_id stays the building clerk.
alter table projects add column clerk_me_id uuid references clerks (id);
alter table projects add column clerk_me_status text check (clerk_me_status in ('have', 'finding', 'none'));
-- 'diary' = worked out from who's in the diary (kept up to date); 'manual' = chosen by someone (never overwritten)
alter table projects add column clerk_source text check (clerk_source in ('diary', 'manual'));
alter table projects add column clerk_me_source text check (clerk_me_source in ('diary', 'manual'));
alter table clerk_candidates add column role text not null default 'building' check (role in ('building', 'me'));
-- clerks who'd chosen a clerk before this: theirs
update projects set clerk_source = 'manual' where clerk_id is not null;
