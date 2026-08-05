'use client'

import { useEffect, useRef, useCallback } from 'react'
import { createClient } from '@/lib/supabase/client'
import { toast } from 'sonner'
import { fetchRecentOrderAlerts, getLatestOrderEventTimestamp } from '@/actions/packaging-board'
import { useDebouncedCallback } from '@/hooks/use-debounced-callback'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface OrderItemSnapshot {
  skuId: string
  skuName: string  // human-readable, e.g. "Blue Dream 3.5g"
  quantity: number
}

// Legacy per-line diff shape. No longer produced by this hook — see the
// "signal-then-discover" note below — but kept exported so OrderAlertBar can
// still render alerts persisted to localStorage by a pre-fix build without
// a type error.
export interface ItemDiff {
  type: 'added' | 'removed' | 'changed'
  skuName: string
  oldQty?: number
  newQty?: number
}

export type AlertEvent =
  | {
      type: 'new_order'
      orderId: string
      customerName: string
      orderNumber?: string | null
      items: OrderItemSnapshot[]
    }
  | {
      type: 'order_edited'
      orderId: string
      customerName: string
      orderNumber?: string | null
      // Current item list, not a diff — see module doc comment.
      items: OrderItemSnapshot[]
    }

interface UseOrderAlertsOptions {
  onAlert: (event: AlertEvent) => void
  soundEnabled: boolean
  /**
   * Optional callback fired on ANY orders/order_items change (INSERT,
   * UPDATE, DELETE) — including ones that don't produce a toast (e.g. an
   * order's status flipping from Confirmed -> Packed). Used by the
   * Packaging Board to trigger a debounced refetch so cards stay live
   * without a 150s poll. Intentionally decoupled from the toast/alert
   * queue logic above — this only signals "something changed", it never
   * reads row content off the realtime payload.
   */
  onDataChange?: () => void
}

// ---------------------------------------------------------------------------
// Root cause & fix (SPRO order-alert bug — "Unknown dispensary / 0 items")
//
// `orders`/`order_items` have RLS enabled with no SELECT grant for the
// anon/authenticated role, so Supabase Realtime delivers postgres_changes
// events for those tables with the row REDACTED — `payload.new`/`payload.old`
// come back empty (`{}`, with a 401 in `payload.errors`). The previous
// implementation read `payload.new.id`/`sku_id`/etc directly to identify and
// enrich the order, which handed downstream lookups `undefined` and produced
// `id=eq.undefined` (Postgres 22P02) plus the "Unknown dispensary" / 0-item
// fallback.
//
// Fix (mirrors what the Packaging Board already does successfully via
// usePackagingBoardRealtime + getBoardData on this same page): treat every
// realtime event as a SIGNAL ONLY. Never read payload.new/payload.old. On a
// signal, call the service-role server action `fetchRecentOrderAlerts`,
// which discovers new/edited orders by comparing `orders.created_at` /
// `orders.last_edited_at` against a client-held high-water mark, and returns
// them fully enriched (customer name + item list) — no browser-visible
// query ever touches `customers`/`order_items`/`skus` directly.
//
// One consequence: because `order_items` payloads are ALSO redacted (both
// old and new), a field-level "what specifically changed" diff can no
// longer be computed client-side (that data simply never reaches the
// browser). Edited-order alerts therefore show the current customer + item
// list rather than an added/removed/changed diff — see AlertEvent above.
// ---------------------------------------------------------------------------

const ORDER_ALERT_DEBOUNCE_MS = 2000

// ---------------------------------------------------------------------------
// Audio: cat meow via HTML5 Audio
//
// /public/meow-new.mp3 — used for both new orders and edited orders.
//
// Single Audio singleton created lazily on first arm() call and reused so
// repeated alerts replay instantly. We call load() inside the user-gesture
// handler (sound toggle click) to satisfy browser autoplay policy.
// play() promise rejections are caught silently.
// ---------------------------------------------------------------------------

// Module-level singleton — created lazily on first arm() call.
let audioMeow: HTMLAudioElement | null = null

/**
 * Call once when the user clicks the sound toggle for the first time.
 * Creates and pre-loads the Audio object inside a user gesture, satisfying
 * Safari / Chrome autoplay requirements.
 */
export function armAudio() {
  if (typeof window === 'undefined') return
  if (!audioMeow) {
    audioMeow = new Audio('/meow-new.mp3')
    audioMeow.preload = 'auto'
    audioMeow.load()
  }
}

function playMeow(soundEnabled: boolean) {
  if (!soundEnabled) return
  if (!audioMeow) return
  // Rewind in case the previous play hasn't finished
  audioMeow.currentTime = 0
  audioMeow.play().catch(() => {
    // Browser blocked autoplay — silently ignore
  })
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

/**
 * Subscribes to Supabase Realtime for:
 *   - orders: INSERT       → signals a possible new order (debounced discovery check)
 *   - orders: UPDATE       → onDataChange only (board refresh); deliberately does
 *     NOT trigger the alert-discovery check — plain status transitions
 *     (Confirmed -> Packed -> Delivered via updateOrderStatus) also touch
 *     `orders.last_edited_at`, and alerting on every one of those would be
 *     alert-fatigue noise. Only `order_items` table events (which
 *     status-only transitions never fire) trigger the "edited" check.
 *   - orders: DELETE       → onDataChange only
 *   - order_items: INSERT | UPDATE | DELETE → onDataChange, AND signals a
 *     possible order edit (debounced discovery check) — order_items only
 *     changes via the order-edit save paths (saveOrder/updateOrderFromSheet),
 *     never via a plain status change, so this stays a clean "content
 *     edited" signal even though we can no longer read row content off it.
 *
 * `onDataChange` is intentionally undebounced here — it fires once per raw
 * DB event. Callers that need to collapse a burst of events into a single
 * refetch (e.g. the Packaging Board) should debounce on their end.
 *
 * Requires:
 *   - orders + order_items in supabase_realtime publication
 *     (migration: 20260615000000_enable_realtime_orders.sql)
 */
export function useOrderAlerts({ onAlert, soundEnabled, onDataChange }: UseOrderAlertsOptions) {
  const onAlertRef = useRef(onAlert)
  const soundEnabledRef = useRef(soundEnabled)
  const onDataChangeRef = useRef(onDataChange)

  useEffect(() => { onAlertRef.current = onAlert }, [onAlert])
  useEffect(() => { soundEnabledRef.current = soundEnabled }, [soundEnabled])
  useEffect(() => { onDataChangeRef.current = onDataChange }, [onDataChange])

  // Stable meow player — reads latest soundEnabled from ref
  const meow = useCallback(() => {
    playMeow(soundEnabledRef.current)
  }, [])

  // High-water mark: only orders whose created_at/last_edited_at is AFTER
  // this get surfaced. Seeded from the DB (not the client clock) on mount so
  // the page doesn't replay pre-existing order history as alerts. A ref
  // (not state) since it's read/written from realtime callbacks and must
  // never trigger a re-render.
  const highWaterMarkRef = useRef<string | null>(null)
  // Optimistic client-clock baseline set synchronously on mount, overwritten
  // by the accurate DB-derived value once getLatestOrderEventTimestamp
  // resolves. Covers the (small) race where a realtime event fires and its
  // debounce elapses before the initial server round-trip completes —
  // without this, sinceIso would be null and the first check would be
  // skipped rather than silently under- or over-firing.
  highWaterMarkRef.current ??= new Date().toISOString()

  const runCheck = useCallback(async () => {
    const sinceIso = highWaterMarkRef.current
    if (!sinceIso) return

    let alerts
    try {
      alerts = await fetchRecentOrderAlerts({ sinceIso })
    } catch (err) {
      console.error('[use-order-alerts] fetchRecentOrderAlerts failed:', err)
      return
    }

    if (!alerts || alerts.length === 0) return

    // Oldest first, so they unshift into the queue in chronological order
    // (most recent ends up on top).
    const chronological = [...alerts].sort((a, b) => (a.eventAt < b.eventAt ? -1 : 1))

    for (const alert of chronological) {
      const event: AlertEvent = {
        type: alert.kind === 'new' ? 'new_order' : 'order_edited',
        orderId: alert.orderId,
        customerName: alert.customerName,
        orderNumber: alert.orderNumber,
        items: alert.items,
      }

      meow()
      onAlertRef.current(event)
      onDataChangeRef.current?.()

      const label = alert.orderNumber ? ` #${alert.orderNumber}` : ''
      const itemLabel = `${alert.items.length} item${alert.items.length !== 1 ? 's' : ''}`
      if (alert.kind === 'new') {
        toast.info(`New order${label} — ${alert.customerName} · ${itemLabel}`, { duration: 6000 })
      } else {
        toast.warning(`Order${label} edited — ${alert.customerName} · ${itemLabel}`, { duration: 6000 })
      }
    }

    // Advance the high-water mark using DB timestamps only (never the
    // client clock, to avoid skew between the browser and Postgres).
    const maxEventAt = chronological.reduce(
      (max, a) => (a.eventAt > max ? a.eventAt : max),
      sinceIso
    )
    highWaterMarkRef.current = maxEventAt
  }, [meow])

  const scheduleCheck = useDebouncedCallback(runCheck, ORDER_ALERT_DEBOUNCE_MS)
  const scheduleCheckRef = useRef(scheduleCheck)
  useEffect(() => { scheduleCheckRef.current = scheduleCheck }, [scheduleCheck])

  useEffect(() => {
    // Seed the accurate high-water mark from the DB.
    let cancelled = false
    getLatestOrderEventTimestamp()
      .then((ts) => {
        if (!cancelled) highWaterMarkRef.current = ts
      })
      .catch((err) => {
        console.error('[use-order-alerts] getLatestOrderEventTimestamp failed:', err)
        // Keep the optimistic client-clock baseline already set above.
      })

    const supabase = createClient()

    // ------------------------------------------------------------------
    // Channel 1: orders INSERT/UPDATE/DELETE
    // ------------------------------------------------------------------
    const ordersChannel = supabase
      .channel('pkg-orders-changes')
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'orders' },
        () => {
          onDataChangeRef.current?.()
          scheduleCheckRef.current()
        }
      )
      .on(
        // Status transitions (e.g. Confirmed -> Packed -> Delivered) don't
        // produce a toast, but they change what the Packaging Board should
        // show — signal a data change so subscribers can refetch. Does NOT
        // schedule an alert-discovery check (see hook doc comment).
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'orders' },
        () => {
          onDataChangeRef.current?.()
        }
      )
      .on(
        'postgres_changes',
        { event: 'DELETE', schema: 'public', table: 'orders' },
        () => {
          onDataChangeRef.current?.()
        }
      )
      .subscribe()

    // ------------------------------------------------------------------
    // Channel 2: order_items INSERT | UPDATE | DELETE — signal only.
    // Debounced together with orders INSERT via the same scheduleCheck, so
    // a multi-row save collapses into a single discovery round-trip.
    // ------------------------------------------------------------------
    const itemsChannel = supabase
      .channel('pkg-order-items-changes')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'order_items' },
        () => {
          onDataChangeRef.current?.()
          scheduleCheckRef.current()
        }
      )
      .subscribe()

    return () => {
      cancelled = true
      supabase.removeChannel(ordersChannel)
      supabase.removeChannel(itemsChannel)
    }
  }, [])
}
