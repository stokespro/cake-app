// types/harvest-trim.ts is imported by 'use server' action files, and
// scripts/check-server-exports.mjs (run during `npm run build`) fails the build
// on re-export syntax in server files (the SPRO-82 outage). Keep the types file
// to plain `export type` / `export interface` declarations so nothing
// downstream can trip it.

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const source = readFileSync(path.resolve(__dirname, '../../types/harvest-trim.ts'), 'utf8')
// Strip comments so prose can't trip or mask the checks.
const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
const exportLines = code.split('\n').filter((l) => /^\s*export\b/.test(l))

describe('types/harvest-trim.ts export form', () => {
  it('has exports', () => {
    expect(exportLines.length).toBeGreaterThan(10)
  })
  it('only declares `export type X` / `export interface X`', () => {
    for (const line of exportLines) {
      expect(line, line).toMatch(/^export (type|interface) [A-Za-z_][A-Za-z0-9_]*/)
    }
  })
  it('never re-exports', () => {
    expect(code).not.toMatch(/export\s+type\s*\{/)
    expect(code).not.toMatch(/export\s*\{/)
    expect(code).not.toMatch(/export\s*\*/)
    expect(code).not.toMatch(/export\s+default/)
  })
  it('has no runtime exports', () => {
    expect(code).not.toMatch(/export\s+(const|let|var|function|class|enum)\b/)
  })
})
