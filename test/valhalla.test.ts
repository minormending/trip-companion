import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ValhallaProvider } from '../src/routing/valhalla.ts'

const FROM = { lat: 50.0892369, lon: 14.3967817 }
const TO = { lat: 50.0903705, lon: 14.3966657 }

/** Shaped from a real answer: `units: kilometers`, so length is km. */
function reply(body: unknown, status = 200) {
  return (async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  })) as unknown as typeof fetch
}

async function withFetch<T>(stub: typeof fetch, fn: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch
  globalThis.fetch = stub
  try {
    return await fn()
  } finally {
    globalThis.fetch = original
  }
}

test('a walking leg is measured in metres and paced at 4.5km/h', async () => {
  const result = await withFetch(reply({ trip: { summary: { length: 3.0, time: 2118 } } }), () =>
    new ValhallaProvider().route({ from: FROM, to: TO, mode: 'walk' }),
  )
  assert.equal(result.ok, true)
  assert.ok(result.ok)
  assert.equal(result.distanceMetres, 3000)
  // Valhalla's own 2118s is 35 min, at its 5.1km/h. Derived at 4.5 it is 40,
  // which errs slow on purpose: an overstated walk costs idle minutes, an
  // understated one costs a train.
  assert.equal(result.durationMinutes, 40)
})

test('its own duration is used when an instance is trusted to have a foot profile', async () => {
  const result = await withFetch(reply({ trip: { summary: { length: 3.0, time: 2118 } } }), () =>
    new ValhallaProvider({ trustDurations: true }).route({ from: FROM, to: TO, mode: 'walk' }),
  )
  assert.ok(result.ok)
  assert.equal(result.durationMinutes, 35)
})

test('driving keeps the router’s own duration', async () => {
  const result = await withFetch(reply({ trip: { summary: { length: 12.0, time: 900 } } }), () =>
    new ValhallaProvider().route({ from: FROM, to: TO, mode: 'drive' }),
  )
  assert.ok(result.ok)
  assert.equal(result.distanceMetres, 12000)
  assert.equal(result.durationMinutes, 15)
})

test('a very short walk still reports a minute rather than zero', async () => {
  const result = await withFetch(reply({ trip: { summary: { length: 0.02, time: 14 } } }), () =>
    new ValhallaProvider().route({ from: FROM, to: TO, mode: 'walk' }),
  )
  assert.ok(result.ok)
  assert.equal(result.durationMinutes, 1)
})

test('modes it cannot serve are declined rather than approximated', async () => {
  const provider = new ValhallaProvider()
  assert.equal(provider.supports('walk'), true)
  assert.equal(provider.supports('drive'), true)
  assert.equal(provider.supports('transit'), false)
  const result = await provider.route({ from: FROM, to: TO, mode: 'transit' })
  assert.equal(result.ok, false)
  assert.match(result.ok === false ? result.reason : '', /no costing for transit/)
})

test('an error status is reported, not swallowed', async () => {
  const result = await withFetch(reply({}, 429), () =>
    new ValhallaProvider().route({ from: FROM, to: TO, mode: 'walk' }),
  )
  assert.equal(result.ok, false)
  assert.match(result.ok === false ? result.reason : '', /returned 429/)
})

test('a response with no route is a refusal, not a zero-length leg', async () => {
  for (const body of [{}, { trip: {} }, { trip: { summary: {} } }]) {
    const result = await withFetch(reply(body), () =>
      new ValhallaProvider().route({ from: FROM, to: TO, mode: 'walk' }),
    )
    assert.equal(result.ok, false, JSON.stringify(body))
    assert.match(result.ok === false ? result.reason : '', /found no route/)
  }
})

test('an unreachable instance says so rather than throwing', async () => {
  const boom = (async () => {
    throw new Error('getaddrinfo ENOTFOUND')
  }) as unknown as typeof fetch
  const result = await withFetch(boom, () => new ValhallaProvider().route({ from: FROM, to: TO, mode: 'walk' }))
  assert.equal(result.ok, false)
  assert.match(result.ok === false ? result.reason : '', /unreachable/)
})
