import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildLabel } from '../src/build.ts'

test('a commit count reads as a version', () => {
  assert.equal(buildLabel('42'), 'v42')
  assert.equal(buildLabel('1'), 'v1')
})

test('anything that is not a count is shown as it is', () => {
  // A build from a tarball has no git to count, and must not come out looking
  // like a version somebody can read back to you.
  assert.equal(buildLabel('dev'), 'dev')
  assert.equal(buildLabel('v42'), 'v42')
  assert.equal(buildLabel('42-dirty'), '42-dirty')
  assert.equal(buildLabel(''), '')
})
