'use client'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Play, FastForward, History, Edit2, CalendarCog, Trash2 } from 'lucide-react'
import { format } from 'date-fns'
import { parseLocalDate } from '@/lib/utils'
import {
  getDayProgress,
  getPairingLabel,
  getCycleStageLabel,
  PHASE_BADGE_CLASSES,
} from '@/lib/cultivation/helpers'
import type { CSSProperties } from 'react'
import { STAGE_ORDER } from '@/types/cultivation'
import type { GrowRoom, RoomCycle, PipelineStage } from '@/types/cultivation'

// ─── Props ────────────────────────────────────────────────────────────────────

export interface RoomCardProps {
  room: GrowRoom
  activeCycles: RoomCycle[]
  allRooms: GrowRoom[]
  taskCounts?: { pending: number; overdue: number }
  onStartCycle?: (room: GrowRoom) => void
  onAdvanceStage?: (room: GrowRoom) => void
  /** Admin-only — correct milestone dates on an active cycle. Rendered only when activeCycles.length > 0. */
  onEditCycle?: (room: GrowRoom) => void
  onHistory?: (room: GrowRoom) => void
  onEdit?: (room: GrowRoom) => void
  onDelete?: (room: GrowRoom) => void
  variant?: 'default' | 'tv'
}

// ─── TV typography ──────────────────────────────────────────────────────────
//
// tv variant only. Text is sized in `cqmin` against the card's own
// `[container-type:size]` box, then multiplied by a per-card `--tv-scale`
// custom property (see getTvScale below) so a card with fewer active cycles
// spends its slack on bigger text and a card with more cycles compresses to
// stay inside its fixed-height grid cell. Clamp floors are pinned to the
// fixed pre-SPRO-83 sizes (text-2xl / text-base / text-sm) so legibility can
// never regress below what was on the wall before this ticket; ceilings are
// raised well above the 1.0-scale target so the 1.5x factor (0-1 cycles)
// isn't immediately clipped.

const TV_TITLE = 'text-[clamp(1.5rem,calc(6.7cqmin*var(--tv-scale)),3.5rem)]'
const TV_BODY = 'text-[clamp(1rem,calc(3.4cqmin*var(--tv-scale)),2.25rem)]'
const TV_MILESTONE = 'text-[clamp(0.875rem,calc(3cqmin*var(--tv-scale)),1.75rem)]'

/**
 * Font scale factor for the tv variant, keyed off active-cycle count.
 *
 * Rooms run perpetual rotation (standing project constraint) — cycle count
 * per room is unbounded and can change at any time, so a 4th or 5th
 * concurrent cycle is a real, expected state, not an edge case. The grid
 * gives every card a fixed-height cell, so a card can't grow to fit more
 * cycles; it has to shrink its own type instead. Without this, the card's
 * `overflow-hidden` would silently clip a cycle off a compliance-adjacent
 * board, which is unacceptable.
 *
 * 0-2 cycles are tuned to spend their measured slack on legibility (a
 * 1920x1080, 2x2-grid F1-style 3-cycle card used only 301px of a 408px box,
 * and a 2-cycle card only 234px of 396px, before this pass) — this is a TV
 * read from across a grow room, so unused vertical space is wasted
 * legibility. 3 cycles gets a modest bump for the same reason. 4 cycles is
 * measured tight (400px content in a ~424px box) and 5+ relies on the
 * TV_MAX_RENDERED_CYCLES cap, so neither is touched here.
 */
function getTvScale(cycleCount: number): number {
  if (cycleCount <= 1) return 1.8
  if (cycleCount === 2) return 1.5
  if (cycleCount === 3) return 1.15
  if (cycleCount === 4) return 0.8
  return 0.65
}

/**
 * Max cycle blocks rendered per tv card, and the threshold at which the
 * milestone chip row is dropped entirely. Measured against the real 421px
 * content box (1920x1080, 2x2 grid): 5 blocks with milestones hidden land at
 * ~382px, plus a `+N more` line (~20px) is ~402px — both fit. 6+ blocks
 * overflow even with milestones hidden (measured 460px @ 6, 538px @ 7), so
 * beyond this count cycles are summarized by `+N more` instead of rendered.
 * If card padding changes again, re-measure before changing this number.
 */
const TV_MAX_RENDERED_CYCLES = 5

/**
 * tv: `room.notes` costs ~50px at TV_BODY with `line-clamp-2` — that cost is
 * not accounted for in the TV_MAX_RENDERED_CYCLES budget above, and at 4+
 * cycles it's exactly the difference between fitting and overflowing
 * (measured: with a note, 4cy=458px vs a ~424px box, 6cy=463px vs ~427px —
 * both overflow; without, 4cy=408px and 6cy=413px both fit). So notes join
 * the same graceful-degradation ladder as the milestone chip row: milestones
 * shed at >=5 cycles, notes shed at >=4. Below that threshold there's slack
 * (the real 3-cycle F1 card uses only 301px of 408px), but notes are still
 * capped to `line-clamp-1` there so they can't grow into being the thing
 * that quietly eats the remaining margin later.
 */
const TV_HIDE_NOTES_AT_CYCLES = 4

// ─── Component ────────────────────────────────────────────────────────────────

export function RoomCard({
  room,
  activeCycles,
  allRooms,
  taskCounts,
  onStartCycle,
  onAdvanceStage,
  onEditCycle,
  onHistory,
  onEdit,
  onDelete,
  variant = 'default',
}: RoomCardProps) {
  const pairingLabel = getPairingLabel(room, allRooms)

  const tv = variant === 'tv'
  // 0-1 cycles -> 1.8x (fill the slack), 3 cycles -> 1.15x, 4+ -> compressed.
  // See getTvScale for the perpetual-rotation why and the measured numbers.
  const tvScale = tv ? getTvScale(activeCycles.length) : 1

  // tv: when a card has more cycles than fit, keep the operationally urgent
  // ones — order by stage progression (most advanced first) rather than
  // display order, so a late-stage (harvest/dry/trim) cycle is never the one
  // dropped in favor of an earlier-stage one. STAGE_ORDER already exists in
  // types/cultivation.ts, so reuse it instead of inventing a second
  // stage-priority list here. Unrecognized stage values sort last.
  const cyclesForTv = tv
    ? [...activeCycles].sort(
        (a, b) =>
          STAGE_ORDER.indexOf(b.current_stage as PipelineStage) -
          STAGE_ORDER.indexOf(a.current_stage as PipelineStage)
      )
    : activeCycles
  const renderedCycles = tv ? cyclesForTv.slice(0, TV_MAX_RENDERED_CYCLES) : activeCycles
  const hiddenCycleCount = tv ? Math.max(activeCycles.length - TV_MAX_RENDERED_CYCLES, 0) : 0
  // tv: milestone dates are the least glanceable detail on a wall display,
  // so they're the first thing shed once a card is dense enough to need the
  // +N-more treatment (see TV_MAX_RENDERED_CYCLES for the measured budget).
  const tvHideMilestones = tv && activeCycles.length >= TV_MAX_RENDERED_CYCLES
  // tv: see TV_HIDE_NOTES_AT_CYCLES — notes are the next thing shed once a
  // busy card runs out of vertical budget.
  const tvHideNotes = tv && activeCycles.length >= TV_HIDE_NOTES_AT_CYCLES

  return (
    // tv: `[container-type:size]` turns the card into a query container on
    // both axes — grid rows are `minmax(0, 1fr)` so the cell (and therefore
    // the card) always has a definite block size, which is what lets the
    // `cqmin`-based text below scale safely instead of guessing viewport size.
    // `--tv-scale` is read by TV_TITLE/TV_BODY/TV_MILESTONE above to grow or
    // shrink that text based on how many cycles this specific card holds.
    <Card
      className={
        tv ? 'border-zinc-700 bg-zinc-900 h-full flex flex-col min-h-0 [container-type:size]' : undefined
      }
      style={tv ? ({ '--tv-scale': tvScale } as unknown as CSSProperties) : undefined}
    >
      {/* tv: header/content padding trimmed from the shadcn default (p-6) —
          that 24px-per-side default eats vertical budget a fixed-height
          kiosk card can't spare, especially at the 3-4 cycle end of the
          --tv-scale range. */}
      <CardHeader className={tv ? 'pt-3 pb-2 px-4 shrink-0' : 'pb-3'}>
        <div className="flex items-center justify-between">
          <CardTitle className={tv ? `${TV_TITLE} font-bold` : 'text-base'}>
            {room.room_name}
            <span
              className={
                tv
                  ? `text-zinc-400 font-normal ${TV_BODY} ml-1`
                  : 'text-muted-foreground font-normal text-sm ml-1'
              }
            >
              #{room.room_number}
            </span>
          </CardTitle>
          <div className="flex items-center gap-1">
            {activeCycles.length > 0 && (
              <Badge variant="outline" className={tv ? TV_BODY : 'text-xs'}>
                {activeCycles.length} {activeCycles.length === 1 ? 'cycle' : 'cycles'}
              </Badge>
            )}
          </div>
        </div>
        {pairingLabel && (
          <p className={tv ? `${TV_BODY} text-zinc-400` : 'text-xs text-muted-foreground'}>
            {pairingLabel}
          </p>
        )}
      </CardHeader>

      <CardContent
        className={
          tv ? 'flex-1 min-h-0 overflow-hidden flex flex-col gap-2 px-4 pb-3' : 'space-y-3'
        }
      >
        {activeCycles.length === 0 ? (
          <p className={tv ? `${TV_BODY} text-zinc-400` : 'text-sm text-muted-foreground'}>
            No active cycle
          </p>
        ) : (
          <>
            {/* All active cycles with milestone timelines (tv: capped at
                TV_MAX_RENDERED_CYCLES, most-advanced-stage first) */}
            {renderedCycles.map((cycle) => {
              const progress = getDayProgress(cycle)
              const stageLabel = getCycleStageLabel(cycle.current_stage, cycle.flower_start)
              const hasMilestones =
                cycle.dome_start ||
                cycle.veg_start ||
                cycle.flower_start ||
                cycle.harvest_date ||
                cycle.trim_start
              return (
                <div key={cycle.id} className={tv ? 'space-y-0.5' : 'space-y-1'}>
                  <div className={`flex items-center justify-between ${tv ? TV_BODY : 'text-sm'}`}>
                    <span className={tv ? 'text-zinc-400' : 'text-muted-foreground'}>
                      {cycle.cycle_number ? `Cycle #${cycle.cycle_number}` : 'Cycle'}
                    </span>
                    <Badge
                      className={`${PHASE_BADGE_CLASSES[cycle.current_stage] || 'bg-gray-500 text-white'} ${tv ? TV_BODY : 'text-xs'}`}
                    >
                      {stageLabel}
                    </Badge>
                  </div>
                  <div className={`flex items-center justify-between ${tv ? TV_BODY : 'text-sm'}`}>
                    <span className={tv ? 'text-zinc-400' : 'text-muted-foreground'}>
                      Progress
                    </span>
                    <span className="font-medium">
                      {progress ? `Day ${progress.current} of ${progress.total}` : '—'}
                    </span>
                  </div>
                  {progress && (
                    <div className="h-2 w-full rounded-full bg-muted overflow-hidden">
                      <div
                        className={`h-full rounded-full ${PHASE_BADGE_CLASSES[cycle.current_stage]?.split(' ')[0] || 'bg-gray-500'}`}
                        style={{
                          width: `${Math.min((progress.current / progress.total) * 100, 100)}%`,
                        }}
                      />
                    </div>
                  )}
                  {hasMilestones &&
                    !(tv && tvHideMilestones) &&
                    (tv ? (
                      // tv: milestones collapse to a single wrapped chip row — the
                      // two-column layout below is the tallest element per cycle
                      // and the main reason a 3-cycle room card overflowed its cell.
                      <div className={`flex flex-wrap gap-x-3 gap-y-0 pt-0.5 ${TV_MILESTONE} text-zinc-400`}>
                        {cycle.dome_start && (
                          <span>Dome {format(parseLocalDate(cycle.dome_start), 'MMM d')}</span>
                        )}
                        {cycle.veg_start && (
                          <span>Veg {format(parseLocalDate(cycle.veg_start), 'MMM d')}</span>
                        )}
                        {cycle.flower_start && (
                          <span>Flower {format(parseLocalDate(cycle.flower_start), 'MMM d')}</span>
                        )}
                        {cycle.harvest_date && (
                          <span>Harvest {format(parseLocalDate(cycle.harvest_date), 'MMM d')}</span>
                        )}
                        {cycle.trim_start && (
                          <span>Trim {format(parseLocalDate(cycle.trim_start), 'MMM d')}</span>
                        )}
                      </div>
                    ) : (
                      <div className="flex flex-wrap justify-between gap-x-4 pt-1 text-[11px] text-muted-foreground">
                        <div className="flex flex-col leading-relaxed">
                          {cycle.dome_start && (
                            <span>Dome: {format(parseLocalDate(cycle.dome_start), 'MMM d')}</span>
                          )}
                          {cycle.veg_start && (
                            <span>Veg: {format(parseLocalDate(cycle.veg_start), 'MMM d')}</span>
                          )}
                          {cycle.flower_start && (
                            <span>
                              Flower: {format(parseLocalDate(cycle.flower_start), 'MMM d')}
                            </span>
                          )}
                        </div>
                        <div className="flex flex-col leading-relaxed text-right">
                          {cycle.harvest_date && (
                            <span>
                              Harvest: {format(parseLocalDate(cycle.harvest_date), 'MMM d')}
                            </span>
                          )}
                          {cycle.trim_start && (
                            <span>Trim: {format(parseLocalDate(cycle.trim_start), 'MMM d')}</span>
                          )}
                        </div>
                      </div>
                    ))}
                </div>
              )
            })}

            {/* tv: overflow must be visible and truthful, not silently
                swallowed by the card's overflow-hidden — see
                TV_MAX_RENDERED_CYCLES. */}
            {tv && hiddenCycleCount > 0 && (
              <p className={`${TV_BODY} text-zinc-400`}>+{hiddenCycleCount} more</p>
            )}
          </>
        )}

        {/* Task counts */}
        {taskCounts && (
          <p className={tv ? `${TV_BODY} text-zinc-400` : 'text-xs text-muted-foreground'}>
            {taskCounts.pending} pending
            {taskCounts.overdue > 0 && (
              <span className="text-red-500"> / {taskCounts.overdue} overdue</span>
            )}
          </p>
        )}

        {/* Notes — tv: dropped entirely at >=TV_HIDE_NOTES_AT_CYCLES cycles,
            single-line below that (see TV_HIDE_NOTES_AT_CYCLES for the
            measured cost). */}
        {room.notes && !tvHideNotes && (
          <p
            className={
              tv ? `${TV_BODY} text-zinc-400 line-clamp-1` : 'text-xs text-muted-foreground line-clamp-2'
            }
          >
            {room.notes}
          </p>
        )}

        {/* Action buttons — only rendered when callbacks are provided */}
        {(onStartCycle || onAdvanceStage || onEditCycle || onHistory || onEdit || onDelete) && (
          <div className="flex flex-wrap gap-2 pt-1">
            {onStartCycle && (
              <Button variant="outline" size="sm" onClick={() => onStartCycle(room)}>
                <Play className="h-4 w-4 mr-1" />
                Start Cycle
              </Button>
            )}
            {onAdvanceStage && activeCycles.length > 0 && (
              <Button variant="outline" size="sm" onClick={() => onAdvanceStage(room)}>
                <FastForward className="h-4 w-4 mr-1" />
                Advance Stage
              </Button>
            )}
            {onEditCycle && activeCycles.length > 0 && (
              <Button variant="outline" size="sm" onClick={() => onEditCycle(room)}>
                <CalendarCog className="h-4 w-4 mr-1" />
                Edit Cycle
              </Button>
            )}
            {onHistory && (
              <Button variant="ghost" size="sm" onClick={() => onHistory(room)}>
                <History className="h-4 w-4 mr-1" />
                History
              </Button>
            )}
            {onEdit && (
              <Button variant="ghost" size="sm" onClick={() => onEdit(room)}>
                <Edit2 className="h-4 w-4 mr-1" />
                Edit Room
              </Button>
            )}
            {onDelete && (
              <Button
                variant="ghost"
                size="sm"
                className="text-destructive"
                onClick={() => onDelete(room)}
              >
                <Trash2 className="h-4 w-4 mr-1" />
                Remove
              </Button>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
