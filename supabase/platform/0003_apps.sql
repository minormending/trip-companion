-- Platform: which apps live in this database, and who moderates them.
--
-- One Postgres instance, one shared public layer, one schema per app. This is
-- what lets several apps share a single Supabase project without the
-- collisions that made a shared `public` a bad idea: profiles, rate_limit and
-- the moderation queue exist once, and each app's own tables sit in its own
-- schema where nothing else can reach them by accident.

set search_path = public, extensions;

create table if not exists apps (
  slug       text primary key,
  name       text not null,
  -- The schema this app's tables live in. Not a foreign key to anything;
  -- Postgres has no catalogue reference to offer, and an app can be registered
  -- before its schema exists.
  schema     text not null unique,
  created_at timestamptz not null default now()
);

alter table apps enable row level security;

-- Public: the app list is not sensitive and a shared moderation UI needs it.
create policy apps_read on apps for select to anon, authenticated using (true);
grant select on apps to anon, authenticated;

-- Moderation rights are per app, not global. Somebody trusted to hide a
-- restroom has no business rewriting a transit card, and the whole point of
-- sharing a database is that these stay separate.
create table if not exists moderators (
  user_id  uuid not null references auth.users(id) on delete cascade,
  app_slug text not null references apps(slug) on delete cascade,
  added_at timestamptz not null default now(),
  primary key (user_id, app_slug)
);

alter table moderators enable row level security;
-- No grants: membership is checked by the function below, never read directly.

create or replace function is_moderator(p_app text, p_uid uuid default auth.uid())
returns boolean
language sql stable security definer set search_path = public, extensions as $$
  select exists (
    select 1 from moderators m
     where m.user_id = p_uid and m.app_slug = p_app
  );
$$;

revoke all on function is_moderator(text, uuid) from public;
grant execute on function is_moderator(text, uuid) to authenticated;
