-- A clerk can choose to see the AI feedback on their own reports in the portal (Ronan, 17 Nov 2026): off until they
-- switch it on themselves.
alter table clerks add column if not exists ai_feedback boolean not null default false;
alter table clerks add column if not exists ai_feedback_changed_at timestamptz;
