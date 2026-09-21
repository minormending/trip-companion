-- trip-companion: its own schema in a shared database.
--
-- Everything this app owns lives in `trip`. The shared layer in `public`
-- (profiles, rate_limit, flags, feedback) is used, never duplicated.

create schema if not exists trip;

grant usage on schema trip to anon, authenticated;

-- Nothing is granted by default. Each table opts in, and writes that need
-- checking go through a function rather than a table grant.
alter default privileges in schema trip revoke all on tables from anon, authenticated;

insert into public.apps (slug, name, schema)
values ('trip-companion', 'Trip Companion', 'trip')
on conflict (slug) do nothing;
