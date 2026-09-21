import {
  type Card,
  type Leg,
  type Place,
  type Tier,
  type Trip,
  TIER_TTL_DAYS,
} from './types.ts'

const DAY_MS = 86_400_000

export function placeById(trip: Trip, id: string): Place | undefined {
  return trip.places.find((p) => p.id === id)
}

export function cardsForPlace(trip: Trip, placeId: string): Card[] {
  return trip.cards.filter((c) => c.attachesTo.kind === 'place' && c.attachesTo.placeId === placeId)
}

export function cardsForLeg(trip: Trip, legId: string): Card[] {
  return trip.cards.filter((c) => c.attachesTo.kind === 'leg' && c.attachesTo.legId === legId)
}

/** Legs in itinerary order, each paired with the places it joins. */
export function orderedLegs(trip: Trip): Array<{ leg: Leg; from: Place; to: Place }> {
  const out: Array<{ leg: Leg; from: Place; to: Place }> = []
  for (const leg of trip.legs) {
    const from = placeById(trip, leg.fromPlaceId)
    const to = placeById(trip, leg.toPlaceId)
    if (from && to) out.push({ leg, from, to })
  }
  return out
}

/** Consecutive place pairs with no leg between them. These are what the router fills. */
export function missingLegs(trip: Trip): Array<{ from: Place; to: Place }> {
  const have = new Set(trip.legs.map((l) => `${l.fromPlaceId}>${l.toPlaceId}`))
  const gaps: Array<{ from: Place; to: Place }> = []
  for (let i = 0; i < trip.places.length - 1; i++) {
    const from = trip.places[i]
    const to = trip.places[i + 1]
    if (!from || !to) continue
    if (!have.has(`${from.id}>${to.id}`)) gaps.push({ from, to })
  }
  return gaps
}

export function ageInDays(verifiedAt: string, now: Date = new Date()): number {
  const then = Date.parse(verifiedAt)
  if (Number.isNaN(then)) return Number.POSITIVE_INFINITY
  return Math.max(0, (now.getTime() - then) / DAY_MS)
}

export function isStale(card: Card, now: Date = new Date()): boolean {
  const ttl = TIER_TTL_DAYS[card.provenance.tier]
  if (ttl === null) return false
  return ageInDays(card.provenance.verifiedAt, now) > ttl
}

/**
 * Cards needing regeneration before departure. The T-2 pass narrows to the
 * tiers where a stale fact strands somebody; the T-14 pass takes everything.
 */
export function staleCards(trip: Trip, opts: { tiers?: Tier[]; now?: Date } = {}): Card[] {
  const now = opts.now ?? new Date()
  const tiers = opts.tiers
  return trip.cards.filter((c) => {
    if (tiers && !tiers.includes(c.provenance.tier)) return false
    return isStale(c, now)
  })
}

export function emptyTrip(id: string, title: string): Trip {
  return { id, title, places: [], legs: [], cards: [] }
}
