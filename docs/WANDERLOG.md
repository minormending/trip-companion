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

## Importing from the site

The site cannot call Wanderlog. `wanderlog.com` returns no
`Access-Control-Allow-Origin` on any route, and its preflight answers
`allow: GET,HEAD,DELETE` with no CORS headers at all, so a browser refuses to
hand the page the response body whatever it presents. That is a property of the
browser rather than of the HTTP client — writing the request in JavaScript
instead of Go changes nothing, which is worth knowing before anybody tries.

So a function asks on the page's behalf:

```
browser ──key──▶ wanderlog-trip ──▶ wanderlog.com
        ◀─json──               ◀──
```

It takes a trip key and nothing else. There is no URL parameter, because a
proxy that forwards a caller's URL is a server-side request forgery with extra
steps, and the key is matched against `^[a-z0-9]{6,40}$` before any request is
made.

Deploy it with the Supabase CLI, from this repository:

```bash
npx supabase login
npx supabase link --project-ref <your project ref>
npx supabase functions deploy wanderlog-trip --no-verify-jwt
```

`--no-verify-jwt` leaves it open to anonymous callers, which is deliberate:
importing a trip is something the app does before anybody signs in, and a key
the caller already holds is not a secret this function is protecting. Drop the
flag to require a session instead — nothing in the page needs changing, because
it already sends whichever token it has.

The key is stored in local storage on the device that imported, and nowhere
else. That means pasting it once per device, and it means nothing
Wanderlog-related is ever written to the database.

## Signing in

Google, and only Google. It replaced a magic link that people reported being
confused by, and the confusion was structural rather than a wording problem: a
sign-in that asks for an address, sends you to your inbox, and depends on you
returning to the same browser has three places to lose somebody.

The provider has to be turned on before the button does anything, and neither
step is visible from this repository:

1. In Google Cloud, create an OAuth 2.0 client (type: web application) and add
   `https://<project ref>.supabase.co/auth/v1/callback` as an authorised
   redirect URI.
2. In the Supabase dashboard, under Authentication → Providers → Google, paste
   the client id and secret and enable it.
3. Under Authentication → URL Configuration, add the site's own origin to the
   redirect allow list, or the round trip lands on a Supabase error page rather
   than back on the app.

Until that is done the button reports the provider is not enabled, which is
what Supabase returns, rather than failing silently.

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
