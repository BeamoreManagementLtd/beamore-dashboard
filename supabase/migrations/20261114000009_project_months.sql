-- Days per month for one project (grouped in the database: busy projects have hundreds of visit rows).
create function public.project_month_days(p uuid)
returns table (month date, kind visit_kind, side visit_side, days numeric)
language sql stable security invoker set search_path = public as $$
  select date_trunc('month', visit_date)::date, kind, side, sum(days)
  from diary_visits where project_id = p
  group by 1, 2, 3 order by 1;
$$;
