#!/usr/bin/env node
/**
 * Guard against the SPRO-82 production outage (2026-08-06).
 *
 * Next.js registers EVERY export in a 'use server' module as a callable server
 * action. A re-export of an imported *type* survives that registration as
 * `registerServerReference(SomeType, ...)`, but types are erased at compile
 * time — so the module throws `ReferenceError: SomeType is not defined` at
 * evaluation. That kills the whole module and every server action in it.
 *
 * This shipped once and blanked the entire finance section in production:
 * bills, templates, vendors and overview all rendered "no data" while the
 * database was completely intact. `next build` exits 0 and `tsc --noEmit`
 * passes, because the code is valid TypeScript — the failure is runtime-only.
 * Hence this check.
 *
 * Type *declarations* (`export type Foo = ...`, `export interface Foo {}`) are
 * fine: they have no imported binding to leak. Only re-export forms are unsafe.
 *
 * Run: node scripts/check-server-exports.mjs
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const ROOT = process.cwd()
const SEARCH_DIRS = ['actions', 'app', 'lib', 'components']
const SKIP = new Set(['node_modules', '.next', '.git', 'dist', 'build'])

/** `export type { X }` / `export interface { ... }` re-export forms. */
const TYPE_REEXPORT = /^\s*export\s+(?:type|interface)\s*\{/
/** A bare `export { X }` with no `from` is also a value re-export of a local binding. */
const BARE_REEXPORT = /^\s*export\s*\{[^}]*\}\s*$/

function walk(dir, out = []) {
  let entries
  try {
    entries = readdirSync(dir)
  } catch {
    return out
  }
  for (const entry of entries) {
    if (SKIP.has(entry)) continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (/\.tsx?$/.test(entry)) out.push(full)
  }
  return out
}

const violations = []

for (const dir of SEARCH_DIRS) {
  for (const file of walk(join(ROOT, dir))) {
    const src = readFileSync(file, 'utf8')
    // 'use server' must be the module directive — first non-comment, non-blank line.
    const head = src.split('\n').slice(0, 5).join('\n')
    if (!/^\s*['"]use server['"]/m.test(head)) continue

    src.split('\n').forEach((line, i) => {
      if (TYPE_REEXPORT.test(line) || BARE_REEXPORT.test(line)) {
        violations.push({
          file: relative(ROOT, file),
          line: i + 1,
          text: line.trim(),
        })
      }
    })
  }
}

if (violations.length > 0) {
  console.error(
    "\n\x1b[31mERROR: type/value re-export found in a 'use server' file.\x1b[0m\n"
  )
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line}\n    ${v.text}`)
  }
  console.error(
    "\nNext.js registers every export in a 'use server' file as a server action.\n" +
      'A re-exported type is erased at compile time, so the module throws\n' +
      'ReferenceError at evaluation and every server action in it dies.\n\n' +
      'Fix: move the type to a plain module and import it from there directly.\n' +
      'See the note at the top of actions/finance.ts.\n'
  )
  process.exit(1)
}

console.log("✓ no unsafe re-exports in 'use server' files")
