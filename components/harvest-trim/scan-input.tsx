'use client'

import dynamic from 'next/dynamic'
import { useEffect, useRef, useState } from 'react'
import { Camera, Loader2, ScanLine, Search } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { cameraAvailable } from '@/lib/trim/camera-scan'
import { parseHangerCodeLenient } from '@/lib/trim/hanger-code'
import type { ScanSource } from '@/actions/hangers'
import { primeScanFeedback } from './scan-feedback'
import { rejectMessage, useScannerWedge } from './use-scanner-wedge'

// The camera dialog, the decoder and its wasm are fetched only when the camera
// is opened, never with the page.
const CameraScanner = dynamic(() => import('./camera-scanner').then((m) => m.CameraScanner), { ssr: false })

interface ScanInputProps {
  /** Called with a canonical code (H1B-042) and where it came from. */
  onScan: (code: string, source: ScanSource) => void
  /** False pauses the scanner, e.g. while a request is in flight. */
  enabled?: boolean
  busy?: boolean
  /** Accepted so existing call sites compile; the quiet layout no longer shows a heading. */
  label?: string
  /** Accepted so existing call sites compile; errors use the inline alert, there is no standing helper. */
  helper?: string
  /** Accessible name of the icon-only submit button. */
  buttonLabel?: string
}

/**
 * The one way a tag enters this module. A wedge scanner works the moment the
 * page is open (no focus needed); a "type the code" box is always visible for a
 * damaged tag and forgives `42`, `h1b42` and `H1B-042` alike. A camera button
 * sits beside the submit button where the browser can offer one; it is an
 * addition, never a replacement for the other two. Looks like the tag lookup on
 * /dashboard/vault: one quiet row.
 */
export function ScanInput({
  onScan,
  enabled = true,
  busy = false,
  buttonLabel = 'Look up tag',
}: ScanInputProps) {
  const [text, setText] = useState('')
  const [notice, setNotice] = useState<string | null>(null)
  const [cameraOpen, setCameraOpen] = useState(false)
  const [cameraOk, setCameraOk] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  // Decided after mount (never during render) so SSR and hydration agree. No
  // secure context or no camera at all: no button, rather than a broken one.
  useEffect(() => {
    const md = typeof navigator !== 'undefined' ? navigator.mediaDevices : undefined
    if (!cameraAvailable({ isSecureContext: window.isSecureContext, hasMediaDevices: !!md?.getUserMedia })) return
    let cancelled = false
    setCameraOk(true)
    md?.enumerateDevices?.()
      .then((devices) => {
        // Only a definite "no video input" hides it; an empty or failed list may just be privacy.
        if (!cancelled && devices.length > 0 && !devices.some((d) => d.kind === 'videoinput')) setCameraOk(false)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [])

  useScannerWedge({
    enabled: enabled && !busy,
    onScan: (code) => {
      setNotice(null)
      onScan(code, 'wedge')
    },
    onReject: (reason) => setNotice(rejectMessage(reason)),
  })

  function submitTyped(e: React.FormEvent) {
    e.preventDefault()
    const parsed = parseHangerCodeLenient(text)
    if (!parsed.ok) {
      setNotice(parsed.message)
      return
    }
    setNotice(null)
    setText('')
    // Hand focus back to the page so the next wedge scan is not typed into this box.
    inputRef.current?.blur()
    onScan(parsed.code, 'typed')
  }

  return (
    <Card>
      <CardContent className="py-3">
        <form onSubmit={submitTyped} className="flex gap-2">
          <div className="relative flex-1">
            <ScanLine className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              ref={inputRef}
              value={text}
              onChange={(e) => {
                setNotice(null)
                setText(e.target.value)
              }}
              placeholder="Scan or enter hanger tag..."
              aria-label="Type a hanger code"
              autoComplete="off"
              autoCapitalize="characters"
              autoCorrect="off"
              spellCheck={false}
              enterKeyHint="go"
              disabled={busy}
              className="pl-9"
            />
          </div>
          {cameraOk && (
            <Button
              type="button"
              variant="outline"
              aria-label="Scan with camera"
              disabled={busy || !enabled}
              onClick={() => {
                primeScanFeedback()
                setNotice(null)
                setCameraOpen(true)
              }}
            >
              <Camera className="h-4 w-4" />
            </Button>
          )}
          <Button type="submit" aria-label={buttonLabel} disabled={busy || text.trim() === ''}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
          </Button>
        </form>
        {notice && (
          <p role="alert" className="mt-2 text-sm font-medium text-destructive">
            {notice}
          </p>
        )}
        {cameraOpen && (
          <CameraScanner
            onClose={() => setCameraOpen(false)}
            onCode={(code) => {
              setCameraOpen(false)
              setNotice(null)
              onScan(code, 'camera')
            }}
          />
        )}
      </CardContent>
    </Card>
  )
}
