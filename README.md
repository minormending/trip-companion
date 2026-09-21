# Trip Companion

Turns a pasted itinerary into an enriched trip graph, then renders it as a
shareable, printable briefing. Implements v1 of the product spec: import,
routing gap-fill, tiered content cards, and the briefing surface.

## Two ways to run it

The same pipeline runs in Node and in the browser. Nothing in `src/` imports a
platform API directly — persistence is injected, so the CLI writes to disk and
the web build writes to `localStorage`.

- **`src/cli.ts`** — file in, HTML out.
- **`src/server.ts`** — the Node server, with an import form and a share view.
- **`web/`** — the same pipeline compiled for the browser. This is what deploys
  to GitHub Pages: no backend, no keys, geocoding and routing called directly
  from the page.

## Running it

```bash
npm install
npm test
node src/cli.ts fixtures/tokyo.txt --departs 2026-11-03 --contact you@example.com
```

Node 22.6+ required — TypeScript runs natively via type stripping, so there is
no build step.

The server is the v1 surface:

```bash
npm run serve
```

## What is actually wired up

Everything below runs today with no API keys.

| Stage | Status | Notes |
| --- | --- | --- |
| Import | Working | Heuristic parser: day headers, 12/24h times, numbered and bulleted lists, transport lines, rating and URL noise |
| Geocoding | Working | Photon, keyless, English names, biased toward the previous resolved place |
| Ambiguity detection | Working | Flags candidates >300m apart for confirmation before enrichment spends anything |
| Walking routes | Working | OSRM for distance; duration derived, see below |
| Place confirmation | Working | Ambiguous matches are offered as a choice before anything is enriched |
| Guide character | System built, art placeholder | Tone ladder and fold states wired; the mark itself is commissioned work |
| Transit routes | Interface only | No provider configured; legs degrade honestly rather than guessing |
| Photo cards | Working | Computed from NOAA solar position, not generated |
| Tier policy | Working | Operational cards are refused without a source |
| Voice enforcement | Working | The spec's "never" list, enforced in code |
| Entity cache | Working | File-backed, keyed to the place rather than the trip |
| Correction loop | Working | Flags carry a claim; two withdraw a card; review folds the fix back in |
| Offline companion | Working | Service worker shell, installable, in-transit view, manual check-in |
| Geofenced check-in | Not possible on the web | Needs native; see below |
| Briefing render | Working | Screen and print, with source footnotes |
| Operational cards | Working | Recorded OpenStreetMap tags via Overpass, cited per element |
| Background cards | Working | Wikipedia summaries, cited |
| Card prose (remaining kinds) | Deterministic stub | The LLM provider is an interface with a working offline implementation |

## Signing in, and connecting Wanderlog

Signing in is optional. With no backend configured the app is exactly what it
was before one existed — everything local, nothing shared — and that mode is
supported, not degraded. The build even swaps the Supabase client for a stub so
a local-only bundle stays about 52kB rather than 270kB.

Signed in, the same interfaces are backed by Supabase instead of localStorage,
so the domain layer never learns there is a backend. That unblocks three things
that were stuck: corrections reach somebody, the entity cache compounds across
travellers rather than per browser, and a warmed cache survives Overpass being
down.

Several apps share one Supabase project: a shared layer in `public` and a
schema per app, because the free plan allows two projects per account and a
schema is cheaper than a project. See [docs/PLATFORM.md](docs/PLATFORM.md).

```bash
npm run db:migrate trip       # this app's schema
PUBLIC_SUPABASE_URL=... PUBLIC_SUPABASE_ANON_KEY=... npm run build:web
```

The shared `public` layer is migrated from
[apps-db](https://github.com/minormending/apps-db), which owns it, and must be
applied first.

The shared layer is generated from [map-kit](https://github.com/minormending/map-kit)
rather than reinvented, which is also how reporting got a rate limiter: two
reports withdraw a card, so unlimited reporting was a suppression attack, and
`rl_take` was already written.

**Wanderlog connects without us ever holding a Wanderlog credential.** Its
session cookie is full account access and cannot be scoped or revoked per app,
so it stays in your own vault; the CLI reads it locally and pushes only trip
data. See [docs/WANDERLOG.md](docs/WANDERLOG.md) for why a browser could not do
this even if it should, and for the one-time and daily paths.

```bash
node scripts/sync-wanderlog.ts <trip-key> --dry-run
```

An imported Wanderlog trip needs **no geocoding**: its places are Google Places
objects with geometry already attached, so the confirmation step that exists
because "Meiji Jingu" resolves to a stadium has nothing to disambiguate.

## Deploying

`.github/workflows/pages.yml` typechecks, tests, builds `dist/` and publishes it
to GitHub Pages on every push to `main`. Enable Pages with **Source: GitHub
Actions** in the repository settings; the workflow needs no secrets.

```bash
npm run build:web    # dist/index.html + app.<hash>.js, about 40 kB
npm run preview:web  # build, then serve dist/ on :8788
```

The bundle filename carries a hash of its own bytes. Pages serves with
`max-age=600`, so without it a deploy leaves browsers on the previous bundle
for ten minutes and can pair new HTML with old JS.

Two things make a backend unnecessary:

- **Photon and OSRM both send `Access-Control-Allow-Origin: *`**, so the page
  calls them directly. Verify this still holds before assuming a deploy works;
  it is a property of somebody else's servers, not of this code.
- **Sharing travels in the URL fragment.** A finished trip is gzipped and
  base64url-encoded into `#t=`, so a link reproduces the briefing with no
  storage and no server. A 25-stop trip encodes to well under 8 kB. Fragments
  are never sent in an HTTP request, so a shared itinerary does not reach any
  server, including the host.

A shared briefing opens read-only. Corrections belong to the traveller who was
actually there, so the flag control is withheld from someone following a link.

## Design decisions worth knowing

**Operational cards refuse rather than guess.** `RETRIEVAL_REQUIRED` in
`src/domain/types.ts` names the tiers that may never be produced from a model's
own knowledge. A card in those tiers with no sources is dropped and a refusal is
recorded, which the briefing prints verbatim: *not confirmed — check locally.*
An absent card is recoverable; a confidently wrong one is not.

**Some cards are computed, never generated.** `src/content/sun.ts` implements
NOAA solar position. Photo timing, facade lighting and golden hours are pure
functions of latitude, longitude and date, so they cannot hallucinate. Verified
against published sunrise tables to within two minutes.

**The solar day is not the UTC day.** Sampling 00:00–24:00 UTC for a UTC+9
location returns tonight's golden hour followed by *tomorrow morning's*, so "the
last window of the day" is the wrong day. Sampling is anchored to local solar
midnight, derived from longitude, which orders them correctly without needing a
timezone.

**Geofencing is not deferred by choice; the web cannot do it.** The Geolocation
API stops when the page is backgrounded and is not exposed to service workers,
and there is no Geofencing API — only an
[open W3C request](https://github.com/w3c/geolocation/issues/214) for one. So
automatic check-in genuinely requires a native app.

What does not require native is the part Phase 6 actually asks about. Its
question is whether in-situ beats the printed page, and its kill signal is
travellers sticking with the PDF. An offline bundle, an in-transit view and
manual check-in answer that, and the spec already requires manual check-in as
the fallback for when location permission is refused — which it often is. So
the fallback is the baseline, and geofencing is a convenience on top of a
product that has to work without it.

Verified by stopping the dev server and reloading, rather than by simulating
offline: the shell came back from the service worker cache, the saved trip
reopened, and check-in kept working with the origin unreachable.

**The companion shows only what is ahead.** `computeNow` drops everything
behind the traveller — a companion that shows the whole trip is just the
briefing again — and reorders what is left by consequence. Standing on a
platform, a card about where to board outranks the history of the building.

**The correction loop is what makes quality compound.** A flag carries the
traveller's own words and the card body they were looking at, so review can see
what they saw. Two independent reports — or one with evidence — withdraw the
card, and the briefing says it was withdrawn rather than quietly dropping it: a
card that vanishes teaches nothing, one that says it was doubted tells you to
check. Review accepts a correction into the entity store, and every later
briefing through that place inherits it.

One flag is deliberately not enough; travellers mistake a card for the place
next door. Three would leave a wrong operational card standing through most of
a season, which is the failure the loop exists to prevent.

```bash
npm run review -- --list
npm run review -- --import reports.json          # exported from the web app
npm run review -- --accept <id> --body "…"       # folds it into the entity store
```

There is no backend in v1, so reports live in the traveller's browser and leave
it through **Export reports**. That is also the seeding path the spec describes
for cold start.

**The cache is keyed to the entity, not the trip.** `src/content/keys.ts`
rounds coordinates to ~100m so the same landmark entered two different ways
collapses to one key. This is what makes both cost and quality compound: the
hundredth traveller through a station inherits the ninety-nine earlier
verifications.

**Voice rules are enforced in code, not prompts.** `src/content/voice.ts`
implements the "never" list. Violations are fatal for safety and operational
cards and advisory for colour, because the cost of being wrong differs by two
orders of magnitude between them.

**Tier-1 cards come from recorded facts, not from a model.** `OverpassProvider`
reads OpenStreetMap tags for the exact element Photon resolved (`fee`, `charge`,
`payment:*`, `opening_hours`, `wheelchair`) and cites the element's OSM URL.
Nothing is inferred from what is usually true elsewhere: no tag means no card,
and the briefing says the fact could not be confirmed. On the Tokyo fixture this
produces twelve sourced operational cards that check out against reality.

**Overpass is not dependable enough to sit on the request path.** It is donated
community capacity and sheds load hard — 504s lasting tens of minutes are
routine. Mirrors are tried in turn with one retry, but the real answer is the
entity cache: once a place's facts are cached they survive the source being
down, which turns the spec's pre-launch cache warming from a growth tactic into
an operational requirement.

**A source that is unreachable must not look like one with nothing to say.**
An early version swallowed a 406 from Overpass, and the result was
indistinguishable from "this place has no recorded facts" — the tier policy
correctly refused the cards, and the reason was invisible. `prime` failures are
now caught in `generateCards` and reported as `sourceProblems`.

**OSM data is ODbL.** Attribution is required and is in the page footer. The
share-alike terms bite on a derived *database*, which the entity cache arguably
becomes. This needs legal review before shipping commercially.

**The OSRM demo server lies about walking time.** Its public instance is built
with a single car profile and ignores the profile in the URL: `/foot`,
`/driving` and `/cycling` return byte-identical routes at about 20km/h. The
distances follow real streets and are usable; the durations are driving times.
So `src/routing/osrm.ts` derives walking duration from distance at 4.5km/h and
ignores the server's clock. Point it at an instance actually built with a foot
profile and pass `trustDurations: true`.

**Confirmation happens before enrichment, not after.** `resolveTrip` stops
after geocoding; `enrichTrip` does the routing and cards. Ambiguous places are
offered as a choice in between, so nothing is ever computed against the wrong
building. Choosing the shrine rather than the stadium turns a 2.3km transit leg
into a walk, which is the whole point.

**The guide's art is a placeholder and lives in one constant.**
`src/render/guide.ts` holds the fold system: `resting` for quiet tiers,
`bird`, `plane` and `boat` on legs by mode. Folds are narrowed to forms people
recognise as origami — rail, bus and metro share the bird, because a folded
"train carriage" reads as a generic box at 20px and forcing a fold per mode
makes the system feel arbitrary. Safety cards render no guide at all, and the
print stylesheet drops it entirely.

**Routers supply the skeleton, content supplies the texture.** Mode is guessed
from straight-line distance before any router is called, so a 400m hop never
burns a paid transit request. When transit is unavailable but the distance is
walkable, a real walking route is shown instead of a straight-line estimate.

## Layout

```
src/
  domain/      trip graph types, staleness, traversal
  import/      itinerary parser and trip builder
  geo/         geocoding, single-timezone country map
  routing/     provider interface, OSRM, transit stub, gap-fill
  content/     tiers, voice rules, solar math, card generation
  cache/       entity-keyed card store
  render/      briefing HTML and print stylesheet
  pipeline.ts  orchestration
  cli.ts       file in, HTML out
  server.ts    import form, briefing, share view, flag endpoint
web/           browser entry, URL-fragment sharing
scripts/       esbuild bundle, static preview server
```

## Not built

Native companion, offline bundle, geofenced check-in, phrase audio, avatar and
guide art, illustrated boarding diagrams, and any paid provider integration.
See the spec for where these sit in the phasing.
