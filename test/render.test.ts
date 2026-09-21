import { test } from 'node:test'
import assert from 'node:assert/strict'
import { escapeHtml, renderBriefing } from '../src/render/briefing.ts'
import type { Card, Tier } from '../src/domain/types.ts'
import type { Refusal } from '../src/content/generate.ts'
import { leg, place, trip, SOURCE } from './helpers.ts'

function card(kind: Card['kind'], tier: Tier, body: string, sources = [SOURCE], verifiedAt = '2026-09-15'): Card {
  return {
    id: `card:${kind}`,
    attachesTo: { kind: 'place', placeId: 'p1' },
    kind,
    title: 'Title',
    body,
    provenance: { tier, sources, verifiedAt, confidence: 0.9 },
  }
}

const NOW = new Date('2026-09-20T00:00:00Z')

test('escapes markup in place names and card bodies', () => {
  const t = trip([place('p1', '<script>alert(1)</script>', 0, 0)])
  const html = renderBriefing(t, { now: NOW })
  assert.ok(!html.includes('<script>alert(1)</script>'))
  assert.ok(html.includes('&lt;script&gt;'))
})

test('escapeHtml covers the five significant characters', () => {
  assert.equal(escapeHtml(`<>&"'`), '&lt;&gt;&amp;&quot;&#39;')
})

test('operational cards show their source and verification date', () => {
  const t = trip([place('p1', 'Station', 0, 0)], [], [card('how_to_pay', 'operational', 'Coins only.')])
  const html = renderBriefing(t, { now: NOW })
  assert.ok(html.includes('verified 2026-09-15'))
  assert.ok(html.includes('Operator fare page'))
})

test('colour cards show no provenance furniture', () => {
  const t = trip([place('p1', 'Temple', 0, 0)], [], [card('history', 'colour', 'Founded long ago.', [])])
  const html = renderBriefing(t, { now: NOW })
  assert.ok(!html.includes('verified'))
})

test('a stale operational card is flagged in the output', () => {
  const t = trip(
    [place('p1', 'Station', 0, 0)],
    [],
    [card('how_to_pay', 'operational', 'Coins only.', [SOURCE], '2026-01-01')],
  )
  const html = renderBriefing(t, { now: NOW })
  assert.ok(html.includes('may be out of date'))
  assert.ok(html.includes('class="stale"'))
})

test('safety cards render in their own tier so the guide can be suppressed', () => {
  const t = trip([place('p1', 'Platform', 0, 0)], [], [card('caution', 'safety', 'Last train departs 23:40.')])
  const html = renderBriefing(t, { now: NOW })
  assert.ok(html.includes('data-tier="safety"'))
  assert.ok(html.includes('data-tone="absent"'))
})

test('refusals appear in the briefing rather than being hidden', () => {
  const refusals: Refusal[] = [
    {
      attachesTo: { kind: 'place', placeId: 'p1' },
      kind: 'how_to_pay',
      tier: 'operational',
      reason: 'no provider could confirm this',
      subjectName: 'Station',
    },
  ]
  const html = renderBriefing(trip([place('p1', 'Station', 0, 0)]), { refusals, now: NOW })
  assert.ok(html.includes('not confirmed'))
  assert.ok(html.includes('Check locally'))
})

test('interactive controls appear only when asked for', () => {
  const t = trip([place('p1', 'Station', 0, 0)], [], [card('how_to_pay', 'operational', 'Coins only.')])
  assert.ok(!renderBriefing(t, { now: NOW }).includes('This was wrong'))
  assert.ok(renderBriefing(t, { now: NOW, interactive: true }).includes('This was wrong'))
})

test('sources are repeated as numbered footnotes for print', () => {
  const t = trip([place('p1', 'Station', 0, 0)], [], [card('how_to_pay', 'operational', 'Coins only.')])
  const html = renderBriefing(t, { now: NOW })
  assert.ok(html.includes('<div class="footnotes">'))
  assert.ok(html.includes('https://example.org/fares'))
  assert.ok(html.includes('read 2026-09-01'))
})

test('the stylesheet carries a print block', () => {
  const html = renderBriefing(trip([place('p1', 'A', 0, 0)]), { now: NOW })
  assert.ok(html.includes('@media print'))
  assert.ok(html.includes('.controls { display: none; }'))
})

test('places are grouped by day in order', () => {
  const t = trip([
    place('p1', 'First', 0, 0, { dayIndex: 2 }),
    place('p2', 'Second', 0, 1, { dayIndex: 1 }),
  ])
  const html = renderBriefing(t, { now: NOW })
  assert.ok(html.indexOf('Day 1') < html.indexOf('Day 2'))
  assert.ok(html.indexOf('Second') < html.indexOf('First'))
})

test('an inferred leg says so rather than implying it was routed', () => {
  const t = trip(
    [place('p1', 'A', 0, 0), place('p2', 'B', 0, 1)],
    [leg('l1', 'p1', 'p2', { mode: 'transit', inferred: true, distanceMetres: 12000 })],
  )
  const html = renderBriefing(t, { now: NOW })
  assert.ok(html.includes('straight-line estimate, not routed'))
  assert.ok(html.includes('12.0 km'))
})

test('a card titled after its own place does not repeat the heading', () => {
  const t = trip(
    [place('p1', 'Sensoji Temple', 0, 0)],
    [],
    [{ ...card('how_to_pay', 'operational', 'Free to enter.'), title: 'Sensoji Temple' }],
  )
  const html = renderBriefing(t, { now: NOW })
  assert.equal(
    (html.match(/Sensoji Temple/g) ?? []).length,
    1,
    'the stop heading says it once; the card does not say it again',
  )
})

test('a card with its own distinct title still shows it', () => {
  const t = trip(
    [place('p1', 'Sensoji Temple', 0, 0)],
    [],
    [{ ...card('watch_for', 'practical', 'Queue splits here.'), title: 'The left queue' }],
  )
  assert.ok(renderBriefing(t, { now: NOW }).includes('<h3>The left queue</h3>'))
})
