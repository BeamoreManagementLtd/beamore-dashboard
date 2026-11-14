-- Project intake automation: DfE or not (with the evidence), when a project's stage last changed,
-- and where in email a checklist item probably is.
alter table projects add column is_dfe boolean;
alter table projects add column dfe_evidence text;
alter table projects add column stage_changed_at timestamptz;

create or replace function public.touch_stage_changed() returns trigger language plpgsql as $$
begin
  if tg_op = 'INSERT' or new.stage is distinct from old.stage then new.stage_changed_at := now(); end if;
  return new;
end $$;
create trigger projects_stage_changed before insert or update of stage on projects
  for each row execute function public.touch_stage_changed();

alter table project_info add column hint text;         -- "Programme rev C (from Sarah Jones, 3 Nov)"
alter table project_info add column hint_thread text;  -- Gmail thread id
alter table project_info add column hint_at timestamptz;
alter table project_info add column auto boolean not null default false;  -- added by the automation
