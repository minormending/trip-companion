import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { parseItinerary, placeNames } from '../src/import/parse.ts'

const fixture = await readFile(new URL('../fixtures/tokyo.txt', import.meta.url), 'utf8')

test('groups entries under explicit day headers', () => {
  const parsed = parseItinerary(fixture)
  assert.equal(parsed.days.length, 3)
  assert.deepEqual(parsed.days.map((d) => d.index), [1, 2, 3])
  assert.equal(parsed.days[0]?.label, 'Asakusa and the river')
})

test('takes the leading line as the title', () => {
  assert.equal(parseItinerary(fixture).title, 'Tokyo, five days')
})

test('normalises 24-hour, am and pm times to HH:MM', () => {
  const parsed = parseItinerary(fixture)
  const entries = parsed.days.flatMap((d) => d.entries)
  const byName = new Map(
    entries.filter((e) => e.type === 'place').map((e) => [e.name, e.time]),
  )
  assert.equal(byName.get('Sensoji Temple'), '09:00')
  assert.equal(byName.get('Shibuya Crossing'), '08:00')
  assert.equal(byName.get('Yoyogi Park'), '15:30')
})

test('classifies transport lines separately from places', () => {
  const parsed = parseItinerary(fixture)
  const transport = parsed.days.flatMap((d) => d.entries).filter((e) => e.type === 'transport')
  assert.deepEqual(transport.map((t) => t.mode), ['walk', 'transit', 'metro'])
  assert.equal(transport[0]?.durationMinutes, 12)
  assert.equal(transport[2]?.durationMinutes, 20)
})

test('strips ratings, URLs and interface chrome', () => {
  const names = placeNames(parseItinerary(fixture))
  assert.ok(names.includes('Sensoji Temple'), 'rating suffix removed')
  assert.ok(!names.some((n) => n.includes('★')), 'no star ratings survive')
  assert.ok(!names.some((n) => n.includes('http')), 'no URLs survive')
  assert.ok(!names.includes('Add a place'), 'interface chrome dropped')
})

test('falls back to a single day when there are no headers', () => {
  const parsed = parseItinerary('- Colosseum\n- Roman Forum\n- Palatine Hill')
  assert.equal(parsed.days.length, 1)
  assert.equal(parsed.days[0]?.entries.length, 3)
})

test('handles numbered lists', () => {
  const parsed = parseItinerary('Day 1\n1. Louvre\n2) Tuileries Garden')
  assert.deepEqual(placeNames(parsed), ['Louvre', 'Tuileries Garden'])
})

test('ignores blank input without throwing', () => {
  assert.deepEqual(parseItinerary('   \n\n  ').days, [])
})
