'use client'

import { useEffect, useRef } from 'react'

/**
 * Realtime is not part of Phase 1. Screens refetch after their own mutations and
 * here, whenever the tab becomes visible or the window regains focus, so a phone
 * that slept in a pocket catches up. Same resilience fallback as the packaging board.
 */
export function useRefetchOnFocus(refetch: () => void): void {
  const ref = useRef(refetch)
  useEffect(() => {
    ref.current = refetch
  }, [refetch])

  useEffect(() => {
    function onVisible() {
      if (document.visibilityState === 'visible') ref.current()
    }
    function onFocus() {
      ref.current()
    }
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('focus', onFocus)
    return () => {
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener('focus', onFocus)
    }
  }, [])
}
