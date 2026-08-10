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
// tv variant only, split into two independent query scopes (SPRO-83
// columns-not-rows fix):
//
//  - TV_TITLE / TV_BODY are sized off the CARD's own `[container-type:size]`
//    box (unchanged scope from before this pass) and cover everything that
//    isn't per-cycle: room name, pairing label, cycle-count badge, task
//    counts, notes, "No active cycle".
//  - TV_COL_BODY / TV_COL_MILESTONE are sized off each CYCLE COLUMN's own
//    `[container-type:size]` box (new — see the columns grid below). A
//    column's height is roughly constant regardless of how many cycles the
//    room has (that's the whole point of laying cycles out as columns
//    instead of a vertical stack), so its `cqmin` ends up width-bound once a
//    room has enough concurrent cycles to squeeze columns narrow — more
//    cycles -> narrower columns -> smaller text, automatically, with no JS
//    scale factor needed. See getTvScale removal note below.
//
// There is deliberately no `--tv-scale` custom property anymore. It existed
// solely to compensate for the old vertical-stack layout, where a card's
// required height (and therefore the text it could afford) scaled with
// active-cycle count. With cycles laid out as columns, a card's content
// height is driven by ONE column, not N stacked blocks, so cycle count no
// longer correlates with available vertical space and there is nothing left
// for a height-derived scale factor to compensate for. Reusing it now would
// be a scale knob with no underlying quantity — see decisions.md-style
// reasoning: don't leave a mechanism that no longer means anything.
//
// Floors: TV_COL_BODY floors at 14px and TV_COL_MILESTONE at 12px (both
// slightly below the pre-SPRO-83 14px/16px floors) because a 5-column row
// genuinely needs that room — narrow columns hit the floor by design at the
// crowded end, same as before, just width-driven now instead of
// height-driven. TV_TITLE/TV_BODY floors are untouched (1.5rem / 1rem) since
// the card-level box they're sized against didn't shrink.
//
// The clamp midpoints below (8cqmin / 6.5cqmin) were tuned against a live
// measurement, not estimated. A cycle column holds ~7 text lines (cycle
// label, progress label/value, then 5 stacked milestone lines) plus a fixed
// 8px progress bar and ~24px of flex gaps, so required column height is
// roughly `9.45 * fontSize + 32`. That budget was checked against a real
// viewport matrix (1920x1080, 1512x982, 1512x800, 1512x720, 1366x768,
// 2560x1440); at the old 9cqmin/7.5cqmin multipliers the two smallest
// viewports (1512x720, 1366x768) clipped the last milestone line on
// 2-cycle cards. The reduced multipliers give a real margin at every
// measured viewport while 1920x1080+ stay comfortably width-bound, so the
// TV keeps the legibility win over the old stacked layout. Re-tune the
// multiplier (not the floor/ceiling) only after re-measuring against this
// same viewport matrix.

const TV_TITLE = 'text-[clamp(1.5rem,6.7cqmin,3.5rem)]'
const TV_BODY = 'text-[clamp(1rem,3.4cqmin,2.25rem)]'
const TV_COL_BODY = 'text-[clamp(0.875rem,8cqmin,2rem)]'
const TV_COL_MILESTONE = 'text-[clamp(0.75rem,6.5cqmin,1.5rem)]'

/**
 * Max cycle COLUMNS rendered per tv card, and the threshold at which the
 * per-column milestone list is dropped entirely.
 *
 * Post-SPRO-83-fix, this is a WIDTH budget, not a height budget: columns lay
 * out across the card's fixed content height, so more cycles no longer risk
 * vertical clipping — they risk becoming too narrow to read. 5 columns is
 * kept as the cap (rooms run perpetual rotation, so 5 concurrent cycles is a
 * real state, not a hypothetical) but at 5 the milestone list — 5 lines of
 * text stacked in an already-narrow column — is dropped so the column isn't
 * forced skinnier still. 6+ is summarized by `+N more` instead of rendered,
 * same visible-overflow-not-silent-clipping principle as before.
 */
const TV_MAX_RENDERED_CYCLES = 5

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
  // so they're the first thing shed once columns get too narrow to carry a
  // 5-line vertical list (see TV_MAX_RENDERED_CYCLES).
  const tvHideMilestones = tv && activeCycles.length >= TV_MAX_RENDERED_CYCLES

  return (
    // tv: `[container-type:size]` turns the card into a query container on
    // both axes — grid rows are `minmax(0, 1fr)` so the cell (and therefore
    // the card) always has a definite block size, which is what lets the
    // `cqmin`-based TV_TITLE/TV_BODY above scale safely off the card box
    // instead of guessing viewport size. Per-cycle text is sized off each
    // column's own container instead (see TV_COL_BODY/TV_COL_MILESTONE and
    // the columns grid in CardContent below) — the card-level container here
    // now exists only for the header (room name, pairing label, badges).
    <Card
      className={
        tv ? 'border-zinc-700 bg-zinc-900 h-full flex flex-col min-h-0 [container-type:size]' : undefined
      }
    >
      {/* tv: header/content padding trimmed from the shadcn default (p-6) —
          that 24px-per-side default eats vertical budget a fixed-height
          kiosk card can't spare. */}
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
        ) : tv ? (
          <>
            {/* tv: cycles laid out as COLUMNS, not a vertical stack (SPRO-83
                fix). The old vertical stack made required card height grow
                with cycle count while the page grid gives every card a
                fixed-height cell — measured on the live board at 1512 wide,
                a 3-cycle card overflowed its cell below ~860px of viewport
                height (last-cycle-bottom vs. card-bottom: -8px @ 860,
                +18px @ 800, +55px @ 720). Laying cycles out side-by-side
                instead means required height is driven by ONE column's
                content, not N stacked blocks, so height is now
                (approximately) independent of cycle count — cycle count
                pressures width instead, which is the axis with slack.
                `flex-1 min-h-0` makes the row fill (not exceed) the
                remaining CardContent height; each column is top-aligned
                (default flex-col behavior) and is its own
                `[container-type:size]` query container so TV_COL_BODY /
                TV_COL_MILESTONE above shrink automatically as columns get
                narrower — no JS scale factor needed (see the TV typography
                comment block for why --tv-scale was removed). */}
            <div
              className="flex-1 min-h-0 grid gap-3"
              style={{
                gridTemplateColumns: `repeat(${renderedCycles.length}, minmax(0, 1fr))`,
              }}
            >
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
                  <div
                    key={cycle.id}
                    className="min-w-0 min-h-0 overflow-hidden flex flex-col gap-1 [container-type:size]"
                  >
                    {/* flex-wrap, not justify-between-or-bust: at 5 columns
                        "Cycle #3" + a stage badge can be tighter than the
                        column is wide, and this must never overflow
                        horizontally. Wrapping the badge to its own line is a
                        CSS-only fallback that can't produce overflow,
                        without needing an exact per-count layout decision. */}
                    <div className={`flex flex-wrap items-center justify-between gap-x-2 gap-y-0.5 ${TV_COL_BODY}`}>
                      <span className="text-zinc-400">
                        {cycle.cycle_number ? `Cycle #${cycle.cycle_number}` : 'Cycle'}
                      </span>
                      <Badge
                        className={`${PHASE_BADGE_CLASSES[cycle.current_stage] || 'bg-gray-500 text-white'} ${TV_COL_BODY}`}
                      >
                        {stageLabel}
                      </Badge>
                    </div>
                    <div className={`flex flex-wrap items-baseline justify-between gap-x-2 gap-y-0.5 ${TV_COL_BODY}`}>
                      <span className="text-zinc-400">Progress</span>
                      <span className="font-medium">
                        {progress ? `Day ${progress.current} of ${progress.total}` : '—'}
                      </span>
                    </div>
                    {progress && (
                      <div className="h-2 w-full rounded-full bg-muted overflow-hidden shrink-0">
                        <div
                          className={`h-full rounded-full ${PHASE_BADGE_CLASSES[cycle.current_stage]?.split(' ')[0] || 'bg-gray-500'}`}
                          style={{
                            width: `${Math.min((progress.current / progress.total) * 100, 100)}%`,
                          }}
                        />
                      </div>
                    )}
                    {hasMilestones && !tvHideMilestones && (
                      // tv: a vertical one-per-line list, not the old wrapped
                      // chip row — a column is narrow by construction, so a
                      // wrapped row of chips would wrap unpredictably and
                      // its height would stop being predictable per column.
                      // A vertical list's height is just "N lines", which is
                      // what makes the column budget plannable.
                      <div className={`flex flex-col gap-0.5 pt-0.5 ${TV_COL_MILESTONE} text-zinc-400 min-w-0`}>
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
                    )}
                  </div>
                )
              })}
            </div>

            {/* tv: overflow must be visible and truthful, not silently
                swallowed by the card's overflow-hidden — see
                TV_MAX_RENDERED_CYCLES. */}
            {hiddenCycleCount > 0 && (
              <p className={`${TV_BODY} text-zinc-400 shrink-0`}>+{hiddenCycleCount} more</p>
            )}
          </>
        ) : (
          <>
            {/* All active cycles with milestone timelines */}
            {activeCycles.map((cycle) => {
              const progress = getDayProgress(cycle)
              const stageLabel = getCycleStageLabel(cycle.current_stage, cycle.flower_start)
              const hasMilestones =
                cycle.dome_start ||
                cycle.veg_start ||
                cycle.flower_start ||
                cycle.harvest_date ||
                cycle.trim_start
              return (
                <div key={cycle.id} className="space-y-1">
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-muted-foreground">
                      {cycle.cycle_number ? `Cycle #${cycle.cycle_number}` : 'Cycle'}
                    </span>
                    <Badge
                      className={`${PHASE_BADGE_CLASSES[cycle.current_stage] || 'bg-gray-500 text-white'} text-xs`}
                    >
                      {stageLabel}
                    </Badge>
                  </div>
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-muted-foreground">Progress</span>
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
                  {hasMilestones && (
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
                  )}
                </div>
              )
            })}
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

        {/* Notes — tv: no longer shed at a cycle-count threshold (removed
            TV_HIDE_NOTES_AT_CYCLES post-SPRO-83-fix). That threshold existed
            because notes sat below a vertical cycle stack whose height grew
            with cycle count, so at some count notes were exactly the
            overflow tipping point. Cycles are columns now — their row's
            height doesn't grow with cycle count — so there's no longer a
            cycle-count-correlated height pressure for notes to be shed
            against. `line-clamp-1` still caps its own worst case. */}
        {room.notes && (
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
