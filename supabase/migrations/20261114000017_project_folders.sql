-- Which kind of Drive folder a won project gets (Work/Schools or Work/Others, and its subfolders).
alter table projects add column folder_kind text check (folder_kind in ('dfe', 'school', 'other', 'cladding'));
