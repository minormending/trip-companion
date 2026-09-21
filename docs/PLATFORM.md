# This app in the shared database

trip-companion owns the `trip` schema of a database shared with other apps,
over a `public` layer holding profiles, rate limiting and the moderation queue.

**How the arrangement works, how to add an app, and how to move one in are in
[map-kit's runbook](https://github.com/minormending/map-kit/blob/main/docs/SHARED-DATABASE.md).**
It is the shared knowledge, and it lives with the shared code rather than in
one tenant's repo. What follows is only what is specific to this app.

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

## Platform migrations live here

`supabase/platform/` is applied once per database and is shared by every app in
it, so a change here reaches restroom-map too. The shared SQL is generated from
map-kit rather than written by hand:

```bash
npm run gen:platform
```

`0003_apps.sql`, `0004_moderation.sql`, `0005_lock_shared_layer.sql` and
`0006_target_types.sql` are ours. Moderation deviates from the kit in two ways,
both forced by sharing: an `app` column, and per-app `target_types` on
`public.apps` instead of a single check constraint listing every app's types.

That this app happens to hold the platform migrations is history — it was first
into the database. If a third app arrives and that feels wrong, the right home
is map-kit, alongside the SQL they are generated from.
