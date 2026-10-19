// Where the self-hosted zxing reader wasm is served from (public/zxing/).
// The version in the filename must match the installed zxing-wasm; the test in
// zxing-asset.test.ts fails if the file or the version drifts. The versioned
// name also makes the file safe to cache forever.
export const ZXING_WASM_PATH = 'zxing/zxing_reader-3.1.6.wasm'
export const ZXING_WASM_URL = `/${ZXING_WASM_PATH}`
