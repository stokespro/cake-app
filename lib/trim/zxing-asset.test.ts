// Guards the self-hosted decoder. The wasm in public/ must be byte-identical to
// the one shipped by the installed zxing-wasm, and its filename must carry that
// version. Upgrading barcode-detector without refreshing the file (so the JS
// and WASM drift apart) fails here instead of on a phone.
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { ZXING_WASM_PATH } from './zxing-asset'

const root = process.cwd()
const sha = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex')

describe('self-hosted zxing wasm', () => {
  const pkg = JSON.parse(readFileSync(path.join(root, 'node_modules/zxing-wasm/package.json'), 'utf8'))
  const installed = path.join(root, 'node_modules/zxing-wasm/dist/reader/zxing_reader.wasm')
  const served = path.join(root, 'public', ZXING_WASM_PATH)

  it('is served from a path that names the installed zxing-wasm version', () => {
    expect(ZXING_WASM_PATH).toContain(`-${pkg.version}.wasm`)
  })

  it('is byte-identical to the installed package', () => {
    expect(sha(served)).toBe(sha(installed))
  })

  it('matches the hash the library itself reports', async () => {
    const { ZXING_WASM_SHA256 } = await import('zxing-wasm/reader')
    expect(sha(served)).toBe(ZXING_WASM_SHA256)
  })

  it('barcode-detector is pinned exactly', () => {
    const app = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'))
    expect(app.dependencies['barcode-detector']).toMatch(/^\d+\.\d+\.\d+$/)
  })
})
