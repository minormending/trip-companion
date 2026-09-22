import type { Source } from '../../domain/types.ts'
import type { CardDraft, CardProvider, CardRequest } from './types.ts'

/**
 * Opening hours, from the trip document the traveller already curated.
 *
 * The Prague validation run produced 98 cards and not one operational card:
 * every `hours` request was refused because Overpass is the only provider that
 * serves them and almost nothing in that trip has an OSM identity. Meanwhile
 * the imported document carried opening hours for most of those same places,
 * and the import threw them away.
 *
 * This is retrieval, not recall. The hours were fetched from a named document
 * at a known URL on a known date, which is exactly what the operational tier
 * demands — an unsourced card here would be refused, and should be.
 *
 * Google's `weekday_text` is passed through verbatim, for the same reason
 * `hoursFrom` does not parse OSM's grammar: a half-understood schedule is
 * worse than a quoted one, because it reads as though somebody checked.
 */

export interface WanderlogHours {
  /** Google's own lines: "Monday: 9 AM–5 PM". */
  weekdayText: string[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Collect every place in the document that states its opening hours. */
export function hoursByName(document: unknown): Map<string, WanderlogHours> {
  const out = new Map<string, WanderlogHours>()
  const seen = new Set<unknown>()

  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const item of node) walk(item)
      return
    }
    if (!isRecord(node) || seen.has(node)) return
    seen.add(node)

    const name = node['name']
    const opening = node['opening_hours']
    if (typeof name === 'string' && name.trim() && isRecord(opening)) {
      const text = opening['weekday_text']
      if (Array.isArray(text)) {
        const lines = text.filter((l): l is string => typeof l === 'string' && l.trim().length > 0)
        // First writer wins: the same place recurs across days, identically.
        if (lines.length > 0 && !out.has(name.trim())) out.set(name.trim(), { weekdayText: lines })
      }
    }

    for (const value of Object.values(node)) walk(value)
  }

  walk(document)
  return out
}

export class WanderlogProvider implements CardProvider {
  readonly name = 'wanderlog'
  readonly #hours: Map<string, WanderlogHours>
  readonly #source: Source

  constructor(document: unknown, source: Source) {
    this.#hours = hoursByName(document)
    this.#source = source
  }

  /** How many places in the document stated hours. Reported by the sync. */
  get known(): number {
    return this.#hours.size
  }

  async draft(req: CardRequest): Promise<CardDraft | null> {
    if (req.kind !== 'hours' || req.context.subject !== 'place') return null
    const found = this.#hours.get(req.context.place.name)
    if (!found) return null

    return {
      title: 'Opening hours',
      // Quoted, not summarised. The traveller can read a schedule; what they
      // cannot do is tell a summary that dropped a closure from one that did
      // not.
      body: found.weekdayText.join('\n'),
      sources: [this.#source],
    }
  }
}
