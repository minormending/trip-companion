# Connecting Wanderlog

Wanderlog has no public API, no API key and no OAuth app. It authenticates with
an Express session cookie, `connect.sid`, which is **full account access**:
whoever holds it can read, create and delete trips and invite people. It cannot
be scoped down and it cannot be revoked per-application.

So Trip Companion never holds one.

## How it actually works

```
your machine (or your GitHub repo)        Trip Companion
┌──────────────────────────────┐          ┌──────────────────┐
│ connect.sid                  │          │                  │
│   ↓                          │          │                  │
│ wlog trip get <key>          │          │                  │
│   ↓                          │          │                  │
│ scripts/sync-wanderlog.ts    │──trip──▶ │ Supabase (RLS)   │
│   + your Supabase token      │  data    │                  │
└──────────────────────────────┘          └──────────────────┘
```

The credential stays in a vault you control. Only trip data crosses over, and
it arrives authenticated as you, so row-level security puts it in your account
and nobody else's.

A browser could not do this even if we wanted it to. `wanderlog.com` sends no
`Access-Control-Allow-Origin`, so a page on another origin cannot read the
response; `connect.sid` is `HttpOnly`, so JavaScript cannot read it; and it is
`SameSite=Lax`, so it would not be sent cross-site anyway. Any three of those
would be enough on their own.

## One-time import

Install the CLI and sign in once — see
[wanderlog-cli](https://github.com/minormending/wanderlog-cli) for the auth
options, including the cookie-paste route for Google and Apple accounts.

```bash
go install github.com/KRamdath/wanderlog-cli/cmd/wlog@latest
wlog auth login --email you@example.com     # or --cookie for SSO accounts
wlog trip list                              # find the key
```

Then, in this repo:

```bash
export SUPABASE_URL=...            # from your Supabase project
export SUPABASE_ANON_KEY=...
export SUPABASE_REFRESH_TOKEN=...  # "Copy sync token" in the web app

node scripts/sync-wanderlog.ts <trip-key> --dry-run   # see what it found
node scripts/sync-wanderlog.ts <trip-key>
```

No Wanderlog account at all? The document works on its own:

```bash
wlog trip get <key> > trip.json
node scripts/sync-wanderlog.ts -f trip.json
```

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
