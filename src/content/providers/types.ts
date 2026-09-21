import type { CardKind, Leg, Place, Source, TransportMode, Trip } from '../../domain/types.ts'

export interface PlaceContext {
  subject: 'place'
  place: Place
}

export interface LegContext {
  subject: 'leg'
  leg: Leg
  from: Place
  to: Place
  mode: TransportMode
}

export type CardContext = PlaceContext | LegContext

export interface CardRequest {
  kind: CardKind
  context: CardContext
  /** Entity key this card will be cached against. */
  entityKey: string
}

export interface CardDraft {
  title: string
  body: string
  /** Empty means unsubstantiated. Retrieval-required tiers reject that. */
  sources: Source[]
  phrase?: { native: string; respelling: string }
}

export interface CardProvider {
  readonly name: string
  /**
   * Optional one-shot fetch for the whole trip. Remote sources are shared
   * community infrastructure, so a provider that needs the network asks once
   * per trip rather than once per card.
   */
  prime?(trip: Trip): Promise<void>
  /** Null means the provider could not substantiate the card. Never a guess. */
  draft(req: CardRequest): Promise<CardDraft | null>
}
