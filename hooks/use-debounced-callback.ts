'use client'

import { useCallback, useEffect, useRef } from 'react'

/**
 * Returns a stable function that, when called repeatedly, only invokes
 * `fn` once after `delayMs` of silence — collapsing a burst of realtime
 * events (e.g. a multi-row task edit) into a single refetch.
 */
export function useDebouncedCallback(fn: () => void, delayMs: number): () => void {
  const fnRef = useRef(fn)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    fnRef.current = fn
  }, [fn])

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current)
    }
  }, [])

  return useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = setTimeout(() => {
      timerRef.current = null
      fnRef.current()
    }, delayMs)
  }, [delayMs])
}
