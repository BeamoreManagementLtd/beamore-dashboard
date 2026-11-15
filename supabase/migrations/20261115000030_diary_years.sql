-- One diary per year (Ronan: "In January we will create the diary 2027 and use that"). {"2026": fileId, "2027": fileId}
alter table google_connection add column diary_files jsonb not null default '{}';
