# Trip Companion

Turns a pasted itinerary into an enriched trip graph, then renders it as a
shareable, printable briefing. Implements v1 of the product spec: import,
routing gap-fill, tiered content cards, and the briefing surface.

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
| Walking routes | Working | OSRM, keyless |
| Transit routes | Interface only | No provider configured; legs degrade honestly rather than guessing |
| Photo cards | Working | Computed from NOAA solar position, not generated |
| Tier policy | Working | Operational cards are refused without a source |
| Voice enforcement | Working | The spec's "never" list, enforced in code |
| Entity cache | Working | File-backed, keyed to the place rather than the trip |
| Briefing render | Working | Screen and print, with source footnotes |
| Card prose (tiers 2–3) | Deterministic stub | The LLM provider is an interface with a working offline implementation |

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
```

## Not built

Native companion, offline bundle, geofenced check-in, phrase audio, avatar and
guide art, illustrated boarding diagrams, and any paid provider integration.
See the spec for where these sit in the phasing.
