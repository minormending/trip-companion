#!/usr/bin/env node
/**
 * Move restroom-map's `public` schema into `restroom` in the shared database.
 *
 *   node scripts/import-restroom.mjs <cluster.sql|.gz>            write the SQL, apply nothing
 *   node scripts/import-restroom.mjs <cluster.sql|.gz> --apply
 *
 * Dry run by default: it writes a reviewable .sql file and stops. Read it
 * before applying — this lands 1,000+ rows into a database another app already
 * lives in.
 *
 * WHAT IS LEFT BEHIND, deliberately: profiles, flags, feedback, rate_limit and
 * their functions. The shared layer already has them, and a second set is the
 * collision this whole arrangement exists to avoid. References to them stay
 * pointed at `public`, which is why the rewrite is name-aware rather than a
 * blanket s/public./restroom./.
 *
 * Every column naming a user is nulled. auth.users ids are per project, so the
 * old ones name nobody here. That loses attribution permanently — keep the
 * backup and it stays recoverable.
 */
import { createHash } from 'node:crypto'
import { createReadStream, writeFileSync, existsSync } from 'node:fs'
import { createGunzip } from 'node:zlib'
import { createInterface } from 'node:readline'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { withClient } from '@minormending/map-kit/node/connect'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const APPLY = process.argv.includes('--apply')
const FILE = process.argv[2]
const OUT = join(ROOT, 'supabase/restroom/0002_imported.sql')

/** Already in the shared layer. Not recreated; references stay on `public`. */
const SHARED = new Set([
  'profiles', 'flags', 'feedback', 'rate_limit', 'schema_migrations',
  'feedback_kind',
  'client_fingerprint', 'handle_new_user', 'rl_salt', 'rl_take',
  'submit_feedback', 'submit_flag',
])

/** restroom-map's own data tables, in dependency order. */
const TABLES = [
  'bathrooms', 'bathroom_codes', 'code_unlocks',
  'access_claims', 'comments', 'reports', 'credit_ledger',
]

/** Columns naming a user. Nulled: those ids do not exist in this project. */
const USER_COLUMNS = new Set([
  'reporter_id', 'author_id', 'user_id', 'submitted_by',
  'created_by', 'claimed_by', 'unlocked_by', 'resolved_by', 'granted_by',
])

if (!FILE || !existsSync(FILE)) {
  console.error('Usage: node scripts/import-restroom.mjs <cluster.sql|.gz> [--apply]')
  process.exit(2)
}

/** Rewrite public.X -> restroom.X, but only for objects we are moving. */
function requalify(sql) {
  const qualified = sql.replace(/\bpublic\.("?)([a-z_][a-z0-9_]*)\1/gi, (match, quote, name) =>
    SHARED.has(name.toLowerCase()) ? match : `restroom.${quote}${name}${quote}`,
  )

  // pg_dump bakes "SET search_path TO 'public', 'extensions'" into every
  // function it wrote. A LANGUAGE sql body is validated at creation time using
  // exactly that path, so an unqualified `bathrooms` inside one looks for
  // public.bathrooms and the whole import fails. restroom has to come first.
  const pathed = qualified.replace(
    /(SET\s+search_path\s+TO\s+)('?public'?)/gi,
    (_m, lead, first) => `${lead}'restroom', ${first}`,
  )

  return reconcileShared(pathed)
}

/**
 * restroom-map predates map-kit — it is where the kit was extracted from — so
 * its own flags table diverged from the shared one it now uses.
 *
 *   reason -> message      renamed in the kit
 *   app filter             flags and feedback now hold every app's rows, so a
 *                          view without this shows trip-companion's reports in
 *                          restroom's moderation queue
 */
function reconcileShared(sql) {
  if (!/public\.(flags|feedback)\b/.test(sql)) return sql

  let out = sql.replace(/\bf\.reason\b/g, 'f.message AS reason')
  out = out.replace(
    /(FROM\s+public\.flags\s+f\b)/gi,
    '$1',
  )
  // Scope each branch of the union to this app.
  out = out.replace(/WHERE \(f\.resolved_at IS NULL\)/gi,
    "WHERE (f.resolved_at IS NULL AND f.app = 'restroom-map')")
  out = out.replace(/WHERE \(d\.resolved_at IS NULL\)/gi,
    "WHERE (d.resolved_at IS NULL AND d.app = 'restroom-map')")
  return out
}

/** Leading object name of a statement, for deciding whether to keep it. */
function subjectOf(sql) {
  // CREATE INDEX/POLICY/TRIGGER name their own object first and the table
  // after ON, so those are resolved by targetTable() instead.
  const create =
    /^\s*CREATE\s+(?:OR REPLACE\s+)?(TABLE|TYPE|FUNCTION|VIEW)\s+(?:IF NOT EXISTS\s+)?"?public"?\."?([a-z_][a-z0-9_]*)"?/i.exec(sql)
  if (create) return { kind: create[1].toUpperCase(), name: create[2].toLowerCase() }

  const attached =
    /^\s*CREATE\s+(?:UNIQUE\s+)?(INDEX|TRIGGER|POLICY)\b/i.exec(sql)
  if (attached) return { kind: attached[1].toUpperCase(), name: '' }

  const alter = /^\s*ALTER TABLE(?: ONLY)?\s+"?public"?\."?([a-z_][a-z0-9_]*)"?/i.exec(sql)
  if (alter) return { kind: 'ALTER', name: alter[1].toLowerCase() }

  // Anything qualified to another schema, or unqualified, is not ours.
  return null
}

/** For CREATE INDEX/POLICY/TRIGGER the interesting name is the target table. */
function targetTable(sql) {
  const m = /\bON\s+"?public"?\."?([a-z_][a-z0-9_]*)"?/i.exec(sql)
  return m ? m[1].toLowerCase() : null
}

const source = FILE.endsWith('.gz')
  ? createReadStream(FILE).pipe(createGunzip())
  : createReadStream(FILE)

const ddl = []
const data = new Map()
const skipped = new Set()

let buffer = []
let dollarTag = null
let copy = null

for await (const line of createInterface({ input: source, crlfDelay: Infinity })) {
  // Data blocks are captured verbatim and transformed separately.
  if (copy) {
    if (line === '\\.') {
      if (!copy.drop) data.set(copy.table, copy)
      copy = null
    } else if (!copy.drop) copy.rows.push(line)
    continue
  }
  const copyStart =
    /^COPY\s+(?:"?([a-z_]+)"?\.)?"?([a-z_]+)"?\s*\(([^)]*)\)\s+FROM stdin;/i.exec(line)
  if (copyStart) {
    const schema = (copyStart[1] ?? 'public').toLowerCase()
    const table = copyStart[2].toLowerCase()
    const mine = schema === 'public' && TABLES.includes(table)
    if (!mine) skipped.add(`data:${schema}.${table}`)
    copy = {
      table,
      drop: !mine,
      columns: copyStart[3].split(',').map((c) => c.trim().replace(/"/g, '')),
      rows: [],
    }
    continue
  }

  // Track dollar-quoting so function bodies are not split on their semicolons.
  for (const tag of line.matchAll(/\$([a-z_]*)\$/gi)) {
    if (dollarTag === null) dollarTag = tag[0]
    else if (tag[0] === dollarTag) dollarTag = null
  }

  // pg_dump precedes every statement with a comment block. Buffering those
  // means the statement string starts with "--", so a ^CREATE match never
  // fires and only statements following a bare ";" are ever classified.
  if (dollarTag === null && buffer.length === 0 && /^\s*(--.*)?$/.test(line)) continue

  buffer.push(line)
  if (dollarTag === null && /;\s*$/.test(line)) {
    const sql = buffer.join('\n')
    buffer = []
    const subject = subjectOf(sql)
    if (!subject) continue

    const attachedKind = ['INDEX', 'POLICY', 'TRIGGER'].includes(subject.kind)
    const target = attachedKind ? targetTable(sql) : subject.name
    // An index or policy on a table in another schema is not ours to move.
    if (attachedKind && target === null) continue
    const relevant = target ?? subject.name

    if (SHARED.has(relevant)) {
      skipped.add(`${subject.kind.toLowerCase()}:${relevant}`)
      continue
    }
    ddl.push({ kind: subject.kind, sql: requalify(sql) })
  }
}

// data blocks flagged as skipped carry no rows we want

/**
 * pg_dump emits in its own order, which puts functions before the tables they
 * query. A LANGUAGE sql body is validated at creation time, so that order fails
 * on the first function. Views come before functions because one of the
 * functions selects from a view.
 */
const ORDER = ['TYPE', 'TABLE', 'ALTER', 'VIEW', 'FUNCTION', 'INDEX', 'TRIGGER', 'POLICY']

function ordered(statements) {
  const rank = (kind) => {
    const i = ORDER.indexOf(kind)
    return i === -1 ? ORDER.length : i
  }
  return [...statements]
    .map((s, i) => ({ ...s, i }))
    .sort((a, b) => rank(a.kind) - rank(b.kind) || a.i - b.i)
    .map((s) => s.sql)
}

const header = [
  `-- Generated by scripts/import-restroom.mjs from a restroom-map cluster backup.`,
  `-- Do not edit once applied: the runner's hash check will refuse it.`,
  ``,
  `create extension if not exists postgis with schema extensions;`,
  `set search_path = restroom, public, extensions;`,
  ``,
].join('\n')

const sqlParts = [
  `-- Generated by scripts/import-restroom.mjs from a restroom-map cluster backup.`,
  `-- Do not edit once applied: the runner's hash check will refuse it.`,
  ``,
  `create extension if not exists postgis with schema extensions;`,
  ``,
  `-- The dump names its own objects unqualified in constraint references and`,
  `-- function bodies. Those resolve against the search path, so restroom has to`,
  `-- come first or they look for a public.bathrooms that does not exist.`,
  `set search_path = restroom, public, extensions;`,
  ``,
  ...ordered(ddl),
  ``,
]

/**
 * Columns that are NOT NULL and name a user. Nulling one would break the
 * constraint, so those rows are skipped rather than dropping the constraint:
 * changing the schema to admit authorless rows would outlive this import and
 * change what the app may write from now on. The rows stay in the backup.
 */
const notNullUserColumns = new Set()
for (const statement of ddl) {
  const table = /CREATE TABLE restroom\.([a-z_]+)/i.exec(statement.sql)?.[1]
  if (!table) continue
  for (const line of statement.sql.split('\n')) {
    const col = line.trim().split(/\s+/)[0]?.replace(/"/g, '')
    if (col && USER_COLUMNS.has(col) && /NOT NULL/i.test(line)) {
      notNullUserColumns.add(`${table}.${col}`)
    }
  }
}

const dataStatements = new Map()
const skippedRows = new Map()
let nulledCount = 0
for (const table of TABLES) {
  const block = data.get(table)
  if (!block || block.rows.length === 0) continue
  const cols = block.columns
  const nullAt = cols.map((c) => USER_COLUMNS.has(c))
  nulledCount += nullAt.filter(Boolean).length

  const rowSql = []
  const blocking = cols.filter((c, i) => nullAt[i] && notNullUserColumns.has(`${table}.${c}`))
  sqlParts.push(`-- ${table}: ${block.rows.length} rows`)
  for (const row of block.rows) {
    if (blocking.length > 0) {
      const raw = row.split('\t')
      const wouldBreak = blocking.some((c) => raw[cols.indexOf(c)] !== '\\N')
      if (wouldBreak) {
        skippedRows.set(table, (skippedRows.get(table) ?? 0) + 1)
        continue
      }
    }
    const values = row.split('\t').map((v, i) => {
      if (nullAt[i]) return 'NULL'
      if (v === '\\N') return 'NULL'
      return `'${v.replace(/'/g, "''").replace(/\\\\/g, '\\')}'`
    })
    rowSql.push(
      `insert into restroom.${table} (${cols.map((c) => `"${c}"`).join(', ')}) values (${values.join(', ')}) on conflict do nothing;`,
    )
  }
  dataStatements.set(table, rowSql)
  sqlParts.push(...rowSql, '')
}

writeFileSync(OUT, sqlParts.join('\n'))

console.log(`Backup: ${FILE}\n`)
console.log('moving into restroom:')
for (const t of TABLES) console.log(`  ${t.padEnd(16)} ${data.get(t)?.rows.length ?? 0} rows`)
console.log(`\nDDL statements rewritten: ${ddl.length}`)
console.log(`user columns nulled:      ${nulledCount}`)
if (skippedRows.size > 0) {
  console.log('\nrows skipped (their user column is NOT NULL, so orphaning would break it):')
  for (const [t, n] of skippedRows) console.log(`  ${t.padEnd(16)} ${n} — still in the backup`)
}
console.log(`\nleft on the shared layer (${skipped.size}):`)
console.log(`  ${[...skipped].sort().join(', ')}`)
console.log(`\nwrote ${OUT}`)

if (!APPLY) {
  console.log('\ndry run — review that file, then pass --apply')
  process.exit(0)
}

await withClient(
  async (client) => {
    await client.query('begin')
    await client.query('create extension if not exists postgis with schema extensions')
    await client.query('set search_path = restroom, public, extensions')

    /**
     * Dependencies are resolved by retrying rather than by sorting. Views and
     * functions here reference each other in both directions — one function
     * selects from a view, one view calls a function — so no single ordering
     * of the groups works. Deferring whatever fails and going round again
     * settles it, and stops as soon as a pass makes no progress.
     */
    let pending = ordered(ddl)
    const applied = []
    let lastError = null

    for (let pass = 1; pending.length > 0 && pass <= 6; pass++) {
      const deferred = []
      for (const sql of pending) {
        await client.query('savepoint s')
        try {
          await client.query(sql)
          await client.query('release savepoint s')
          applied.push(sql)
        } catch (err) {
          await client.query('rollback to savepoint s')
          deferred.push(sql)
          lastError = err
        }
      }
      console.log(`  pass ${pass}: ${pending.length - deferred.length} applied, ${deferred.length} deferred`)
      if (deferred.length === pending.length) {
        await client.query('rollback')
        console.error(`\nno progress on pass ${pass}, rolled back: ${lastError?.message}`)
        process.exit(1)
      }
      pending = deferred
    }

    for (const [table, block] of dataStatements) {
      if (block.length === 0) continue
      try {
        await client.query(block.join('\n'))
        console.log(`  loaded restroom.${table}: ${block.length} rows`)
      } catch (err) {
        await client.query('rollback')
        console.error(`\nFAILED loading ${table}, rolled back: ${err.message}`)
        process.exit(1)
      }
    }

    // Record it the way the runner would, or `db.mjs migrate restroom` will try
    // to apply this file again and fail on objects that already exist.
    const finalSql = [header, ...applied, '', ...[...dataStatements.values()].flat(), ''].join('\n')
    await client.query(
      'insert into schema_migrations (version, checksum) values ($1, $2) on conflict (version) do update set checksum = excluded.checksum',
      ['0002_imported', createHash('sha256').update(finalSql).digest('hex').slice(0, 16)],
    )

    await client.query('commit')

    // Rewritten in the order that actually worked, so the committed migration
    // replays without needing the retry loop.
    writeFileSync(
      OUT,
      finalSql,
    )
    console.log(`\napplied, and rewrote ${OUT} in the working order`)
  },
  { root: ROOT, applicationName: 'trip-companion/import-restroom' },
)
