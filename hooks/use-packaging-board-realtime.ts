'use client'

import { useEffect, useRef } from 'react'
import { createClient } from '@/lib/supabase/client'

// ---------------------------------------------------------------------------
// Tables backing the Packaging Board (v2) that changes on ANY device —
// e.g. another worker claiming/advancing/releasing a task, an inventory
// adjustment, a container being added, or a note being edited.
//
// Requires these tables in the supabase_realtime publication:
//   migration: 20260721060000_enable_realtime_packaging.sql
//   (containers, packaging_task_state, packaging_claims, task_notes, inventory)
// ---------------------------------------------------------------------------
const BOARD_TABLES = [
  'containers',
  'packaging_task_state',
  'packaging_claims',
  'task_notes',
  'inventory',
] as const

interface UsePackagingBoardRealtimeOptions {
  /**
   * Called whenever any board table changes, AND whenever the realtime
   * channel re-establishes a SUBSCRIBED connection after having been
   * subscribed before (e.g. a device waking from sleep / reconnecting wifi)
   * — self-heals stale state without a background poll.
   *
   * The caller is responsible for debouncing — this hook does not batch
   * events on its own so it can be combined with other event sources
   * (e.g. useOrderAlerts' onDataChange) behind a single shared debounce.
   */
  onChange: () => void
  /** Pass false to skip subscribing (e.g. while unauthenticated). */
  enabled?: boolean
}

/**
 * Subscribes to Supabase Realtime postgres_changes for every table that
 * feeds the Packaging Board's server-computed allocation (containers,
 * packaging_task_state, packaging_claims, task_notes, inventory). Never
 * reads row content off the payload — the board is always recomputed via
 * the authorized server action (getBoardData), so this hook only needs to
 * know "something changed, go refetch."
 */
export function usePackagingBoardRealtime({
  onChange,
  enabled = true,
}: UsePackagingBoardRealtimeOptions) {
  const onChangeRef = useRef(onChange)
  useEffect(() => {
    onChangeRef.current = onChange
  }, [onChange])

  useEffect(() => {
    if (!enabled) return

    const supabase = createClient()
    let hasSubscribedBefore = false

    let channel = supabase.channel('pkg-board-tables')
    for (const table of BOARD_TABLES) {
      channel = channel.on(
        'postgres_changes',
        { event: '*', schema: 'public', table },
        () => {
          onChangeRef.current()
        }
      )
    }

    channel.subscribe((status) => {
      if (status === 'SUBSCRIBED') {
        if (hasSubscribedBefore) {
          // Reconnected after a drop — self-heal any state we may have
          // missed while disconnected.
          onChangeRef.current()
        }
        hasSubscribedBefore = true
      }
    })

    return () => {
      supabase.removeChannel(channel)
    }
  }, [enabled])
}
