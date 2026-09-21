import type { Trip } from '../../domain/types.ts'
import type { CardDraft, CardProvider, CardRequest } from './types.ts'

export interface WikiSummary {
  title: string
  extract: string
  url: string
}

export interface WikipediaFetcher {
  (title: string): Promise<WikiSummary | null>
}

const ENDPOINT = 'https://en.wikipedia.org/api/rest_v1/page/summary'

/** Background is optional content; it never gets to stall the briefing. */
const REQUEST_TIMEOUT_MS = 8_000

const MIN_USEFUL_CHARS = 40

/**
 * Two sentences is the ceiling for a warm-tone card; the rest is padding.
 *
 * Finds sentence ends and slices, rather than matching sentences and joining
 * them. A global match SKIPS text it cannot match, so "Tokyo Skytree , a.k.a
 * Tokyo Sky Tree, is..." lost its opening words entirely — the first thing
 * that looked like a sentence end sat after the abbreviation. Slicing from
 * index 0 cannot drop a prefix.
 *
 * A terminator only ends a sentence when whitespace or the end of the string
 * follows it, which is what keeps "a.k.a" intact. Short fragments keep
 * absorbing the next sentence until there is something worth reading.
 */
export function trimToSentences(text: string, limit: number): string {
  const trimmed = text.trim()
  const ends: number[] = []
  const terminator = /[.!?]+(?=\s|$)/g
  for (let m = terminator.exec(trimmed); m !== null; m = terminator.exec(trimmed)) {
    ends.push(m.index + m[0].length)
  }
  if (ends.length === 0) return trimmed

  for (let i = 0; i < ends.length; i++) {
    const end = ends[i] as number
    if (i + 1 >= limit && end >= MIN_USEFUL_CHARS) return trimmed.slice(0, end).trim()
  }
  return trimmed.slice(0, ends[ends.length - 1] as number).trim()
}

/**
 * Colour-tier background, cited. Wikipedia is not a source good enough for an
 * operational claim, which is why this provider only ever answers `history` —
 * it cannot be talked into filling a tier-1 card.
 */
export class WikipediaProvider implements CardProvider {
  readonly name = 'wikipedia'
  readonly #fetcher: WikipediaFetcher
  readonly #summaries = new Map<string, WikiSummary>()
  #retrieved = new Date().toISOString().slice(0, 10)

  constructor(opts: { fetcher?: WikipediaFetcher; endpoint?: string } = {}) {
    this.#fetcher = opts.fetcher ?? defaultFetcher(opts.endpoint ?? ENDPOINT)
  }

  async prime(trip: Trip): Promise<void> {
    this.#retrieved = new Date().toISOString().slice(0, 10)
    // One place failing to have an article is normal and not worth reporting;
    // the endpoint being unreachable is not, and that error propagates.
    for (const place of trip.places) {
      // The geocoder's name first: it is the one an encyclopaedia indexes.
      const names = [place.canonicalName, place.name].filter((n): n is string => Boolean(n))
      for (const name of names) {
        try {
          const summary = await this.#fetcher(name)
          if (summary?.extract) {
            this.#summaries.set(place.id, summary)
            break
          }
        } catch {
          // Colour cards are allowed to be absent, so one lookup timing out
          // costs this place its background and nothing else.
        }
      }
    }
  }

  async draft(req: CardRequest): Promise<CardDraft | null> {
    if (req.kind !== 'history' || req.context.subject !== 'place') return null
    const summary = this.#summaries.get(req.context.place.id)
    if (!summary) return null

    return {
      title: req.context.place.name,
      body: trimToSentences(summary.extract, 2),
      sources: [{ url: summary.url, title: `Wikipedia: ${summary.title}`, retrieved: this.#retrieved }],
    }
  }
}

function defaultFetcher(endpoint: string): WikipediaFetcher {
  return async (title: string) => {
    const res = await fetch(`${endpoint}/${encodeURIComponent(title)}`, {
      headers: { 'User-Agent': 'trip-companion/0.1 (github.com/minormending/trip-companion)' },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    // 404 just means no article under that name, which is an ordinary answer.
    if (res.status === 404) return null
    if (!res.ok) throw new Error(`wikipedia returned ${res.status}`)
    const body = (await res.json()) as {
      type?: string
      title?: string
      extract?: string
      content_urls?: { desktop?: { page?: string } }
    }
    // A disambiguation page is a list of things it might be, which is not an
    // answer about this place.
    if (body.type === 'disambiguation' || !body.extract || !body.title) return null
    return {
      title: body.title,
      extract: body.extract,
      url: body.content_urls?.desktop?.page ?? `https://en.wikipedia.org/wiki/${encodeURIComponent(body.title)}`,
    }
  }
}
