/**
 * Fetch one Wanderlog trip document, on behalf of a browser that cannot.
 *
 * wanderlog.com sends no Access-Control-Allow-Origin on any route, so a page
 * gets `TypeError: Failed to fetch` whatever it presents. That is not a
 * property of the HTTP client — porting the CLI to JavaScript changes nothing,
 * because the browser is refusing to hand the page a response from an origin
 * that never opted in. The only fix is to ask from somewhere the same-origin
 * policy does not apply, which is here.
 *
 * Deliberately narrow. It takes a trip key and nothing else: there is no URL
 * parameter to point it anywhere, because a proxy that forwards a caller's URL
 * is a server-side request forgery with extra steps.
 */

const UPSTREAM = 'https://wanderlog.com/api/tripPlans'
const CLIENT_SCHEMA_VERSION = '2'

/**
 * Wanderlog keys are lowercase alphanumeric. Anything else is rejected before
 * a request is made rather than encoded into one — `..` and `/` in particular
 * would otherwise walk off the path this function is pinned to.
 */
const KEY = /^[a-z0-9]{6,40}$/

/**
 * Open to anonymous callers on purpose: importing a trip is something the app
 * does before anybody signs in, and requiring an account to read a key the
 * caller already holds would gate the wrong thing.
 *
 * What that costs is bounded by the narrowness above — it reaches exactly one
 * upstream path, returns only what that path returns, and holds no credential
 * of anyone's. To close it anyway, deploy without --no-verify-jwt and Supabase
 * will require a session before the handler runs.
 */
function cors(origin: string | null): Record<string, string> {
  return {
    // The function is useless to a page it will not answer, and the document
    // it returns is already readable by anyone holding the key.
    'access-control-allow-origin': origin ?? '*',
    'access-control-allow-methods': 'GET, OPTIONS',
    'access-control-allow-headers': 'authorization, content-type, apikey',
    'access-control-max-age': '86400',
    vary: 'origin',
  }
}

function json(body: unknown, status: number, origin: string | null): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...cors(origin) },
  })
}

Deno.serve(async (req: Request): Promise<Response> => {
  const origin = req.headers.get('origin')

  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(origin) })
  if (req.method !== 'GET') return json({ error: 'Use GET.' }, 405, origin)

  const key = new URL(req.url).searchParams.get('key')?.trim() ?? ''
  if (!KEY.test(key)) {
    return json({ error: 'That does not look like a Wanderlog trip key.' }, 400, origin)
  }

  let upstream: Response
  try {
    upstream = await fetch(`${UPSTREAM}/${key}?clientSchemaVersion=${CLIENT_SCHEMA_VERSION}`, {
      headers: { accept: 'application/json' },
      redirect: 'manual',
      signal: AbortSignal.timeout(20_000),
    })
  } catch (err) {
    return json({ error: `Could not reach Wanderlog: ${(err as Error).message}` }, 502, origin)
  }

  const text = await upstream.text()

  // Wanderlog answers an unknown key with HTTP 200 and `success: false`, so the
  // status is not the answer. The body is passed through unchanged either way
  // and the caller's own interpretTripResponse decides, which keeps one set of
  // rules for what a trip document is rather than two that can drift.
  return new Response(text, {
    status: upstream.status >= 200 && upstream.status < 300 ? 200 : 502,
    headers: {
      'content-type': upstream.headers.get('content-type') ?? 'application/json; charset=utf-8',
      // A trip changes when its owner edits it; a minute is long enough to
      // absorb a double click and short enough that a resync means something.
      'cache-control': 'private, max-age=60',
      ...cors(origin),
    },
  })
})
