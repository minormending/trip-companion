import type { CardKind, Leg, Place, Source, TransportMode } from '../../domain/types.ts'

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
  /** Null means the provider could not substantiate the card. Never a guess. */
  draft(req: CardRequest): Promise<CardDraft | null>
}
