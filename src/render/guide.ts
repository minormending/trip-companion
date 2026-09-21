import type { Personality, Tier, TransportMode } from '../domain/types.ts'

/**
 * The guide's fold, narrowed to the forms people actually recognise as
 * origami. The 24px legibility sketch showed a folded "train carriage" reads
 * as a generic box, and forcing a fold per mode makes the system feel
 * arbitrary, so anything that is not air or water uses the walking bird: the
 * guide accompanies the traveller rather than becoming the vehicle.
 */
export type Fold = 'resting' | 'bird' | 'plane' | 'boat'

export function foldForMode(mode: TransportMode): Fold {
  if (mode === 'flight') return 'plane'
  if (mode === 'ferry') return 'boat'
  return 'bird'
}

/**
 * PLACEHOLDER ART. Commissioned work drops in here and nowhere else — the
 * rest of the guide layer addresses folds by name, never by geometry. Kept
 * deliberately plain: three facets, one accent colour, legible as a
 * silhouette at 20px. See the spec's asset licensing section for why this
 * cannot come from a free library.
 */
const FOLD_PATHS: Record<Fold, string> = {
  resting:
    '<polygon points="2,13 11,4 11,14"/><polygon points="11,4 20,13 11,14" opacity="0.72"/><polygon points="2,13 11,14 20,13 11,19" opacity="0.5"/>',
  bird:
    '<polygon points="10,12 11,2 13,12"/><polygon points="11,12 1,7 7,17" opacity="0.72"/><polygon points="11,12 21,7 15,17" opacity="0.5"/>',
  plane:
    '<polygon points="21,11 2,6 10,12"/><polygon points="21,11 2,17 10,12" opacity="0.72"/><polygon points="21,11 10,12 5,11" opacity="0.5"/>',
  boat:
    '<polygon points="10,14 11,3 11,14"/><polygon points="11,3 16,14 11,14" opacity="0.72"/><polygon points="2,15 21,15 18,20 5,20" opacity="0.5"/>',
}

const FOLD_LABEL: Record<Fold, string> = {
  resting: 'folded flat',
  bird: 'folded as a bird',
  plane: 'folded as a paper plane',
  boat: 'folded as a paper boat',
}

/**
 * Decorative only. Every fact the guide carries is in the card text beneath
 * it, so the mark is hidden from assistive technology rather than described.
 */
export function guideMark(fold: Fold): string {
  return (
    `<svg class="guide" viewBox="0 0 23 23" width="20" height="20" aria-hidden="true" focusable="false" data-fold="${fold}">` +
    `<title>${FOLD_LABEL[fold]}</title>${FOLD_PATHS[fold]}</svg>`
  )
}

/**
 * The tone ladder, enforced where it cannot be argued with. A safety card
 * renders no guide at all; an operational card gets the flat fold and no
 * voice. Whimsy during a missed connection is how a charming product becomes
 * an infuriating one.
 */
export function guideForCard(
  tier: Tier,
  personality: Personality,
  mode?: TransportMode,
): string {
  if (tier === 'safety' || personality === 'absent') return ''
  if (personality === 'quiet') return guideMark('resting')
  return guideMark(mode ? foldForMode(mode) : 'resting')
}
