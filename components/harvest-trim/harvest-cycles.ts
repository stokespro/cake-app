// Pure helpers for the Harvest tab's cycle picker. No I/O, so they are unit-tested.
//
// Harvest day is read from the cycle's harvest_date, which is authoritative and read-only here:
// nothing in this module writes to room_cycles.

import { format } from 'date-fns'
import type { ScanBatch } from '@/actions/hangers'
import type { CycleBatch, CycleOption } from '@/actions/harvest-trim'

/** Today as a calendar date ('yyyy-MM-dd') on the device doing the weighing. */
export function todayLocal(now: Date = new Date()): string {
  return format(now, 'yyyy-MM-dd')
}

function day(date: string | null): string | null {
  return date ? date.slice(0, 10) : null
}

/** True once the cycle's harvest date is today or earlier. A cycle with no harvest date has not reached it. */
export function harvestReached(cycle: Pick<CycleOption, 'harvestDate'>, today: string): boolean {
  const d = day(cycle.harvestDate)
  return d !== null && d <= today
}

/** Cycles that can be weighed today, best guess first: rooms not yet dried, then the most recent harvest. */
export function eligibleCycles(cycles: readonly CycleOption[], today: string): CycleOption[] {
  const rank = (c: CycleOption) => (c.stage === 'flower' || c.stage === 'harvest' ? 0 : 1)
  return cycles
    .filter((c) => harvestReached(c, today))
    .sort((a, b) => rank(a) - rank(b) || (day(b.harvestDate) ?? '').localeCompare(day(a.harvestDate) ?? ''))
}

/** The soonest harvest still ahead, for the empty state ("Next: Room 2 on Oct 29"). */
export function nextHarvest(cycles: readonly CycleOption[], today: string): CycleOption | null {
  const ahead = cycles.filter((c) => {
    const d = day(c.harvestDate)
    return d !== null && d > today
  })
  ahead.sort((a, b) => (day(a.harvestDate) ?? '').localeCompare(day(b.harvestDate) ?? ''))
  return ahead[0] ?? null
}

/** The remembered cycle if it is still weighable, otherwise the first eligible one (already best-first). */
export function pickCycleId(eligible: readonly CycleOption[], stored: string | null): string | null {
  if (stored && eligible.some((c) => c.id === stored)) return stored
  return eligible[0]?.id ?? null
}

export function cycleLabel(c: Pick<CycleOption, 'roomName' | 'roomNumber' | 'cycleNumber'>): string {
  const room = c.roomName ?? (c.roomNumber !== null ? `Room ${c.roomNumber}` : 'Room')
  return `${room}${c.cycleNumber !== null ? ` · Cycle ${c.cycleNumber}` : ''}`
}

/** The shape BatchBanner draws, from the cycle on screen and one of its batches. */
export function toScanBatch(cycle: CycleOption, batch: CycleBatch): ScanBatch {
  return {
    id: batch.id,
    name: batch.name,
    harvestDate: batch.harvestDate ?? cycle.harvestDate,
    strainId: batch.strainId,
    strainName: batch.strainName,
    cycleId: cycle.id,
    cycleNumber: cycle.cycleNumber,
    cycleStatus: 'active',
    cycleStage: cycle.stage,
    roomName: cycle.roomName,
    roomNumber: cycle.roomNumber,
  }
}
