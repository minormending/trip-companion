import type { EntityCache } from '../cache/entityCache.ts'
import { legKey, placeKey } from '../content/keys.ts'
import { placeById } from '../domain/graph.ts'
import type { Refusal } from '../content/generate.ts'
import { CARD_TIER, type Card, type CardKind, type Trip } from '../domain/types.ts'
import type { Correction, CorrectionStore } from './store.ts'

/**
 * Two independent flags, or one with evidence, withdraw a card pending review.
 * One flag is not enough — travellers mistake a card for the place next door —
 * but three would leave a wrong operational card standing through most of a
 * season, which is the failure this whole loop exists to prevent.
 */
export const SUPPRESSION_THRESHOLD = 2

/** Each flag costs confidence. Confidence is never raised by a flag. */
export const FLAG_PENALTY = 0.35

export interface FlagInput {
  cardId: string
  claim: string
  /** Evidence counts double: a photo of the machine settles it on its own. */
  hasEvidence?: boolean
  now?: Date
  id?: string
}

/**
 * Resolves a card back to the real-world entity it describes. A correction
 * recorded against the trip would die with the trip.
 */
export function entityKeyForCard(trip: Trip, card: Card): string | null {
  // Bound to a const so the narrowing survives into the callback below.
  const attachesTo = card.attachesTo
  if (attachesTo.kind === 'place') {
    const place = placeById(trip, attachesTo.placeId)
    return place ? placeKey(place) : null
  }
  const leg = trip.legs.find((l) => l.id === attachesTo.legId)
  if (!leg) return null
  const from = placeById(trip, leg.fromPlaceId)
  const to = placeById(trip, leg.toPlaceId)
  return from && to ? legKey(leg, from, to) : null
}

export interface FlagResult {
  correction: Correction
  /** True once the card is withdrawn from every future briefing pending review. */
  suppressed: boolean
  openFlags: number
}

export function recordFlag(
  trip: Trip,
  input: FlagInput,
  store: CorrectionStore,
  cache?: EntityCache,
): FlagResult | null {
  const card = trip.cards.find((c) => c.id === input.cardId)
  if (!card) return null
  const entityKey = entityKeyForCard(trip, card)
  if (!entityKey) return null

  const now = input.now ?? new Date()
  const correction: Correction = {
    id: input.id ?? `fix:${entityKey}:${card.kind}:${now.getTime()}`,
    entityKey,
    cardKind: card.kind,
    claim: input.claim,
    sawBody: card.body,
    submittedAt: now.toISOString(),
    status: 'open',
  }
  store.add(correction)
  cache?.flag(entityKey, card.kind, FLAG_PENALTY)

  const openFlags = store.openFor(entityKey, card.kind).length
  const weight = input.hasEvidence ? openFlags + 1 : openFlags
  return { correction, suppressed: weight >= SUPPRESSION_THRESHOLD, openFlags }
}

export interface CardVerdict {
  /** Withdrawn pending review: shown as withdrawn, never shown as fact. */
  suppressed: boolean
  /** Review's replacement text, which every future trip inherits. */
  correctedBody?: string
}

export function verdictFor(entityKey: string, kind: CardKind, store: CorrectionStore): CardVerdict {
  const accepted = store.acceptedFor(entityKey, kind)
  if (accepted?.correctedBody) return { suppressed: false, correctedBody: accepted.correctedBody }
  const open = store.openFor(entityKey, kind).length
  return { suppressed: open >= SUPPRESSION_THRESHOLD }
}

export interface AppliedCorrections {
  trip: Trip
  /**
   * Withdrawn cards, shaped as refusals so the briefing says plainly that the
   * fact is unconfirmed rather than quietly dropping it. A card that vanishes
   * teaches nothing; one that says it was doubted tells you to check.
   */
  withdrawn: Refusal[]
  suppressed: string[]
  corrected: string[]
}

function subjectNameFor(trip: Trip, card: Card): string {
  const attachesTo = card.attachesTo
  if (attachesTo.kind === 'place') {
    return placeById(trip, attachesTo.placeId)?.name ?? 'this stop'
  }
  const leg = trip.legs.find((l) => l.id === attachesTo.legId)
  const from = leg ? placeById(trip, leg.fromPlaceId) : undefined
  const to = leg ? placeById(trip, leg.toPlaceId) : undefined
  return from && to ? `${from.name} to ${to.name}` : 'this leg'
}

/**
 * The compounding step. Applied on every render, so a correction accepted on
 * somebody else's trip last month shows up on this one.
 */
export function applyCorrections(trip: Trip, store: CorrectionStore): AppliedCorrections {
  const suppressed: string[] = []
  const corrected: string[] = []
  const withdrawn: Refusal[] = []

  const cards = trip.cards.flatMap((card) => {
    const entityKey = entityKeyForCard(trip, card)
    if (!entityKey) return [card]
    const verdict = verdictFor(entityKey, card.kind, store)

    if (verdict.suppressed) {
      suppressed.push(card.id)
      withdrawn.push({
        attachesTo: card.attachesTo,
        kind: card.kind,
        tier: CARD_TIER[card.kind],
        subjectName: subjectNameFor(trip, card),
        reason: 'withdrawn after travellers reported it was wrong',
      })
      return []
    }
    if (verdict.correctedBody && verdict.correctedBody !== card.body) {
      corrected.push(card.id)
      return [
        {
          ...card,
          body: verdict.correctedBody,
          provenance: {
            ...card.provenance,
            // A traveller who was standing there outranks a recorded tag.
            confidence: Math.max(card.provenance.confidence, 0.95),
            verifiedAt: new Date().toISOString().slice(0, 10),
          },
        },
      ]
    }
    return [card]
  })

  return { trip: { ...trip, cards }, withdrawn, suppressed, corrected }
}

/**
 * Review. Accepting writes the corrected text into the entity store, which is
 * what makes the fix outlive the trip that found it.
 */
export function acceptCorrection(
  store: CorrectionStore,
  cache: EntityCache | undefined,
  id: string,
  correctedBody: string,
): boolean {
  const correction = store.get(id)
  if (!correction || !store.resolve(id, 'accepted', correctedBody)) return false

  const cached = cache?.get(correction.entityKey, correction.cardKind)
  if (cached && cache) {
    cache.set(correction.entityKey, correction.cardKind, {
      draft: { ...cached.draft, body: correctedBody },
      provenance: {
        ...cached.provenance,
        confidence: 0.95,
        verifiedAt: new Date().toISOString().slice(0, 10),
      },
    })
  }
  return true
}

export function rejectCorrection(store: CorrectionStore, id: string): boolean {
  return store.resolve(id, 'rejected')
}
