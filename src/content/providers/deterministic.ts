import type { CardDraft, CardProvider, CardRequest, LegContext } from './types.ts'

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
 * Above this a walk is worth naming as a walk. Prague's itinerary implies four
 * of them — 32, 40, 60 and 64 minutes — and the old card described all four in
 * the same words as a two-minute hop between adjacent palaces.
 */
const LONG_WALK_MINUTES = 30

/**
 * What can honestly be said about a leg, from the leg.
 *
 * Every one of thirty-two legs used to get a sentence chosen by mode alone, so
 * twenty-nine of them were identical. Nothing here is a new source: duration,
 * distance and whether a router answered are all already on the leg, and were
 * simply never read.
 *
 * Null means there is nothing to watch for, which is a real answer.
 */
function legAdvice(context: LegContext): string | null {
  const { leg, mode } = context
  const minutes = leg.durationMinutes
  const parts: string[] = []

  if (mode === 'walk' && !leg.inferred) {
    // A routed walk needs no card of its own. The briefing already prints
    // "Walk, 12 min, 900 m" beside the leg, and "on foot the whole way" under
    // it is the same fact in a box. Seventeen of Prague's walks got that
    // sentence verbatim; none of them learned anything from it.
    //
    // Length is the exception, because length is the thing somebody would
    // otherwise discover at the wrong end of it.
    if (minutes === undefined || minutes < LONG_WALK_MINUTES) return null
    parts.push(
      `About ${minutes} minutes on foot. Worth checking whether local transport covers it before setting out.`,
    )
  } else {
    parts.push(MODE_GUIDANCE[mode] ?? (MODE_GUIDANCE['unknown'] as string))
  }

  // An inferred leg has a straight-line distance and no time at all. Saying so
  // matters more than the mode advice above it: a number that looks routed and
  // is not will be planned around.
  if (leg.inferred) {
    parts.push('No router served this leg, so the distance is a straight line and the time is not established.')
  }

  return parts.join(' ')
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
        const body = legAdvice(context)
        if (!body) return null
        return {
          title: `${context.from.name} to ${context.to.name}`,
          body,
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
