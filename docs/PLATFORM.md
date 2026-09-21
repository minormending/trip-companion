# One database, several apps

Supabase's free plan allows **two active projects per account** — across all
organisations, so making another organisation does not help. Paused projects do
not count against it.

Rather than spend a slot per app, this database holds a shared layer in `public`
and one schema per app. Adding an app costs a schema, not a project.

```
shared project
├── public      profiles · rate_limit · apps · moderators · flags · feedback
├── trip        trip-companion
└── restroom    restroom-map (to be moved in)
```

## Why schemas and not a shared `public`

orchard-map's `provision-supabase.mjs` argues against putting a second app into
an existing database, and it is right about what it describes: those migrations
collide on `profiles`, `flags`, `feedback`, `rate_limit` and `reports`, and two
statements in the grants migration would reach into a live application.

Every one of those is a collision **in `public`**. A schema per app removes them
while keeping the one thing worth sharing — a single identity, one rate limiter,
one moderation queue.

What you give up: apps share an auth pool, so signing into one signs you into
all of them; and the free tier's 500 MB is shared. Both are fine for a portfolio
and would not be for products with separate audiences.

## Migration sets

`supabase/platform/` is the shared layer, applied **once per database**.
`supabase/trip/` is this app. Each set tracks itself:

```bash
node scripts/db.mjs status  platform
node scripts/db.mjs migrate platform   # once per database, before any app
node scripts/db.mjs status  trip
node scripts/db.mjs migrate trip
```

The live database is `minormending-apps` (`gwlgmuiorzwfsimlfvuk`), us-east-1.
Auth is per project and therefore shared: `scripts/configure-auth.mjs` holds a
redirect allow list covering every app's site, not just this one.

map-kit's runner creates `schema_migrations` unqualified, so it lands wherever
`search_path` points. `db.mjs` points it at each set's own schema, which is what
stops two apps colliding — both number their migrations from `0001`.

The shared files are generated from map-kit rather than copied by hand:

```bash
npm run gen:platform
```

`0003_apps.sql` and `0004_moderation.sql` are ours. Moderation deviates from
map-kit in two ways, both forced by sharing: an `app` column, and no cross-app
check constraint on `target_type` — map-kit substitutes `{{TARGET_TYPES}}` into
a check, which would have to list every target type of every app, so adding an
app would mean altering a constraint every other app depends on.

Worth contributing back to map-kit as a multi-app variant.

## Adding an app

1. `supabase/<app>/0001_schema.sql`: create the schema, grant `usage`, revoke
   default table privileges, and insert a row into `public.apps`.
2. Add the set to `SETS` in `scripts/db.mjs`.
3. Expose the schema to PostgREST, and set `db: { schema: '<app>' }` in that
   app's Supabase client. A schema that exists in Postgres is invisible to the
   API until it is listed, and the failure is a confusing 404 from a table you
   can see in the dashboard. It looks like a dashboard-only setting but it is a
   Management API field:

   ```bash
   node scripts/expose-schema.mjs <app> --apply
   ```
4. Writes that need checking go through `security definer` functions, not table
   grants. `public.rl_take()` is already there; namespace your keys with the app
   slug so a noisy app cannot spend another's budget.

## Moving restroom-map in

Pause it first — a paused project stops counting against the limit, and the data
stays put until you export it.

1. `pg_dump` the old project, schema-only and data separately.
2. Its app tables become `restroom.*`. Its `public.profiles`, `flags`,
   `feedback` and `rate_limit` are **dropped**, not moved: the shared layer
   already has them.
3. Remap `profiles.id` — the user ids differ, because `auth.users` is per
   project. Anyone who signed into the old project has to sign in again, and
   their submissions need their `reporter_id` remapped by email or orphaned to
   null. This is the expensive part and the reason to pick the destination
   database before an app has users, not after.
4. Restore into `restroom`, register it in `public.apps`, add its schema to the
   exposed list, repoint `PUBLIC_SUPABASE_URL`.
5. Keep the old project paused rather than deleted until the new one has served
   real traffic.

Step 3 is why trip-companion is going in first: it has no users yet, so it costs
nothing to be the one that proves the shape.
