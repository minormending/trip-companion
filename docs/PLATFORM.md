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

## The shared layer is not here any more

`public` — profiles, rate limiting, the app registry, the moderation queue —
is owned by [apps-db](https://github.com/minormending/apps-db), along with
provisioning, the schema-exposure script and a nightly audit that checks the
running database is still locked down.

It used to live in this repo, which was first into the database rather than its
owner. Migrate the shared layer from there before this app's schema: `trip`
references `profiles`, `rate_limit` and `apps`.
