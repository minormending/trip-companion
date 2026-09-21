import type { Card, Leg, Place, Trip } from '../src/domain/types.ts'
import type { CardDraft, CardProvider, CardRequest } from '../src/content/providers/types.ts'

export function place(id: string, name: string, lat: number, lon: number, extra: Partial<Place> = {}): Place {
  return { id, name, coords: { lat, lon }, dayIndex: 1, ...extra }
}

export function leg(id: string, from: string, to: string, extra: Partial<Leg> = {}): Leg {
  return { id, fromPlaceId: from, toPlaceId: to, mode: 'walk', inferred: false, ...extra }
}

export function trip(places: Place[], legs: Leg[] = [], cards: Card[] = []): Trip {
  return { id: 'trip:test', title: 'Test trip', places, legs, cards }
}

export const SOURCE = {
  url: 'https://example.org/fares',
  title: 'Operator fare page',
  retrieved: '2026-09-01',
}

/** Returns whatever draft it is handed, for whichever kinds it is told to serve. */
export class StubProvider implements CardProvider {
  readonly name: string
  readonly #kinds: Set<string>
  readonly #draft: CardDraft

  constructor(name: string, kinds: string[], draft: CardDraft) {
    this.name = name
    this.#kinds = new Set(kinds)
    this.#draft = draft
  }

  async draft(req: CardRequest): Promise<CardDraft | null> {
    return this.#kinds.has(req.kind) ? this.#draft : null
  }
}
