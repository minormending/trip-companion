-- Row-level security. Default deny; every table opts in explicitly.

set search_path = trip, public, extensions;

alter table trips        enable row level security;
alter table check_ins    enable row level security;
alter table corrections  enable row level security;
alter table entity_cards enable row level security;

-- A trip is private to its owner. Sharing stays in the URL fragment, which
-- needs no server and means a shared briefing is never readable from here.
create policy trips_owner_select on trips for select using (auth.uid() = owner);
create policy trips_owner_insert on trips for insert with check (auth.uid() = owner);
create policy trips_owner_update on trips for update
  using (auth.uid() = owner) with check (auth.uid() = owner);
create policy trips_owner_delete on trips for delete using (auth.uid() = owner);
grant select, insert, update, delete on trips to authenticated;

create policy check_ins_owner_all on check_ins for all
  using (exists (select 1 from trips t where t.id = trip_id and t.owner = auth.uid()))
  with check (exists (select 1 from trips t where t.id = trip_id and t.owner = auth.uid()));
grant select, insert, update, delete on check_ins to authenticated;

-- Reports are readable by their author, by a moderator of this app, and by
-- everyone once accepted — an accepted correction is the point of the loop.
create policy corrections_read on corrections for select using (
  status = 'accepted'
  or auth.uid() = submitted_by
  or public.is_moderator('trip-companion')
);
grant select on corrections to authenticated;

-- No insert or update grant. Reporting goes through report_card(), which rate
-- limits; resolution goes through accept_correction(), which is a moderator
-- action. A traveller cannot accept their own report, and that is what stops
-- one person rewriting a shared card unilaterally.

-- Readable by anyone signed in, writable by nobody through the API. Writes
-- arrive from review or the warming job under the service role, so a single
-- user cannot poison the store every other traveller reads.
create policy entity_cards_read on entity_cards for select using (auth.role() = 'authenticated');
grant select on entity_cards to authenticated;
