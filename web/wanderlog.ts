import { callFunction } from '../src/backend/client.ts'
import { interpretTripResponse } from '../src/import/wanderlogApi.ts'
import { tripFromWanderlog, type WanderlogReport } from '../src/import/wanderlog.ts'
import type { Trip } from '../src/domain/types.ts'

const KEY_STORE = 'trip-companion:wanderlog-key'

/**
 * Importing a Wanderlog trip from the browser, which cannot ask Wanderlog.
 *
 * wanderlog.com sends no Access-Control-Allow-Origin, so a page gets
 * `TypeError: Failed to fetch` whatever it presents — a fact about the browser,
 * not about the HTTP client, which is why writing the request in JavaScript
 * does not help. The `wanderlog-trip` edge function asks on the page's behalf
 * and is the only reason any of this works.
 *
 * The key is kept on this device and nowhere else. It is a read-only capability
 * for one trip — it cannot edit that trip and cannot reach the account it
 * belongs to — but it is still the traveller's to hold, so it stays in local
 * storage and is never sent anywhere except to the function that needs it.
 */

export type ImportResult =
  | { ok: true; trip: Trip; report: WanderlogReport; scheduled: number }
  | { ok: false; reason: string }

export function savedKey(): string | null {
  try {
    return globalThis.localStorage?.getItem(KEY_STORE) ?? null
  } catch {
    return null
  }
}

export function rememberKey(key: string): void {
  try {
    globalThis.localStorage?.setItem(KEY_STORE, key)
  } catch {
    /* private mode: the import still worked, it just will not be offered again */
  }
}

export function forgetKey(): void {
  try {
    globalThis.localStorage?.removeItem(KEY_STORE)
  } catch {
    /* nothing to do: the key was never stored */
  }
}

/**
 * The short id in wanderlog.com/plan/<key>, from whatever was pasted.
 *
 * People paste the whole URL, because that is what is in front of them. Taking
 * the last path segment costs a line and removes a class of failure that would
 * otherwise read as "that does not look like a trip key" for a perfectly good
 * one.
 */
export function keyFrom(pasted: string): string {
  const text = pasted.trim()
  if (!text) return ''
  try {
    const url = new URL(text)
    const segments = url.pathname.split('/').filter(Boolean)
    return segments[segments.length - 1] ?? ''
  } catch {
    return text.replace(/^.*\//, '')
  }
}

export async function importTrip(pasted: string): Promise<ImportResult> {
  const key = keyFrom(pasted)
  if (!/^[a-z0-9]{6,40}$/.test(key)) {
    return { ok: false, reason: 'That does not look like a Wanderlog trip key or link.' }
  }

  let res: Response | null
  try {
    res = await callFunction('wanderlog-trip', { key }, AbortSignal.timeout(30_000))
  } catch (err) {
    const name = (err as { name?: string }).name
    return {
      ok: false,
      reason: name === 'TimeoutError' ? 'The import took too long. Try again.' : `Could not import: ${(err as Error).message}`,
    }
  }
  if (!res) return { ok: false, reason: 'This build has no backend configured, so it cannot import.' }

  // One set of rules for what a trip document is: the same interpreter the
  // command-line sync uses, so the two cannot drift.
  const interpreted = interpretTripResponse({
    status: res.status,
    contentType: res.headers.get('content-type'),
    body: await res.text(),
    key,
  })
  if (!interpreted.ok) return { ok: false, reason: interpreted.reason }

  const { trip, report } = tripFromWanderlog(interpreted.document)

  // A briefing is the itinerary. The standing lists — "Places to visit",
  // "Food" — are candidates the traveller collected and did not schedule, and
  // several carry notes explaining why they were dropped, so staging them as
  // stops would put rejected ideas in among the real ones.
  const scheduled = trip.places.filter((place) => place.dayIndex !== undefined)
  if (scheduled.length === 0) {
    return { ok: false, reason: 'That trip has no scheduled days yet, so there is nothing to brief.' }
  }

  return { ok: true, trip: { ...trip, places: scheduled }, report, scheduled: scheduled.length }
}
