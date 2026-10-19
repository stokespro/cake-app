'use client'

// Optional camera entry for a hanger tag. Opened from ScanInput's camera button;
// the wedge scanner and the typed box are untouched and still work underneath.
//
// Tier one: a live view that decodes the guide box about every 150 ms and only
// accepts a value read identically several frames in a row (lib/trim/camera-scan.ts).
// Tier two: if the camera refuses to start, the stream dies, or no frames arrive
// for ~3 s (the installed-iOS-PWA failure modes), we offer a single still photo
// from the system camera and decode that instead.
//
// Everything a read is checked against is parseHangerCodeStrict, the same
// validator the wedge uses. This component mounts only while open, so closing it
// (including unmount) stops the camera.

import { useCallback, useEffect, useRef, useState } from 'react'
import { Camera, Flashlight, FlashlightOff, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  CONFIRM_FRAMES,
  FULL_FRAME_EVERY,
  GUIDE_BOX,
  SCAN_INTERVAL_MS,
  STALL_TIMEOUT_MS,
  classifyCameraError,
  confirmFrame,
  coverCropRect,
  createConfirmState,
  createStallState,
  fitWithin,
  observeStall,
  type CameraFailure,
  type ConfirmState,
} from '@/lib/trim/camera-scan'
import { parseHangerCodeStrict } from '@/lib/trim/hanger-code'
import { loadHangerDetector, type HangerDetector } from './hanger-detector'
import { scanFeedback } from './scan-feedback'

const LIVE_MAX_EDGE = 1600
const FULL_FRAME_MAX_EDGE = 1280
const PHOTO_MAX_EDGE = 2000
const MAX_DETECT_ERRORS = 5

type Phase =
  | 'starting'
  | 'live'
  | 'photo' // live view unavailable: offer a still photo
  | 'reading' // decoding the photo
  | 'denied'
  | 'no_camera'
  | 'engine_error'

interface CameraScannerProps {
  /** A valid, canonical hanger code. The caller closes the scanner. */
  onCode: (code: string) => void
  onClose: () => void
}

function notRecognised(value: string, error: string, message: string): string {
  if (error === 'looks_like_metrc_tag') return message
  const shown = value.length > 24 ? `${value.slice(0, 24)}...` : value
  return `Read "${shown}", which is not a hanger tag.`
}

/** First valid hanger code among the reads, else a message about the first unreadable one. */
function judge(values: string[]): { code: string } | { reject: string } | null {
  let reject: string | null = null
  for (const v of values) {
    const parsed = parseHangerCodeStrict(v)
    if (parsed.ok) return { code: parsed.code }
    reject ??= notRecognised(v, parsed.error, parsed.message)
  }
  return reject ? { reject } : null
}

export function CameraScanner({ onCode, onClose }: CameraScannerProps) {
  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="max-w-sm gap-3 p-4">
        <DialogHeader>
          <DialogTitle className="text-base">Scan hanger tag</DialogTitle>
          <DialogDescription className="sr-only">Point the camera at the hanger tag barcode.</DialogDescription>
        </DialogHeader>
        <ScannerBody onCode={onCode} onClose={onClose} />
      </DialogContent>
    </Dialog>
  )
}

function ScannerBody({ onCode, onClose }: CameraScannerProps) {
  const [phase, setPhase] = useState<Phase>('starting')
  const [notice, setNotice] = useState<string | null>(null)
  const [photoFailed, setPhotoFailed] = useState(false)
  const [torchSupported, setTorchSupported] = useState(false)
  const [torchOn, setTorchOn] = useState(false)

  const frameRef = useRef<HTMLDivElement>(null)
  const videoRef = useRef<HTMLVideoElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const trackRef = useRef<MediaStreamTrack | null>(null)
  const doneRef = useRef(false)
  const onCodeRef = useRef(onCode)

  useEffect(() => {
    onCodeRef.current = onCode
  }, [onCode])

  const accept = useCallback((code: string) => {
    if (doneRef.current) return
    doneRef.current = true
    scanFeedback()
    onCodeRef.current(code)
  }, [])

  // Live camera: start, loop, and tear down.
  useEffect(() => {
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | null = null
    let stream: MediaStream | null = null
    const canvas = document.createElement('canvas')
    const g = canvas.getContext('2d', { willReadFrequently: true })

    const stop = () => {
      if (timer) clearTimeout(timer)
      timer = null
      stream?.getTracks().forEach((t) => t.stop())
      stream = null
      trackRef.current = null
    }

    const toPhoto = () => {
      if (cancelled || doneRef.current) return
      stop()
      setTorchSupported(false)
      setTorchOn(false)
      setPhase((p) => (p === 'starting' || p === 'live' ? 'photo' : p))
    }

    // Start loading the decoder in parallel with the permission prompt.
    const detectorPromise = loadHangerDetector()
    detectorPromise.catch(() => {
      if (!cancelled) {
        stop()
        setPhase('engine_error')
      }
    })

    ;(async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: {
            facingMode: { ideal: 'environment' },
            width: { ideal: 1920 },
            height: { ideal: 1080 },
          },
        })
      } catch (err) {
        if (cancelled) return
        const failure: CameraFailure = classifyCameraError(err)
        if (failure === 'denied') setPhase('denied')
        else if (failure === 'no_camera') setPhase('no_camera')
        else setPhase('photo')
        return
      }
      if (cancelled) {
        stop()
        return
      }

      const video = videoRef.current
      const track = stream.getVideoTracks()[0]
      if (!video || !track) {
        toPhoto()
        return
      }
      trackRef.current = track
      track.addEventListener('ended', toPhoto)
      try {
        const caps = track.getCapabilities?.() as (MediaTrackCapabilities & { torch?: boolean }) | undefined
        if (caps?.torch) setTorchSupported(true)
      } catch {
        // torch is optional
      }

      video.srcObject = stream
      try {
        await video.play()
      } catch {
        toPhoto()
        return
      }
      if (cancelled) return
      setPhase('live')

      let detector: HangerDetector
      try {
        detector = await detectorPromise
      } catch {
        return // handled above
      }
      if (cancelled) return

      let confirm: ConfirmState = createConfirmState()
      let stall = createStallState(performance.now())
      let attempt = 0
      let errors = 0

      const tick = async () => {
        if (cancelled || doneRef.current) return
        const started = performance.now()

        const s = observeStall(stall, video.currentTime, started, STALL_TIMEOUT_MS)
        stall = s.state
        if (s.stalled) {
          toPhoto()
          return
        }

        if (video.readyState >= 2 && video.videoWidth > 0 && g) {
          attempt += 1
          const vw = video.videoWidth
          const vh = video.videoHeight
          const box = frameRef.current?.getBoundingClientRect()
          const crop =
            attempt % FULL_FRAME_EVERY === 0 || !box || !(box.height > 0)
              ? null
              : coverCropRect(vw, vh, box.width / box.height, GUIDE_BOX)
          const src = crop ?? { sx: 0, sy: 0, sw: vw, sh: vh }
          const size = fitWithin(src.sw, src.sh, crop ? LIVE_MAX_EDGE : FULL_FRAME_MAX_EDGE)
          canvas.width = size.w
          canvas.height = size.h
          g.drawImage(video, src.sx, src.sy, src.sw, src.sh, 0, 0, size.w, size.h)

          try {
            const values = await detector.detect(canvas)
            errors = 0
            if (cancelled || doneRef.current) return
            // Prefer a valid hanger code among the reads so a stray symbol cannot hide it.
            const verdict = judge(values)
            const key = verdict ? ('code' in verdict ? verdict.code : verdict.reject) : null
            const step = confirmFrame(confirm, key, { required: CONFIRM_FRAMES })
            confirm = step.state
            if (step.confirmed && verdict) {
              if ('code' in verdict) {
                stop()
                accept(verdict.code)
                return
              }
              setNotice(verdict.reject)
            }
          } catch {
            errors += 1
            if (errors >= MAX_DETECT_ERRORS) {
              stop()
              setPhase('engine_error')
              return
            }
          }
        }

        if (cancelled || doneRef.current) return
        timer = setTimeout(tick, Math.max(0, SCAN_INTERVAL_MS - (performance.now() - started)))
      }
      void tick()
    })()

    return () => {
      cancelled = true
      stop()
    }
  }, [accept])

  async function toggleTorch() {
    const track = trackRef.current
    if (!track) return
    const next = !torchOn
    try {
      await track.applyConstraints({ advanced: [{ torch: next } as MediaTrackConstraintSet] })
      setTorchOn(next)
    } catch {
      setTorchSupported(false) // not really supported here; stop offering it
    }
  }

  async function onPhoto(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    e.target.value = '' // allow the same photo to be chosen again
    if (!file) return
    setNotice(null)
    setPhotoFailed(false)
    setPhase('reading')

    let url: string | null = null
    try {
      const detector = await loadHangerDetector()
      url = URL.createObjectURL(file)
      const img = new Image()
      img.src = url
      await img.decode()
      const size = fitWithin(img.naturalWidth, img.naturalHeight, PHOTO_MAX_EDGE)
      const canvas = document.createElement('canvas')
      canvas.width = size.w
      canvas.height = size.h
      canvas.getContext('2d')?.drawImage(img, 0, 0, size.w, size.h)
      const verdict = judge(await detector.detect(canvas))
      if (verdict && 'code' in verdict) {
        accept(verdict.code)
        return
      }
      setNotice(verdict ? verdict.reject : 'Could not read a tag in that photo.')
      setPhotoFailed(true)
      setPhase('photo')
    } catch {
      setNotice('Could not read that photo.')
      setPhotoFailed(true)
      setPhase('photo')
    } finally {
      if (url) URL.revokeObjectURL(url)
    }
  }

  const showVideo = phase === 'starting' || phase === 'live'

  return (
    <div className="space-y-3">
      {showVideo && (
        <>
          <div ref={frameRef} className="relative aspect-[4/3] w-full overflow-hidden rounded-md bg-black">
            <video
              ref={videoRef}
              playsInline
              muted
              autoPlay
              className="absolute inset-0 h-full w-full object-cover"
            />
            <div
              aria-hidden
              className="pointer-events-none absolute rounded-md border-2 border-white/90 shadow-[0_0_0_9999px_rgba(0,0,0,0.45)]"
              style={{
                left: `${GUIDE_BOX.x * 100}%`,
                top: `${GUIDE_BOX.y * 100}%`,
                width: `${GUIDE_BOX.w * 100}%`,
                height: `${GUIDE_BOX.h * 100}%`,
              }}
            />
            {phase === 'starting' && (
              <div className="absolute inset-0 flex items-center justify-center">
                <Loader2 className="h-5 w-5 animate-spin text-white" />
              </div>
            )}
            {torchSupported && phase === 'live' && (
              <Button
                type="button"
                size="icon"
                variant="secondary"
                className="absolute right-2 top-2 h-12 w-12"
                aria-label={torchOn ? 'Turn light off' : 'Turn light on'}
                aria-pressed={torchOn}
                onClick={toggleTorch}
              >
                {torchOn ? <FlashlightOff className="h-5 w-5" /> : <Flashlight className="h-5 w-5" />}
              </Button>
            )}
          </div>
          {!notice && (
            <p className="text-sm text-muted-foreground">
              {phase === 'starting' ? 'Starting camera...' : 'Line the tag up in the box.'}
            </p>
          )}
        </>
      )}

      {(phase === 'photo' || phase === 'reading') && (
        <div className="space-y-3">
          {!photoFailed && (
            <p className="text-sm text-muted-foreground">
              Live view is not working here. Take a photo of the tag instead.
            </p>
          )}
          <Button
            type="button"
            className="h-12 w-full"
            disabled={phase === 'reading'}
            onClick={() => fileRef.current?.click()}
          >
            {phase === 'reading' ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Camera className="h-4 w-4" />
            )}
            {phase === 'reading' ? 'Reading...' : photoFailed ? 'Try again' : 'Take photo'}
          </Button>
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            capture="environment"
            className="hidden"
            onChange={onPhoto}
          />
        </div>
      )}

      {phase === 'denied' && (
        <p role="alert" className="text-sm font-medium text-destructive">
          Camera access is blocked. Allow it for this site in your browser or phone settings, then reopen the
          scanner.
        </p>
      )}
      {phase === 'no_camera' && (
        <p role="alert" className="text-sm font-medium text-destructive">
          No camera found on this device.
        </p>
      )}
      {phase === 'engine_error' && (
        <p role="alert" className="text-sm font-medium text-destructive">
          Camera scanning could not load.
        </p>
      )}
      {notice && (
        <p role="alert" className="text-sm font-medium text-destructive">
          {notice}
        </p>
      )}

      <Button
        type="button"
        variant={phase === 'denied' || phase === 'no_camera' || phase === 'engine_error' ? 'default' : 'ghost'}
        size="sm"
        className="w-full"
        onClick={onClose}
      >
        Type the code instead
      </Button>
    </div>
  )
}
