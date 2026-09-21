-- Row-level security. Default deny; every table opts in explicitly.

alter table public.trips        enable row level security;
alter table public.check_ins    enable row level security;
alter table public.corrections  enable row level security;
alter table public.entity_cards enable row level security;
alter table public.reviewers    enable row level security;

-- ---------------------------------------------------------------- trips ----
-- A trip is private to its owner. Sharing stays in the URL fragment, which
-- needs no server and means a shared briefing is never readable from here.
create policy trips_owner_select on public.trips
  for select using (auth.uid() = owner);
create policy trips_owner_insert on public.trips
  for insert with check (auth.uid() = owner);
create policy trips_owner_update on public.trips
  for update using (auth.uid() = owner) with check (auth.uid() = owner);
create policy trips_owner_delete on public.trips
  for delete using (auth.uid() = owner);

-- ------------------------------------------------------------ check-ins ----
create policy check_ins_owner_all on public.check_ins
  for all
  using (exists (select 1 from public.trips t where t.id = trip_id and t.owner = auth.uid()))
  with check (exists (select 1 from public.trips t where t.id = trip_id and t.owner = auth.uid()));

-- ---------------------------------------------------------- corrections ----
-- Anyone signed in may report. Reports are visible to their author and to
-- reviewers; an accepted correction is public, because that is the point of
-- the loop.
create policy corrections_insert_own on public.corrections
  for insert with check (auth.uid() = submitted_by);

create policy corrections_read on public.corrections
  for select using (
    status = 'accepted'
    or auth.uid() = submitted_by
    or public.is_reviewer(auth.uid())
  );

-- Resolution is a reviewer action. A traveller cannot accept their own report,
-- which is what stops one person rewriting a shared card unilaterally.
create policy corrections_review on public.corrections
  for update using (public.is_reviewer(auth.uid()))
  with check (public.is_reviewer(auth.uid()));

-- --------------------------------------------------------- entity cards ----
-- Readable by anyone signed in, writable by nobody through the API. Writes
-- arrive from the review path or the warming job using the service role, so a
-- single user cannot poison the store every other traveller reads.
create policy entity_cards_read on public.entity_cards
  for select using (auth.role() = 'authenticated');

-- ------------------------------------------------------------ reviewers ----
create policy reviewers_self_read on public.reviewers
  for select using (auth.uid() = user_id or public.is_reviewer(auth.uid()));

-- ------------------------------------------------------------- triggers ----
create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trips_touch on public.trips;
create trigger trips_touch before update on public.trips
  for each row execute function public.touch_updated_at();

drop trigger if exists entity_cards_touch on public.entity_cards;
create trigger entity_cards_touch before update on public.entity_cards
  for each row execute function public.touch_updated_at();
