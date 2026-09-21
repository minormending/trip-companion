import type { CardDraft, CardProvider, CardRequest } from './types.ts'

const MODE_GUIDANCE: Record<string, string> = {
  walk: 'On foot the whole way. Follow the street network rather than the straight line.',
  transit: 'Local public transport covers this. Check the operator at the stop.',
  metro: 'Underground for this leg. Platforms are signed by terminus, not by line colour.',
  rail: 'Rail for this leg. Seat reservations are separate from the ticket on many operators.',
  bus: 'Bus for this leg. Stops are often request-only outside city centres.',
  ferry: 'Water crossing. Boarding usually closes several minutes before departure.',
  flight: 'Air leg. Airport transfer at both ends is not included in this timing.',
  taxi: 'Door to door by car.',
  drive: 'By car. Parking near the destination is the usual constraint.',
  unknown: 'Mode not established for this leg.',
}

/**
 * Runs with no API key. It produces colour and practical cards only — it
 * never fabricates an operational one, because the refuse-rather-than-guess
 * rule applies to every provider equally, including this one.
 */
export class DeterministicProvider implements CardProvider {
  readonly name = 'deterministic'

  async draft(req: CardRequest): Promise<CardDraft | null> {
    const { kind, context } = req

    if (context.subject === 'leg') {
      if (kind === 'watch_for') {
        const guidance = MODE_GUIDANCE[context.mode] ?? MODE_GUIDANCE['unknown']
        return {
          title: `${context.from.name} to ${context.to.name}`,
          body: guidance ?? 'Mode not established for this leg.',
          sources: [],
        }
      }
      return null
    }

    if (kind === 'history') {
      return {
        title: context.place.name,
        body: `No verified history is on file for ${context.place.name} yet.`,
        sources: [],
      }
    }

    return null
  }
}
