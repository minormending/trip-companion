/**
 * Fetching a trip document from Wanderlog, without the CLI.
 *
 * The sync used to shell out to `wlog trip get`, which cannot be installed:
 * the module has no cmd/wlog package. Rather than wait on that, this calls the
 * route the CLI itself calls.
 *
 * What the probing found, none of which the CLI's docs say:
 *
 *   - The route needs no credential. A trip key is a capability: hold it and
 *     you get the document, signed in or not. That is why this takes no cookie
 *     by default — there is nothing for CI to hold, so nothing for CI to leak.
 *   - There are three kinds of key. The view key returns the same itinerary as
 *     the edit key with `editKey: null`, so a sync should use that one: a
 *     leaked read-only capability cannot be used to change the trip.
 *   - Failure is HTTP 200. A key that does not exist comes back as a normal
 *     response with `success: false`, so status alone tells you nothing and a
 *     `curl -f` would have called it a success.
 */

export const TRIP_API = 'https://wanderlog.com/api/tripPlans'
export const CLIENT_SCHEMA_VERSION = '2'

/** The document URL for a trip key — the same one a browser tab would open. */
export function tripUrl(key: string): string {
  return `${TRIP_API}/${encodeURIComponent(key)}?clientSchemaVersion=${CLIENT_SCHEMA_VERSION}`
}

export type TripResponse =
  | { ok: true; document: unknown }
  | { ok: false; reason: string }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Decide what a response means, without performing one.
 *
 * Separate from the fetch so the interesting half is testable against captured
 * bodies rather than against the network.
 */
export function interpretTripResponse(input: {
  status: number
  contentType?: string | null
  body: string
  key: string
}): TripResponse {
  const { status, contentType, body, key } = input

  if (status >= 300 && status < 400) {
    return { ok: false, reason: `redirected (${status}) — the trip is not readable with the key "${key}"` }
  }
  if (status < 200 || status >= 300) {
    return { ok: false, reason: `HTTP ${status} from ${TRIP_API}` }
  }

  // A sign-in page arrives as HTML with a perfectly cheerful 200.
  const type = (contentType ?? '').toLowerCase()
  if (type.includes('html') || body.trimStart().startsWith('<')) {
    return { ok: false, reason: `expected JSON, got HTML — "${key}" is probably not a readable trip key` }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    return { ok: false, reason: `the response was not JSON (${body.length} bytes)` }
  }

  // The failure path, which also arrives as 200.
  if (isRecord(parsed) && parsed['success'] === false) {
    const messages = parsed['messages']
    const detail = Array.isArray(messages) && typeof messages[0] === 'string' ? messages[0] : 'no reason given'
    const types = parsed['errTypes']
    const known = Array.isArray(types) && types.includes('keyNotFound')
    return {
      ok: false,
      reason: known
        ? `no trip is shared under the key "${key}"`
        : `Wanderlog refused: ${detail}`,
    }
  }

  if (!isRecord(parsed) || !isRecord(parsed['tripPlan'])) {
    return { ok: false, reason: 'the response carried no tripPlan' }
  }

  return { ok: true, document: parsed }
}

/**
 * Fetch one trip document.
 *
 * `session` is optional and only needed for a trip that is not shared by key
 * at all. Passing one puts a credential in reach of this process, so the
 * scheduled sync deliberately does not.
 */
export async function fetchTrip(
  key: string,
  opts: { session?: string | undefined; timeoutMs?: number } = {},
): Promise<TripResponse> {
  const headers: Record<string, string> = {}
  if (opts.session) headers['cookie'] = `connect.sid=${opts.session}`

  let res: Response
  try {
    res = await fetch(tripUrl(key), {
      headers,
      // A redirect here means "sign in", not "the trip moved". Following it
      // would turn a clear failure into an HTML body two hops later.
      redirect: 'manual',
      signal: AbortSignal.timeout(opts.timeoutMs ?? 30_000),
    })
  } catch (err) {
    const name = (err as { name?: string }).name
    return {
      ok: false,
      reason: name === 'TimeoutError' ? 'wanderlog.com did not answer in time' : `request failed: ${(err as Error).message}`,
    }
  }

  return interpretTripResponse({
    status: res.status,
    contentType: res.headers.get('content-type'),
    body: await res.text(),
    key,
  })
}
