import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  OverpassProvider,
  accessFrom,
  hoursFrom,
  payingFrom,
  type Tags,
} from '../src/content/providers/overpass.ts'
import { WikipediaProvider } from '../src/content/providers/wikipedia.ts'
import { generateCards } from '../src/content/generate.ts'
import { place, trip } from './helpers.ts'

const SENSOJI = place('p1', 'Sensoji Temple', 35.7148, 139.7967, {
  osmId: 173154847,
  osmKind: 'way',
})

// The real tag set, trimmed to what the provider reads.
const SENSOJI_TAGS: Tags = {
  fee: 'no',
  opening_hours: 'Mo-Su 06:00-17:00',
  wheelchair: 'yes',
  'name:en': 'Sensō-ji',
}

function overpassWith(tags: Record<string, Tags>): OverpassProvider {
  return new OverpassProvider({
    async fetcher() {
      return Object.entries(tags).map(([key, t]) => {
        const [type, id] = key.split('/')
        return { type: type ?? 'way', id: Number(id), tags: t }
      })
    },
  })
}

test('payment wording is read off recorded tags, never inferred', () => {
  assert.equal(payingFrom({ fee: 'no' }), 'Free to enter.')
  assert.equal(payingFrom({ fee: 'yes', charge: '¥500' }), 'Entry costs ¥500.')
  assert.equal(
    payingFrom({ fee: 'yes' }),
    'There is an entry fee, but the amount is not recorded.',
  )
  assert.equal(
    payingFrom({ 'payment:coins': 'yes', 'payment:notes': 'no' }),
    'The machine takes coins only, not notes.',
  )
  assert.equal(payingFrom({ 'payment:cash': 'only' }), 'Cash only.')
  assert.equal(payingFrom({ 'payment:contactless': 'no' }), 'Contactless does not work here.')
})

test('no payment tags produces no card rather than a guess', () => {
  assert.equal(payingFrom({ name: 'Somewhere' }), null)
  assert.equal(payingFrom({}), null)
})

test('opening hours pass through verbatim rather than being half-parsed', () => {
  assert.equal(hoursFrom({ opening_hours: 'Mo-Su 06:00-17:00' }), 'Opening hours are recorded as Mo-Su 06:00-17:00')
  assert.equal(hoursFrom({ opening_hours: '24/7' }), 'Open at all hours')
  assert.equal(hoursFrom({}), null)
})

test('access wording distinguishes limited from absent', () => {
  assert.equal(accessFrom({ wheelchair: 'yes' }), 'Step-free access is recorded here')
  assert.equal(accessFrom({ wheelchair: 'limited' }), 'Step-free access is recorded as limited')
  assert.equal(accessFrom({ wheelchair: 'no' }), 'No step-free access is recorded here')
  assert.equal(accessFrom({}), null)
})

test('an operational card from OSM carries a citable source and is published', async () => {
  const provider = overpassWith({ 'way/173154847': SENSOJI_TAGS })
  const { trip: out, report } = await generateCards(trip([SENSOJI]), { providers: [provider] })

  const paying = out.cards.find((c) => c.kind === 'how_to_pay')
  assert.ok(paying, 'the card is published, not refused')
  assert.equal(paying.provenance.tier, 'operational')
  assert.equal(paying.body, 'Free to enter.')
  assert.equal(paying.provenance.sources[0]?.url, 'https://www.openstreetmap.org/way/173154847')
  assert.equal(report.refusals.filter((r) => r.kind === 'how_to_pay').length, 0)

  assert.ok(out.cards.find((c) => c.kind === 'hours'), 'opening hours become their own card')
})

test('a place with no OSM identity gets no cards from Overpass', async () => {
  const provider = overpassWith({ 'way/173154847': SENSOJI_TAGS })
  const anonymous = place('p9', 'Somewhere', 0, 0)
  const { trip: out } = await generateCards(trip([anonymous]), { providers: [provider] })
  assert.equal(out.cards.filter((c) => c.provenance.tier === 'operational').length, 0)
})

test('an unreachable Overpass refuses rather than inventing', async () => {
  const provider = new OverpassProvider({
    async fetcher() {
      throw new Error('network down')
    },
  })
  const { trip: out, report } = await generateCards(trip([SENSOJI]), { providers: [provider] })
  assert.equal(out.cards.filter((c) => c.provenance.tier === 'operational').length, 0)
  assert.ok(report.refusals.some((r) => r.kind === 'how_to_pay'))
})

test('the whole trip is fetched in one Overpass request', async () => {
  let calls = 0
  let sent = ''
  const provider = new OverpassProvider({
    async fetcher(query) {
      calls++
      sent = query
      return []
    },
  })
  const places = [
    place('p1', 'A', 0, 0, { osmId: 1, osmKind: 'way' }),
    place('p2', 'B', 0, 1, { osmId: 2, osmKind: 'node' }),
    place('p3', 'C', 0, 2, { osmId: 3, osmKind: 'relation' }),
  ]
  await generateCards(trip(places), { providers: [provider] })

  assert.equal(calls, 1, 'community infrastructure is asked once per trip')
  assert.match(sent, /way\(1\);/)
  assert.match(sent, /node\(2\);/)
  assert.match(sent, /relation\(3\);/)
})

test('Overpass is not called at all when no place has an OSM identity', async () => {
  let calls = 0
  const provider = new OverpassProvider({
    async fetcher() {
      calls++
      return []
    },
  })
  await generateCards(trip([place('p1', 'A', 0, 0)]), { providers: [provider] })
  assert.equal(calls, 0)
})

test('Wikipedia answers history and refuses to fill an operational card', async () => {
  const provider = new WikipediaProvider({
    async fetcher() {
      return {
        title: 'Sensō-ji',
        extract: 'It is an ancient Buddhist temple in Asakusa. It is Tokyo’s oldest temple. A third sentence that should be trimmed.',
        url: 'https://en.wikipedia.org/wiki/Sens%C5%8D-ji',
      }
    },
  })
  const { trip: out, report } = await generateCards(trip([SENSOJI]), { providers: [provider] })

  const history = out.cards.find((c) => c.kind === 'history')
  assert.ok(history)
  assert.equal(history.provenance.tier, 'colour')
  assert.ok(!history.body.includes('third sentence'), 'trimmed to two sentences')
  assert.match(history.provenance.sources[0]?.url ?? '', /wikipedia\.org/)

  // Wikipedia is not a good enough source for a claim that strands someone.
  assert.ok(report.refusals.some((r) => r.kind === 'how_to_pay'))
  assert.equal(out.cards.filter((c) => c.provenance.tier === 'operational').length, 0)
})

test('a disambiguation page is not an answer about this place', async () => {
  const provider = new WikipediaProvider({
    async fetcher() {
      return null
    },
  })
  const { trip: out } = await generateCards(trip([SENSOJI]), { providers: [provider] })
  assert.equal(out.cards.filter((c) => c.kind === 'history').length, 0)
})

test('a sourced provider is preferred over the generic fallback', async () => {
  const { DeterministicProvider } = await import('../src/content/providers/deterministic.ts')
  const overpass = overpassWith({ 'way/173154847': SENSOJI_TAGS })
  const wiki = new WikipediaProvider({
    async fetcher() {
      return { title: 'Sensō-ji', extract: 'An ancient temple.', url: 'https://en.wikipedia.org/wiki/X' }
    },
  })
  const { trip: out } = await generateCards(trip([SENSOJI]), {
    providers: [overpass, wiki, new DeterministicProvider()],
  })
  const history = out.cards.find((c) => c.kind === 'history')
  assert.equal(history?.body, 'An ancient temple.', 'not the "no verified history" fallback')
  assert.ok((history?.provenance.sources.length ?? 0) > 0)
})

test('sentence trimming survives abbreviations', async () => {
  const { trimToSentences } = await import('../src/content/providers/wikipedia.ts')

  // The real failure: a naive split left "Tokyo Skytree , a.k." as the card.
  const skytree = 'Tokyo Skytree, a.k.a. Tokyo Sky Tree, is a broadcasting and observation tower in Sumida. It became the tallest structure in Japan in 2010.'
  const trimmed = trimToSentences(skytree, 2)
  assert.ok(trimmed.length > 40, `got ${trimmed.length} chars: ${trimmed}`)
  assert.ok(trimmed.includes('observation tower'), 'keeps going past the abbreviation')

  // A normal two-sentence extract still stops at two.
  const normal = 'It is an ancient Buddhist temple in Asakusa district. It is the oldest temple in the city. A third sentence.'
  assert.ok(!trimToSentences(normal, 2).includes('third sentence'))

  assert.equal(trimToSentences('No terminator here', 2), 'No terminator here')
  assert.equal(trimToSentences('', 2), '')
})

test('the canonical name is preferred over the traveller wording for lookups', async () => {
  const asked: string[] = []
  const provider = new WikipediaProvider({
    async fetcher(title) {
      asked.push(title)
      return title === 'Sensō-ji'
        ? { title: 'Sensō-ji', extract: 'An ancient Buddhist temple in Asakusa, Tokyo.', url: 'https://en.wikipedia.org/wiki/X' }
        : null
    },
  })
  const p = place('p1', 'Sensoji Temple', 35.7148, 139.7967, { canonicalName: 'Sensō-ji' })
  const { trip: out } = await generateCards(trip([p]), { providers: [provider] })

  assert.equal(asked[0], 'Sensō-ji', 'the indexed name is tried first')
  assert.ok(out.cards.find((c) => c.kind === 'history'), 'which is what makes the card appear')
})

test('trimming never drops text before the first sentence end', async () => {
  const { trimToSentences } = await import('../src/content/providers/wikipedia.ts')

  // The real extract. A global match skipped everything before "a Tokyo Sky
  // Tree", because the first matchable sentence end sat after the abbreviation.
  const raw =
    'Tokyo Skytree , a.k.a Tokyo Sky Tree, is a broadcasting and observation tower, located in Sumida, Tokyo, Japan. It has been the tallest tower in Japan since opening in 2012. A third sentence.'
  const out = trimToSentences(raw, 2)

  assert.ok(out.startsWith('Tokyo Skytree'), `lost its opening: ${out.slice(0, 40)}`)
  assert.ok(out.includes('a.k.a Tokyo Sky Tree'), 'the abbreviation survives intact')
  assert.ok(out.includes('tallest tower'), 'two sentences are kept')
  assert.ok(!out.includes('third sentence'), 'and no more than two')
})

test('a stalled source cannot hold the briefing open', async () => {
  const { OverpassProvider: OP } = await import('../src/content/providers/overpass.ts')
  const provider = new OP({
    async fetcher() {
      // Stands in for a mirror that accepts the connection and never answers.
      throw new Error('The operation was aborted due to timeout')
    },
  })
  const started = Date.now()
  const { report } = await generateCards(trip([SENSOJI]), { providers: [provider] })

  assert.ok(Date.now() - started < 2000, 'returns rather than hanging')
  assert.equal(report.sourceProblems.length, 1)
  assert.match(report.sourceProblems[0]?.reason ?? '', /timeout/)
})

test('one place without an article does not cost the others their background', async () => {
  const provider = new WikipediaProvider({
    async fetcher(title) {
      if (title === 'Broken') throw new Error('timeout')
      return { title, extract: 'A place with a reasonably long description sentence here.', url: 'https://en.wikipedia.org/wiki/X' }
    },
  })
  const t = trip([
    place('p1', 'Broken', 0, 0),
    place('p2', 'Fine', 0, 1),
  ])
  const { trip: out, report } = await generateCards(t, { providers: [provider] })

  assert.equal(report.sourceProblems.length, 0, 'a missing article is not a source outage')
  const histories = out.cards.filter((c) => c.kind === 'history')
  assert.equal(histories.length, 1)
  assert.equal((histories[0]?.attachesTo as { placeId: string }).placeId, 'p2')
})
