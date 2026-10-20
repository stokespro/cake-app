// Loads the Code 128 reader on demand. Nothing here is imported at page load:
// ScanInput reaches this file only through a dynamic import() when the camera
// dialog opens, and this file in turn dynamic-imports the barcode-detector
// ponyfill (and fetches the ~0.9 MB wasm) only if the browser has no native
// BarcodeDetector for Code 128. Android Chrome takes the native path and never
// downloads the wasm; iPhone Safari does not ship BarcodeDetector, so it uses
// the wasm decoder, self-hosted under /zxing/ rather than fetched from jsDelivr.

import { ZXING_WASM_URL } from '@/lib/trim/zxing-asset'

/** What the scanner decodes: a canvas (live crop) or a still photo canvas. */
export type DetectSource = HTMLCanvasElement

export interface HangerDetector {
  /** Raw text of every Code 128 symbol found, in detection order. */
  detect(source: DetectSource): Promise<string[]>
  /** Which engine is running, for the console / debugging only. */
  engine: 'native' | 'wasm'
}

interface DetectorLike {
  detect(source: DetectSource): Promise<Array<{ rawValue: string }>>
}

interface NativeBarcodeDetectorCtor {
  new (options?: { formats?: string[] }): DetectorLike
  getSupportedFormats?: () => Promise<string[]>
}

const FORMATS = ['code_128']

let cached: Promise<HangerDetector> | null = null

async function createWasmDetector(): Promise<DetectorLike> {
  const mod = await import('barcode-detector/ponyfill')
  // Point the module at our copy of the wasm. fireImmediately fetches and
  // instantiates it now, so a load failure surfaces while the dialog is opening
  // instead of on the first frame.
  await mod.prepareZXingModule({
    overrides: {
      locateFile: (path: string, prefix: string) => (path.endsWith('.wasm') ? ZXING_WASM_URL : prefix + path),
    },
    fireImmediately: true,
  })
  return new mod.BarcodeDetector({ formats: ['code_128'] }) as unknown as DetectorLike
}

async function createNativeDetector(): Promise<DetectorLike | null> {
  const Native = (globalThis as { BarcodeDetector?: NativeBarcodeDetectorCtor }).BarcodeDetector
  if (!Native) return null
  try {
    const supported = await Native.getSupportedFormats?.()
    if (supported && !supported.includes('code_128')) return null
    return new Native({ formats: FORMATS })
  } catch {
    return null
  }
}

async function build(): Promise<HangerDetector> {
  let active: DetectorLike | null = await createNativeDetector()
  let engine: HangerDetector['engine'] = active ? 'native' : 'wasm'
  if (!active) active = await createWasmDetector()

  let wasmFallback: Promise<DetectorLike> | null = null

  const self: HangerDetector = {
    get engine() {
      return engine
    },
    async detect(source) {
      try {
        const found = await active!.detect(source)
        return found.map((b) => b.rawValue)
      } catch (err) {
        // A native detector that throws (some devices advertise it but fail at
        // runtime) is replaced by the wasm one once, then we retry this frame.
        if (engine !== 'native') throw err
        wasmFallback ??= createWasmDetector()
        active = await wasmFallback
        engine = 'wasm'
        const found = await active.detect(source)
        return found.map((b) => b.rawValue)
      }
    },
  }
  return self
}

/** One shared detector per page. A failed load is not cached, so "try again" can retry. */
export function loadHangerDetector(): Promise<HangerDetector> {
  if (!cached) {
    cached = build().catch((err) => {
      cached = null
      throw err
    })
  }
  return cached
}
