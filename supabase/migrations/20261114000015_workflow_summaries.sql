-- One row per project with what the workflow needs from the diary and the report tracker,
-- so the Workflows board can work out every project in a handful of queries.
create view project_visit_summary with (security_invoker = on) as
select dv.project_id,
       max(dv.visit_date) filter (where dv.side <> 'planned') as last_visit,
       count(*) as visits,
       count(*) filter (where dv.side <> 'planned') as charged_visits,
       array_remove(array_agg(distinct c.name) filter (where dv.side <> 'planned'), null) as clerk_names
from diary_visits dv
left join clerks c on c.id = dv.clerk_id
where dv.project_id is not null
group by dv.project_id;

create view project_report_summary with (security_invoker = on) as
select project_id, max(last_report) as last_report, sum(n) as reports
from (
  select project_id, max(report_date) as last_report, count(*) as n from report_log where project_id is not null group by project_id
  union all
  select project_id, null::date, count(*) from report_queue where project_id is not null group by project_id
) x
group by project_id;
