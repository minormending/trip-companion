import { test } from 'node:test'
import assert from 'node:assert/strict'
import { checkVoice, sentenceCount, violationsAreFatal } from '../src/content/voice.ts'

const rules = (text: string, tone: Parameters<typeof checkVoice>[1]) =>
  checkVoice(text, tone).map((v) => v.rule)

test('rejects exclamation marks at every tone', () => {
  assert.ok(rules('Buy the ticket first!', 'full').includes('no-exclamation'))
  assert.ok(rules('Buy the ticket first!', 'quiet').includes('no-exclamation'))
})

test('rejects emoji', () => {
  assert.ok(rules('Coins only \u{1F686}', 'warm').includes('no-emoji'))
})

test('rejects hype adjectives and flattery', () => {
  assert.ok(rules('An amazing hidden gem.', 'full').includes('no-hype'))
  assert.ok(rules('Great choice going here.', 'full').includes('no-second-guessing-choices'))
})

test('rejects references to being an AI', () => {
  assert.ok(rules('As an AI, I cannot confirm.', 'warm').includes('no-ai-reference'))
})

test('enforces the sentence ceiling per tone', () => {
  const four = 'One thing. Two things. Three things. Four things.'
  assert.ok(rules(four, 'full').includes('length'))
  assert.ok(rules('One thing. Two things.', 'full').length === 0)
  assert.ok(rules('One thing. Two things.', 'absent').includes('length'))
})

test('safety cards carry no persona', () => {
  assert.ok(rules('I think the last train is at 23:40.', 'absent').includes('no-persona-in-safety'))
  assert.equal(rules('Last train departs 23:40.', 'absent').length, 0)
})

test('clean operational copy passes', () => {
  assert.deepEqual(rules('Coins only at this machine. Notes are not accepted.', 'quiet'), [])
})

test('violations are fatal only where being wrong strands somebody', () => {
  assert.equal(violationsAreFatal('absent'), true)
  assert.equal(violationsAreFatal('quiet'), true)
  assert.equal(violationsAreFatal('warm'), false)
  assert.equal(violationsAreFatal('full'), false)
})

test('sentenceCount handles trailing punctuation and blanks', () => {
  assert.equal(sentenceCount(''), 0)
  assert.equal(sentenceCount('One.'), 1)
  assert.equal(sentenceCount('One. Two.'), 2)
  assert.equal(sentenceCount('No trailing stop'), 1)
})
