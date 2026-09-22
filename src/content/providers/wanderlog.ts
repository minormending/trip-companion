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

/**
 * Google's one-line editorial summary of a place, where the document has one.
 *
 * Deliberately **not** `generatedDescription`, which sits in the same object
 * and covers far more places. That field is what another system's model wrote
 * about the reviews, and passing it off as a retrieved fact is the exact move
 * the tier policy exists to prevent. It reads well, which is what makes it
 * dangerous: nothing downstream could tell it from something somebody checked.
 *
 * Keyed on `placeId` being present so this only ever reads place metadata,
 * rather than any object in the document that happens to have a description.
 */
export function descriptionsByName(document: unknown): Map<string, string> {
  const out = new Map<string, string>()
  const seen = new Set<unknown>()

  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const item of node) walk(item)
      return
    }
    if (!isRecord(node) || seen.has(node)) return
    seen.add(node)

    const name = node['name']
    const description = node['description']
    if (
      typeof name === 'string' &&
      name.trim() &&
      typeof node['placeId'] === 'string' &&
      typeof description === 'string' &&
      description.trim()
    ) {
      if (!out.has(name.trim())) out.set(name.trim(), description.trim())
    }

    for (const value of Object.values(node)) walk(value)
  }

  walk(document)
  return out
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

export interface RecordedCost {
  amount: number
  currency: string
}

function formatAmount(cost: RecordedCost): string {
  // Whole koruna and whole dollars alike: the document stores integers, and
  // inventing decimal places would imply a precision it does not have.
  return `${cost.amount} ${cost.currency}`
}

/**
 * What the trip's own budget records against each place.
 *
 * The document keeps expenses in a structured list, each carrying the `blockId`
 * of the itinerary entry it belongs to, so this is a join rather than a guess:
 * thirteen of this trip's fourteen expenses resolve to a named place. The
 * fourteenth is the hotel, whose block the view-key document does not carry.
 *
 * It is a fact about the trip rather than about the world — the traveller wrote
 * it — which is exactly why it can be stated. What a museum charges today is
 * something nobody here has checked; what this trip has budgeted for it is on
 * the page.
 */
export function costsByName(document: unknown): Map<string, RecordedCost[]> {
  const out = new Map<string, RecordedCost[]>()
  if (!isRecord(document)) return out

  const root = isRecord(document['tripPlan']) ? document['tripPlan'] : document
  const itinerary = isRecord(root['itinerary']) ? root['itinerary'] : undefined
  if (!itinerary) return out

  // blockId -> place name, from the itinerary the expenses point into.
  const blocks = new Map<number, string>()
  const sections = itinerary['sections']
  if (Array.isArray(sections)) {
    for (const section of sections) {
      if (!isRecord(section) || !Array.isArray(section['blocks'])) continue
      for (const block of section['blocks']) {
        if (!isRecord(block)) continue
        const place = block['place']
        const id = block['id']
        if (typeof id === 'number' && isRecord(place) && typeof place['name'] === 'string') {
          blocks.set(id, place['name'].trim())
        }
      }
    }
  }

  const budget = isRecord(itinerary['budget']) ? itinerary['budget'] : undefined
  const expenses = budget && Array.isArray(budget['expenses']) ? budget['expenses'] : []
  for (const expense of expenses) {
    if (!isRecord(expense)) continue
    const name = typeof expense['blockId'] === 'number' ? blocks.get(expense['blockId']) : undefined
    const amount = expense['amount']
    if (!name || !isRecord(amount)) continue
    const value = amount['amount']
    const currency = amount['currencyCode']
    if (typeof value !== 'number' || value <= 0 || typeof currency !== 'string') continue
    const list = out.get(name) ?? []
    list.push({ amount: value, currency: currency.toUpperCase() })
    out.set(name, list)
  }

  return out
}

/** The currency most of the trip is budgeted in, if there is a clear one. */
export function dominantCurrency(costs: Map<string, RecordedCost[]>): string | undefined {
  const tally = new Map<string, number>()
  for (const list of costs.values()) {
    for (const cost of list) tally.set(cost.currency, (tally.get(cost.currency) ?? 0) + 1)
  }
  const ranked = [...tally].sort((a, b) => b[1] - a[1])
  const top = ranked[0]
  if (!top) return undefined
  // A tie says nothing about which currency is the trip's.
  if (ranked[1] && ranked[1][1] === top[1]) return undefined
  return top[0]
}

export class WanderlogProvider implements CardProvider {
  readonly name = 'wanderlog'
  readonly #hours: Map<string, WanderlogHours>
  readonly #descriptions: Map<string, string>
  readonly #costs: Map<string, RecordedCost[]>
  readonly #currency: string | undefined
  readonly #source: Source

  constructor(document: unknown, source: Source) {
    this.#hours = hoursByName(document)
    this.#descriptions = descriptionsByName(document)
    this.#costs = costsByName(document)
    this.#currency = dominantCurrency(this.#costs)
    this.#source = source
  }

  /** How many places in the document stated hours. Reported by the sync. */
  get known(): number {
    return this.#hours.size
  }

  /** How many places the document describes. */
  get described(): number {
    return this.#descriptions.size
  }

  /** How many places the trip's budget records a cost against. */
  get priced(): number {
    return this.#costs.size
  }

  async draft(req: CardRequest): Promise<CardDraft | null> {
    if (req.context.subject !== 'place') return null

    if (req.kind === 'history') {
      // Last word rather than first: Wikipedia runs before this and has whole
      // articles on the landmarks. This answers for the pub and the museum
      // wing that Wikipedia has never heard of.
      const description = this.#descriptions.get(req.context.place.name)
      if (!description) return null
      return { title: req.context.place.name, body: description, sources: [this.#source] }
    }

    if (req.kind === 'how_to_pay') {
      const costs = this.#costs.get(req.context.place.name)
      if (!costs || costs.length === 0) return null

      const distinct = [...new Set(costs.map(formatAmount))]
      const parts = [`Recorded in the trip budget as ${distinct.join(' and ')}.`]

      // A line in another currency is a conversion somebody did in advance,
      // and the charge will not arrive in that currency. Saying so is a fact
      // about the document, not a claim about the country's money.
      if (this.#currency && costs.some((c) => c.currency !== this.#currency)) {
        parts.push(`The rest of this trip is budgeted in ${this.#currency}.`)
      }

      return { title: req.context.place.name, body: parts.join(' '), sources: [this.#source] }
    }

    if (req.kind !== 'hours') return null
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
