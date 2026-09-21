import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CLIENT_SCHEMA_VERSION, interpretTripResponse, tripUrl } from '../src/import/wanderlogApi.ts'

const KEY = 'aqifgcpkvo'
const ok = (over: Partial<Parameters<typeof interpretTripResponse>[0]> = {}) =>
  interpretTripResponse({
    status: 200,
    contentType: 'application/json; charset=utf-8',
    body: '{"success":true,"tripPlan":{"title":"Trip to Prague "}}',
    key: KEY,
    ...over,
  })

test('the url is the one a browser tab would open', () => {
  assert.equal(
    tripUrl(KEY),
    `https://wanderlog.com/api/tripPlans/${KEY}?clientSchemaVersion=${CLIENT_SCHEMA_VERSION}`,
  )
  // Keys are opaque; encode rather than trust them into a URL.
  assert.ok(tripUrl('a/b?c').includes('a%2Fb%3Fc'))
})

test('a good response yields the document', () => {
  const result = ok()
  assert.equal(result.ok, true)
  assert.ok(result.ok && typeof result.document === 'object')
})

/**
 * Captured verbatim from the live route. This is the case that matters most:
 * a key that does not exist answers **HTTP 200** with an error body, so status
 * alone reports success and `curl -f` would have passed it downstream.
 */
const KEY_NOT_FOUND =
  '{"error":"ApplicationError: Couldn\'t fetch keyInfo for key zzzznotarealkey",' +
  '"success":false,"messages":["Couldn\'t fetch keyInfo for key zzzznotarealkey"],' +
  '"errTypes":["keyNotFound"]}'

test('a missing key fails even though the status says 200', () => {
  const result = interpretTripResponse({
    status: 200,
    contentType: 'application/json; charset=utf-8',
    body: KEY_NOT_FOUND,
    key: 'zzzznotarealkey',
  })
  assert.equal(result.ok, false)
  assert.match(result.ok === false ? result.reason : '', /no trip is shared under the key "zzzznotarealkey"/)
})

test('an unrecognised refusal still reports what Wanderlog said', () => {
  const result = interpretTripResponse({
    status: 200,
    contentType: 'application/json',
    body: '{"success":false,"messages":["rate limited"],"errTypes":["somethingElse"]}',
    key: KEY,
  })
  assert.equal(result.ok, false)
  assert.match(result.ok === false ? result.reason : '', /rate limited/)
})

test('a sign-in page is not mistaken for a trip', () => {
  const html = interpretTripResponse({
    status: 200,
    contentType: 'text/html; charset=utf-8',
    body: '<!doctype html><html><body>Sign in</body></html>',
    key: KEY,
  })
  assert.equal(html.ok, false)
  assert.match(html.ok === false ? html.reason : '', /got HTML/)

  // Content-type can lie; the body still gives it away.
  const lying = interpretTripResponse({
    status: 200,
    contentType: 'application/json',
    body: '  <html>nope</html>',
    key: KEY,
  })
  assert.equal(lying.ok, false)
})

test('a redirect means sign in, not that the trip moved', () => {
  const result = ok({ status: 302 })
  assert.equal(result.ok, false)
  assert.match(result.ok === false ? result.reason : '', /redirected \(302\)/)
})

test('an error status is reported as itself', () => {
  const result = ok({ status: 503 })
  assert.equal(result.ok, false)
  assert.match(result.ok === false ? result.reason : '', /HTTP 503/)
})

test('a 200 with no tripPlan is refused rather than passed on', () => {
  const result = ok({ body: '{"success":true}' })
  assert.equal(result.ok, false)
  assert.match(result.ok === false ? result.reason : '', /no tripPlan/)
})

test('unparseable JSON is reported as such', () => {
  const result = ok({ body: '{"success":' })
  assert.equal(result.ok, false)
  assert.match(result.ok === false ? result.reason : '', /not JSON/)
})
