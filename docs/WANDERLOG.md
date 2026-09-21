# Connecting Wanderlog

Wanderlog has no public API, no API key and no OAuth app. It authenticates with
an Express session cookie, `connect.sid`, which is **full account access**:
whoever holds it can read, create and delete trips and invite people. It cannot
be scoped down and it cannot be revoked per-application.

So Trip Companion never holds one — and, as it turns out, neither does the
sync. The trip document route answers to a trip key rather than to a session,
so there is no cookie in this design at all:

```
your machine (or your GitHub repo)        Trip Companion
┌──────────────────────────────┐          ┌──────────────────┐
│ a trip's view key            │          │                  │
│   ↓                          │          │                  │
│ GET /api/tripPlans/<key>     │          │                  │
│   ↓                          │          │                  │
│ scripts/sync-wanderlog.ts    │──trip──▶ │ Supabase (RLS)   │
│   + your Supabase token      │  data    │                  │
└──────────────────────────────┘          └──────────────────┘
```

Only trip data crosses over, and it arrives authenticated as you, so row-level
security puts it in your account and nobody else's.

The trade this makes is worth stating plainly rather than celebrating. A
session cookie is a credential you can revoke; a trip key is a capability you
cannot. Nothing here can revoke a leaked key — only Wanderlog can, by reissuing
it. What the design buys is that there is far less to leak: a read-only key to
one holiday, rather than a cookie that owns the whole account.

A browser could not do this even if we wanted it to. `wanderlog.com` sends no
`Access-Control-Allow-Origin`, so a page on another origin cannot read the
response; `connect.sid` is `HttpOnly`, so JavaScript cannot read it; and it is
`SameSite=Lax`, so it would not be sent cross-site anyway. Any three of those
would be enough on their own.

## One-time import

The quickest route needs no CLI at all. Signed in to Wanderlog in your browser,
open the trip and then open its document directly:

```
https://wanderlog.com/api/tripPlans/<key>?clientSchemaVersion=2
```

`<key>` is the short id already in the trip's URL, `wanderlog.com/plan/<key>`.
Save the JSON and skip to the `-f` form below. Nothing leaves your browser but
the trip itself.

Or hand the key straight to the sync, which fetches the same document itself:

```bash
node scripts/sync-wanderlog.ts <key> --dry-run
```

**This needs no Wanderlog credential.** The document route serves a trip to
whoever presents its key, signed in or not, so the key is the authorisation.
That is worth knowing in both directions: it is why the scheduled sync holds no
cookie, and it is why a trip key should be treated as a secret. Anyone who has
one can read the whole document — every note, and the budget with it.

There are three keys per trip, and they are not equivalent:

| key | where | what it gives |
| --- | --- | --- |
| view | Share menu | the itinerary, `editKey: null` |
| suggest | Share menu | the same, plus the ability to suggest |
| edit | your address bar while editing | everything, including edit rights |

**Use the view key.** On the trip this was built against it returns an
identical itinerary — every day, every time, same places — and differs only in
dropping an empty Notes section, a Flights section the import does not read,
and a hotel already listed on three days. A leaked view key costs you a read;
a leaked edit key costs you the trip.

> The `wlog` CLI is no longer involved. It could not be: `go install
> github.com/KRamdath/wanderlog-cli/cmd/wlog@latest` names a package the module
> does not contain — `internal/cli` exports `Run` and nothing calls it. Note the
> path is `KRamdath` even though the repository lives at `minormending`, because
> Go resolves by the module path in `go.mod`, not the URL you cloned. If a
> `main.go` ever lands, nothing here needs it.

Then, in this repo:

```bash
export SUPABASE_URL=...            # from your Supabase project
export SUPABASE_ANON_KEY=...
export SUPABASE_REFRESH_TOKEN=...  # "Copy sync token" in the web app

node scripts/sync-wanderlog.ts <trip-key> --dry-run   # see what it found
node scripts/sync-wanderlog.ts <trip-key>
```

Or from a document you already saved:

```bash
node scripts/sync-wanderlog.ts -f trip.json --dry-run
node scripts/sync-wanderlog.ts -f trip.json
```

## What the dry run tells you

```
Trip to Prague: 101 places across 14 sections
  68 in standing lists rather than on a day
  CHECK   South Gardens of Prague Castle — tagged us, unlike the rest of the trip
  legs   59 routed, 35 walk-fallback, 6 inferred
  cards  289 generated
```

Two lines are worth reading rather than counting:

- `SKIPPED` — a place the document named but gave no coordinates. It is left
  out rather than guessed at.
- `CHECK` — a place whose country disagrees with the rest of the trip. Some are
  real: the outbound airport is in another country by definition. Some are
  upstream errors, and Google does tag four Prague places `US`. The import
  reports them and changes nothing, because country drives which language and
  payment cards you get, and picking for you would be inventing a fact about
  your trip.

Places in standing lists — "Places to visit", "Food", "Views" — are imported
but given no day. Their notes are often the record of a decision *against*
going, so staging them as if they were stops would put rejected candidates
ahead of the real itinerary.

## Daily sync

`.github/workflows/sync-wanderlog.yml` runs the same script on a schedule from
**your** repository, with `WANDERLOG_SESSION` in your repository secrets. Set
the five secrets it lists and enable the workflow. Re-syncing a trip updates it
in place rather than piling up copies.

## What the import skips

Wanderlog stores places as Google Places objects, geometry included, so an
imported trip needs **no geocoding**. That removes the single largest source of
error in the paste path: the confirmation step exists because "Meiji Jingu"
resolves to the stadium rather than the shrine, and a Wanderlog trip has no such
ambiguity because the traveller already picked the exact place.

Routing, card generation and the correction loop all run exactly as they do for
a pasted itinerary.

## The fragility worth knowing

`wlog` drives Wanderlog's private web-client API, which can change without
notice. When it does, the paste path still works — copy the text out of the
Wanderlog page and use the normal importer. That is why the integration feeds
the paste path rather than replacing it.
