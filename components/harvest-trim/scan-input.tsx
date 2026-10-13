'use client'

import { useRef, useState } from 'react'
import { ScanLine } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { parseHangerCodeLenient } from '@/lib/trim/hanger-code'
import type { ScanSource } from '@/actions/hangers'
import { rejectMessage, useScannerWedge } from './use-scanner-wedge'

interface ScanInputProps {
  /** Called with a canonical code (H1B-042) and where it came from. */
  onScan: (code: string, source: ScanSource) => void
  /** False pauses the scanner, e.g. while a request is in flight. */
  enabled?: boolean
  busy?: boolean
  label?: string
  helper?: string
  buttonLabel?: string
}

/**
 * The one way a tag enters this module. A wedge scanner works the moment the
 * page is open (no focus needed); a "type the code" box is always visible for a
 * damaged tag and forgives `42`, `h1b42` and `H1B-042` alike. The camera is a
 * later phase.
 */
export function ScanInput({
  onScan,
  enabled = true,
  busy = false,
  label = 'Scan a hanger tag',
  helper = 'Point the scanner at the tag, or type the number below.',
  buttonLabel = 'Go',
}: ScanInputProps) {
  const [text, setText] = useState('')
  const [notice, setNotice] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

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
    <div className="rounded-xl border-2 border-dashed border-primary/40 bg-primary/5 p-4">
      <div className="mb-3 flex items-center gap-2">
        <ScanLine className="h-6 w-6 text-primary" />
        <p className="text-lg font-semibold">{label}</p>
      </div>
      <form onSubmit={submitTyped} className="flex gap-2">
        <Input
          ref={inputRef}
          value={text}
          onChange={(e) => {
            setNotice(null)
            setText(e.target.value)
          }}
          placeholder="Type a tag, e.g. 42 or H1B-042"
          aria-label="Type a hanger code"
          autoComplete="off"
          autoCapitalize="characters"
          autoCorrect="off"
          spellCheck={false}
          enterKeyHint="go"
          disabled={busy}
          className="h-14 text-lg"
        />
        <Button type="submit" className="h-14 min-w-24 text-base font-semibold" disabled={busy || text.trim() === ''}>
          {busy ? '...' : buttonLabel}
        </Button>
      </form>
      {notice ? (
        <p role="alert" className="mt-3 text-sm font-medium text-destructive">
          {notice}
        </p>
      ) : (
        <p className="mt-3 text-sm text-muted-foreground">{helper}</p>
      )}
    </div>
  )
}
