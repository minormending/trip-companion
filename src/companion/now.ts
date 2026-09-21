import { cardsForLeg, cardsForPlace } from '../domain/graph.ts'
import type { Card, CardKind, Leg, Place, Trip } from '../domain/types.ts'

export interface CheckIn {
  placeId: string
  /** ISO timestamp. Manual today; a geofence would write the same record. */
  at: string
}

export interface NowState {
  /** The last place checked into. Absent before the trip starts. */
  at?: Place
  /** The next place not yet reached. Absent once everything is done. */
  next?: Place
  /** The leg being travelled, when there is one. */
  leg?: Leg
  /** Cards for this moment, most consequential first. */
  cards: Card[]
  complete: boolean
  /** How far through the trip, for a progress read. */
  reached: number
  total: number
}

/**
 * In-transit ordering, which is not the briefing's ordering. Standing on a
 * platform, a card about where to board outranks the history of the building,
 * and anything that can strand you outranks everything.
 */
const URGENCY: CardKind[] = [
  'caution',
  'boarding',
  'orientation',
  'how_to_pay',
  'hours',
  'phrase',
  'watch_for',
  'photo',
  'history',
]

export function promoteForTravel(cards: Card[]): Card[] {
  const rank = (card: Card): number => {
    const index = URGENCY.indexOf(card.kind)
    return index === -1 ? URGENCY.length : index
  }
  return [...cards].sort((a, b) => rank(a) - rank(b))
}

function checkedInIds(checkIns: CheckIn[]): Set<string> {
  return new Set(checkIns.map((c) => c.placeId))
}

/**
 * What matters right now: the leg in progress and the stop at the end of it.
 * Everything already behind the traveller is dropped, because a companion that
 * shows the whole trip is just the briefing again.
 */
export function computeNow(trip: Trip, checkIns: CheckIn[]): NowState {
  const done = checkedInIds(checkIns)
  const reached = trip.places.filter((p) => done.has(p.id)).length
  const next = trip.places.find((p) => !done.has(p.id))

  const lastCheckIn = [...checkIns]
    .sort((a, b) => a.at.localeCompare(b.at))
    .at(-1)
  const at = lastCheckIn ? trip.places.find((p) => p.id === lastCheckIn.placeId) : undefined

  const leg =
    at && next
      ? trip.legs.find((l) => l.fromPlaceId === at.id && l.toPlaceId === next.id)
      : undefined

  const cards = [
    ...(leg ? cardsForLeg(trip, leg.id) : []),
    ...(next ? cardsForPlace(trip, next.id) : []),
  ]

  const state: NowState = {
    cards: promoteForTravel(cards),
    complete: next === undefined,
    reached,
    total: trip.places.length,
  }
  if (at) state.at = at
  if (next) state.next = next
  if (leg) state.leg = leg
  return state
}

export function checkIn(checkIns: CheckIn[], placeId: string, now: Date = new Date()): CheckIn[] {
  if (checkIns.some((c) => c.placeId === placeId)) return checkIns
  return [...checkIns, { placeId, at: now.toISOString() }]
}

/** Undo. Travellers tap the wrong thing, and a check-in is not a commitment. */
export function undoCheckIn(checkIns: CheckIn[], placeId: string): CheckIn[] {
  return checkIns.filter((c) => c.placeId !== placeId)
}
