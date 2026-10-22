'use client'

// The current time, refreshed on an interval, so "held 2.4 h" on a checked-out hanger keeps moving while the
// report stays open on a screen. Only the open rows read it.

import { useEffect, useState } from 'react'

export function useNow(intervalMs = 60_000): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(id)
  }, [intervalMs])
  return now
}
