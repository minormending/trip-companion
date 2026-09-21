#!/usr/bin/env node
/**
 * Load restroom-map's downloaded backup into the `restroom` schema.
 *
 *   node scripts/import-restroom.mjs <backup.sql>            inspect only
 *   node scripts/import-restroom.mjs <backup.sql> --apply
 *
 * Dry run by default. It reports what it found and what it would rewrite, so
 * the transformation can be checked against the real file before anything is
 * written — the dump's exact shape is not known until one exists.
 *
 * WHAT IT DOES
 *
 *   - Keeps only restroom-map's own tables. Its profiles, flags, feedback and
 *     rate_limit are dropped on the floor: the shared layer in `public` already
 *     has them, and importing a second set is the collision this whole
 *     arrangement exists to avoid.
 *   - Rewrites those tables from `public.` to `restroom.`.
 *   - Nulls every reference to a user. auth.users ids are per project, so the
 *     old ones point at nobody here. This loses attribution permanently, which
 *     is the decision taken deliberately — keep the backup file and it stays
 *     recoverable.
 *   - Never touches the auth schema.
 */
import { createReadStream, existsSync, writeFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { withClient } from '@minormending/map-kit/node/connect'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const APPLY = process.argv.includes('--apply')
const FILE = process.argv[2]

/** restroom-map's own tables. Everything else in public is shared or ignored. */
const OWN_TABLES = [
  'bathrooms',
  'bathroom_codes',
  'code_unlocks',
  'access_claims',
  'comments',
  'reports',
  'credit_ledger',
]

/** Columns that point at a user, nulled because those ids do not exist here. */
const USER_COLUMNS = [
  'reporter_id',
  'author_id',
  'user_id',
  'submitted_by',
  'created_by',
  'claimed_by',
  'unlocked_by',
  'resolved_by',
]

if (!FILE || !existsSync(FILE)) {
  console.error(`Usage: node scripts/import-restroom.mjs <backup.sql> [--apply]

Download it from Supabase Studio -> restroom-map -> Project Overview.`)
  process.exit(2)
}

const wanted = new Set(OWN_TABLES)
const copyHeader = /^COPY\s+(?:"?public"?\.)?"?([a-z_]+)"?\s*\(([^)]*)\)\s+FROM stdin;/i
const createTable = /^CREATE TABLE\s+(?:"?public"?\.)?"?([a-z_]+)"?/i

const found = new Map()
const skipped = new Set()
const statements = []

let currentCopy = null
let rows = []

const lines = createInterface({ input: createReadStream(FILE), crlfDelay: Infinity })

for await (const line of lines) {
  if (currentCopy) {
    if (line === '\\.') {
      statements.push({ kind: 'copy', table: currentCopy.table, columns: currentCopy.columns, rows })
      found.set(currentCopy.table, rows.length)
      currentCopy = null
      rows = []
    } else {
      rows.push(line)
    }
    continue
  }

  const copy = copyHeader.exec(line)
  if (copy) {
    const [, table, cols] = copy
    if (wanted.has(table)) {
      currentCopy = { table, columns: cols.split(',').map((c) => c.trim().replace(/"/g, '')) }
      rows = []
    } else {
      skipped.add(table)
      // Skip this table's data block entirely.
      // eslint-disable-next-line no-constant-condition
      for await (const skip of lines) if (skip === '\\.') break
    }
    continue
  }

  const created = createTable.exec(line)
  if (created && !wanted.has(created[1])) skipped.add(created[1])
}

console.log(`Backup: ${FILE}\n`)
console.log('tables imported into restroom:')
for (const t of OWN_TABLES) {
  const n = found.get(t)
  console.log(`  ${t.padEnd(18)} ${n === undefined ? 'NOT FOUND in backup' : `${n} rows`}`)
}
if (skipped.size) {
  console.log('\nleft behind (shared layer already has these, or not ours):')
  for (const t of [...skipped].sort()) console.log(`  ${t}`)
}

const nulled = []
for (const s of statements) {
  for (const c of s.columns) if (USER_COLUMNS.includes(c)) nulled.push(`${s.table}.${c}`)
}
console.log(`\nuser references nulled: ${nulled.length ? nulled.join(', ') : 'none found'}`)

if (!APPLY) {
  const preview = join(ROOT, 'restroom-import-preview.txt')
  writeFileSync(
    preview,
    statements.map((s) => `restroom.${s.table} (${s.columns.join(', ')}) — ${s.rows.length} rows`).join('\n') + '\n',
  )
  console.log(`\ndry run — nothing written. Plan in ${preview}`)
  console.log('pass --apply to load it')
  process.exit(0)
}

await withClient(
  async (client) => {
    await client.query('set search_path = restroom, public, extensions')
    for (const s of statements) {
      const cols = s.columns
      const nullAt = cols.map((c) => USER_COLUMNS.includes(c))
      await client.query('begin')
      try {
        for (const row of s.rows) {
          const values = row.split('\t').map((v, i) => (nullAt[i] ? null : v === '\\N' ? null : v))
          const placeholders = values.map((_, i) => `$${i + 1}`).join(',')
          await client.query(
            `insert into restroom.${s.table} (${cols.map((c) => `"${c}"`).join(',')}) values (${placeholders}) on conflict do nothing`,
            values,
          )
        }
        await client.query('commit')
        console.log(`  loaded restroom.${s.table}: ${s.rows.length} rows`)
      } catch (err) {
        await client.query('rollback')
        console.error(`  FAILED on restroom.${s.table}: ${err.message}`)
        process.exit(1)
      }
    }
  },
  { root: ROOT, applicationName: 'trip-companion/import-restroom' },
)
console.log('\ndone')
