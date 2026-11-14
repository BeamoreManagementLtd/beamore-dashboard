-- Each clerk's latest diary day (planned or charged), for showing who's working with us now.
create view clerk_activity with (security_invoker = true) as
select clerk_id, max(visit_date) as last_visit
from diary_visits
where clerk_id is not null
group by clerk_id;
