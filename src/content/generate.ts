import type { EntityCache } from '../cache/entityCache.ts'
import { orderedLegs } from '../domain/graph.ts'
import {
  type Card,
  type CardAttachment,
  type CardKind,
  type Tier,
  type Trip,
  CARD_TIER,
  RETRIEVAL_REQUIRED,
  TIER_PERSONALITY,
} from '../domain/types.ts'
import { legKey, placeKey } from './keys.ts'
import { photoCard } from './photo.ts'
import type { CardContext, CardProvider, CardRequest } from './providers/types.ts'
import { checkVoice, violationsAreFatal } from './voice.ts'

const PLACE_KINDS: CardKind[] = ['caution', 'orientation', 'history']
const LEG_KINDS: CardKind[] = ['how_to_pay', 'boarding', 'watch_for', 'phrase']

export interface Refusal {
  attachesTo: CardAttachment
  kind: CardKind
  tier: Tier
  /** Shown to the traveller verbatim. An absent card is recoverable; a wrong one is not. */
  reason: string
  subjectName: string
}

export interface GenerationReport {
  generated: number
  fromCache: number
  refusals: Refusal[]
  voiceRejections: Array<{ kind: CardKind; rules: string[] }>
}

export interface GenerateOptions {
  providers: CardProvider[]
  cache?: EntityCache
  /** Date the photo cards are computed for. Defaults to the trip's departure. */
  photoDate?: Date
  now?: Date
}

function cardId(attachesTo: CardAttachment, kind: CardKind): string {
  const owner = attachesTo.kind === 'place' ? attachesTo.placeId : attachesTo.legId
  return `card:${kind}:${owner}`
}

async function buildCard(
  req: CardRequest,
  attachesTo: CardAttachment,
  subjectName: string,
  opts: GenerateOptions,
  report: GenerationReport,
): Promise<Card | null> {
  const tier = CARD_TIER[req.kind]
  const personality = TIER_PERSONALITY[tier]
  const today = (opts.now ?? new Date()).toISOString().slice(0, 10)

  const cached = opts.cache?.get(req.entityKey, req.kind)
  if (cached) {
    report.fromCache++
    return {
      id: cardId(attachesTo, req.kind),
      attachesTo,
      kind: req.kind,
      title: cached.draft.title,
      body: cached.draft.body,
      ...(cached.draft.phrase ? { phrase: cached.draft.phrase } : {}),
      provenance: { ...cached.provenance, cached: true },
    }
  }

  for (const provider of opts.providers) {
    const draft = await provider.draft(req)
    if (!draft) continue

    if (RETRIEVAL_REQUIRED.has(tier) && draft.sources.length === 0) {
      report.refusals.push({
        attachesTo,
        kind: req.kind,
        tier,
        subjectName,
        reason: `${provider.name} could not substantiate this from a source`,
      })
      continue
    }

    const violations = checkVoice(draft.body, personality)
    if (violations.length > 0 && violationsAreFatal(personality)) {
      report.voiceRejections.push({ kind: req.kind, rules: violations.map((v) => v.rule) })
      continue
    }

    const card: Card = {
      id: cardId(attachesTo, req.kind),
      attachesTo,
      kind: req.kind,
      title: draft.title,
      body: draft.body,
      ...(draft.phrase ? { phrase: draft.phrase } : {}),
      provenance: {
        tier,
        sources: draft.sources,
        verifiedAt: today,
        confidence: draft.sources.length > 0 ? 0.9 : 0.6,
      },
    }
    opts.cache?.set(req.entityKey, req.kind, { draft, provenance: card.provenance })
    report.generated++
    return card
  }

  if (RETRIEVAL_REQUIRED.has(tier)) {
    report.refusals.push({
      attachesTo,
      kind: req.kind,
      tier,
      subjectName,
      reason: 'no provider could confirm this',
    })
  }
  return null
}

export async function generateCards(
  trip: Trip,
  opts: GenerateOptions,
): Promise<{ trip: Trip; report: GenerationReport }> {
  const report: GenerationReport = {
    generated: 0,
    fromCache: 0,
    refusals: [],
    voiceRejections: [],
  }
  const cards: Card[] = []
  const photoDate = opts.photoDate ?? (trip.departsOn ? new Date(trip.departsOn) : new Date())

  for (const place of trip.places) {
    const attachesTo: CardAttachment = { kind: 'place', placeId: place.id }
    const context: CardContext = { subject: 'place', place }
    const entityKey = placeKey(place)

    for (const kind of PLACE_KINDS) {
      const card = await buildCard(
        { kind, context, entityKey },
        attachesTo,
        place.name,
        opts,
        report,
      )
      if (card) cards.push(card)
    }

    const photo = photoCard(place, photoDate)
    if (photo) {
      cards.push(photo)
      report.generated++
    }
  }

  for (const { leg, from, to } of orderedLegs(trip)) {
    const attachesTo: CardAttachment = { kind: 'leg', legId: leg.id }
    const context: CardContext = { subject: 'leg', leg, from, to, mode: leg.mode }
    const entityKey = legKey(leg, from, to)

    for (const kind of LEG_KINDS) {
      const card = await buildCard(
        { kind, context, entityKey },
        attachesTo,
        `${from.name} to ${to.name}`,
        opts,
        report,
      )
      if (card) cards.push(card)
    }
  }

  return { trip: { ...trip, cards: [...trip.cards, ...cards] }, report }
}
