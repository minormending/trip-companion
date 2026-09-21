export type Tier = 'safety' | 'operational' | 'practical' | 'colour'

export type CardKind =
  | 'history'
  | 'how_to_pay'
  | 'boarding'
  | 'watch_for'
  | 'phrase'
  | 'photo'
  | 'caution'
  | 'orientation'

export type TransportMode =
  | 'walk'
  | 'transit'
  | 'rail'
  | 'bus'
  | 'metro'
  | 'ferry'
  | 'flight'
  | 'taxi'
  | 'drive'
  | 'unknown'

/** How loudly the guide speaks. Derived from tier, never set by hand. */
export type Personality = 'absent' | 'quiet' | 'warm' | 'full'

export interface Source {
  url: string
  title: string
  /** ISO date the page was read. */
  retrieved: string
}

export interface Provenance {
  tier: Tier
  sources: Source[]
  /** ISO date this claim was last confirmed. */
  verifiedAt: string
  /** 0..1. Lowered by corrections, never raised by them. */
  confidence: number
  /** Set when the card came from the entity cache rather than fresh generation. */
  cached?: boolean
}

export interface Coordinates {
  lat: number
  lon: number
}

export interface Place {
  id: string
  name: string
  coords: Coordinates
  /** ISO datetimes. Absent when the itinerary did not specify them. */
  arrive?: string
  depart?: string
  placeType?: string
  /** 1-based day this place falls on, from the itinerary's own grouping. */
  dayIndex?: number
  /** Country code, drives which language and payment cards generate. */
  region?: string
  /** Compass bearing the main facade faces, degrees from north. Enables photo cards. */
  facadeBearing?: number
  /** IANA zone. Absent means photo timings fall back to a longitude estimate. */
  timezone?: string
}

export interface Leg {
  id: string
  fromPlaceId: string
  toPlaceId: string
  mode: TransportMode
  durationMinutes?: number
  distanceMetres?: number
  operator?: string
  /** True when no router could serve this leg and the content layer filled in. */
  inferred: boolean
}

export type CardAttachment =
  | { kind: 'place'; placeId: string }
  | { kind: 'leg'; legId: string }

export interface Card {
  id: string
  attachesTo: CardAttachment
  kind: CardKind
  title: string
  body: string
  /** Respelling and audio for phrase cards. */
  phrase?: { native: string; respelling: string; audioUrl?: string }
  provenance: Provenance
}

export interface Trip {
  id: string
  title: string
  places: Place[]
  legs: Leg[]
  cards: Card[]
  /** ISO date the traveller departs. Drives the staleness passes. */
  departsOn?: string
  shareToken?: string
}

export interface Correction {
  id: string
  cardId: string
  /** Keyed to the real-world entity so the fix outlives the trip that found it. */
  entityKey: string
  claim: string
  submittedAt: string
  status: 'open' | 'accepted' | 'rejected'
}

export const TIER_TTL_DAYS: Record<Tier, number | null> = {
  safety: 30,
  operational: 90,
  practical: 180,
  colour: null,
}

export const TIER_PERSONALITY: Record<Tier, Personality> = {
  safety: 'absent',
  operational: 'quiet',
  practical: 'warm',
  colour: 'full',
}

export const CARD_TIER: Record<CardKind, Tier> = {
  caution: 'safety',
  how_to_pay: 'operational',
  boarding: 'operational',
  orientation: 'operational',
  watch_for: 'practical',
  phrase: 'practical',
  history: 'colour',
  photo: 'colour',
}

/** Tiers that may never be produced from a model's own knowledge. */
export const RETRIEVAL_REQUIRED: ReadonlySet<Tier> = new Set<Tier>(['safety', 'operational'])
