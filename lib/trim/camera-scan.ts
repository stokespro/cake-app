// Pure logic behind camera scanning of hanger tags. No DOM, no I/O, no wasm:
// the browser glue (getUserMedia, canvas, the detector) lives in
// components/harvest-trim/camera-scanner.tsx and hanger-detector.ts, and only
// feeds numbers and strings into the functions below.
//
// Validation of what was read is NOT here: callers run the result through
// parseHangerCodeStrict (lib/trim/hanger-code.ts), same as the wedge scanner.

/** How often a live frame is decoded, measured start to start. */
export const SCAN_INTERVAL_MS = 150

/** Identical reads in a row required before a value is trusted. 1D codes misread easily. */
export const CONFIRM_FRAMES = 3

/** Frames with nothing readable tolerated inside a streak (motion blur, glare). */
export const CONFIRM_MISS_TOLERANCE = 1

/** No new video frame for this long means the stream is dead; switch to a still photo. */
export const STALL_TIMEOUT_MS = 3000

/** Every Nth attempt decodes the whole frame, so a rotated frame or a mis-aimed tag still reads. */
export const FULL_FRAME_EVERY = 4

// ---------------------------------------------------------------------------
// Frame confirmation
// ---------------------------------------------------------------------------

export interface ConfirmState {
  value: string | null
  count: number
  misses: number
}

export interface ConfirmOptions {
  required?: number
  missTolerance?: number
}

export function createConfirmState(): ConfirmState {
  return { value: null, count: 0, misses: 0 }
}

export interface ConfirmStep {
  state: ConfirmState
  /** Set on the frame that completes a streak; the value is now trusted. */
  confirmed: string | null
}

/**
 * Feed one decoded frame (`null` = nothing readable). A value is confirmed once
 * it has been read `required` times with no different value in between and at
 * most `missTolerance` empty frames in a row. A different value restarts the
 * streak at 1 rather than at 0, so the new value is not penalised.
 */
export function confirmFrame(
  state: ConfirmState,
  read: string | null,
  options: ConfirmOptions = {},
): ConfirmStep {
  const required = Math.max(1, options.required ?? CONFIRM_FRAMES)
  const missTolerance = Math.max(0, options.missTolerance ?? CONFIRM_MISS_TOLERANCE)

  if (read === null || read === '') {
    if (state.value === null) return { state, confirmed: null }
    const misses = state.misses + 1
    if (misses > missTolerance) return { state: createConfirmState(), confirmed: null }
    return { state: { ...state, misses }, confirmed: null }
  }

  const count = state.value === read ? state.count + 1 : 1
  if (count >= required) return { state: createConfirmState(), confirmed: read }
  return { state: { value: read, count, misses: 0 }, confirmed: null }
}

// ---------------------------------------------------------------------------
// Guide-box crop
// ---------------------------------------------------------------------------

/** The guide box as fractions of the on-screen preview (0..1). */
export interface GuideBox {
  x: number
  y: number
  w: number
  h: number
}

/** Wide and short: a Code 128 tag is a horizontal strip. */
export const GUIDE_BOX: GuideBox = { x: 0.08, y: 0.3, w: 0.84, h: 0.4 }

export interface CropRect {
  sx: number
  sy: number
  sw: number
  sh: number
}

/**
 * Map the on-screen guide box back to source-video pixels when the preview is
 * shown with `object-fit: cover` in a container of the given aspect ratio. Cover
 * crops the video to fill the container, so the visible region is smaller than
 * the frame and the guide fractions apply to that region, not to the frame.
 * Result is clamped to the frame and rounded to whole pixels.
 */
export function coverCropRect(
  videoW: number,
  videoH: number,
  containerAspect: number,
  guide: GuideBox = GUIDE_BOX,
): CropRect | null {
  if (!(videoW > 0) || !(videoH > 0) || !(containerAspect > 0)) return null

  const videoAspect = videoW / videoH
  // Visible region of the source, centred.
  let visW = videoW
  let visH = videoH
  if (videoAspect > containerAspect) visW = videoH * containerAspect
  else visH = videoW / containerAspect
  const offX = (videoW - visW) / 2
  const offY = (videoH - visH) / 2

  const sx = Math.max(0, Math.round(offX + guide.x * visW))
  const sy = Math.max(0, Math.round(offY + guide.y * visH))
  const sw = Math.min(videoW - sx, Math.round(guide.w * visW))
  const sh = Math.min(videoH - sy, Math.round(guide.h * visH))
  if (sw <= 0 || sh <= 0) return null
  return { sx, sy, sw, sh }
}

/** Scale to fit within `maxEdge` on the long side; never upscales. */
export function fitWithin(w: number, h: number, maxEdge: number): { w: number; h: number } {
  const longest = Math.max(w, h)
  if (!(longest > maxEdge)) return { w: Math.round(w), h: Math.round(h) }
  const k = maxEdge / longest
  return { w: Math.max(1, Math.round(w * k)), h: Math.max(1, Math.round(h * k)) }
}

// ---------------------------------------------------------------------------
// Stall detection (the "stream silently closed" iOS PWA failure)
// ---------------------------------------------------------------------------

export interface StallState {
  lastTime: number | null
  lastProgressAt: number
}

export function createStallState(now: number): StallState {
  return { lastTime: null, lastProgressAt: now }
}

/**
 * Observe the video element's `currentTime`. Any change counts as a new frame.
 * `stalled` is true once nothing has moved for `timeoutMs` (including never
 * having produced a first frame since the state was created).
 */
export function observeStall(
  state: StallState,
  currentTime: number,
  now: number,
  timeoutMs: number = STALL_TIMEOUT_MS,
): { state: StallState; stalled: boolean } {
  const progressed = state.lastTime === null ? currentTime > 0 : currentTime !== state.lastTime
  const next: StallState = progressed
    ? { lastTime: currentTime, lastProgressAt: now }
    : { lastTime: state.lastTime ?? null, lastProgressAt: state.lastProgressAt }
  return { state: next, stalled: now - next.lastProgressAt >= timeoutMs }
}

// ---------------------------------------------------------------------------
// Capability + error classification
// ---------------------------------------------------------------------------

export interface CameraEnv {
  isSecureContext: boolean
  hasMediaDevices: boolean
}

/** False hides the camera button entirely: it would only ever fail. */
export function cameraAvailable(env: CameraEnv): boolean {
  return env.isSecureContext && env.hasMediaDevices
}

export type CameraFailure =
  | 'denied' // user or OS said no: tell them how to re-enable
  | 'no_camera' // no device: hide-worthy, fall to typing
  | 'unavailable' // anything else (in use, overconstrained, stream error): try the still-photo path

export function classifyCameraError(err: unknown): CameraFailure {
  const name = (err as { name?: string } | null)?.name ?? ''
  if (name === 'NotAllowedError' || name === 'SecurityError' || name === 'PermissionDeniedError') {
    return 'denied'
  }
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
    return 'no_camera'
  }
  return 'unavailable'
}
