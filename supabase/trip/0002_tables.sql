set search_path = trip, public, extensions;

create table if not exists trips (
  id         uuid primary key default gen_random_uuid(),
  owner      uuid not null references auth.users(id) on delete cascade,
  title      text not null,
  departs_on date,
  -- The whole trip graph. Kept opaque so the domain model can evolve without a
  -- migration; nothing here is queried by shape.
  graph      jsonb not null,
  source     text not null default 'paste' check (source in ('paste', 'wanderlog')),
  source_key text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- A Wanderlog trip re-synced updates in place rather than piling up copies.
create unique index if not exists trips_owner_source_key
  on trips (owner, source, source_key) where source_key is not null;
create index if not exists trips_owner_updated on trips (owner, updated_at desc);

create table if not exists check_ins (
  id       uuid primary key default gen_random_uuid(),
  trip_id  uuid not null references trips(id) on delete cascade,
  place_id text not null,
  at       timestamptz not null default now(),
  -- 'manual' today; 'geofence' once a native shell can write these.
  source   text not null default 'manual' check (source in ('manual', 'geofence')),
  unique (trip_id, place_id)
);

-- Corrections are this app's flags, but they carry more than a complaint: what
-- the traveller saw, what they say is true, and eventually the text that
-- replaces it. They stay here rather than in public.flags, and surface into the
-- shared queue through a view.
create table if not exists corrections (
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
  submitted_by   uuid references public.profiles(id) on delete set null,
  submitted_at   timestamptz not null default now(),
  reviewed_at    timestamptz,
  reviewed_by    uuid references public.profiles(id) on delete set null
);

create index if not exists corrections_entity on corrections (entity_key, card_kind);
create index if not exists corrections_open on corrections (status) where status = 'open';

-- The shared store: cards keyed by real-world place, so the hundredth traveller
-- through a station inherits the ninety-nine earlier verifications.
create table if not exists entity_cards (
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

create or replace function touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

drop trigger if exists trips_touch on trips;
create trigger trips_touch before update on trips
  for each row execute function touch_updated_at();

drop trigger if exists entity_cards_touch on entity_cards;
create trigger entity_cards_touch before update on entity_cards
  for each row execute function touch_updated_at();
