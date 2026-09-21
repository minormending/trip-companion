-- restroom-map: its own schema in the shared database.
--
-- Its app tables move here. Its own profiles, flags, feedback and rate_limit
-- do NOT: the shared layer in `public` already has them, and having two of
-- each is the collision this arrangement exists to avoid.

create schema if not exists restroom;

grant usage on schema restroom to anon, authenticated;

-- Nothing is granted by default. Each table opts in, and writes that need
-- checking go through a function rather than a table grant — the endpoint this
-- app already reached on its own (flags_rpc_only, writes_through_rpc).
alter default privileges in schema restroom revoke all on tables from anon, authenticated;

insert into public.apps (slug, name, schema)
values ('restroom-map', 'Restroom Map', 'restroom')
on conflict (slug) do nothing;
