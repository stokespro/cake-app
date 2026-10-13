'use client'

// One way to call a harvest-trim server action from a component.
//
// Every action returns ActionResult<T> and never throws on business errors, but
// a network drop can still reject. This wraps both: a rejection becomes a
// failed result, a session failure is routed through handleSessionError() (the
// single authoritative path, which logs the user out and lets the dashboard
// layout redirect), and any other failure is toasted unless the caller wants to
// render it inline (`quiet`).

import { useCallback, useEffect, useRef } from 'react'
import { toast } from 'sonner'
import { useAuth } from '@/lib/auth-context'
import type { ActionResult } from '@/types/harvest-trim'

export interface RunOptions {
  /** Do not toast a failure; the caller shows result.error itself. */
  quiet?: boolean
}

export type TrimRun = <T>(call: Promise<ActionResult<T>>, options?: RunOptions) => Promise<ActionResult<T>>

export function useTrimRun(): TrimRun {
  const { handleSessionError } = useAuth()
  // Held in a ref so `run` keeps one identity for the life of the component: screens put it in
  // effect dependency lists, and a changing identity would re-fire their fetches.
  const handlerRef = useRef(handleSessionError)
  useEffect(() => {
    handlerRef.current = handleSessionError
  }, [handleSessionError])

  return useCallback(
    async function run<T>(call: Promise<ActionResult<T>>, options?: RunOptions): Promise<ActionResult<T>> {
      let result: ActionResult<T>
      try {
        result = await call
      } catch (err) {
        if (handlerRef.current(err)) return { success: false, error: 'Session ended.' }
        console.error('[harvest-trim] action rejected:', err)
        result = { success: false, error: 'Could not reach the server. Check the connection and try again.' }
      }
      if (!result.success) {
        // A dead session logs the user out; never render "session expired" copy of our own.
        if (handlerRef.current(result.error)) return result
        if (!options?.quiet) toast.error(result.error)
      }
      return result
    },
    []
  )
}
