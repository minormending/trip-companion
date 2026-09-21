#!/usr/bin/env node
/**
 * Run SQL against the shared database. The generic pieces live in map-kit;
 * this file is the part that knows about several apps sharing one Postgres.
 *
 *   node scripts/db.mjs status  platform    applied and pending, shared layer
 *   node scripts/db.mjs migrate platform    apply the shared layer (once per DB)
 *   node scripts/db.mjs status  trip        this app's own schema
 *   node scripts/db.mjs migrate trip
 *   node scripts/db.mjs queue               open reports across every app
 *   node scripts/db.mjs query "select …"
 *
 * WHY A SET ARGUMENT: map-kit's runner creates `schema_migrations` unqualified,
 * so it lands wherever search_path points. Pointing it at each app's own schema
 * gives every app its own tracking table — otherwise two apps in one database
 * share one table and collide on version numbers, because both number their
 * migrations from 0001.
 */
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { withClient } from '@minormending/map-kit/node/connect'
import { migrate, status, printResult } from '@minormending/map-kit/node/migrate'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

/** Migration sets. `schema` is where that set's tracking table lives. */
const SETS = {
  platform: { dir: 'supabase/platform', schema: 'public' },
  trip: { dir: 'supabase/trip', schema: 'trip' },
}

const [command, ...rest] = process.argv.slice(2)

function usage(message) {
  if (message) console.error(`${message}\n`)
  console.error(`Usage:
  node scripts/db.mjs status  <${Object.keys(SETS).join('|')}>
  node scripts/db.mjs migrate <${Object.keys(SETS).join('|')}>
  node scripts/db.mjs queue
  node scripts/db.mjs query "<sql>"

Apply platform before any app set: the app schemas reference profiles,
rate_limit and apps, and will fail without them.`)
  process.exit(2)
}

async function withSet(name, fn) {
  const set = SETS[name]
  if (!set) usage(`Unknown set "${name ?? ''}".`)
  await withClient(async (client) => {
    // The schema has to exist before search_path can point at it, and the
    // set's own first migration is what creates it.
    if (set.schema !== 'public') {
      await client.query(`create schema if not exists ${set.schema}`)
    }
    await client.query(`set search_path = ${set.schema}, public, extensions`)
    return fn(client, join(ROOT, set.dir))
  }, { root: ROOT, applicationName: `trip-companion/db:${name}` })
}

switch (command) {
  case 'status':
    await withSet(rest[0], (client, dir) => status(client, dir))
    break

  case 'migrate':
    await withSet(rest[0], (client, dir) => migrate(client, dir))
    break

  case 'queue':
    await withClient(
      async (client) => {
        const res = await client.query(`
          select app, source, kind, subject, left(message, 80) as message, created_at
            from public.moderation_queue where resolved_at is null
          union all
          select app, source, kind, subject, left(message, 80), created_at
            from public.trip_moderation_queue where resolved_at is null
          order by created_at desc limit 50`)
        printResult(res)
      },
      { root: ROOT, applicationName: 'trip-companion/db:queue' },
    )
    break

  case 'query': {
    const sql = rest.join(' ')
    if (!sql) usage('query needs some SQL.')
    await withClient(async (client) => printResult(await client.query(sql)), {
      root: ROOT,
      applicationName: 'trip-companion/db:query',
    })
    break
  }

  default:
    usage()
}
