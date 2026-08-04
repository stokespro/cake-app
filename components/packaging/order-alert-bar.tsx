'use client'

import { useState, useCallback, useEffect, useRef } from 'react'
import { Bell, BellOff, X, ChevronDown, ChevronUp, Plus, Minus, ArrowRight } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import { useOrderAlerts, armAudio, type AlertEvent, type ItemDiff, type OrderItemSnapshot } from '@/hooks/use-order-alerts'

// ---------------------------------------------------------------------------
// LocalStorage keys
// ---------------------------------------------------------------------------
const SOUND_PREF_KEY = 'packaging-alert-sound'
const ALERT_QUEUE_KEY = 'packaging-alert-queue'

// ---------------------------------------------------------------------------
// Stored alert shape (what gets persisted to localStorage)
// ---------------------------------------------------------------------------
export interface StoredAlert {
  id: string           // uuid generated at alert time
  receivedAt: string   // ISO timestamp
  type: 'new_order' | 'order_edited'
  orderId: string
  customerName: string
  orderNumber?: string
  // new_order fields
  items?: OrderItemSnapshot[]
  // order_edited fields
  diff?: ItemDiff[]
}

function makeId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2)
}

function loadQueue(): StoredAlert[] {
  try {
    const raw = localStorage.getItem(ALERT_QUEUE_KEY)
    if (!raw) return []
    return JSON.parse(raw) as StoredAlert[]
  } catch {
    return []
  }
}

function saveQueue(queue: StoredAlert[]) {
  try {
    localStorage.setItem(ALERT_QUEUE_KEY, JSON.stringify(queue))
  } catch {}
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function DiffLine({ d }: { d: ItemDiff }) {
  if (d.type === 'added') {
    return (
      <div className="flex items-center gap-1.5 text-sm text-green-400">
        <Plus className="h-3 w-3 shrink-0" />
        <span className="font-medium">{d.skuName}</span>
        {d.newQty !== undefined && (
          <span className="text-muted-foreground">× {d.newQty}</span>
        )}
      </div>
    )
  }
  if (d.type === 'removed') {
    return (
      <div className="flex items-center gap-1.5 text-sm text-red-400">
        <Minus className="h-3 w-3 shrink-0" />
        <span className="font-medium">{d.skuName}</span>
        {d.oldQty !== undefined && (
          <span className="text-muted-foreground">× {d.oldQty}</span>
        )}
      </div>
    )
  }
  // changed
  return (
    <div className="flex items-center gap-1.5 text-sm text-amber-400">
      <ArrowRight className="h-3 w-3 shrink-0" />
      <span className="font-medium">{d.skuName}</span>
      <span className="text-muted-foreground">
        {d.oldQty} <ArrowRight className="inline h-2.5 w-2.5" /> {d.newQty}
      </span>
    </div>
  )
}

function AlertCard({ alert, onDismiss }: { alert: StoredAlert; onDismiss: (id: string) => void }) {
  const [expanded, setExpanded] = useState(false)

  const timeLabel = (() => {
    const d = new Date(alert.receivedAt)
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  })()

  const summaryText = alert.type === 'new_order'
    ? `${alert.items?.length ?? 0} item${(alert.items?.length ?? 0) !== 1 ? 's' : ''}`
    : `${alert.diff?.length ?? 0} change${(alert.diff?.length ?? 0) !== 1 ? 's' : ''}`

  const orderLabel = alert.orderNumber ? ` #${alert.orderNumber}` : ''

  return (
    <div className="border rounded-lg overflow-hidden bg-card">
      {/* Header row */}
      <div
        className="flex items-center gap-2 p-3 cursor-pointer hover:bg-muted/40 transition-colors"
        onClick={() => setExpanded((v) => !v)}
      >
        {/* Type badge */}
        {alert.type === 'new_order' ? (
          <Badge className="bg-blue-600 text-white text-[10px] shrink-0">NEW</Badge>
        ) : (
          <Badge className="bg-amber-500 text-white text-[10px] shrink-0">EDITED</Badge>
        )}

        {/* Customer + order */}
        <div className="flex-1 min-w-0">
          <p className="font-semibold text-sm truncate">{alert.customerName}</p>
          <p className="text-xs text-muted-foreground">
            Order{orderLabel} · {summaryText} · {timeLabel}
          </p>
        </div>

        {/* Controls */}
        <div className="flex items-center gap-1 shrink-0">
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6 text-muted-foreground hover:text-red-400"
            onClick={(e) => { e.stopPropagation(); onDismiss(alert.id) }}
            title="Dismiss this alert"
          >
            <X className="h-3 w-3" />
          </Button>
          {expanded
            ? <ChevronUp className="h-4 w-4 text-muted-foreground" />
            : <ChevronDown className="h-4 w-4 text-muted-foreground" />}
        </div>
      </div>

      {/* Expanded detail */}
      {expanded && (
        <div className="border-t px-3 pb-3 pt-2 space-y-1.5 bg-muted/20">
          {alert.type === 'new_order' && alert.items && (
            <>
              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-1.5">Items ordered</p>
              {alert.items.map((item, i) => (
                <div key={i} className="flex items-baseline gap-2 text-sm">
                  <span className="text-foreground font-medium">{item.skuName}</span>
                  <span className="text-muted-foreground">× {item.quantity}</span>
                </div>
              ))}
            </>
          )}
          {alert.type === 'order_edited' && alert.diff && (
            <>
              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-1.5">Changes</p>
              {alert.diff.map((d, i) => (
                <DiffLine key={i} d={d} />
              ))}
            </>
          )}
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

interface OrderAlertBarProps {
  /**
   * Optional callback fired whenever an orders/order_items realtime change
   * comes through (new order, edited order, or a status update). Wired up
   * by the Packaging Board to trigger a debounced board refetch — this
   * component stays self-contained otherwise (own alert queue, own sound
   * toggle) so passing nothing preserves the original behavior.
   */
  onDataChange?: () => void
}

/**
 * Self-contained alert bar for the packaging page.
 *
 * - Sound toggle (cat meow synth) — arms AudioContext on first click
 * - Red badge count with pulsing animation
 * - Sheet panel listing each unreviewed alert, expandable per order
 * - "Clear all" dismisses everything; individual X dismisses one
 */
export function OrderAlertBar({ onDataChange }: OrderAlertBarProps = {}) {
  // --- Sound preference ---
  const [soundEnabled, setSoundEnabled] = useState(false)
  const [audioArmed, setAudioArmed] = useState(false)

  useEffect(() => {
    try {
      const stored = localStorage.getItem(SOUND_PREF_KEY)
      if (stored !== null) {
        const on = stored === 'true'
        setSoundEnabled(on)
        if (on) {
          setAudioArmed(true)
          // Pre-load audio buffers immediately so returning users don't wait
          // on first alert. play() still requires a prior gesture in Safari,
          // but load() here warms the network fetch.
          armAudio()
        }
      }
    } catch {}
  }, [])

  const toggleSound = useCallback(() => {
    setSoundEnabled((prev) => {
      const next = !prev
      try { localStorage.setItem(SOUND_PREF_KEY, String(next)) } catch {}
      // First click: arm the Audio objects (satisfies browser autoplay gesture
      // requirement — must happen inside a user-initiated event handler).
      if (!audioArmed) {
        setAudioArmed(true)
        armAudio()
      }
      return next
    })
  }, [audioArmed])

  // --- Alert queue (persistent) ---
  const [queue, setQueue] = useState<StoredAlert[]>([])
  const [panelOpen, setPanelOpen] = useState(false)

  // Load persisted queue on mount
  useEffect(() => {
    setQueue(loadQueue())
  }, [])

  // Sync queue to localStorage whenever it changes (use a ref to avoid
  // double-writing on mount from the useEffect above)
  const mountedRef = useRef(false)
  useEffect(() => {
    if (!mountedRef.current) { mountedRef.current = true; return }
    saveQueue(queue)
  }, [queue])

  const handleAlert = useCallback((event: AlertEvent) => {
    const stored: StoredAlert = {
      id: makeId(),
      receivedAt: new Date().toISOString(),
      type: event.type,
      orderId: event.orderId,
      customerName: event.customerName,
      orderNumber: event.orderNumber,
      ...(event.type === 'new_order' ? { items: event.items } : { diff: event.diff }),
    }
    setQueue((prev) => [stored, ...prev])
  }, [])

  const dismissOne = useCallback((alertId: string) => {
    setQueue((prev) => prev.filter((a) => a.id !== alertId))
  }, [])

  const clearAll = useCallback(() => {
    setQueue([])
    setPanelOpen(false)
  }, [])

  // --- Realtime subscription ---
  useOrderAlerts({
    onAlert: handleAlert,
    soundEnabled: soundEnabled && audioArmed,
    onDataChange,
  })

  const count = queue.length

  return (
    <>
      <div className="flex items-center gap-2 flex-wrap">
        {/* Sound toggle */}
        <Button
          variant="ghost"
          size="sm"
          onClick={toggleSound}
          className="h-8 px-2 gap-1.5 text-xs text-muted-foreground hover:text-foreground"
          title={soundEnabled ? 'Sound on — click to mute' : 'Sound off — click to enable'}
        >
          {soundEnabled ? (
            <Bell className="h-4 w-4 text-amber-400" />
          ) : (
            <BellOff className="h-4 w-4" />
          )}
          <span className="hidden sm:inline">{soundEnabled ? 'Sound on' : 'Sound off'}</span>
        </Button>

        {/* Badge — opens the detail panel */}
        {count > 0 && (
          <button
            onClick={() => setPanelOpen(true)}
            className="flex items-center gap-1.5 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded"
          >
            <Badge className="bg-red-600 hover:bg-red-500 text-white text-xs px-2 py-0.5 animate-pulse cursor-pointer transition-colors">
              {count} unreviewed
            </Badge>
          </button>
        )}
      </div>

      {/* Detail sheet — slides in from the right */}
      <Sheet open={panelOpen} onOpenChange={setPanelOpen}>
        <SheetContent side="right" className="w-full sm:max-w-md flex flex-col">
          <SheetHeader className="shrink-0">
            <SheetTitle className="flex items-center justify-between">
              <span>Order alerts</span>
              <span className="text-sm font-normal text-muted-foreground">{count} unreviewed</span>
            </SheetTitle>
          </SheetHeader>

          {/* Alert list — scrollable */}
          <div className="flex-1 overflow-y-auto space-y-3 py-4 min-h-0">
            {queue.length === 0 ? (
              <p className="text-center text-muted-foreground py-12 text-sm">All clear</p>
            ) : (
              queue.map((alert) => (
                <AlertCard key={alert.id} alert={alert} onDismiss={dismissOne} />
              ))
            )}
          </div>

          {/* Footer */}
          {count > 0 && (
            <div className="shrink-0 border-t pt-4">
              <Button
                variant="outline"
                className="w-full"
                onClick={clearAll}
              >
                <X className="h-4 w-4 mr-2" />
                Clear all ({count})
              </Button>
            </div>
          )}
        </SheetContent>
      </Sheet>
    </>
  )
}
