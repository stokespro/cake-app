'use client'

// Thin DOM wrapper around the pure scan-buffer state machine
// (lib/trim/scan-buffer.ts). All the decisions (what counts as a burst, when it
// commits, what is noise) live there and are unit-tested; this file only feeds
// it keydown events and a flush timer.
//
// A keyboard-wedge scanner types the code as a fast burst of keystrokes ended by
// Enter. We listen on the window so nothing needs focus, with two exceptions:
//   - never while an editable field has focus (a weight field, a note, the typed
//     code box): those keystrokes belong to the field;
//   - never while a dialog is open: a scan must not act on the screen behind it.
// When a burst commits, its Enter is swallowed so it cannot "click" whichever
// button happens to be focused.

import { useEffect, useRef } from 'react'
import {
  createScanBuffer,
  feedKey,
  flushIfIdle,
  nextFlushAt,
  type ScanBufferState,
  type ScanOutcome,
  type ScanRejectReason,
} from '@/lib/trim/scan-buffer'

const REJECT_MESSAGES: Record<ScanRejectReason, string> = {
  empty: 'Nothing was read. Try the scan again.',
  looks_like_metrc_tag: 'That is a Metrc package tag, not a hanger tag.',
  invalid_format: 'That is not a hanger tag. Hanger tags look like H1B-042.',
  out_of_range: 'That hanger number is out of range.',
  too_long: 'That scan was too long to be a hanger tag.',
}

export function rejectMessage(reason: ScanRejectReason): string {
  return REJECT_MESSAGES[reason]
}

function editableFocused(): boolean {
  const el = document.activeElement as HTMLElement | null
  if (!el || el === document.body) return false
  if (el.isContentEditable) return true
  const tag = el.tagName
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true
  if (tag === 'INPUT') {
    const type = (el as HTMLInputElement).type
    return !['button', 'checkbox', 'radio', 'submit', 'reset', 'file'].includes(type)
  }
  return false
}

function dialogOpen(): boolean {
  return document.querySelector('[role="dialog"], [role="alertdialog"]') !== null
}

interface Options {
  enabled: boolean
  onScan: (code: string) => void
  onReject?: (reason: ScanRejectReason, raw: string) => void
}

export function useScannerWedge({ enabled, onScan, onReject }: Options): void {
  const stateRef = useRef<ScanBufferState>(createScanBuffer())
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const onScanRef = useRef(onScan)
  const onRejectRef = useRef(onReject)

  useEffect(() => {
    onScanRef.current = onScan
    onRejectRef.current = onReject
  }, [onScan, onReject])

  useEffect(() => {
    if (!enabled) return

    function clearTimer() {
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current)
        timerRef.current = null
      }
    }

    function emit(outcome: ScanOutcome | null) {
      if (!outcome) return
      if (outcome.kind === 'scan') onScanRef.current(outcome.code)
      else onRejectRef.current?.(outcome.reason, outcome.raw)
    }

    function schedule() {
      clearTimer()
      const at = nextFlushAt(stateRef.current)
      if (at === null) return
      timerRef.current = setTimeout(() => {
        timerRef.current = null
        const step = flushIfIdle(stateRef.current, performance.now())
        stateRef.current = step.state
        emit(step.outcome)
        // Not idle yet (timer fired early): try again.
        if (step.outcome === null) schedule()
      }, Math.max(0, at - performance.now()) + 5)
    }

    function onKeyDown(e: KeyboardEvent) {
      if (e.ctrlKey || e.metaKey || e.altKey || e.repeat) return
      if (editableFocused() || dialogOpen()) {
        stateRef.current = createScanBuffer()
        clearTimer()
        return
      }
      const step = feedKey(stateRef.current, e.key, performance.now())
      stateRef.current = step.state
      if (step.outcome) {
        // The terminating Enter of a real scan must not press a focused button.
        e.preventDefault()
        e.stopPropagation()
        emit(step.outcome)
      }
      schedule()
    }

    window.addEventListener('keydown', onKeyDown, true)
    return () => {
      window.removeEventListener('keydown', onKeyDown, true)
      clearTimer()
      stateRef.current = createScanBuffer()
    }
  }, [enabled])
}
