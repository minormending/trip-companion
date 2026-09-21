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
| Briefing render | Working | Screen and print, with source footnotes |
| Card prose (tiers 2–3) | Deterministic stub | The LLM provider is an interface with a working offline implementation |

## Deploying

`.github/workflows/pages.yml` typechecks, tests, builds `dist/` and publishes it
to GitHub Pages on every push to `main`. Enable Pages with **Source: GitHub
Actions** in the repository settings; the workflow needs no secrets.

```bash
npm run build:web    # dist/index.html + app.js, about 32 kB
npm run preview:web  # build, then serve dist/ on :8788
```

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

**The cache is keyed to the entity, not the trip.** `src/content/keys.ts`
rounds coordinates to ~100m so the same landmark entered two different ways
collapses to one key. This is what makes both cost and quality compound: the
hundredth traveller through a station inherits the ninety-nine earlier
verifications.

**Voice rules are enforced in code, not prompts.** `src/content/voice.ts`
implements the "never" list. Violations are fatal for safety and operational
cards and advisory for colour, because the cost of being wrong differs by two
orders of magnitude between them.

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
