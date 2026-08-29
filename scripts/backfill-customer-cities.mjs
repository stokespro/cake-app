#!/usr/bin/env node
/**
 * Fill in customers.city where it is missing.
 *
 * Half the dispensaries on the map (861 of 1,785) carry no city at all, which
 * makes a "jump to city" control useless for them. The city is recoverable:
 * the Census batch geocoder already returns a normalised address —
 * "108 S MAIN ST, BLACKWELL, OK, 74631" — and we simply discarded the city
 * component when backfilling coordinates. This asks for it again and keeps it.
 *
 * WRITES ARE DELIBERATELY CONSERVATIVE. Only rows where city is null or blank
 * are touched. A value somebody typed is never overwritten, even when the
 * geocoder disagrees with it — `customers` is live CRM data and a wrong bulk
 * rewrite is far more expensive than a missing city.
 *
 * The pre-existing junk in that column (street fragments like "S ND ST" and
 * "W TH AVE", the residue of an old import) is therefore left alone and
 * reported at the end instead, so a human can decide.
 *
 *   node scripts/backfill-customer-cities.mjs [--dry-run] [--limit N]
 *
 * Re-runnable and idempotent: rows that already have a city are skipped.
 */

import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

function loadEnvLocal() {
  try {
    const raw = readFileSync(resolve(process.cwd(), '.env.local'), 'utf8')
    for (const line of raw.split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/)
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '')
    }
  } catch {
    // fall through to real env vars
  }
}
loadEnvLocal()

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY')
  process.exit(1)
}

const args = process.argv.slice(2)
const DRY_RUN = args.includes('--dry-run')
const LIMIT = (() => {
  const i = args.indexOf('--limit')
  return i >= 0 ? Number(args[i + 1]) : null
})()

const db = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } })

// ---------------------------------------------------------------------------
// Address parsing (mirrors scripts/geocode-customers.mjs)
// ---------------------------------------------------------------------------

const STATE_TOKEN = /^(ok|okla|oklahoma)\.?$/i

function parseAddress(row) {
  const parts = String(row.address || '')
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean)

  while (parts.length > 1 && STATE_TOKEN.test(parts[parts.length - 1])) parts.pop()
  if (parts.length < 2) return null

  const city = parts[parts.length - 1]
  const street = parts.slice(0, -1).join(' ')
  if (!street || !city) return null
  return { street, city }
}

/**
 * Does this look like a street fragment rather than a town?
 *
 * The bad import split some addresses one comma too early, leaving values like
 * "S ND ST", "W TH AVE" and "PHELPS AVE" in the city column. Used only to
 * decide whether the address-derived fallback is trustworthy — never to
 * overwrite anything.
 */
const STREET_WORD =
  /\b(st|street|ave|avenue|rd|road|blvd|boulevard|dr|drive|ln|lane|ct|court|pl|place|hwy|highway|expy|expressway|pkwy|parkway|ter|terrace|cir|circle|way|suite|ste|unit)\b\.?$/i

function looksLikeStreet(value) {
  const v = String(value || '').trim()
  if (!v) return true
  if (/^\d+$/.test(v)) return true
  return STREET_WORD.test(v)
}

// ---------------------------------------------------------------------------
// Census batch geocoder — we want the matched address, not the coordinates
// ---------------------------------------------------------------------------

const CENSUS_URL = 'https://geocoding.geo.census.gov/geocoder/locations/addressbatch'
const CENSUS_BATCH = 250

function csvField(v) {
  const s = String(v ?? '')
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

function parseCsvLine(line) {
  const out = []
  let cur = ''
  let inQuotes = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"'
          i++
        } else inQuotes = false
      } else cur += ch
    } else if (ch === '"') inQuotes = true
    else if (ch === ',') {
      out.push(cur)
      cur = ''
    } else cur += ch
  }
  out.push(cur)
  return out
}

/**
 * Field 4 of a Census match is the normalised address:
 * "108 S MAIN ST, BLACKWELL, OK, 74631". The city is the second component.
 */
function cityFromMatchedAddress(matched) {
  const parts = String(matched || '').split(',').map((p) => p.trim())
  if (parts.length < 3) return null
  const city = parts[1]
  return city ? city.toUpperCase() : null
}

async function censusBatch(batch) {
  const csv = batch
    .map((r) => [csvField(r.id), csvField(r.street), csvField(r.city), 'OK', ''].join(','))
    .join('\n')

  const form = new FormData()
  form.append('benchmark', 'Public_AR_Current')
  form.append('addressFile', new Blob([csv], { type: 'text/csv' }), 'addresses.csv')

  const res = await fetch(CENSUS_URL, {
    method: 'POST',
    body: form,
    signal: AbortSignal.timeout(180_000),
  })
  if (!res.ok) throw new Error(`Census HTTP ${res.status}`)

  const text = await res.text()
  const hits = new Map()
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    const f = parseCsvLine(line.trim())
    if (f[2] !== 'Match') continue
    const city = cityFromMatchedAddress(f[4])
    if (city) hits.set(f[0], city)
  }
  return hits
}

// ---------------------------------------------------------------------------
// Write-back
// ---------------------------------------------------------------------------

/**
 * A Supabase UPDATE matching no rows returns 204 with no error, so the affected
 * row is asserted rather than assumed. The `.is('city', null)` guard makes the
 * write a no-op if someone filled the city in between the read and here.
 */
async function writeCity(id, city) {
  if (DRY_RUN) return true
  const { data, error } = await db
    .from('customers')
    .update({ city })
    .eq('id', id)
    .is('city', null)
    .select('id')
  if (error) {
    console.error(`  write failed for ${id}: ${error.message}`)
    return false
  }
  if (!data || data.length !== 1) {
    console.error(`  write matched ${data?.length ?? 0} rows for ${id} — skipped`)
    return false
  }
  return true
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function fetchPending() {
  const all = []
  const PAGE = 1000
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await db
      .from('customers')
      .select('id, business_name, address, city')
      .is('city', null)
      .not('address', 'is', null)
      .order('id')
      .range(from, from + PAGE - 1)
    if (error) throw new Error(error.message)
    all.push(...data)
    if (data.length < PAGE) break
  }
  return all
}

async function reportJunk() {
  const { data } = await db
    .from('customers')
    .select('city')
    .not('city', 'is', null)
  const counts = new Map()
  for (const r of data ?? []) {
    const v = String(r.city).trim()
    if (!v || !looksLikeStreet(v)) continue
    counts.set(v.toUpperCase(), (counts.get(v.toUpperCase()) ?? 0) + 1)
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1])
}

async function main() {
  console.log(`City backfill${DRY_RUN ? ' (DRY RUN — no writes)' : ''}`)

  const pending = await fetchPending()
  const parsed = []
  for (const row of pending) {
    const p = parseAddress(row)
    parsed.push({ id: row.id, name: row.business_name, raw: row.address, ...(p ?? {}) })
  }

  const work = LIMIT ? parsed.slice(0, LIMIT) : parsed
  console.log(`  ${pending.length} rows with no city\n  ${work.length} queued this run\n`)

  let written = 0
  let fromCensus = 0
  let fromAddress = 0
  const unresolved = []

  for (let i = 0; i < work.length; i += CENSUS_BATCH) {
    const batch = work.slice(i, i + CENSUS_BATCH)
    const geocodable = batch.filter((r) => r.street && r.city)

    let hits = new Map()
    if (geocodable.length) {
      try {
        hits = await censusBatch(geocodable)
      } catch (err) {
        console.error(`  batch ${i + 1}: ${err.message} — falling back to address parsing`)
      }
    }

    for (const row of batch) {
      let city = hits.get(row.id) ?? null
      let source = 'census'

      // Fallback: the city the address itself carries, but only when it does
      // not look like a mis-split street. A wrong city is worse than none —
      // it puts the dispensary under a heading it does not belong to.
      if (!city && row.city && !looksLikeStreet(row.city)) {
        city = row.city.toUpperCase()
        source = 'address'
      }

      if (!city) {
        unresolved.push(row)
        continue
      }
      if (await writeCity(row.id, city)) {
        written++
        if (source === 'census') fromCensus++
        else fromAddress++
      }
    }
    console.log(`  ${Math.min(i + CENSUS_BATCH, work.length)}/${work.length} — ${written} written`)
  }

  console.log(
    `\nDone. ${written} cities written (${fromCensus} from Census, ${fromAddress} from the address string).`
  )

  const { count: stillNull } = await db
    .from('customers')
    .select('id', { count: 'exact', head: true })
    .is('city', null)
  console.log(`${stillNull} customers still have no city.`)

  if (unresolved.length) {
    console.log(`\nNo trustworthy city for ${unresolved.length} rows:`)
    for (const r of unresolved.slice(0, 15)) {
      console.log(`  ${r.name} — ${JSON.stringify(r.raw)}`)
    }
    if (unresolved.length > 15) console.log(`  ...and ${unresolved.length - 15} more`)
  }

  const junk = await reportJunk()
  if (junk.length) {
    console.log(
      `\nPre-existing city values that look like street fragments (NOT modified —` +
        ` fix these in the CRM if they matter):`
    )
    for (const [value, n] of junk) console.log(`  ${n.toString().padStart(3)}x  ${value}`)
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
