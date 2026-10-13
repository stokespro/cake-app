// Guards R2.4 of the Harvest & Trim plan: `trim_manager` is a STRICT SUPERSET
// of `packaging`. Role arrays are hard-coded across ~a dozen files, so the
// failure mode is silent drift: someone adds a new `['admin', 'packaging', ...]`
// gate, forgets `trim_manager`, and Joey quietly loses access to that area.
//
// This reads the source files (rather than importing the constants, which are
// mostly module-private) and checks every array literal that contains the
// string 'packaging'.

import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(__dirname, '..')

/**
 * Intentional exceptions: arrays that mention 'packaging' but are deliberately
 * NOT granted to trim_manager. Key is `<relative file>`, value is the exact
 * array contents (as a normalized, comma-joined list) with the reason.
 * Keep this empty unless there is a written reason.
 */
const ALLOWLIST: Array<{ file: string; members: string; reason: string }> = []

function sourceFiles(): string[] {
  const actionsDir = path.join(ROOT, 'actions')
  const actions = readdirSync(actionsDir)
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
    .map((f) => path.join('actions', f))
  return [...actions, 'lib/auth-context.tsx', 'app/dashboard/layout.tsx']
}

interface FoundArray {
  file: string
  line: number
  members: string[]
}

function stripLineComments(src: string): string {
  // Replace (don't delete) so line numbers survive.
  return src
    .split('\n')
    .map((l) => (/^\s*\/\//.test(l) ? '' : l))
    .join('\n')
}

function findPackagingArrays(): FoundArray[] {
  const found: FoundArray[] = []
  for (const file of sourceFiles()) {
    const src = stripLineComments(readFileSync(path.join(ROOT, file), 'utf8'))
    // Innermost array literals only (no nested brackets).
    const re = /\[[^[\]]*\]/g
    let m: RegExpExecArray | null
    while ((m = re.exec(src))) {
      const members = [...m[0].matchAll(/'([^']+)'/g)].map((x) => x[1])
      if (!members.includes('packaging')) continue
      found.push({
        file,
        line: src.slice(0, m.index).split('\n').length,
        members,
      })
    }
  }
  return found
}

function isAllowed(a: FoundArray): boolean {
  return ALLOWLIST.some((e) => e.file === a.file && e.members === a.members.join(','))
}

describe("role array parity: 'packaging' implies 'trim_manager'", () => {
  const arrays = findPackagingArrays()

  it('finds the known packaging role arrays (scanner sanity check)', () => {
    // If a refactor changes how roles are declared and the scanner goes blind,
    // the parity check below would pass vacuously. Fail loudly instead.
    expect(arrays.length).toBeGreaterThanOrEqual(20)
    const files = new Set(arrays.map((a) => a.file))
    for (const f of [
      'actions/cultivation.ts',
      'actions/packaging.ts',
      'actions/packaging-board.ts',
      'actions/dashboard.ts',
      'lib/auth-context.tsx',
      'app/dashboard/layout.tsx',
    ]) {
      expect(files, `expected to find a packaging role array in ${f}`).toContain(f)
    }
  })

  it("every array containing 'packaging' also contains 'trim_manager'", () => {
    const offenders = arrays
      .filter((a) => !a.members.includes('trim_manager') && !isAllowed(a))
      .map((a) => `${a.file}:${a.line}  [${a.members.join(', ')}]`)
    expect(
      offenders,
      `These role arrays contain 'packaging' but not 'trim_manager'. trim_manager is a strict superset of packaging (plan R2.4); add it, or add a justified ALLOWLIST entry:\n${offenders.join('\n')}`
    ).toEqual([])
  })

  it('ALLOWLIST entries still match a real array (no stale exceptions)', () => {
    for (const e of ALLOWLIST) {
      const hit = arrays.some((a) => a.file === e.file && a.members.join(',') === e.members)
      expect(hit, `stale allowlist entry: ${e.file} [${e.members}] (${e.reason})`).toBe(true)
    }
  })
})
