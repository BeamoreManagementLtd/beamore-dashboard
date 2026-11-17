-- The AI feedback emails are their own choice (Ronan, 17 Nov 2026: "they should have the option, when they switch on AI
-- feedback, to also get the emails"): off until the clerk ticks it, even with the feedback switched on.
alter table clerks add column if not exists ai_feedback_email boolean not null default false;
