'use client'

// The reports page's "Finished only" display preference, remembered per device.
// Storage format, tolerance for bad values and the meaning of "finished" live in lib/trim/report-finished.ts.

import { useCallback, useEffect, useState } from 'react'
import { DEFAULT_FINISHED_ONLY, readStoredFinishedOnly, writeStoredFinishedOnly } from '@/lib/trim/report-finished'

export function useFinishedOnly() {
  // The default on the first render (server and client agree), the stored choice right after mount.
  const [finishedOnly, setFinishedOnly] = useState<boolean>(DEFAULT_FINISHED_ONLY)
  useEffect(() => {
    setFinishedOnly(readStoredFinishedOnly())
  }, [])

  const change = useCallback((next: boolean) => {
    setFinishedOnly(next)
    writeStoredFinishedOnly(next)
  }, [])

  return [finishedOnly, change] as const
}
