import { test } from 'node:test'
import assert from 'node:assert/strict'
import { foldForMode, guideForCard, guideMark } from '../src/render/guide.ts'
import { renderBriefing } from '../src/render/briefing.ts'
import type { Card, Tier } from '../src/domain/types.ts'
import { leg, place, trip } from './helpers.ts'

function card(kind: Card['kind'], tier: Tier, attachTo: Card['attachesTo']): Card {
  return {
    id: `card:${kind}`,
    attachesTo: attachTo,
    kind,
    title: 'Title',
    body: 'Body text.',
    provenance: { tier, sources: [], verifiedAt: '2026-09-20', confidence: 0.9 },
  }
}

const NOW = new Date('2026-09-21T00:00:00Z')
const AT_PLACE: Card['attachesTo'] = { kind: 'place', placeId: 'p1' }

test('safety cards render no guide at all', () => {
  assert.equal(guideForCard('safety', 'absent'), '')
})

test('operational cards get the flat fold, never a mode fold', () => {
  const mark = guideForCard('operational', 'quiet', 'flight')
  assert.match(mark, /data-fold="resting"/)
  assert.ok(!mark.includes('plane'), 'quiet tone ignores the transport mode')
})

test('warm and full tones take the fold for their mode', () => {
  assert.match(guideForCard('practical', 'warm', 'ferry'), /data-fold="boat"/)
  assert.match(guideForCard('colour', 'full', 'flight'), /data-fold="plane"/)
})

test('a card with no mode rests', () => {
  assert.match(guideForCard('colour', 'full'), /data-fold="resting"/)
})

test('folds are narrowed to forms people recognise as origami', () => {
  assert.equal(foldForMode('flight'), 'plane')
  assert.equal(foldForMode('ferry'), 'boat')
  // Rail, metro and bus deliberately share the bird: no familiar fold exists,
  // and the guide accompanies the traveller rather than being the vehicle.
  assert.equal(foldForMode('rail'), 'bird')
  assert.equal(foldForMode('metro'), 'bird')
  assert.equal(foldForMode('bus'), 'bird')
  assert.equal(foldForMode('walk'), 'bird')
})

test('the mark is hidden from assistive technology', () => {
  const mark = guideMark('bird')
  assert.match(mark, /aria-hidden="true"/)
  assert.match(mark, /focusable="false"/)
})

test('a safety card in a rendered briefing carries no guide svg', () => {
  const t = trip([place('p1', 'Platform', 0, 0)], [], [card('caution', 'safety', AT_PLACE)])
  const html = renderBriefing(t, { now: NOW })
  assert.ok(html.includes('data-tier="safety"'))
  assert.ok(!html.includes('class="guide"'), 'no guide anywhere on a safety-only briefing')
})

test('a leg card takes the fold of its own leg', () => {
  const t = trip(
    [place('p1', 'A', 0, 0), place('p2', 'B', 0, 1)],
    [leg('l1', 'p1', 'p2', { mode: 'ferry' })],
    [card('watch_for', 'practical', { kind: 'leg', legId: 'l1' })],
  )
  assert.match(renderBriefing(t, { now: NOW }), /data-fold="boat"/)
})

test('the guide can be stripped entirely', () => {
  const t = trip([place('p1', 'Temple', 0, 0)], [], [card('history', 'colour', AT_PLACE)])
  assert.ok(renderBriefing(t, { now: NOW }).includes('class="guide"'))
  assert.ok(!renderBriefing(t, { now: NOW, guide: false }).includes('class="guide"'))
})

test('the guide is hidden in print, where operational content earns the space', () => {
  const html = renderBriefing(trip([place('p1', 'A', 0, 0)]), { now: NOW })
  const print = html.slice(html.indexOf('@media print'))
  assert.match(print, /\.guide \{ display: none; \}/)
})

test('card text stands alone with the guide removed', () => {
  const t = trip([place('p1', 'Temple', 0, 0)], [], [card('history', 'colour', AT_PLACE)])
  const stripped = renderBriefing(t, { now: NOW, guide: false })
  assert.ok(stripped.includes('Body text.'), 'the guide is never the only channel')
})
