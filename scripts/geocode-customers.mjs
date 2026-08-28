#!/usr/bin/env node
/**
 * Backfill customers.latitude / longitude / geocoded_at.
 *
 * SPRO-115 needs a pin for every dispensary in the CRM, not just the ~85
 * order-placing stores the public site geocoded in one batch on 2026-08-02.
 *
 * Two passes, cheapest first:
 *   1. US Census batch geocoder — free, unlimited, no storage restriction, and
 *      strong on US street addresses. Handles the bulk.
 *   2. Nominatim (OpenStreetMap) — free, 1 req/sec, licence permits storing
 *      results. Recovers the rural-route and malformed rows Census rejects.
 *
 * Re-runnable: only rows with a null latitude are attempted, so a partial or
 * interrupted run is resumed simply by running it again.
 *
 *   node scripts/geocode-customers.mjs [--dry-run] [--limit N] [--census-only]
 *
 * Re-run it to pick up newly added dispensaries; it is idempotent.
 */

import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

// ---------------------------------------------------------------------------
// Env — read .env.local directly; this is a standalone script, not Next.js
// ---------------------------------------------------------------------------

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
const CENSUS_ONLY = args.includes('--census-only')
const LIMIT = (() => {
  const i = args.indexOf('--limit')
  return i >= 0 ? Number(args[i + 1]) : null
})()

const db = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } })

// ---------------------------------------------------------------------------
// Sanity bounds
// ---------------------------------------------------------------------------

/**
 * Oklahoma's bounding box, slightly inflated. A geocoder handed "S 650 RD"
 * with no ZIP will happily return a same-named road in another state; without
 * this check those land as pins in Kansas and read as data corruption rather
 * than a miss. Rejected results are treated as unmatched and fall through to
 * the next pass.
 */
const OK_BOUNDS = { minLat: 33.5, maxLat: 37.1, minLon: -103.2, maxLon: -94.3 }

function inOklahoma(lat, lon) {
  return (
    Number.isFinite(lat) &&
    Number.isFinite(lon) &&
    lat >= OK_BOUNDS.minLat &&
    lat <= OK_BOUNDS.maxLat &&
    lon >= OK_BOUNDS.minLon &&
    lon <= OK_BOUNDS.maxLon
  )
}

// ---------------------------------------------------------------------------
// Address parsing
// ---------------------------------------------------------------------------

const STATE_TOKEN = /^(ok|okla|oklahoma)\.?$/i

/**
 * CRM addresses are stored as "STREET, CITY" with no state and no ZIP
 * ("108 S MAIN ST, BLACKWELL"). A minority carry a suite in the middle
 * ("440 SW 59TH ST Bldg B, OKLAHOMA CITY") or a stray trailing state token.
 * Split from the right so extra commas stay with the street.
 */
function parseAddress(row) {
  const parts = String(row.address || '')
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean)

  // Drop a trailing state token so it is not mistaken for the city.
  while (parts.length > 1 && STATE_TOKEN.test(parts[parts.length - 1])) parts.pop()

  if (parts.length === 0) return null

  if (parts.length === 1) {
    // No city in the address string — fall back to the column.
    const city = (row.city || '').trim()
    if (!city) return null
    return { street: parts[0], city }
  }

  const city = parts[parts.length - 1]
  const street = parts.slice(0, -1).join(' ')
  if (!street || !city) return null
  return { street, city }
}

// ---------------------------------------------------------------------------
// Pass 1 — US Census batch geocoder
// ---------------------------------------------------------------------------

const CENSUS_URL =
  'https://geocoding.geo.census.gov/geocoder/locations/addressbatch'
/** Census accepts 10k rows per file, but smaller batches fail less and let a
 *  timeout cost one chunk rather than the whole run. */
const CENSUS_BATCH = 250

function csvField(v) {
  const s = String(v ?? '')
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

/** Census returns CSV with every field quoted; fields can contain commas. */
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

async function censusBatch(batch) {
  const csv = batch
    .map((r) =>
      [csvField(r.id), csvField(r.street), csvField(r.city), 'OK', ''].join(',')
    )
    .join('\n')

  const form = new FormData()
  form.append('benchmark', 'Public_AR_Current')
  form.append(
    'addressFile',
    new Blob([csv], { type: 'text/csv' }),
    'addresses.csv'
  )

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
    // id, input, status, matchType, matchedAddress, "lon,lat", tigerId, side
    if (f[2] !== 'Match' || !f[5]) continue
    const [lon, lat] = f[5].split(',').map(Number)
    if (!inOklahoma(lat, lon)) continue
    hits.set(f[0], { latitude: lat, longitude: lon })
  }
  return hits
}

// ---------------------------------------------------------------------------
// Pass 2 — Nominatim (OpenStreetMap)
// ---------------------------------------------------------------------------

/**
 * What Census misses is mostly rural-route addresses ("65899 E 153 RD") and
 * rows carrying suite noise or a glued-on state and ZIP. Census matches against
 * a strict street-range file and rejects those outright; Nominatim parses
 * free-form text and recovers a useful share of them.
 *
 * Chosen over Mapbox because the only Mapbox token we hold is scoped to map
 * tiles for the public site and is Forbidden on the geocoding API. Nominatim is
 * free and its licence permits storing results, so no key or spend is needed.
 * Usage policy caps this at 1 request/second with a identifying User-Agent,
 * which is why this pass is serial and slow — it is a few hundred rows, once.
 */

const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/search'
const NOMINATIM_UA = 'cake-app-crm-geocoder/1.0 (joshua@stokes.pro)'
const NOMINATIM_DELAY_MS = 1100

/** Suite/unit noise defeats both geocoders; the street range is what matters. */
const UNIT_NOISE = /(,\s*)?\b(ste|suite|apt|apartment|unit|bldg|building|rm|room)\b\.?\s*[\w-]*|#\s*[\w-]+/gi

/** A trailing "Oklahoma 74354" / "OK 73112-6902" the CRM sometimes carries. */
const TRAILING_STATE_ZIP = /,?\s*(ok|okla|oklahoma)\.?\s*\d{5}(-\d{4})?\s*$/i

function clean(text) {
  return String(text || '')
    .replace(UNIT_NOISE, ' ')
    .replace(/\s{2,}/g, ' ')
    .replace(/\s*,\s*/g, ', ')
    .replace(/^[\s,]+|[\s,]+$/g, '')
}

/**
 * Two shots per row, cheapest signal first: the street/city split Census was
 * given (minus unit noise), then the raw stored address as free text. The
 * second recovers rows whose city never split off cleanly — a comma-less
 * "1012 E Steve Owens Blvd Miami, Oklahoma 74354" parses to a city of
 * "Oklahoma 74354" and can only be read as free text.
 */
function nominatimQueries(row) {
  const structured = `${clean(row.street)}, ${clean(row.city)}, OK, USA`
  const freeform = `${clean(String(row.rawAddress || '').replace(TRAILING_STATE_ZIP, ''))}, OK, USA`
  return structured.toLowerCase() === freeform.toLowerCase()
    ? [structured]
    : [structured, freeform]
}

async function nominatimOne(row) {
  for (const q of nominatimQueries(row)) {
    const url =
      `${NOMINATIM_URL}?format=json&limit=1&countrycodes=us&q=${encodeURIComponent(q)}`
    const res = await fetch(url, {
      headers: { 'User-Agent': NOMINATIM_UA },
      signal: AbortSignal.timeout(30_000),
    })
    await new Promise((r) => setTimeout(r, NOMINATIM_DELAY_MS))
    if (!res.ok) throw new Error(`Nominatim HTTP ${res.status}`)
    const json = await res.json()
    const first = Array.isArray(json) ? json[0] : null
    if (!first) continue
    const lat = Number(first.lat)
    const lon = Number(first.lon)
    if (!inOklahoma(lat, lon)) continue
    return { latitude: lat, longitude: lon }
  }
  return null
}

// ---------------------------------------------------------------------------
// Write-back
// ---------------------------------------------------------------------------

const stampedAt = new Date().toISOString()

/**
 * Per-row updates rather than an upsert: an upsert on `customers` would need
 * every NOT NULL column echoed back, and a mistake there overwrites live CRM
 * records. Updating two columns by primary key cannot damage anything else.
 *
 * A Supabase update matching no rows returns 204 with no error, so the returned
 * row is asserted rather than assumed.
 */
async function writeCoords(id, coords) {
  if (DRY_RUN) return true
  const { data, error } = await db
    .from('customers')
    .update({ ...coords, geocoded_at: stampedAt })
    .eq('id', id)
    .select('id')
  if (error) {
    console.error(`  write failed for ${id}: ${error.message}`)
    return false
  }
  if (!data || data.length !== 1) {
    console.error(`  write matched ${data?.length ?? 0} rows for ${id} — expected 1`)
    return false
  }
  return true
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function fetchPending() {
  // Supabase caps a single select at 1000 rows; page through explicitly.
  const all = []
  const PAGE = 1000
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await db
      .from('customers')
      .select('id, business_name, address, city')
      .is('latitude', null)
      .not('address', 'is', null)
      .order('id')
      .range(from, from + PAGE - 1)
    if (error) throw new Error(error.message)
    all.push(...data)
    if (data.length < PAGE) break
  }
  return all
}

async function main() {
  console.log(`Geocoding backfill${DRY_RUN ? ' (DRY RUN — no writes)' : ''}`)

  const pending = await fetchPending()
  const parsed = []
  const unparseable = []
  for (const row of pending) {
    const p = parseAddress(row)
    if (p) parsed.push({ id: row.id, name: row.business_name, rawAddress: row.address, ...p })
    else unparseable.push(row)
  }

  const work = LIMIT ? parsed.slice(0, LIMIT) : parsed
  console.log(
    `  ${pending.length} rows without coordinates` +
      `\n  ${parsed.length} parsed into street + city` +
      `\n  ${unparseable.length} unparseable (no city recoverable)` +
      `\n  ${work.length} queued this run\n`
  )

  let written = 0
  const misses = []
  const unresolved = []

  // --- Pass 1: Census ---
  for (let i = 0; i < work.length; i += CENSUS_BATCH) {
    const batch = work.slice(i, i + CENSUS_BATCH)
    const label = `census ${i + 1}-${i + batch.length} of ${work.length}`
    let hits
    try {
      hits = await censusBatch(batch)
    } catch (err) {
      console.error(`  ${label}: ${err.message} — deferring batch to pass 2`)
      misses.push(...batch)
      continue
    }
    for (const row of batch) {
      const hit = hits.get(row.id)
      if (!hit) {
        misses.push(row)
        continue
      }
      if (await writeCoords(row.id, hit)) written++
    }
    console.log(`  ${label}: ${hits.size} matched`)
  }

  console.log(`\nCensus pass: ${written} written, ${misses.length} unmatched`)

  // --- Pass 2: Nominatim ---
  if (CENSUS_ONLY) {
    console.log('Skipping Nominatim pass (--census-only)')
  } else if (misses.length) {
    console.log(
      `\nNominatim pass: ${misses.length} rows at ~1/sec` +
        ` (~${Math.ceil((misses.length * 2 * NOMINATIM_DELAY_MS) / 60000)} min worst case)`
    )
    let nWritten = 0
    let nFailed = 0
    for (let i = 0; i < misses.length; i++) {
      const row = misses[i]
      try {
        const hit = await nominatimOne(row)
        if (hit && (await writeCoords(row.id, hit))) nWritten++
        else {
          nFailed++
          unresolved.push(row)
        }
      } catch (err) {
        console.error(`  nominatim ${row.name}: ${err.message}`)
        nFailed++
        unresolved.push(row)
      }
      if (i % 50 === 49) console.log(`  ${i + 1}/${misses.length} — ${nWritten} matched`)
    }
    written += nWritten
    console.log(`\nNominatim pass: ${nWritten} written, ${nFailed} still unresolved`)
  }

  const { count: remaining } = await db
    .from('customers')
    .select('id', { count: 'exact', head: true })
    .is('latitude', null)

  console.log(
    `\nDone. ${written} coordinates written this run.` +
      ` ${remaining} customers still without coordinates.`
  )

  if (unresolved.length) {
    console.log('\nStill unresolved — no geocoder matched these addresses:')
    for (const r of unresolved.slice(0, 25)) {
      console.log(`  ${r.name} — ${JSON.stringify(r.rawAddress)}`)
    }
    if (unresolved.length > 25) console.log(`  ...and ${unresolved.length - 25} more`)
  }

  if (unparseable.length) {
    console.log('\nRows with an address no city could be recovered from:')
    for (const r of unparseable.slice(0, 20)) {
      console.log(`  ${r.business_name} — ${JSON.stringify(r.address)}`)
    }
    if (unparseable.length > 20) console.log(`  ...and ${unparseable.length - 20} more`)
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
