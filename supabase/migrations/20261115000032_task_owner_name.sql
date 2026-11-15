-- Tasks for staff who haven't signed in yet (e.g. Judy): owner by first name until they have a profile.
alter table tasks add column owner_name text;
