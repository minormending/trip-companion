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
 * Runs with no API key. It produces practical cards only — it never fabricates
 * an operational one, because the refuse-rather-than-guess rule applies to
 * every provider equally, including this one.
 *
 * What it says about a leg is genuinely derivable from the mode. What it once
 * said about a place's history was derivable from nothing.
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

    // No history branch. This used to answer every `history` request with "No
    // verified history is on file for X yet", which is not a card: it is the
    // absence of one, printed. Twenty of Prague's thirty-three places carried
    // it, three lines each, between cards that had something to say.
    //
    // An absent card is recoverable — the same reason refusals exist — and a
    // briefing that says nothing about a bakery is shorter and no less
    // informative than one that says nothing at length.
    return null
  }
}
