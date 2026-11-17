-- Report timings (Ronan, 17 Nov 2026): who's late with their reports.
-- visit_date_source: where the visit date came from (report = read from inside it when checked, name = file name,
-- name+diary = a weekly report's date settled against the diary, diary = the job's last diary visit before the upload,
-- monthly = a monthly report, no visit date, manual = set by hand). issued_on: the date put in the report's
-- "Date issued to Lead Consultant (TA)" box when it was approved.
alter table reports add column if not exists visit_date_source text;
alter table reports add column if not exists issued_on date;
-- clerks have 2 working days after the visit to upload their report (Ronan, 17 Nov 2026)
alter table report_settings alter column clerk_days set default 2;
update report_settings set clerk_days = 2 where id = 1;
update reports set visit_date_source = 'report' where visit_date is not null and visit_date_source is null;
