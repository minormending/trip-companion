import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fetchOsmTags, findOsmIdentity, namesMatch } from '../src/geo/osmLookup.ts'
import { OsmApiProvider, osmCardCount, resolvePlaces } from '../src/content/providers/osmApi.ts'
import type { Card, Place } from '../src/domain/types.ts'
import type { CardRequest } from '../src/content/providers/types.ts'

const CATHEDRAL: Place = {
  id: 'p:vitus',
  name: 'St. Vitus Cathedral',
  coords: { lat: 50.0908918, lon: 14.4005114 },
}

/** Shaped from a real Photon answer with lang=en. */
const photon = (features: Array<{ name: string; osm_type: string; osm_id: number }>) =>
  (async () => ({ ok: true, json: async () => ({ features: features.map((f) => ({ properties: f })) }) })) as unknown as typeof fetch

test('names match through accents, punctuation and a trailing description', () => {
  // The document and OSM rarely write a place the same way.
  assert.ok(namesMatch('Bistró Loreta', 'Bistro Loreta'))
  assert.ok(namesMatch('Crème de la Crème - zmrzlinový salon', 'Crème de la Crème'))
  assert.ok(namesMatch('Vinohradský Parlament Restaurant', 'Vinohradský parlament'))
})

test('a name matches when one side carries a word the other leaves out', () => {
  // Every one of these is a real stop that went unmatched while names were
  // compared as prefixes, and the missing word is never at the front.
  assert.ok(namesMatch('Hotel Royal Plaza', 'Royal plaza'))
  assert.ok(namesMatch('Prague Astronomical Clock', 'Astronomical Clock'))
  assert.ok(namesMatch('State Opera', 'Prague State Opera'))
  assert.ok(namesMatch('Přátelé coffee & wine friends', 'Přátelé Wine Friends'))
  assert.ok(
    namesMatch(
      'National Gallery Prague – Schwarzenberg Palace',
      'National Gallery in Prague - Schwarzenberg Palace',
    ),
  )
  assert.ok(
    namesMatch(
      'National Gallery Prague - Convent of St. Agnes',
      'National Gallery in Prague - Convent of St Agnes of Bohemia',
    ),
  )
})

test('saint is spelled four ways and means one thing', () => {
  assert.ok(namesMatch('St. Vitus Cathedral', 'Saint Vitus Cathedral'))
  assert.ok(namesMatch('Church of St Giles', 'Saint Giles'))
  assert.ok(namesMatch('Kostel sv. Jiljí', 'Kostel Saint Jiljí'))
})

test('one long word may be a character out, and no more', () => {
  // OSM writes the Prague landmark with a C. Nothing else in the trip needed
  // this, so the floor is set where it stops being a guess.
  assert.ok(namesMatch('Klementinum', 'Clementinum'))
  // Two characters out is a different word: Czech adjective, German name.
  assert.equal(namesMatch('Šternberský Palace', 'Sternberg Palace'), false)
  assert.equal(namesMatch('Kampa', 'Kampu'), false)
})

test('names do not match on being nearby', () => {
  // The café next door is not the cathedral, and giving it the cathedral's
  // card payments is the one failure this tier exists to prevent.
  assert.equal(namesMatch('St. Vitus Cathedral', 'Starbucks'), false)
  assert.equal(namesMatch('Old Town Square', 'Prague Meridian'), false)
  // Two-letter Czech names are whole place names and must not carry a match.
  assert.equal(namesMatch('U Fleků', 'U'), false)
  assert.equal(namesMatch('Na Příkopě', 'Na'), false)
  assert.equal(namesMatch('', 'Anything'), false)
})

test('a shared word has to be doing some work', () => {
  // A supermarket called Albert is a real stop on this trip. Six characters is
  // not enough to hand it somebody else's opening hours.
  assert.equal(namesMatch('Albert', 'Albert Einstein'), false)
  assert.equal(namesMatch('Old Town', 'Old Town Hall Tower'), false)
  // Eight is, which is what "Kolacherie Kampus Hybernská" needs to find the
  // bakery OSM simply calls "Kolacherie".
  assert.ok(namesMatch('Kolacherie Kampus Hybernská', 'Kolacherie'))
  assert.ok(namesMatch('Grébovka (Havlíčkovy sady)', 'Grébovka'))
})

test('an exact match is preferred over a prefix that appears first', () => {
  const found = findOsmIdentity(CATHEDRAL, {
    fetchImpl: photon([
      { name: 'St. Vitus Cathedral South Tower', osm_type: 'W', osm_id: 1 },
      { name: 'St. Vitus Cathedral', osm_type: 'W', osm_id: 2 },
    ]),
  })
  return found.then((identity) => {
    assert.equal(identity?.id, 2, 'the exact name wins even though it is second')
    assert.equal(identity?.kind, 'way')
  })
})

test('nothing recognisable yields nothing rather than the nearest thing', async () => {
  const identity = await findOsmIdentity(CATHEDRAL, {
    fetchImpl: photon([
      { name: 'Prague Castle', osm_type: 'W', osm_id: 1 },
      { name: 'Zvonová věž', osm_type: 'N', osm_id: 2 },
    ]),
  })
  assert.equal(identity, null)
})

/** Answers the reverse lookup and the name search differently, with geometry. */
const twoStep = (
  reverse: Array<{ name: string; osm_type: string; osm_id: number }>,
  search: Array<{ name: string; osm_type: string; osm_id: number; lat: number; lon: number }>,
) =>
  (async (url: string) => ({
    ok: true,
    json: async () => ({
      features: String(url).includes('/reverse')
        ? reverse.map((f) => ({ properties: f }))
        : search.map(({ lat, lon, ...props }) => ({
            properties: props,
            geometry: { coordinates: [lon, lat] },
          })),
    }),
  })) as unknown as typeof fetch

test('a place the reverse lookup cannot see is searched for by name', async () => {
  // Reverse returns the eight nearest features, which inside an airport are
  // eight airport shops. Václav Havel and JFK both resolve this way and no
  // other.
  const identity = await findOsmIdentity(CATHEDRAL, {
    fetchImpl: twoStep(
      [{ name: 'Aelia Dutyfree', osm_type: 'N', osm_id: 1 }],
      [{ name: 'St. Vitus Cathedral', osm_type: 'R', osm_id: 2, lat: 50.0909, lon: 14.4005 }],
    ),
  })
  assert.equal(identity?.id, 2)
  assert.equal(identity?.kind, 'relation')
})

test('a searched name on the wrong continent is refused', async () => {
  // Searching for "Farmers' Saturday market" returns marketplaces in Vienna
  // and Los Angeles, every one of them a perfect name match. Distance is the
  // only thing that keeps them out of a Prague briefing.
  const identity = await findOsmIdentity(CATHEDRAL, {
    fetchImpl: twoStep(
      [{ name: 'Vikářská', osm_type: 'W', osm_id: 1 }],
      [{ name: 'St. Vitus Cathedral', osm_type: 'N', osm_id: 2, lat: 34.0522, lon: -118.2437 }],
    ),
  })
  assert.equal(identity, null)
})

test('a searched answer with no coordinates is refused', async () => {
  // Nothing to check it against is not the same as checking it and passing.
  const identity = await findOsmIdentity(CATHEDRAL, {
    fetchImpl: (async (url: string) => ({
      ok: true,
      json: async () => ({
        features: String(url).includes('/reverse')
          ? []
          : [{ properties: { name: 'St. Vitus Cathedral', osm_type: 'N', osm_id: 2 } }],
      }),
    })) as unknown as typeof fetch,
  })
  assert.equal(identity, null)
})

test('the search is not made when the reverse lookup already answered', async () => {
  let calls = 0
  await findOsmIdentity(CATHEDRAL, {
    fetchImpl: (async (url: string) => {
      calls++
      assert.ok(String(url).includes('/reverse'), 'only the reverse lookup should be asked')
      return { ok: true, json: async () => ({ features: [{ properties: { name: 'St. Vitus Cathedral', osm_type: 'W', osm_id: 1 } }] }) }
    }) as unknown as typeof fetch,
  })
  assert.equal(calls, 1)
})

test('an unreachable Photon is null, not a throw', async () => {
  const boom = (async () => {
    throw new Error('ENOTFOUND')
  }) as unknown as typeof fetch
  assert.equal(await findOsmIdentity(CATHEDRAL, { fetchImpl: boom }), null)
})

test('tags come back from the element the identity names', async () => {
  const tags = await fetchOsmTags(
    { kind: 'node', id: 331959659, matchedName: 'U Fleků' },
    {
      fetchImpl: (async (url: string) => {
        assert.match(String(url), /\/node\/331959659\.json$/)
        return { ok: true, json: async () => ({ elements: [{ tags: { 'payment:cash': 'yes' } }] }) }
      }) as unknown as typeof fetch,
    },
  )
  assert.deepEqual(tags, { 'payment:cash': 'yes' })
})

test('the provider turns real tags into the operational cards', async () => {
  // Captured from node/331959659, the pub the trip actually visits.
  const resolved = new Map([
    [
      'p:fleku',
      {
        identity: { kind: 'node' as const, id: 331959659, matchedName: 'U Fleků' },
        tags: { 'payment:cash': 'yes', 'payment:contactless': 'yes', opening_hours: 'Mo-Su 10:00-23:00' },
      },
    ],
  ])
  const provider = new OsmApiProvider(resolved, '2026-09-22')
  const ask = (kind: string): CardRequest =>
    ({
      kind,
      entityKey: 'place:p:fleku',
      context: { subject: 'place', place: { id: 'p:fleku', name: 'U Fleků', coords: { lat: 0, lon: 0 } } },
    }) as CardRequest

  const paying = await provider.draft(ask('how_to_pay'))
  assert.match(paying?.body ?? '', /Contactless works/)
  assert.deepEqual(paying?.sources, [
    {
      url: 'https://www.openstreetmap.org/node/331959659',
      title: 'OpenStreetMap node 331959659',
      retrieved: '2026-09-22',
    },
  ])

  const hours = await provider.draft(ask('hours'))
  assert.match(hours?.body ?? '', /Mo-Su 10:00-23:00/)

  // A place it never resolved says nothing at all.
  const unknown = await provider.draft({
    kind: 'how_to_pay',
    entityKey: 'place:other',
    context: { subject: 'place', place: { id: 'other', name: 'Elsewhere', coords: { lat: 0, lon: 0 } } },
  } as CardRequest)
  assert.equal(unknown, null)
})

test('a place appearing on several days is looked up once', async () => {
  let calls = 0
  const fetchImpl = (async (url: string) => {
    calls++
    if (String(url).includes('photon')) {
      return { ok: true, json: async () => ({ features: [{ properties: { name: 'U Fleků', osm_type: 'N', osm_id: 7 } }] }) }
    }
    return { ok: true, json: async () => ({ elements: [{ tags: { 'payment:cash': 'yes' } }] }) }
  }) as unknown as typeof fetch

  const same = { name: 'U Fleků', coords: { lat: 50.0788023, lon: 14.4169978 } }
  const resolved = await resolvePlaces(
    [
      { id: 'a', ...same },
      { id: 'b', ...same },
      { id: 'c', ...same },
    ] as Place[],
    { fetchImpl, minIntervalMs: 0 },
  )

  assert.equal(resolved.size, 3, 'every copy gets the answer')
  assert.equal(calls, 2, 'one Photon call and one OSM call, not three of each')
})

test('resolution stops when it is asked to', async () => {
  const controller = new AbortController()
  controller.abort()
  const resolved = await resolvePlaces([CATHEDRAL], { signal: controller.signal, minIntervalMs: 0 })
  assert.equal(resolved.size, 0)
})

test('OSM contributions are counted from provenance, not from a card delta', () => {
  // The delta is zero on a warm cache — the first pass already serves OSM's
  // cards from the entity cache — and the line then claimed nothing was found
  // over a briefing with six OSM cards in it.
  const resolved = new Map([
    ['p:vitus', { identity: { kind: 'way' as const, id: 123, matchedName: 'St. Vitus Cathedral' }, tags: {} }],
  ])
  const sourced = (url: string): Card => ({
    id: `card:how_to_pay:${url}`,
    attachesTo: { kind: 'place', placeId: 'p:vitus' },
    kind: 'how_to_pay',
    title: 'St. Vitus Cathedral',
    body: 'Cards accepted.',
    provenance: { tier: 'operational', sources: [{ url, title: 't', retrieved: '2026-09-22' }], verifiedAt: '2026-09-22', confidence: 0.9 },
  })

  assert.equal(
    osmCardCount(
      [
        sourced('https://www.openstreetmap.org/way/123'),
        sourced('https://en.wikipedia.org/wiki/St._Vitus_Cathedral'),
        { ...sourced('https://www.openstreetmap.org/way/123'), id: 'card:hours' },
      ],
      resolved,
    ),
    2,
  )
})

test('an OSM element nobody resolved is not counted as ours', () => {
  // Overpass cites openstreetmap.org too. Only the elements this pass actually
  // looked up are its own work.
  const resolved = new Map([
    ['p:vitus', { identity: { kind: 'way' as const, id: 123, matchedName: 'St. Vitus Cathedral' }, tags: {} }],
  ])
  const card: Card = {
    id: 'card:orientation:p:other',
    attachesTo: { kind: 'place', placeId: 'p:other' },
    kind: 'orientation',
    title: 'Somewhere else',
    body: 'Step-free.',
    provenance: {
      tier: 'practical',
      sources: [{ url: 'https://www.openstreetmap.org/node/999', title: 't', retrieved: '2026-09-22' }],
      verifiedAt: '2026-09-22',
      confidence: 0.9,
    },
  }
  assert.equal(osmCardCount([card], resolved), 0)
})
