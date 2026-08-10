'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import { useRouter } from 'next/navigation'
import { format } from 'date-fns'
import { getGrowRooms, getActiveCycles } from '@/actions/cultivation'
import { RoomCard } from '@/components/cultivation/room-card'
import type { GrowRoom, RoomCycle } from '@/types/cultivation'

// ─── Constants ───────────────────────────────────────────────────────────────

const REFRESH_INTERVAL = 60_000

// ─── Layout helpers ───────────────────────────────────────────────────────────

/**
 * Column count is derived from room count, not viewport width — this is a
 * fixed-room-count kiosk, not a responsive card feed. Deliberately not a
 * `Math.ceil(Math.sqrt(n))` formula: a few counts (4, 6+) look better biased
 * wider than a naive square grid, so the mapping is spelled out explicitly.
 */
function getColumnCount(roomCount: number): number {
  if (roomCount <= 1) return 1
  if (roomCount === 2) return 2
  if (roomCount === 3) return 3
  if (roomCount === 4) return 2
  if (roomCount <= 6) return 3
  if (roomCount <= 9) return 3
  return 4
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function CultivationRoomsDisplayPage() {
  const router = useRouter()
  const [rooms, setRooms] = useState<GrowRoom[]>([])
  const [activeCyclesMap, setActiveCyclesMap] = useState<Record<string, RoomCycle[]>>({})
  const [loading, setLoading] = useState(true)
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null)
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // UX-only auth redirect
  useEffect(() => {
    const stored = typeof window !== 'undefined' ? localStorage.getItem('crm-user') : null
    if (!stored) {
      router.replace('/login?next=/cultivation-display/rooms')
    }
  }, [router])

  const fetchData = useCallback(async () => {
    try {
      const [roomsRes, cyclesRes] = await Promise.all([
        getGrowRooms(),
        getActiveCycles(),
      ])
      if (roomsRes.data) setRooms(roomsRes.data)
      if (cyclesRes.data) {
        const map: Record<string, RoomCycle[]> = {}
        for (const cycle of cyclesRes.data) {
          if (!map[cycle.room_id]) map[cycle.room_id] = []
          map[cycle.room_id].push(cycle)
        }
        setActiveCyclesMap(map)
      }
      setLastUpdated(new Date())
    } catch (err) {
      console.error('[cultivation-display/rooms] fetch error:', err)
    } finally {
      setLoading(false)
    }
  }, [])

  // Initial load
  useEffect(() => {
    fetchData()
  }, [fetchData])

  // Auto-refresh via chained setTimeout (mirrors packaging board pattern)
  useEffect(() => {
    function schedule() {
      refreshTimerRef.current = setTimeout(() => {
        fetchData().then(schedule)
      }, REFRESH_INTERVAL)
    }
    schedule()
    return () => {
      if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current)
    }
  }, [fetchData])

  if (loading) {
    return (
      <div className="h-screen w-full flex items-center justify-center text-zinc-400 text-lg">
        Loading rooms...
      </div>
    )
  }

  return (
    <div className="h-screen overflow-hidden flex flex-col text-lg">
      {/* Page header */}
      <div className="px-6 pt-5 pb-4 flex items-center justify-between shrink-0">
        <h1 className="text-2xl font-bold tracking-tight text-zinc-100">
          Grow Rooms
        </h1>
        <div className="text-right">
          <div className="text-base text-zinc-500">
            {format(new Date(), 'EEEE, MMMM d')}
          </div>
          {lastUpdated && (
            <div className="text-sm text-zinc-600">
              Updated {format(lastUpdated, 'h:mm a')}
            </div>
          )}
        </div>
      </div>

      {/* Rooms grid — overflow-hidden is deliberate: this is a hands-off TV
          kiosk, so scrolling must be structurally impossible, not just
          visually hidden. Column/row counts are derived from room count so
          every room gets a definite-height cell and nothing overflows it. */}
      <div className="flex-1 min-h-0 overflow-hidden px-6 pb-5">
        {rooms.length === 0 ? (
          <p className="text-lg text-zinc-400 mt-8">No rooms configured</p>
        ) : (
          <div
            className="grid gap-5 h-full"
            style={{
              gridTemplateColumns: `repeat(${getColumnCount(rooms.length)}, minmax(0, 1fr))`,
              gridTemplateRows: `repeat(${Math.ceil(rooms.length / getColumnCount(rooms.length))}, minmax(0, 1fr))`,
            }}
          >
            {rooms.map((room) => (
              <RoomCard
                key={room.id}
                room={room}
                activeCycles={activeCyclesMap[room.id] || []}
                allRooms={rooms}
                variant="tv"
              />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
