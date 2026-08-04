'use client'

import { useEffect, useRef, useCallback } from 'react'
import { createClient } from '@/lib/supabase/client'
import { toast } from 'sonner'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface OrderItemSnapshot {
  skuId: string
  skuName: string  // human-readable, e.g. "Blue Dream 3.5g"
  quantity: number
}

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
      orderNumber?: string
      items: OrderItemSnapshot[]
    }
  | {
      type: 'order_edited'
      orderId: string
      customerName: string
      orderNumber?: string
      diff: ItemDiff[]
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
// SKU name cache (browser-side, lives for the page session)
// Keyed by sku UUID → "name (code)" display string
// ---------------------------------------------------------------------------

const skuNameCache = new Map<string, string>()

async function resolveSkuName(
  skuId: string,
  supabase: ReturnType<typeof createClient>
): Promise<string> {
  if (skuNameCache.has(skuId)) return skuNameCache.get(skuId)!

  const { data } = await supabase
    .from('skus')
    .select('code, name')
    .eq('id', skuId)
    .single()

  const label = data ? `${data.name} (${data.code})` : skuId
  skuNameCache.set(skuId, label)
  return label
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

/**
 * Subscribes to Supabase Realtime for:
 *   - orders: INSERT  → new order alert with full item list
 *   - orders: UPDATE | DELETE → no toast, just fires onDataChange (status
 *     transitions like Confirmed -> Packed affect the Packaging Board)
 *   - order_items: INSERT | UPDATE | DELETE → diff alert (debounced per
 *     order for the toast) AND an immediate onDataChange signal
 *
 * `onDataChange` is intentionally undebounced here — it fires once per raw
 * DB event. Callers that need to collapse a burst of events into a single
 * refetch (e.g. the Packaging Board) should debounce on their end.
 *
 * Requires:
 *   - orders + order_items in supabase_realtime publication
 *     (migration: 20260615000000_enable_realtime_orders.sql)
 *   - order_items REPLICA IDENTITY FULL for UPDATE old-row values
 *     (migration: 20260615120000_order_items_replica_identity_full.sql)
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

  useEffect(() => {
    const supabase = createClient()

    // ------------------------------------------------------------------
    // Channel 1: orders INSERT → new order
    // ------------------------------------------------------------------
    const ordersChannel = supabase
      .channel('pkg-orders-insert')
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'orders' },
        async (payload) => {
          const row = payload.new as {
            id: string
            customer_id: string
            order_number?: string
          }

          // Fetch customer + all items (with SKU join) in parallel
          const [customerRes, itemsRes] = await Promise.all([
            supabase
              .from('customers')
              .select('business_name')
              .eq('id', row.customer_id)
              .single(),
            supabase
              .from('order_items')
              .select('sku_id, quantity, skus(code, name)')
              .eq('order_id', row.id),
          ])

          const customerName =
            customerRes.data?.business_name ?? 'Unknown dispensary'

          const items: OrderItemSnapshot[] = (itemsRes.data ?? []).map((item) => {
            const skuData = item.skus as unknown as { code: string; name: string } | null
            const label = skuData ? `${skuData.name} (${skuData.code})` : item.sku_id
            // Cache it for future diff lookups
            if (skuData) skuNameCache.set(item.sku_id, label)
            return { skuId: item.sku_id, skuName: label, quantity: item.quantity }
          })

          const event: AlertEvent = {
            type: 'new_order',
            orderId: row.id,
            customerName,
            orderNumber: row.order_number,
            items,
          }

          meow()
          onAlertRef.current(event)
          onDataChangeRef.current?.()

          const label = row.order_number ? ` #${row.order_number}` : ''
          toast.info(`New order${label} — ${customerName} · ${items.length} item${items.length !== 1 ? 's' : ''}`, {
            duration: 6000,
          })
        }
      )
      .on(
        // Status transitions (e.g. Confirmed -> Packed -> Delivered) don't
        // produce a toast, but they change what the Packaging Board should
        // show — signal a data change so subscribers can refetch.
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
    // Channel 2: order_items INSERT | UPDATE | DELETE → diff per order
    // Debounce 2 s so multi-row saves collapse into one alert.
    // Accumulate per-row change events in pendingDiffs map.
    // ------------------------------------------------------------------

    type RowChange = {
      changeType: 'INSERT' | 'UPDATE' | 'DELETE'
      oldSkuId?: string
      oldQty?: number
      newSkuId?: string
      newQty?: number
      itemId: string
    }

    const pendingDiffs = new Map<string, RowChange[]>()   // orderId → changes
    const debounceMap = new Map<string, ReturnType<typeof setTimeout>>()

    function scheduleFlush(orderId: string) {
      if (debounceMap.has(orderId)) clearTimeout(debounceMap.get(orderId)!)

      const timer = setTimeout(async () => {
        debounceMap.delete(orderId)
        const changes = pendingDiffs.get(orderId) ?? []
        pendingDiffs.delete(orderId)

        if (changes.length === 0) return

        // Fetch customer + order number
        const { data: order } = await supabase
          .from('orders')
          .select('order_number, customer_id, customers(business_name)')
          .eq('id', orderId)
          .single()

        const customerRaw = order?.customers as unknown as { business_name: string } | null
        const customerName = customerRaw?.business_name ?? 'Unknown dispensary'

        // Resolve all unique sku IDs to names
        const allSkuIds = new Set<string>()
        for (const c of changes) {
          if (c.oldSkuId) allSkuIds.add(c.oldSkuId)
          if (c.newSkuId) allSkuIds.add(c.newSkuId)
        }
        await Promise.all(
          Array.from(allSkuIds).map((id) => resolveSkuName(id, supabase))
        )

        // Build human-readable diff
        const diff: ItemDiff[] = []

        for (const c of changes) {
          if (c.changeType === 'INSERT' && c.newSkuId) {
            diff.push({
              type: 'added',
              skuName: skuNameCache.get(c.newSkuId) ?? c.newSkuId,
              newQty: c.newQty,
            })
          } else if (c.changeType === 'DELETE' && c.oldSkuId) {
            diff.push({
              type: 'removed',
              skuName: skuNameCache.get(c.oldSkuId) ?? c.oldSkuId,
              oldQty: c.oldQty,
            })
          } else if (c.changeType === 'UPDATE') {
            // SKU swapped (line item replaced) → treat as remove + add
            if (c.oldSkuId && c.newSkuId && c.oldSkuId !== c.newSkuId) {
              diff.push({
                type: 'removed',
                skuName: skuNameCache.get(c.oldSkuId) ?? c.oldSkuId,
                oldQty: c.oldQty,
              })
              diff.push({
                type: 'added',
                skuName: skuNameCache.get(c.newSkuId) ?? c.newSkuId,
                newQty: c.newQty,
              })
            } else if (
              c.newSkuId &&
              c.oldQty !== undefined &&
              c.newQty !== undefined &&
              c.oldQty !== c.newQty
            ) {
              // Quantity changed on same SKU
              diff.push({
                type: 'changed',
                skuName: skuNameCache.get(c.newSkuId) ?? c.newSkuId,
                oldQty: c.oldQty,
                newQty: c.newQty,
              })
            }
          }
        }

        if (diff.length === 0) return  // No meaningful change

        const event: AlertEvent = {
          type: 'order_edited',
          orderId,
          customerName,
          orderNumber: order?.order_number,
          diff,
        }

        meow()
        onAlertRef.current(event)

        const label = order?.order_number ? ` #${order.order_number}` : ''
        toast.warning(`Order${label} edited — ${customerName} · ${diff.length} change${diff.length !== 1 ? 's' : ''}`, {
          duration: 6000,
        })
      }, 2000)

      debounceMap.set(orderId, timer)
    }

    const itemsChannel = supabase
      .channel('pkg-order-items-changes')
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'order_items' },
        (payload) => {
          onDataChangeRef.current?.()
          const row = payload.new as { id: string; order_id: string; sku_id: string; quantity: number }
          const changes = pendingDiffs.get(row.order_id) ?? []
          changes.push({ changeType: 'INSERT', itemId: row.id, newSkuId: row.sku_id, newQty: row.quantity })
          pendingDiffs.set(row.order_id, changes)
          scheduleFlush(row.order_id)
        }
      )
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'order_items' },
        (payload) => {
          onDataChangeRef.current?.()
          const oldRow = payload.old as { id: string; order_id: string; sku_id?: string; quantity?: number }
          const newRow = payload.new as { id: string; order_id: string; sku_id: string; quantity: number }
          const orderId = newRow.order_id
          const changes = pendingDiffs.get(orderId) ?? []
          changes.push({
            changeType: 'UPDATE',
            itemId: newRow.id,
            oldSkuId: oldRow.sku_id,
            oldQty: oldRow.quantity,
            newSkuId: newRow.sku_id,
            newQty: newRow.quantity,
          })
          pendingDiffs.set(orderId, changes)
          scheduleFlush(orderId)
        }
      )
      .on(
        'postgres_changes',
        { event: 'DELETE', schema: 'public', table: 'order_items' },
        (payload) => {
          onDataChangeRef.current?.()
          const oldRow = payload.old as { id: string; order_id: string; sku_id?: string; quantity?: number }
          // order_id may not be in the old payload without REPLICA IDENTITY FULL on orders,
          // but it IS present because we set REPLICA IDENTITY FULL on order_items.
          const orderId = oldRow.order_id
          if (!orderId) return
          const changes = pendingDiffs.get(orderId) ?? []
          changes.push({
            changeType: 'DELETE',
            itemId: oldRow.id,
            oldSkuId: oldRow.sku_id,
            oldQty: oldRow.quantity,
          })
          pendingDiffs.set(orderId, changes)
          scheduleFlush(orderId)
        }
      )
      .subscribe()

    return () => {
      supabase.removeChannel(ordersChannel)
      supabase.removeChannel(itemsChannel)
      debounceMap.forEach((t) => clearTimeout(t))
      debounceMap.clear()
      pendingDiffs.clear()
    }
  }, [meow])
}
