-- Take back the grants Supabase hands out by default.
--
-- A new table in `public` is granted ALL to anon and authenticated by the
-- project's default privileges. That silently undoes the design in 0004: those
-- tables are meant to have no grants at all, so the API answers "permission
-- denied for table" rather than an empty result.
--
-- RLS was covering the tables. It was NOT covering the views: a view runs as
-- its owner unless it is declared security_invoker, so moderation_queue read
-- straight past the RLS on flags and feedback and served every report — with
-- contact emails — to anyone holding the anon key.

set search_path = public, extensions;

-- Views first: this is the one that was actually leaking.
revoke all on public.moderation_queue from anon, authenticated;
revoke all on public.trip_moderation_queue from anon, authenticated;

-- Belt and braces: even reached directly, these now run as the caller.
alter view public.moderation_queue set (security_invoker = on);
alter view public.trip_moderation_queue set (security_invoker = on);

-- The tables behind them, and the rest of the shared layer. submit_flag and
-- submit_feedback are security definer, so they keep working.
revoke all on public.flags      from anon, authenticated;
revoke all on public.feedback   from anon, authenticated;
revoke all on public.moderators from anon, authenticated;
revoke all on public.rate_limit from anon, authenticated;

-- Migration history is not a public document; it names every change and when.
revoke all on public.schema_migrations from anon, authenticated;

-- These two stay readable, which is deliberate: display names appear next to
-- submissions, and a shared moderation UI needs the app list. Writes do not.
revoke insert, update, delete on public.profiles from anon, authenticated;
revoke insert, update, delete on public.apps     from anon, authenticated;

-- And stop the next table in this schema inheriting the same default.
alter default privileges in schema public revoke all on tables from anon, authenticated;
