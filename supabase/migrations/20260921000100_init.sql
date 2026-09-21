-- Trip Companion: shared stores behind auth.
--
-- The one credential this system deliberately does NOT hold is the traveller's
-- Wanderlog session cookie. It is full-access and unscopable, so it stays in
-- the user's own vault and only trip data arrives here. See docs/WANDERLOG.md.

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------- trips ----
create table if not exists public.trips (
  id           uuid primary key default gen_random_uuid(),
  owner        uuid not null references auth.users (id) on delete cascade,
  title        text not null,
  departs_on   date,
  -- The whole trip graph. Kept opaque so the domain model can evolve without
  -- a migration; nothing here is queried by shape.
  graph        jsonb not null,
  -- Set when this trip came from Wanderlog, so a re-sync updates in place.
  source       text not null default 'paste'
                 check (source in ('paste', 'wanderlog')),
  source_key   text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create unique index if not exists trips_owner_source_key
  on public.trips (owner, source, source_key)
  where source_key is not null;

create index if not exists trips_owner_updated on public.trips (owner, updated_at desc);

-- ------------------------------------------------------------ check-ins ----
create table if not exists public.check_ins (
  id        uuid primary key default gen_random_uuid(),
  trip_id   uuid not null references public.trips (id) on delete cascade,
  place_id  text not null,
  at        timestamptz not null default now(),
  -- 'manual' today; 'geofence' once a native shell can write these.
  source    text not null default 'manual' check (source in ('manual', 'geofence')),
  unique (trip_id, place_id)
);

-- ---------------------------------------------------------- corrections ----
create table if not exists public.corrections (
  id             text primary key,
  -- Keyed to the real-world entity, never the trip: a correction found on one
  -- traveller's trip has to outlive that trip or the dataset never compounds.
  entity_key     text not null,
  card_kind      text not null,
  claim          text not null,
  saw_body       text not null,
  status         text not null default 'open'
                   check (status in ('open', 'accepted', 'rejected')),
  corrected_body text,
  submitted_by   uuid references auth.users (id) on delete set null,
  submitted_at   timestamptz not null default now(),
  reviewed_at    timestamptz,
  reviewed_by    uuid references auth.users (id) on delete set null
);

create index if not exists corrections_entity on public.corrections (entity_key, card_kind);
create index if not exists corrections_open on public.corrections (status) where status = 'open';

-- --------------------------------------------------------- entity cards ----
-- The shared store. Cards keyed by real-world place, so the hundredth
-- traveller through a station inherits the ninety-nine earlier verifications.
create table if not exists public.entity_cards (
  entity_key  text not null,
  kind        text not null,
  title       text not null,
  body        text not null,
  sources     jsonb not null default '[]'::jsonb,
  tier        text not null,
  verified_at date not null,
  confidence  real not null default 0.9,
  updated_at  timestamptz not null default now(),
  primary key (entity_key, kind)
);

-- ------------------------------------------------------------ reviewers ----
create table if not exists public.reviewers (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  added_at   timestamptz not null default now()
);

create or replace function public.is_reviewer(uid uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (select 1 from public.reviewers r where r.user_id = uid);
$$;
